package com.helmglass.browser.infrastructure.repository;

import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Durable CLOSE delivery; only physical closure confirms its outbox entry. */
@Repository
public class BrowserCloseOutboxRepository {
  private static final String READY_FOR_CLOSE =
      """
      s.binding_released_at IS NULL
      AND (NOT EXISTS(SELECT 1 FROM browser_session_operations p WHERE p.session_id=s.id
        AND p.state IN ('QUIESCING','SAVING','RESUMING') AND p.deadline>now())
        OR EXISTS(SELECT 1 FROM application_users u WHERE u.id=s.user_id AND u.state<>'ACTIVE'))
      AND (s.state NOT IN ('ACTIVE','STOPPING')
        OR EXISTS(SELECT 1 FROM browser_session_operations p WHERE p.session_id=s.id
          AND (p.state IN ('CLOSING','FAILED','UNKNOWN','SUCCEEDED') OR p.deadline<=now()))
        OR EXISTS(SELECT 1 FROM application_users u WHERE u.id=s.user_id AND u.state<>'ACTIVE')
        OR s.runtime_generation IS NULL)
      AND (t.state IN ('STOPPING','COMPLETED','FAILED','CANCELLED') OR s.state IN ('STOPPING','LOST')
        OR s.budget_deadline_at<=now() OR s.idle_deadline_at<=now()
        OR s.runtime_generation IS NULL AND a.dispatch_attempts>=6
        OR EXISTS(SELECT 1 FROM task_commands c WHERE c.expected_session_id=s.id
          AND c.state='DISPATCHED' AND (c.delivery_attempts>=6 OR c.deadline<=now())))
      """;
  private static final String INSERT_INTENT =
      """
      INSERT INTO transactional_outbox(id,user_id,aggregate_id,aggregate_version,event_type,payload)
      SELECT gen_random_uuid(),user_id,id,allocation_epoch,'worker.close',
        jsonb_build_object('workerId',worker_id,'workerBootId',worker_boot_id,
          'browserSessionId',id,'allocationEpoch',allocation_epoch)
      FROM closing ON CONFLICT(aggregate_id,aggregate_version,event_type,ordinal) DO NOTHING
      """;
  private static final String CURRENT_BINDING =
      """
      o.event_type='worker.close' AND o.published_at IS NULL
      AND o.aggregate_version=s.allocation_epoch
      AND o.payload->>'workerId'=s.worker_id::text
      AND o.payload->>'workerBootId'=s.worker_boot_id::text
      AND w.boot_id=s.worker_boot_id
      """;
  private final JdbcClient jdbc;

  public BrowserCloseOutboxRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record Delivery(
      UUID id, UUID workerId, UUID workerBootId, UUID sessionId, long allocationEpoch) {}

  @Transactional(propagation = Propagation.MANDATORY)
  public void request(UUID sessionId) {
    jdbc.sql(
            """
            WITH closing AS (
              UPDATE browser_sessions SET state='STOPPING',
                version=version+CASE WHEN state='STOPPING' THEN 0 ELSE 1 END
              WHERE id=:id AND state<>'CLOSED' AND binding_released_at IS NULL
              RETURNING id,user_id,worker_id,worker_boot_id,allocation_epoch
            )
            """
                + INSERT_INTENT)
        .param("id", sessionId)
        .update();
  }

  /** Admits deadline/recovery closure through the existing save/quiescence barrier. */
  @Transactional
  public void enqueueDue() {
    jdbc.sql(
            """
            WITH due AS (
              SELECT s.id FROM browser_sessions s LEFT JOIN tasks t ON t.id=s.task_id
                JOIN browser_allocations a ON a.session_id=s.id
              WHERE
            """
                + READY_FOR_CLOSE
                + """
                  AND NOT EXISTS(SELECT 1 FROM transactional_outbox o WHERE o.aggregate_id=s.id
                    AND o.aggregate_version=s.allocation_epoch AND o.event_type='worker.close')
                  ORDER BY s.requested_at,s.id LIMIT 100 FOR UPDATE OF s SKIP LOCKED
                ), closing AS (
                  UPDATE browser_sessions s SET state=CASE WHEN s.state='LOST' THEN 'LOST' ELSE 'STOPPING' END,
                    version=version+1 FROM due WHERE s.id=due.id
                  RETURNING s.id,s.user_id,s.worker_id,s.worker_boot_id,s.allocation_epoch
                )
                """
                + INSERT_INTENT)
        .update();
  }

  /** Reserves a bounded attempt before transport, retaining the same message ID after a crash. */
  @Transactional
  public List<Delivery> due() {
    return jdbc.sql(
            """
            WITH due AS (
              SELECT o.id FROM transactional_outbox o
                JOIN browser_sessions s ON s.id=o.aggregate_id
                JOIN browser_allocations a ON a.session_id=s.id
                JOIN browser_workers w ON w.id=s.worker_id LEFT JOIN tasks t ON t.id=s.task_id
              WHERE
            """
                + CURRENT_BINDING
                + " AND o.delivery_attempts<8 AND o.retry_at<=now() AND "
                + READY_FOR_CLOSE
                + """
                  ORDER BY o.retry_at,o.id LIMIT 100 FOR UPDATE OF o SKIP LOCKED
                ) UPDATE transactional_outbox o SET delivery_attempts=delivery_attempts+1,
                  retry_at=now()+make_interval(secs=>least(30,power(2,delivery_attempts+1)::int)),
                  last_failure_code='CLOSE_ACK_PENDING'
                FROM due WHERE o.id=due.id
                RETURNING o.id,(o.payload->>'workerId')::uuid worker_id,
                  (o.payload->>'workerBootId')::uuid worker_boot_id,
                  o.aggregate_id session_id,o.aggregate_version allocation_epoch
                """)
        .query(Delivery.class)
        .list();
  }

  public boolean deliverable(UUID id) {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM transactional_outbox o
              JOIN browser_sessions s ON s.id=o.aggregate_id
              JOIN browser_allocations a ON a.session_id=s.id
              JOIN browser_workers w ON w.id=s.worker_id LEFT JOIN tasks t ON t.id=s.task_id
              WHERE o.id=:id AND
            """
                + CURRENT_BINDING
                + " AND "
                + READY_FOR_CLOSE
                + ")")
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  public void transportFailed(UUID id) {
    jdbc.sql(
            """
            UPDATE transactional_outbox SET last_failure_code='WORKER_TRANSPORT_UNAVAILABLE'
            WHERE id=:id AND event_type='worker.close' AND published_at IS NULL
            """)
        .param("id", id)
        .update();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void confirmed(UUID sessionId) {
    jdbc.sql(
            """
            UPDATE transactional_outbox o SET published_at=now(),last_failure_code=NULL
            FROM browser_sessions s WHERE s.id=:id AND s.state='CLOSED'
              AND s.binding_released_at IS NOT NULL AND o.aggregate_id=s.id
              AND o.aggregate_version=s.allocation_epoch AND o.event_type='worker.close'
              AND o.payload->>'workerId'=s.worker_id::text
              AND o.payload->>'workerBootId'=s.worker_boot_id::text AND o.published_at IS NULL
            """)
        .param("id", sessionId)
        .update();
  }
}
