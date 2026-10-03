package com.helmglass.browser.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.identity.domain.QuotaCeiling;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;

@Repository
public class BrowserRepository {
  private final JdbcClient jdbc;

  public BrowserRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record Worker(UUID id, UUID bootId, int capacity) {}

  public record Session(
      UUID id,
      UUID userId,
      UUID taskId,
      UUID workerId,
      UUID workerBootId,
      long version,
      long allocationEpoch,
      long pageEpoch,
      long privacyEpoch,
      String state,
      String privacy,
      Instant budgetDeadlineAt,
      Instant idleDeadlineAt,
      UUID connectionId,
      String purpose,
      String currentUrl,
      long mediaGeneration,
      UUID profileVersionId,
      String savePolicy,
      int viewportWidth,
      int viewportHeight,
      String closeReason) {}

  public record Candidate(
      UUID id, UUID taskId, UUID userId, String state, Instant deadline, String startUrl) {}

  public Candidate candidate(UUID id) {
    return jdbc.sql(
            "SELECT"
                + " c.id,c.task_id,c.user_id,c.state,c.deadline,coalesce(c.payload->>'url',t.start_url)"
                + " start_url FROM task_commands c JOIN tasks t ON t.id=c.task_id WHERE c.id=:id")
        .param("id", id)
        .query(Candidate.class)
        .single();
  }

  public Optional<Session> binding(UUID taskId) {
    return jdbc.sql(
            "SELECT * FROM browser_sessions WHERE task_id=:id AND binding_released_at IS NULL")
        .param("id", taskId)
        .query(Session.class)
        .optional();
  }

  public Session owned(UUID userId, UUID id) {
    return jdbc.sql("SELECT * FROM browser_sessions WHERE id=:id AND user_id=:user")
        .param("id", id)
        .param("user", userId)
        .query(Session.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void checkBrowserLimit(UUID userId) {
    record Capacity(
        Integer personal, String mode, Integer customLimit, int standardLimit, long used) {}
    Capacity limits =
        jdbc.sql(
                """
                SELECT p.browser_limit personal,l.browser_mode mode,l.browser_custom custom_limit,
                s.standard_browser_limit standard_limit,(SELECT count(*) FROM browser_allocations a
                WHERE a.user_id=:user AND a.state IN ('RESERVED','ASSIGNED','RELEASING','QUARANTINED')) used
                FROM user_policies p JOIN admin_user_limits l ON l.user_id=p.user_id
                CROSS JOIN platform_settings s WHERE p.user_id=:user
                """)
            .param("user", userId)
            .query(Capacity.class)
            .single();
    Integer limit =
        QuotaCeiling.browsers(
                limits.mode(), limits.customLimit(), limits.standardLimit(), limits.personal())
            .effective();
    if (limit != null && limits.used() >= limit) {
      throw DomainException.conflict("USER_BROWSER_LIMIT", "Browser quota is currently occupied");
    }
  }

  public Optional<Worker> freeWorker() {
    return jdbc.sql(
            """
            SELECT w.id,w.boot_id,w.capacity FROM browser_workers w CROSS JOIN platform_settings p
            WHERE p.accepting_allocations AND w.desired_mode='ENABLED' AND w.observed_state='READY'
            AND w.inventory_reconciled_at IS NOT NULL AND w.heartbeat_at>now()-interval '20 seconds' AND w.capacity>(SELECT count(*)
            FROM browser_allocations a WHERE a.worker_id=w.id
            AND a.state IN ('RESERVED','ASSIGNED','RELEASING','QUARANTINED'))
            ORDER BY w.heartbeat_at DESC,w.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED
            """)
        .query(Worker.class)
        .optional();
  }

  public Session reserve(UUID userId, UUID taskId, Worker worker, int budget) {
    return reserve(userId, taskId, null, "TASK", worker, budget);
  }

  public Session reserve(
      UUID userId, UUID taskId, UUID connectionId, String purpose, Worker worker, int budget) {
    UUID sessionId = UUID.randomUUID();
    request(sessionId, userId, taskId, purpose, Instant.now().plusSeconds(budget));
    return allocate(owned(userId, sessionId), connectionId, worker, budget);
  }

  public void request(UUID sessionId, UUID userId, UUID taskId, String purpose, Instant deadline) {
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,purpose,state,save_policy,idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:task,:purpose,'REQUESTED','DISCARD_CHANGES',:deadline,:deadline)
            """)
        .param("id", sessionId)
        .param("user", userId)
        .param("task", taskId)
        .param("purpose", purpose)
        .param("deadline", Timestamp.from(deadline))
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_control_leases(session_id,owner_id,expires_at,owner_kind,state)
            VALUES(:session,:user,:deadline,'NONE','QUIESCED')
            """)
        .param("session", sessionId)
        .param("user", userId)
        .param("deadline", Timestamp.from(deadline))
        .update();
  }

