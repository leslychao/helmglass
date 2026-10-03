package com.helmglass.browser.infrastructure.repository;

import com.helmglass.api.DomainException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class BrowserSessionOperationRepository {
  public record SessionOperation(
      UUID id,
      UUID userId,
      UUID sessionId,
      UUID loginId,
      UUID controllerInstanceId,
      UUID previousOperationId,
      String intent,
      String state,
      long controlEpoch,
      long privacyEpoch,
      long allocationEpoch,
      long policyVersion,
      UUID expectedProfileVersion,
      UUID transferId,
      UUID profileVersionId,
      Instant deadline,
      String initiator,
      String failureCode) {}

  private final JdbcClient jdbc;

  public BrowserSessionOperationRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public UUID owner(UUID id) {
    return jdbc.sql("SELECT user_id FROM browser_session_operations WHERE id=:id")
        .param("id", id)
        .query(UUID.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public SessionOperation lock(UUID id) {
    return jdbc.sql("SELECT * FROM browser_session_operations WHERE id=:id FOR UPDATE")
        .param("id", id)
        .query(SessionOperation.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public Optional<UUID> pendingForSession(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT id FROM browser_session_operations WHERE session_id=:id
              AND state IN ('QUIESCING','SAVING','RESUMING','CLOSING')
            """)
        .param("id", sessionId)
        .query(UUID.class)
        .optional();
  }

  public record ClosingSession(UUID id, UUID userId) {}

  public List<ClosingSession> dueClosures() {
    return jdbc.sql(
            """
            SELECT s.id,s.user_id FROM browser_sessions s
              JOIN application_users u ON u.id=s.user_id LEFT JOIN tasks t ON t.id=s.task_id
            WHERE u.state='ACTIVE' AND s.state IN ('ACTIVE','STOPPING')
              AND s.binding_released_at IS NULL AND s.runtime_generation IS NOT NULL
              AND (s.state='STOPPING' OR s.budget_deadline_at<=now() OR\
            """
                + BrowserRepository.IDLE_EXPIRED
                + """
                    OR t.state IN ('STOPPING','COMPLETED','FAILED','CANCELLED'))
                  AND NOT EXISTS(SELECT 1 FROM browser_session_operations o WHERE o.session_id=s.id
                    AND (o.initiator='SYSTEM' OR o.state IN ('QUIESCING','SAVING','RESUMING','CLOSING')))
                ORDER BY s.requested_at,s.id LIMIT 50
                """)
        .query(ClosingSession.class)
        .list();
  }

  public boolean closeDue(UUID id) {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM browser_sessions s LEFT JOIN tasks t ON t.id=s.task_id
              WHERE s.id=:id AND (s.state='STOPPING' OR s.budget_deadline_at<=now()
                OR\
            """
                + BrowserRepository.IDLE_EXPIRED
                + """
                    OR t.state IN ('STOPPING','COMPLETED','FAILED','CANCELLED')))
                """)
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  public boolean automaticCloseExists(UUID sessionId) {
    return jdbc.sql(
            "SELECT EXISTS(SELECT 1 FROM browser_session_operations WHERE session_id=:id AND"
                + " initiator='SYSTEM')")
        .param("id", sessionId)
        .query(Boolean.class)
        .single();
  }

  public UUID currentProfileVersion(UUID userId, UUID connectionId) {
    return jdbc.sql(
            "SELECT current_version_id FROM browser_profiles WHERE user_id=:user AND"
                + " connection_id=:connection AND state='ACTIVE'")
        .param("user", userId)
        .param("connection", connectionId)
        .query(UUID.class)
        .optional()
        .orElse(null);
  }

  public void automatic(UUID id, Instant deadline) {
    jdbc.sql(
            "UPDATE browser_session_operations SET initiator='SYSTEM',deadline=:deadline WHERE"
                + " id=:id")
        .param("id", id)
        .param("deadline", Timestamp.from(deadline))
        .update();
  }

  public List<UUID> pending() {
    return jdbc.sql(
            """
            SELECT id FROM browser_session_operations
              WHERE state IN ('QUIESCING','SAVING','RESUMING','CLOSING') AND updated_at<now()-interval '5 seconds'
              ORDER BY updated_at,id LIMIT 20
            """)
        .query(UUID.class)
        .list();
  }

  public void create(
      UUID id,
      BrowserRepository.Session session,
      ControlRepository.Lease control,
      UUID loginId,
      UUID controller,
      String intent,
      long policyVersion,
      UUID expectedProfileVersion) {
    if (pendingForSession(session.id()).isPresent()) {
      throw DomainException.conflict(
          "BROWSER_OPERATION_PENDING", "A browser operation is in progress");
    }
    jdbc.sql(
            """
            INSERT INTO browser_session_operations(id,user_id,session_id,login_id,controller_instance_id,
              previous_operation_id,intent,state,control_epoch,privacy_epoch,allocation_epoch,
              policy_version,expected_profile_version,deadline,initiator)
            VALUES(:id,:user,:session,:login,:controller,:previous,:intent,'QUIESCING',:control,
              :privacy,:allocation,:policy,:profile,now()+interval '5 minutes',:initiator)
            """)
        .param("id", id)
        .param("user", session.userId())
        .param("session", session.id())
        .param("login", loginId)
        .param("controller", controller)
        .param("previous", control.operationId())
        .param("intent", intent)
        .param("control", control.epoch())
        .param("privacy", session.privacyEpoch())
        .param("allocation", session.allocationEpoch())
        .param("policy", policyVersion)
        .param("profile", expectedProfileVersion)
        .param("initiator", loginId == null ? "SYSTEM" : "WEB")
        .update();
  }

  public void transfer(UUID id, UUID transferId, UUID profileVersionId) {
    jdbc.sql(
            """
            UPDATE browser_session_operations SET transfer_id=:transfer,profile_version_id=:profile,
              state='SAVING',updated_at=now() WHERE id=:id AND state='QUIESCING'
            """)
        .param("id", id)
        .param("transfer", transferId)
        .param("profile", profileVersionId)
        .update();
  }

  public void phase(UUID id, String phase) {
    jdbc.sql("UPDATE browser_session_operations SET state=:state,updated_at=now() WHERE id=:id")
        .param("id", id)
        .param("state", phase)
        .update();
  }

  public void attempted(UUID id) {
    jdbc.sql("UPDATE browser_session_operations SET updated_at=now() WHERE id=:id")
        .param("id", id)
        .update();
  }

  public void closing(UUID id, String failureCode) {
    jdbc.sql(
            "UPDATE browser_session_operations SET"
                + " state='CLOSING',failure_code=:code,updated_at=now() WHERE id=:id")
        .param("id", id)
        .param("code", failureCode)
        .update();
  }

  public void failure(UUID id, String code) {
    jdbc.sql("UPDATE browser_session_operations SET failure_code=:code WHERE id=:id")
        .param("id", id)
        .param("code", code)
        .update();
  }

  public long advanceSession(UUID sessionId) {
    return jdbc.sql("UPDATE browser_sessions SET version=version+1 WHERE id=:id RETURNING version")
        .param("id", sessionId)
        .query(Long.class)
        .single();
  }

  public long savePolicy(UUID sessionId, String policy) {
    return jdbc.sql(
            "UPDATE browser_sessions SET save_policy=:policy,version=version+1 WHERE id=:id"
                + " RETURNING version")
        .param("id", sessionId)
        .param("policy", policy)
        .query(Long.class)
        .single();
  }

  public void closeReason(UUID sessionId, String code) {
    jdbc.sql("UPDATE browser_sessions SET close_reason=:code,version=version+1 WHERE id=:id")
        .param("id", sessionId)
        .param("code", code)
        .update();
  }

  public void pauseTask(UUID sessionId) {
    jdbc.sql(
            """
            UPDATE tasks SET state='PAUSED',version=version+1,updated_at=now()
              WHERE id=(SELECT task_id FROM browser_sessions WHERE id=:id)
              AND state NOT IN ('COMPLETED','FAILED','CANCELLED','STOPPING','INTERRUPTED','PAUSED')
              AND NOT mutation_barrier
            """)
        .param("id", sessionId)
        .update();
  }

  public long finish(SessionOperation operation, String state, String code) {
    phase(operation.id(), state);
    return jdbc.sql(
            """
            UPDATE operations SET state=:state,progress=100,failure_code=:code,finished_at=now(),
              updated_at=now(),version=version+1 WHERE id=:id RETURNING version
            """)
        .param("id", operation.id())
        .param("state", state.equals("UNKNOWN") ? "NEEDS_ATTENTION" : state)
        .param("code", code)
        .query(Long.class)
        .single();
  }
}
