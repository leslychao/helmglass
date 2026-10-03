package com.helmglass.browser.infrastructure.repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Explicit opening extends the existing session binding; it does not create another registry. */
@Repository
public class BrowserOpenRepository {
  private final JdbcClient jdbc;

  public BrowserOpenRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record Request(
      UUID sessionId,
      UUID operationId,
      UUID userId,
      UUID taskId,
      long instructionRevision,
      Instant deadline,
      String operationState) {}

  public Optional<Request> request(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT s.id session_id,s.open_operation_id operation_id,s.user_id,s.task_id,
            s.open_instruction_revision instruction_revision,s.open_request_deadline deadline,o.state operation_state
            FROM browser_sessions s JOIN operations o ON o.id=s.open_operation_id WHERE s.id=:id
            """)
        .param("id", sessionId)
        .query(Request.class)
        .optional();
  }

  public Optional<UUID> existingOperation(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT id FROM operations WHERE kind='browser.open' AND target_id=:id
            AND state IN ('PENDING','RUNNING','SUCCEEDED') ORDER BY created_at DESC,id DESC LIMIT 1
            """)
        .param("id", sessionId)
        .query(UUID.class)
        .optional();
  }

  public record Reuse(UUID userId, UUID taskId, Instant deadline) {}

  public Optional<Reuse> pendingReuse(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT s.user_id,s.task_id,min(o.created_at)+interval '120 seconds' deadline
            FROM browser_sessions s JOIN operations o ON o.target_id=s.id AND o.kind='browser.open'
            WHERE s.id=:id AND s.open_operation_id IS NULL AND o.state IN ('PENDING','RUNNING')
            GROUP BY s.id
            """)
        .param("id", sessionId)
        .query(Reuse.class)
        .optional();
  }

  public void failReuse(UUID sessionId, String code) {
    jdbc.sql(
            """
            UPDATE operations SET state='FAILED',failure_code=:code,finished_at=now(),updated_at=now(),
            version=version+1 WHERE target_id=:id AND kind='browser.open' AND state IN ('PENDING','RUNNING')
            """)
        .param("id", sessionId)
        .param("code", code)
        .update();
  }

  public Optional<UUID> previousSession(UUID taskId) {
    return jdbc.sql(
            "SELECT id FROM browser_sessions WHERE task_id=:task ORDER BY requested_at DESC,id DESC"
                + " LIMIT 1")
        .param("task", taskId)
        .query(UUID.class)
        .optional();
  }

  public void prepare(
      UUID sessionId, UUID operationId, long revision, Instant deadline, String savePolicy) {
    jdbc.sql(
            """
            UPDATE browser_sessions SET open_operation_id=:operation,open_request_deadline=:deadline,
            open_instruction_revision=:revision,open_next_attempt_at=now(),save_policy=:savePolicy WHERE id=:id AND state='REQUESTED'
            """)
        .param("id", sessionId)
        .param("operation", operationId)
        .param("revision", revision)
        .param("deadline", Timestamp.from(deadline))
        .param("savePolicy", savePolicy)
        .update();
  }

  public List<UUID> due() {
    return jdbc.sql(
            """
            SELECT s.id FROM browser_sessions s JOIN operations o ON o.target_id=s.id AND o.kind='browser.open'
            WHERE o.state IN ('PENDING','RUNNING') AND (s.open_next_attempt_at IS NULL OR s.open_next_attempt_at<=now())
            GROUP BY s.id ORDER BY min(o.created_at),s.id LIMIT 20
            """)
        .query(UUID.class)
        .list();
  }

  public void waitForResource(UUID sessionId, String reason) {
    jdbc.sql(
            """
            UPDATE browser_sessions SET open_failure_code=:reason,open_next_attempt_at=now()+interval '1 second'
            WHERE id=:id
            """)
        .param("id", sessionId)
        .param("reason", reason)
        .update();
  }

  public void finish(UUID sessionId, String state, String code) {
    jdbc.sql(
            """
            UPDATE operations o SET state=:state,failure_code=:code,finished_at=now(),updated_at=now(),
            progress=100,version=o.version+1 FROM browser_sessions s WHERE s.id=:id AND o.id=s.open_operation_id
            AND o.state IN ('PENDING','RUNNING')
            """)
        .param("id", sessionId)
        .param("state", state)
        .param("code", code)
        .update();
    if (!state.equals("SUCCEEDED")) {
      jdbc.sql(
              """
              UPDATE browser_sessions s SET state=CASE WHEN state='REQUESTED' THEN 'FAILED' ELSE 'STOPPING' END,
              binding_released_at=CASE WHEN state='REQUESTED' THEN now() ELSE binding_released_at END,
              closed_at=CASE WHEN state='REQUESTED' THEN now() ELSE closed_at END,close_reason=:code,
              open_failure_code=:code,version=version+1 WHERE id=:id AND binding_released_at IS NULL
              """)
          .param("id", sessionId)
          .param("code", code)
          .update();
    }
  }

  public Optional<BrowserRepository.Session> activeSession(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT * FROM browser_sessions WHERE id=:id AND purpose='TASK' AND state='ACTIVE'
            AND binding_released_at IS NULL
            AND EXISTS(SELECT 1 FROM operations WHERE target_id=:id AND kind='browser.open' AND state IN ('PENDING','RUNNING'))
            """)
        .param("id", sessionId)
        .query(BrowserRepository.Session.class)
        .optional();
  }
}
