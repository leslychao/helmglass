package com.helmglass.browser.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;

/** Durable HUMAN browser command disposition; the operation ID is also its wire command ID. */
@Repository
public class HumanBrowserCommandRepository {
  public record HumanCommand(
      UUID id,
      UUID userId,
      UUID sessionId,
      UUID loginId,
      UUID controllerInstanceId,
      UUID attemptId,
      String action,
      String actionDigest,
      String scope,
      String executionMode,
      String state,
      UUID permitId,
      Instant deadline,
      String resultDigest) {}

  private final JdbcClient jdbc;
  private final JsonSupport json;

  public HumanBrowserCommandRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public boolean contains(UUID id) {
    return jdbc.sql("SELECT EXISTS(SELECT 1 FROM human_browser_commands WHERE id=:id)")
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  public boolean effectsKnown(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT NOT EXISTS(SELECT 1 FROM browser_sessions s JOIN tasks t ON t.id=s.task_id
            WHERE s.id=:session AND t.mutation_barrier) AND NOT EXISTS(
            SELECT 1 FROM operations WHERE target_id=:session AND human_checkpoint='UNKNOWN')
            """)
        .param("session", sessionId)
        .query(Boolean.class)
        .single();
  }

  public UUID owner(UUID id) {
    return jdbc.sql("SELECT user_id FROM human_browser_commands WHERE id=:id")
        .param("id", id)
        .query(UUID.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public HumanCommand lock(UUID id) {
    return jdbc.sql("SELECT * FROM human_browser_commands WHERE id=:id FOR UPDATE")
        .param("id", id)
        .query(HumanCommand.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public HumanCommand create(
      UUID id,
      UUID userId,
      UUID sessionId,
      UUID loginId,
      UUID controller,
      JsonNode action,
      Map<String, Object> scope,
      String mode,
      Instant deadline) {
    if (jdbc.sql(
            "SELECT EXISTS(SELECT 1 FROM human_browser_commands WHERE session_id=:id AND state IN"
                + " ('ACCEPTED','STARTED'))")
        .param("id", sessionId)
        .query(Boolean.class)
        .single()) {
      throw DomainException.conflict(
          "NAVIGATION_PENDING", "A previous navigation is still pending");
    }
    jdbc.sql(
            """
            INSERT INTO human_browser_commands(id,user_id,session_id,login_id,controller_instance_id,
            attempt_id,action,action_digest,scope,execution_mode,deadline)
            VALUES(:id,:user,:session,:login,:controller,:attempt,CAST(:action AS jsonb),:digest,
            CAST(:scope AS jsonb),:mode,:deadline)
            """)
        .param("id", id)
        .param("user", userId)
        .param("session", sessionId)
        .param("login", loginId)
        .param("controller", controller)
        .param("attempt", UUID.randomUUID())
        .param("action", json.write(action))
        .param("digest", json.workerDigest(action))
        .param("scope", json.write(scope))
        .param("mode", mode)
        .param("deadline", Timestamp.from(deadline))
        .update();
    if (!action.path("type").asString().equals("SNAPSHOT")) {
      jdbc.sql("UPDATE operations SET human_checkpoint='OPEN' WHERE id=:id")
          .param("id", id)
          .update();
    }
    return lock(id);
  }

  public void started(UUID id, UUID permitId) {
    if (jdbc.sql(
                """
                UPDATE human_browser_commands SET state='STARTED',permit_id=:permit,started_at=now()
                WHERE id=:id AND state='ACCEPTED' AND deadline>now()
                """)
            .param("id", id)
            .param("permit", permitId)
            .update()
        != 1) {
      throw DomainException.conflict(
          "START_PERMIT_DENIED", "HumanCommand already has an execution disposition");
    }
    jdbc.sql(
            "UPDATE operations SET state='RUNNING',version=version+1,updated_at=now() WHERE id=:id")
        .param("id", id)
        .update();
  }

  public void recordLateReceipt(UUID id, String digest) {
    jdbc.sql(
            "UPDATE human_browser_commands SET result_digest=:digest WHERE id=:id AND result_digest"
                + " IS NULL")
        .param("id", id)
        .param("digest", digest)
        .update();
  }

  public long finish(UUID id, String state, String effect, String digest, String code) {
    jdbc.sql(
            """
            UPDATE human_browser_commands SET state=:state,effect_state=:effect,
            result_digest=:digest,failure_code=:code,finished_at=now() WHERE id=:id
            """)
        .param("id", id)
        .param("state", state)
        .param("effect", effect)
        .param("digest", digest)
        .param("code", code)
        .update();
    return jdbc.sql(
            """
            UPDATE operations SET state=:state,human_checkpoint=CASE WHEN human_checkpoint IS NULL THEN NULL WHEN :unknown THEN 'UNKNOWN' ELSE 'CLOSED' END,
            progress=CASE WHEN :unknown THEN progress ELSE 100 END,failure_code=:code,
            version=version+1,updated_at=now(),finished_at=now() WHERE id=:id RETURNING version
            """)
        .param("id", id)
        .param("state", state.equals("UNKNOWN") ? "NEEDS_ATTENTION" : state)
        .param("unknown", state.equals("UNKNOWN"))
        .param("code", code)
        .query(Long.class)
        .single();
  }

  public void artifactTarget(UUID id, UUID artifactId) {
    jdbc.sql("UPDATE operations SET target_type='artifact',target_id=:artifact WHERE id=:id")
        .param("id", id)
        .param("artifact", artifactId)
        .update();
  }

  public void interruptTask(UUID sessionId) {
    jdbc.sql(
            """
            UPDATE tasks SET state='INTERRUPTED',mutation_barrier=true,failure_code='HUMAN_EFFECT_UNKNOWN',
            version=version+1,updated_at=now() WHERE id=(SELECT task_id FROM browser_sessions WHERE id=:id)
            AND state NOT IN ('COMPLETED','FAILED','CANCELLED','STOPPING')
            """)
        .param("id", sessionId)
        .update();
  }

  public List<UUID> pending() {
    return jdbc.sql(
            "SELECT id FROM human_browser_commands WHERE state='ACCEPTED' AND deadline>now() ORDER"
                + " BY created_at LIMIT 20")
        .query(UUID.class)
        .list();
  }

  public List<UUID> expired() {
    return jdbc.sql(
            "SELECT id FROM human_browser_commands WHERE state IN ('ACCEPTED','STARTED') AND"
                + " deadline<=now() ORDER BY deadline LIMIT 20")
        .query(UUID.class)
        .list();
  }
}
