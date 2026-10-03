package com.helmglass.continuation.infrastructure.repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ContinuationRepository {
  private final JdbcClient jdbc;

  public ContinuationRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record Continuation(UUID id, UUID taskId, long instructionRevision, UUID sessionId,
      String state, String reason, UUID claimId, String claimClientId, UUID claimGrantId,
      Long claimControlEpoch, Instant expiresAt, long version) {}

  public Optional<Continuation> current(UUID taskId) {
    return jdbc.sql("""
        SELECT * FROM task_continuations WHERE task_id=:task
        AND state IN ('READY','DISPATCHING','DELIVERED','DELIVERY_UNKNOWN','CLAIMED')
        FOR UPDATE
        """).param("task", taskId).query(Continuation.class).optional();
  }

  public void ready(UUID taskId, UUID sourceOperation, UUID sourceCommand, String reason) {
    jdbc.sql("""
        INSERT INTO task_continuations(id,task_id,user_id,source_operation_id,source_command_id,
        instruction_revision,session_id,reason,mode,binding_version,expires_at)
        SELECT :id,t.id,t.user_id,:operation,:command,t.instruction_revision,s.id,:reason,'MANUAL',1,
        least(now()+interval '2 hours',coalesce(s.budget_deadline_at,now()+interval '2 hours'))
        FROM tasks t LEFT JOIN browser_sessions s ON s.task_id=t.id AND s.binding_released_at IS NULL
        WHERE t.id=:task AND t.state='WAITING_AGENT' AND NOT t.mutation_barrier
        AND NOT EXISTS(SELECT 1 FROM task_continuations c WHERE c.task_id=t.id
          AND c.state IN ('READY','DISPATCHING','DELIVERED','DELIVERY_UNKNOWN','CLAIMED'))
        ON CONFLICT DO NOTHING
        """).param("id", UUID.randomUUID()).param("task", taskId).param("operation", sourceOperation)
        .param("command", sourceCommand).param("reason", reason).update();
  }

  public void claim(UUID id, UUID claim, String client, UUID grant, Long controlEpoch, Instant expiry) {
    jdbc.sql("""
        UPDATE task_continuations SET state='CLAIMED',claim_id=:claim,claim_client_id=:client,
        claim_grant_id=:grant,claim_control_epoch=:epoch,claimed_at=now(),expires_at=:expiry,
        version=version+1 WHERE id=:id
        """).param("id", id).param("claim", claim).param("client", client).param("grant", grant)
        .param("epoch", controlEpoch).param("expiry", Timestamp.from(expiry)).update();
  }

  public void consume(UUID id) {
    jdbc.sql("UPDATE task_continuations SET state='CONSUMED',consumed_at=now(),version=version+1 WHERE id=:id")
        .param("id", id).update();
  }

  public void cancel(UUID taskId) {
    jdbc.sql("""
        UPDATE task_continuations SET state='CANCELLED',version=version+1 WHERE task_id=:task
        AND state IN ('READY','DISPATCHING','DELIVERED','DELIVERY_UNKNOWN','CLAIMED')
        """).param("task", taskId).update();
  }

  public Map<String, Object> snapshot(UUID taskId) {
    var rows = jdbc.sql("""
        SELECT id,state,reason,mode,version,instruction_revision AS "instructionRevision",
        expires_at AS "expiresAt",session_id AS "observedSessionId"
        FROM task_continuations WHERE task_id=:task ORDER BY created_at DESC,id DESC LIMIT 1
        """).param("task", taskId).query().listOfRows();
    return rows.isEmpty() ? null : rows.getFirst();
  }
}