  public Session allocate(Session requested, UUID connectionId, Worker worker, long budget) {
    int slot =
        jdbc.sql(
                """
                SELECT slot FROM generate_series(0,:capacity-1) slot WHERE NOT EXISTS
                (SELECT 1 FROM browser_allocations a WHERE a.worker_id=:worker AND a.slot_index=slot
                AND a.state IN ('RESERVED','ASSIGNED','RELEASING','QUARANTINED')) ORDER BY slot LIMIT 1
                """)
            .param("capacity", worker.capacity())
            .param("worker", worker.id())
            .query(Integer.class)
            .single();
    UUID sessionId = requested.id();
    Instant deadline = Instant.now().plusSeconds(budget);
    int allocated =
        jdbc.sql(
                """
                UPDATE browser_sessions SET connection_id=:connection,worker_id=:worker,worker_boot_id=:boot,
                state='STARTING',save_policy=CASE WHEN open_operation_id IS NOT NULL THEN save_policy
                  WHEN (SELECT save_preference FROM connections WHERE id=:connection)='SAVE'
                  THEN 'SAVE_ON_CLOSE' ELSE 'DISCARD_CHANGES' END,idle_deadline_at=now()+interval '15 minutes',
                budget_deadline_at=:deadline,version=version+1 WHERE id=:id AND state='REQUESTED'
                """)
            .param("id", sessionId)
            .param("connection", connectionId)
            .param("worker", worker.id())
            .param("boot", worker.bootId())
            .param("deadline", Timestamp.from(deadline))
            .update();
    if (allocated != 1) {
      throw DomainException.conflict(
          "BROWSER_ALLOCATION_FENCED", "Browser is no longer awaiting allocation");
    }
    jdbc.sql(
            """
            INSERT INTO browser_allocations(id,session_id,user_id,connection_id,worker_id,slot_index,allocation_epoch)
            VALUES(:id,:session,:user,:connection,:worker,:slot,1)
            """)
        .param("id", UUID.randomUUID())
        .param("session", sessionId)
        .param("user", requested.userId())
        .param("connection", connectionId)
        .param("worker", worker.id())
        .param("slot", slot)
        .update();
    jdbc.sql(
            """
            UPDATE browser_control_leases SET expires_at=:deadline,owner_kind='AGENT',state='ACTIVE'
            WHERE session_id=:session
            """)
        .param("session", sessionId)
        .param("deadline", Timestamp.from(deadline))
        .update();
    if (!requested.purpose().equals("TASK")) {
      jdbc.sql("UPDATE browser_sessions SET privacy='LOGIN_PRIVATE' WHERE id=:id")
          .param("id", sessionId)
          .update();
    }
    return owned(requested.userId(), sessionId);
  }

