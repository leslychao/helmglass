package com.helmglass.task.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.task.api.ActionRequestContracts;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ActionRequestRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public ActionRequestRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public record ActionRequest(UUID id, UUID taskId, UUID commandId, String kind, String intentHash,
      String prompt, long version, String status, Instant expiresAt, String context) {}

  public ActionRequest lockOwned(UUID userId, UUID id) {
    return jdbc.sql("""
        SELECT r.id,r.task_id,r.command_id,r.kind,r.intent_hash,r.prompt,r.version,r.status,
        r.expires_at,r.context::text AS context FROM user_action_requests r JOIN tasks t ON t.id=r.task_id
        WHERE r.id=:id AND t.user_id=:user FOR UPDATE OF r
        """).param("id", id).param("user", userId).query(ActionRequest.class).optional()
        .orElseThrow(DomainException::notFound);
  }

  public void answer(ActionRequest request, ActionRequestContracts.Answer input) {
    jdbc.sql("""
        UPDATE user_action_requests SET answer=CAST(:answer AS jsonb),status='ANSWERED',
        version=version+1,resolved_at=now() WHERE id=:id
        """).param("id", request.id()).param("answer", json.write(input)).update();
    boolean rejected = input.decision().equals("DENY");
    if (rejected && request.commandId() != null) {
      jdbc.sql("""
          UPDATE task_commands SET state='CANCELLED',failure_code='USER_DENIED',finished_at=now(),
          version=version+1 WHERE id=:id AND state='ACCEPTED'
          """).param("id", request.commandId()).update();
    }
    String state = request.commandId() == null || rejected ? "WAITING_AGENT" : "QUEUED";
    jdbc.sql("UPDATE tasks SET state=:state,wait_reason=NULL,version=version+1,updated_at=now() WHERE id=:id")
        .param("id", request.taskId()).param("state", state).update();
  }
}
