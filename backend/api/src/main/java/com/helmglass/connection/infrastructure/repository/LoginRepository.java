package com.helmglass.connection.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.connection.api.LoginContracts;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class LoginRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public LoginRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public record Login(
      UUID id,
      UUID connectionId,
      UUID userId,
      UUID sessionId,
      UUID taskId,
      long version,
      String kind,
      String state,
      UUID controllerInstanceId,
      String expectedOrigin,
      String postLoginPathPrefix,
      String accountEvidenceText,
      String verificationResult,
      UUID profileVersionId,
      Instant expiresAt,
      String saveMode,
      String continuationIntent,
      String accountLabel,
      UUID completeOperationId,
      boolean userAsserted,
      UUID loginId) {}

  public record SessionCommand(
      UUID id,
      UUID operationId,
      UUID sessionId,
      UUID userId,
      UUID attemptId,
      String action,
      String actionDigest,
      String state,
      Instant deadline,
      UUID permitId,
      String resultDigest) {}

  public Login owned(UUID userId, UUID id, boolean lock) {
    return jdbc.sql(
            "SELECT * FROM connection_login_operations WHERE id=:id AND user_id=:user"
                + (lock ? " FOR UPDATE" : ""))
        .param("id", id)
        .param("user", userId)
        .query(Login.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public Login get(UUID id) {
    return jdbc.sql("SELECT * FROM connection_login_operations WHERE id=:id")
        .param("id", id)
        .query(Login.class)
        .single();
  }

  public void insert(
      UUID id,
      UUID userId,
      UUID loginId,
      UUID connectionId,
      UUID taskId,
      UUID controller,
      String origin,
      String kind) {
    if (jdbc.sql(
                """
                SELECT count(*) FROM connection_login_operations WHERE connection_id=:connection
                AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED')
                """)
            .param("connection", connectionId)
            .query(Long.class)
            .single()
        > 0) {
      throw DomainException.conflict("LOGIN_IN_PROGRESS", "Continue the existing login operation");
    }
    if (jdbc.sql(
                """
                SELECT count(*) FROM browser_sessions WHERE connection_id=:connection AND binding_released_at IS NULL
                AND (CAST(:task AS uuid) IS NULL OR task_id IS DISTINCT FROM :task)
                """)
            .param("connection", connectionId)
            .param("task", taskId)
            .query(Long.class)
            .single()
        > 0) {
      throw DomainException.conflict(
          "CONNECTION_BUSY", "Connection is already used by another browser");
    }
    jdbc.sql(
            """
            INSERT INTO connection_login_operations(id,user_id,connection_id,task_id,controller_instance_id,
            expected_origin,kind,login_id) VALUES(:id,:user,:connection,:task,:controller,:origin,:kind,:login)
            """)
        .param("id", id)
        .param("user", userId)
        .param("connection", connectionId)
        .param("task", taskId)
        .param("controller", controller)
        .param("origin", origin)
        .param("kind", kind)
        .param("login", loginId)
        .update();
  }

  public List<UUID> pending() {
    return jdbc.sql(
            """
            SELECT l.id FROM connection_login_operations l JOIN application_users u ON u.id=l.user_id
            WHERE l.state='WAITING_RESOURCE' AND u.state='ACTIVE' AND l.expires_at>now()
            ORDER BY l.created_at,l.id LIMIT 20
            """)
        .query(UUID.class)
        .list();
  }

  public List<Login> pendingForConnection(UUID userId, UUID connectionId) {
    return jdbc.sql(
            """
            SELECT * FROM connection_login_operations WHERE user_id=:user AND connection_id=:connection
              AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED') ORDER BY id LIMIT 100 FOR UPDATE
            """)
        .param("user", userId)
        .param("connection", connectionId)
        .query(Login.class)
        .list();
  }

  public void assigned(UUID id, UUID sessionId) {
    jdbc.sql(
            """
            UPDATE connection_login_operations SET session_id=:session,state='STARTING',version=version+1 WHERE id=:id
            """)
        .param("id", id)
        .param("session", sessionId)
        .update();
  }

  public Optional<Login> forSession(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT * FROM connection_login_operations WHERE session_id=:session
            AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED')
            """)
        .param("session", sessionId)
        .query(Login.class)
        .optional();
  }

  public record SessionAccess(
      boolean loginRequired,
      boolean temporaryLogin,
      UUID currentProfileVersion,
      Long connectionVersion) {}

  public SessionAccess sessionAccess(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT coalesce(c.status='NEEDS_LOGIN',false) AND NOT EXISTS(
              SELECT 1 FROM connection_login_operations l WHERE l.session_id=s.id AND l.state='SUCCEEDED') login_required,
              EXISTS(SELECT 1 FROM connection_login_operations l WHERE l.session_id=s.id
                AND l.state='SUCCEEDED' AND l.save_mode='SESSION_ONLY') temporary_login,
                p.current_version_id current_profile_version,c.version connection_version
            FROM browser_sessions s LEFT JOIN connections c ON c.id=s.connection_id
              LEFT JOIN browser_profiles p ON p.connection_id=c.id AND p.user_id=s.user_id WHERE s.id=:id
            """)
        .param("id", sessionId)
        .query(SessionAccess.class)
        .single();
  }

  public void state(UUID id, String state) {
    jdbc.sql("UPDATE connection_login_operations SET state=:state,version=version+1 WHERE id=:id")
        .param("id", id)
        .param("state", state)
        .update();
  }

  public List<Login> reconciliationCandidates() {
    return jdbc.sql(
            """
            SELECT l.* FROM connection_login_operations l
            JOIN application_users u ON u.id=l.user_id
            LEFT JOIN browser_sessions s ON s.id=l.session_id
            LEFT JOIN application_logins a ON a.id=l.login_id
            WHERE (l.state NOT IN ('SUCCEEDED','FAILED','CANCELLED') AND
              (l.expires_at<=now() OR s.state='CLOSED' OR u.state<>'ACTIVE'
                OR a.id IS NULL OR a.state<>'ACTIVE' OR a.revoked_at IS NOT NULL OR a.expires_at<=now()))
              OR (l.state IN ('FAILED','CANCELLED') AND (l.session_id IS NULL OR s.state='CLOSED')
                AND EXISTS(SELECT 1 FROM operations o WHERE o.user_id=l.user_id
                  AND o.target_type='loginOperation' AND o.target_id=l.id AND o.state IN ('PENDING','RUNNING')))
            ORDER BY l.expires_at,l.id LIMIT 20
            """)
        .query(Login.class)
        .list();
  }

  public SessionCommand command(UUID id, boolean lock) {
    return jdbc.sql(
            "SELECT * FROM session_operation_commands WHERE id=:id" + (lock ? " FOR UPDATE" : ""))
        .param("id", id)
        .query(SessionCommand.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public boolean isSessionCommand(UUID id) {
    return jdbc.sql("SELECT count(*) FROM session_operation_commands WHERE id=:id")
            .param("id", id)
            .query(Long.class)
            .single()
        == 1;
  }

  public SessionCommand navigation(Login login, String url) {
    UUID id = UUID.randomUUID();
    var action = json.read(json.write(Map.of("type", "NAVIGATE", "url", url)));
    Instant deadline = Instant.now().plusSeconds(60);
    if (login.expiresAt().isBefore(deadline)) {
      deadline = login.expiresAt();
    }
    jdbc.sql(
            """
            INSERT INTO session_operation_commands(id,operation_id,session_id,user_id,attempt_id,action,
            action_digest,deadline) VALUES(:id,:operation,:session,:user,:attempt,CAST(:action AS jsonb),:digest,:deadline)
            """)
        .param("id", id)
        .param("operation", login.id())
        .param("session", login.sessionId())
        .param("user", login.userId())
        .param("attempt", UUID.randomUUID())
        .param("action", json.write(action))
        .param("digest", json.workerDigest(action))
        .param("deadline", Timestamp.from(deadline))
        .update();
    return command(id, false);
  }

  public void started(UUID id, UUID permitId) {
    int changed =
        jdbc.sql(
                """
                UPDATE session_operation_commands SET state='STARTED',permit_id=:permit,started_at=now()
                WHERE id=:id AND state='ACCEPTED' AND deadline>now()
                """)
            .param("id", id)
            .param("permit", permitId)
            .update();
    if (changed != 1) {
      throw DomainException.conflict(
          "START_PERMIT_DENIED", "Navigation permit is no longer available");
    }
  }

  public void result(UUID id, String digest, String state, String effect) {
    jdbc.sql(
            """
            UPDATE session_operation_commands SET state=:state,result_digest=:digest,effect_state=:effect,
            finished_at=now() WHERE id=:id
            """)
        .param("id", id)
        .param("digest", digest)
        .param("state", state)
        .param("effect", effect)
        .update();
  }

  public void completeRequested(UUID id, UUID operationId, LoginContracts.Complete input) {
    jdbc.sql(
            """
            UPDATE connection_login_operations SET state='VERIFYING',version=version+1,save_mode=:mode,
            user_asserted=:asserted,account_label=:label,
            continuation_intent=:intent,complete_operation_id=:operation WHERE id=:id
            """)
        .param("id", id)
        .param("operation", operationId)
        .param("mode", input.mode())
        .param("asserted", input.userAsserted())
        .param("label", input.accountLabel())
        .param("intent", input.continuationIntent())
        .update();
  }

  public void verification(UUID id, String result) {
    jdbc.sql(
            "UPDATE connection_login_operations SET verification_result=:result,version=version+1"
                + " WHERE id=:id")
        .param("id", id)
        .param("result", result)
        .update();
  }

  public void verificationRejected(UUID id) {
    completionFailed(id, "LOGIN_NOT_VERIFIED");
  }

  public void completionFailed(UUID id, String code) {
    jdbc.sql(
            """
            UPDATE operations SET state='FAILED',failure_code=:code,finished_at=now(),
            updated_at=now(),version=version+1
            WHERE id=(SELECT complete_operation_id FROM connection_login_operations WHERE id=:id)
            """)
        .param("id", id)
        .param("code", code)
        .update();
    state(id, "WAITING_USER");
  }

  public List<Login> saving() {
    return jdbc.sql(
            """
            SELECT l.* FROM connection_login_operations l JOIN application_users u ON u.id=l.user_id
              WHERE l.state='SAVING' AND u.state='ACTIVE' ORDER BY l.expires_at,l.id LIMIT 20
            """)
        .query(Login.class)
        .list();
  }

  public void profileVersion(UUID id, UUID versionId) {
    jdbc.sql("UPDATE connection_login_operations SET profile_version_id=:version WHERE id=:id")
        .param("id", id)
        .param("version", versionId)
        .update();
  }

  public void successful(Login login) {
    state(login.id(), "SUCCEEDED");
    if ("SAVE_PROFILE".equals(login.saveMode())) {
      jdbc.sql(
              """
              UPDATE connections SET status=:status,account_label=:label,
              last_checked_at=now(),account_evidence=:evidence,last_user_confirmed_at=now(),
              last_successful_login_at=CASE WHEN :evidence='AUTHENTICATED' THEN now() ELSE last_successful_login_at END,
              last_used_at=now(),version=version+1,updated_at=now() WHERE id=:id
              """)
          .param("id", login.connectionId())
          .param("label", login.accountLabel())
          .param("status", "SAVED")
          .param("evidence", login.verificationResult())
          .update();
    }
    jdbc.sql(
            """
            UPDATE user_action_requests SET status='ANSWERED',resolved_at=now(),version=version+1
            WHERE task_id=:task AND connection_id=:connection AND kind='LOGIN' AND status='OPEN'
            """)
        .param("task", login.taskId())
        .param("connection", login.connectionId())
        .update();
  }
}