  public void dispatch(Candidate candidate, Session session) {
    jdbc.sql(
            "UPDATE tasks SET state='STARTING',version=version+1,updated_at=now() WHERE id=:task"
                + " AND state='QUEUED'")
        .param("task", candidate.taskId())
        .update();
    UUID attemptId = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO command_attempts(id,command_id,session_id,worker_id,attempt_no,
            assignment_epoch,control_epoch)
            SELECT :id,:command,:session,:worker,
            (SELECT coalesce(max(attempt_no),0)+1 FROM command_attempts WHERE command_id=:command),:epoch,l.epoch
            FROM browser_control_leases l WHERE l.session_id=:session
            """)
        .param("id", attemptId)
        .param("command", candidate.id())
        .param("session", session.id())
        .param("worker", session.workerId())
        .param("epoch", session.allocationEpoch())
        .update();
    jdbc.sql(
            """
            UPDATE task_commands SET state='DISPATCHED',expected_session_id=:session,
            dispatched_at=now(),delivery_attempts=0,next_delivery_at=now()+interval '2 seconds',version=version+1 WHERE id=:id
            """)
        .param("session", session.id())
        .param("id", candidate.id())
        .update();
  }

  public UUID dispatchedForSession(UUID id) {
    return jdbc.sql(
            "SELECT id FROM task_commands WHERE expected_session_id=:id AND state='DISPATCHED'")
        .param("id", id)
        .query(UUID.class)
        .optional()
        .orElse(null);
  }

  public void waitForResource(UUID commandId, String reason) {
    jdbc.sql(
            """
            UPDATE task_commands SET state='WAITING_RESOURCE',next_eligible_at=now()+interval '1 second'
            WHERE id=:id AND state IN ('ACCEPTED','WAITING_RESOURCE')
            """)
        .param("id", commandId)
        .update();
    jdbc.sql(
            """
            UPDATE tasks SET wait_reason=:reason WHERE id=(SELECT task_id FROM task_commands WHERE id=:id)
            """)
        .param("id", commandId)
        .param("reason", reason)
        .update();
  }

  public void runtimeEpochs(UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt) {
    for (String field : List.of("allocationEpoch", "controlEpoch", "pageEpoch", "privacyEpoch")) {
      if (!receipt.path(field).isIntegralNumber() || receipt.path(field).asLong(-1) < 1) {
        throw new DomainException(
            422, "RECEIPT_EPOCHS_MISSING", "Runtime receipt must contain its epoch binding");
      }
    }
    jdbc.sql(
            """
            UPDATE browser_sessions s SET page_epoch=:page,version=s.version+1
            FROM browser_control_leases l WHERE s.id=:id AND l.session_id=s.id
            AND s.worker_id=:worker AND s.worker_boot_id=:boot AND s.allocation_epoch=:allocation
            AND l.epoch=:control AND s.privacy_epoch=:privacy AND s.page_epoch<:page
            AND s.binding_released_at IS NULL
            """)
        .param("id", sessionId)
        .param("worker", workerId)
        .param("boot", bootId)
        .param("allocation", receipt.path("allocationEpoch").asLong())
        .param("control", receipt.path("controlEpoch").asLong())
        .param("privacy", receipt.path("privacyEpoch").asLong())
        .param("page", receipt.path("pageEpoch").asLong())
        .update();
  }

  public void observedLocation(
      UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt, String url) {
    jdbc.sql(
            """
            UPDATE browser_sessions s SET current_url=:url,version=s.version+1
            FROM browser_control_leases l WHERE s.id=:id AND l.session_id=s.id
            AND s.worker_id=:worker AND s.worker_boot_id=:boot AND s.allocation_epoch=:allocation
            AND l.epoch=:control AND s.privacy_epoch=:privacy AND s.page_epoch=:page
            AND s.binding_released_at IS NULL AND s.current_url IS DISTINCT FROM :url
            """)
        .param("id", sessionId)
        .param("worker", workerId)
        .param("boot", bootId)
        .param("allocation", receipt.path("allocationEpoch").asLong())
        .param("control", receipt.path("controlEpoch").asLong())
        .param("privacy", receipt.path("privacyEpoch").asLong())
        .param("page", receipt.path("pageEpoch").asLong())
        .param("url", url)
        .update();
  }
}
