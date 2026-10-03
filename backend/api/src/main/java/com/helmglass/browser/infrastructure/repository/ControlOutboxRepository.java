package com.helmglass.browser.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

/** Stores the immutable control transition in the transaction that changes its lease. */
@Repository
public class ControlOutboxRepository {
  private static final String CURRENT_BINDING =
      """
      o.event_type='worker.control' AND o.published_at IS NULL
      AND o.payload->>'workerId'=s.worker_id::text
      AND o.payload->>'workerBootId'=s.worker_boot_id::text AND w.boot_id=s.worker_boot_id
      AND s.binding_released_at IS NULL AND s.runtime_generation IS NOT NULL
      AND s.state IN ('ACTIVE','STOPPING')
      AND (o.payload->'message'->>'allocationEpoch')::bigint=s.allocation_epoch
      AND (o.payload->'message'->>'controlEpoch')::bigint=c.epoch
      AND (o.payload->'message'->>'privacyEpoch')::bigint=s.privacy_epoch
      AND (o.payload->'message'->>'pageEpoch')::bigint=s.page_epoch
      AND o.aggregate_version=c.version AND c.state IN ('TRANSFERRING','QUIESCING')
      AND (o.payload->>'operationId')::uuid IS NOT DISTINCT FROM c.operation_id
      AND u.state='ACTIVE'
      AND (o.payload->'message'->>'policyVersion')::bigint=p.version
      AND (NOT jsonb_exists(o.payload->'message','connectionId') OR EXISTS(
        SELECT 1 FROM connections x WHERE x.id=s.connection_id AND x.user_id=s.user_id
        AND x.id::text=o.payload->'message'->>'connectionId'
        AND x.scope_version=(o.payload->'message'->>'scopeVersion')::bigint))
      AND (o.payload->'message'->>'mode'='QUIESCED' OR
        (s.state='ACTIVE' AND (o.payload->'message'->>'leaseExpiresAt')::timestamptz>now()
        AND (o.payload->'message'->>'mode'='AGENT' OR EXISTS(
          SELECT 1 FROM application_logins l WHERE l.id=c.login_id
          AND l.user_id=s.user_id AND l.state='ACTIVE' AND l.expires_at>now()
          AND l.admitted_access_epoch=u.access_epoch))))
      AND (c.continuation_claim_id IS NULL OR EXISTS(SELECT 1 FROM task_continuations t
        JOIN client_grants g ON g.id=t.claim_grant_id WHERE t.claim_id=c.continuation_claim_id
        AND t.state='CLAIMED' AND t.expires_at>now() AND t.claim_expires_at>now()
        AND g.status='ACTIVE'))
      AND (s.budget_deadline_at>now() OR
        (o.payload->'message'->>'mode'='QUIESCED'
        AND (o.payload->'message'->>'cleanupDeadline')::timestamptz>now()
        AND (o.payload->'message'->>'cleanupDeadline')::timestamptz<=s.budget_deadline_at+interval '120 seconds'))
      """;
  private static final String JOINS =
      """
      FROM transactional_outbox o JOIN browser_sessions s ON s.id=o.aggregate_id
      JOIN browser_control_leases c ON c.session_id=s.id
      JOIN browser_workers w ON w.id=s.worker_id
      JOIN application_users u ON u.id=s.user_id JOIN user_policies p ON p.user_id=s.user_id
      """;
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public ControlOutboxRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public record Delivery(UUID id, UUID workerId, UUID workerBootId, String message) {}

  public record Receipt(UUID id, UUID userId) {}

  /** Retains unsent intents as failed evidence; closure is not a control delivery ACK. */
  @Transactional
  public void retireClosedBindings() {
    jdbc.sql(
            """
            WITH closed AS (
              SELECT o.id FROM transactional_outbox o
              JOIN browser_sessions s ON s.id=o.aggregate_id
              WHERE o.event_type='worker.control' AND o.published_at IS NULL
                AND o.last_failure_code IS DISTINCT FROM 'SESSION_CLOSED'
                AND s.state='CLOSED' AND s.binding_released_at IS NOT NULL
                AND NOT EXISTS(SELECT 1 FROM browser_allocations a
                  WHERE a.session_id=s.id AND a.state<>'RELEASED')
              ORDER BY o.created_at,o.id LIMIT 100 FOR UPDATE OF o SKIP LOCKED)
            UPDATE transactional_outbox o SET last_failure_code='SESSION_CLOSED'
            FROM closed WHERE o.id=closed.id
            """)
        .update();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void enqueue(UUID workerId, Map<String, Object> message) {
    UUID sessionId = UUID.fromString(Objects.toString(message.get("browserSessionId")));
    UUID requestId = UUID.fromString(Objects.toString(message.get("requestId")));
    int inserted =
        jdbc.sql(
                """
                INSERT INTO transactional_outbox(id,user_id,aggregate_id,aggregate_version,event_type,payload)
                SELECT :request,s.user_id,s.id,c.version,'worker.control',
                  jsonb_build_object('workerId',s.worker_id,'workerBootId',s.worker_boot_id,
                    'operationId',c.operation_id,'message',CAST(:message AS jsonb))
                FROM browser_sessions s JOIN browser_control_leases c ON c.session_id=s.id
                WHERE s.id=:session AND s.worker_id=:worker AND s.binding_released_at IS NULL
                ON CONFLICT(aggregate_id,aggregate_version,event_type,ordinal) DO NOTHING
                """)
            .param("request", requestId)
            .param("message", json.write(message))
            .param("session", sessionId)
            .param("worker", workerId)
            .update();
    if (inserted == 0
        && !jdbc.sql(
                """
                SELECT EXISTS(SELECT 1 FROM transactional_outbox o
                JOIN browser_control_leases c ON c.session_id=o.aggregate_id
                WHERE o.aggregate_id=:session AND o.aggregate_version=c.version AND o.event_type='worker.control')
                """)
            .param("session", sessionId)
            .query(Boolean.class)
            .single()) {
      throw DomainException.conflict(
          "CONTROL_BINDING_CHANGED", "Control delivery has no live binding");
    }
  }

  @Transactional
  public List<Delivery> due() {
    return jdbc.sql(
            "WITH due AS (SELECT o.id "
                + JOINS
                + " WHERE "
                + CURRENT_BINDING
                + """
                AND o.delivery_attempts<8 AND o.retry_at<=now()
                ORDER BY o.retry_at,o.id LIMIT 100 FOR UPDATE OF o SKIP LOCKED)
                UPDATE transactional_outbox o SET delivery_attempts=delivery_attempts+1,
                  retry_at=now()+make_interval(secs=>least(30,power(2,delivery_attempts+1)::int)),
                  last_failure_code='CONTROL_ACK_PENDING'
                FROM due WHERE o.id=due.id RETURNING o.id,(o.payload->>'workerId')::uuid worker_id,
                  (o.payload->>'workerBootId')::uuid worker_boot_id,(o.payload->'message')::text message
                """)
        .query(Delivery.class)
        .list();
  }

  public boolean deliverable(UUID id) {
    return jdbc.sql(
            "SELECT EXISTS(SELECT 1 " + JOINS + " WHERE o.id=:id AND " + CURRENT_BINDING + ")")
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  public void transportFailed(UUID id) {
    jdbc.sql(
            """
            UPDATE transactional_outbox SET last_failure_code='WORKER_TRANSPORT_UNAVAILABLE'
            WHERE id=:id AND event_type='worker.control' AND published_at IS NULL
            """)
        .param("id", id)
        .update();
  }

  /** Validates the immutable wire receipt before a domain transition is applied. */
  @Transactional(propagation = Propagation.MANDATORY)
  public Optional<Receipt> receipt(UUID workerId, UUID bootId, JsonNode value) {
    UUID id = UUID.fromString(value.path("requestId").asString());
    var found =
        jdbc.sql(
                """
                SELECT user_id,aggregate_id session_id,payload::text
                FROM transactional_outbox WHERE id=:id AND event_type='worker.control'
                """)
            .param("id", id)
            .query(StoredReceipt.class)
            .optional();
    if (found.isEmpty()) {
      return Optional.empty();
    }
    StoredReceipt stored = found.get();
    JsonNode payload = json.read(stored.payload());
    JsonNode message = payload.path("message");
    if (!workerId.toString().equals(payload.path("workerId").asString())
        || !bootId.toString().equals(payload.path("workerBootId").asString())
        || !stored.sessionId().toString().equals(value.path("browserSessionId").asString())
        || !message.path("mode").asString().equals(value.path("mode").asString())) {
      throw DomainException.conflict("CONTROL_ACK_FENCED", "Control receipt binding changed");
    }
    for (String field : List.of("allocationEpoch", "controlEpoch", "pageEpoch", "privacyEpoch")) {
      if (message.path(field).asLong(-1) != value.path(field).asLong(-2)) {
        throw DomainException.conflict("CONTROL_ACK_FENCED", "Control receipt epoch changed");
      }
    }
    return Optional.of(new Receipt(id, stored.userId()));
  }

  public boolean published(UUID id) {
    return jdbc.sql(
            "SELECT published_at IS NOT NULL FROM transactional_outbox WHERE id=:id AND"
                + " event_type='worker.control'")
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void confirmed(UUID id) {
    jdbc.sql(
            """
            UPDATE transactional_outbox SET published_at=now(),last_failure_code=NULL
            WHERE id=:id AND event_type='worker.control' AND published_at IS NULL
            """)
        .param("id", id)
        .update();
  }

  private record StoredReceipt(UUID userId, UUID sessionId, String payload) {}
}
