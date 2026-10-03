package com.helmglass.command.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.command.api.CommandContracts;
import com.helmglass.identity.domain.AuthenticatedActor;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;

@Repository
public class CommandRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public CommandRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public record TaskAdmission(
      UUID id,
      UUID userId,
      long version,
      long instructionRevision,
      String state,
      boolean mutationBarrier,
      boolean confirmImportantActions,
      String startUrl) {}

  public TaskAdmission lockTask(UUID userId, UUID taskId) {
    return jdbc.sql(
            """
            SELECT id,user_id,version,instruction_revision,state,mutation_barrier,confirm_important_actions,start_url
            FROM tasks WHERE id=:task AND user_id=:user FOR UPDATE
            """)
        .param("task", taskId)
        .param("user", userId)
        .query(TaskAdmission.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void verifyBinding(UUID taskId, CommandContracts.Submit request, boolean readOnly) {
    record Binding(
        UUID id,
        long controlEpoch,
        long pageEpoch,
        long privacyEpoch,
        String ownerKind,
        String privacy) {}
    var binding =
        jdbc.sql(
                """
                SELECT s.id,l.epoch control_epoch,s.page_epoch,s.privacy_epoch,l.owner_kind,s.privacy
                FROM browser_sessions s JOIN browser_control_leases l ON l.session_id=s.id
                WHERE s.task_id=:task AND s.binding_released_at IS NULL
                """)
            .param("task", taskId)
            .query(Binding.class)
            .optional();
    if (binding.isEmpty()) {
      if (request.browserSessionId() != null) {
        throw DomainException.conflict("STALE_SESSION", "Browser session is no longer available");
      }
      return;
    }
    Binding current = binding.get();
    if (!current.id().equals(request.browserSessionId())
        || request.controlEpoch() == null
        || current.controlEpoch() != request.controlEpoch()
        || request.pageEpoch() == null
        || current.pageEpoch() != request.pageEpoch()
        || request.privacyEpoch() == null
        || current.privacyEpoch() != request.privacyEpoch()) {
      throw DomainException.conflict("STALE_BROWSER_BINDING", "Read the current browser state");
    }
    if (!current.privacy().equals("NORMAL")
        || (!readOnly && !current.ownerKind().equals("AGENT"))) {
      throw DomainException.conflict("CONTROL_UNAVAILABLE", "Browser is under human control");
    }
  }

  public void insert(
      AuthenticatedActor actor,
      UUID taskId,
      CommandContracts.Submit request,
      String kind,
      String digest,
      Instant deadline) {
    jdbc.sql(
            """
            INSERT INTO task_commands(id,task_id,user_id,client_grant_id,command_sequence,kind,payload,
            payload_hash,accepted_task_version,instruction_revision,expected_session_id,
            control_epoch,page_epoch,privacy_epoch,deadline)
            VALUES(:id,:task,:user,:grant,(SELECT coalesce(max(command_sequence),0)+1 FROM task_commands
            WHERE task_id=:task),:kind,CAST(:payload AS jsonb),:hash,:version,:revision,:session,
            :control,:page,:privacy,:deadline)
            """)
        .param("id", request.commandId())
        .param("task", taskId)
        .param("user", actor.userId())
        .param("grant", actor.grantId())
        .param("kind", kind)
        .param("payload", json.write(request.action()))
        .param("hash", digest)
        .param("version", request.expectedTaskVersion())
        .param("revision", request.instructionRevision())
        .param("session", request.browserSessionId())
        .param("control", request.controlEpoch())
        .param("page", request.pageEpoch())
        .param("privacy", request.privacyEpoch())
        .param("deadline", Timestamp.from(deadline))
        .update();
    jdbc.sql("UPDATE tasks SET state='QUEUED',version=version+1,updated_at=now() WHERE id=:task")
        .param("task", taskId)
        .update();
  }

  public void requireConfirmation(UUID taskId, UUID commandId, String hash) {
    jdbc.sql(
            """
            INSERT INTO user_action_requests(id,task_id,command_id,kind,intent_hash,prompt,expires_at)
            VALUES(:id,:task,:command,'CONFIRMATION',:hash,'Confirm the requested website change',
            now()+interval '5 minutes')
            """)
        .param("id", UUID.randomUUID())
        .param("task", taskId)
        .param("command", commandId)
        .param("hash", hash)
        .update();
    jdbc.sql("UPDATE tasks SET state='WAITING_USER',wait_reason='CONFIRMATION' WHERE id=:id")
        .param("id", taskId)
        .update();
  }

  public boolean outstanding(UUID taskId) {
    return jdbc.sql(
                """
                SELECT count(*) FROM task_commands WHERE task_id=:task
                AND state IN ('ACCEPTED','WAITING_RESOURCE','DISPATCHED','STARTED')
                """)
            .param("task", taskId)
            .query(Long.class)
            .single()
        > 0;
  }

  public boolean hasApproval(UUID taskId, UUID intentId, String hash) {
    return intentId != null
        && jdbc.sql(
                    """
                    SELECT count(*) FROM user_action_requests WHERE id=:id AND task_id=:task
                    AND kind='CONFIRMATION' AND status='ANSWERED' AND intent_hash=:hash
                    AND answer->>'decision'='APPROVE' AND expires_at>now()
                    """)
                .param("id", intentId)
                .param("task", taskId)
                .param("hash", hash)
                .query(Long.class)
                .single()
            == 1;
  }

  public Map<String, Object> get(UUID userId, UUID id) {
    return jdbc
        .sql(
            """
            SELECT c.id,c.task_id AS "taskId",c.version,c.kind,c.state,c.failure_code AS "failureCode",
            c.instruction_revision AS "instructionRevision",c.accepted_at AS "acceptedAt",
            a.id AS "attemptId",a.effect_state AS "effectState",a.result::text AS result
            FROM task_commands c LEFT JOIN LATERAL (SELECT * FROM command_attempts
            WHERE command_id=c.id ORDER BY attempt_no DESC LIMIT 1) a ON true
            WHERE c.id=:id AND c.user_id=:user
            """)
        .param("id", id)
        .param("user", userId)
        .query()
        .listOfRows()
        .stream()
        .findFirst()
        .map(
            row -> {
              Object result = row.get("result");
              if (result instanceof String encoded) {
                row.put("result", json.read(encoded));
              }
              return row;
            })
        .orElseThrow(DomainException::notFound);
  }

  public List<UUID> due() {
    return jdbc.sql(
            """
            SELECT c.id FROM task_commands c JOIN tasks t ON t.id=c.task_id
            JOIN application_users u ON u.id=c.user_id
            WHERE c.state IN ('ACCEPTED','WAITING_RESOURCE') AND c.next_eligible_at<=now()
            AND c.deadline>now() AND t.state='QUEUED' AND u.state='ACTIVE'
            ORDER BY row_number() OVER (PARTITION BY c.user_id ORDER BY c.accepted_at),c.accepted_at,c.id
            LIMIT 20
            """)
        .query(UUID.class)
        .list();
  }

  public record Dispatch(
      UUID commandId,
      UUID attemptId,
      UUID taskId,
      UUID userId,
      UUID sessionId,
      UUID workerId,
      UUID workerBootId,
      long allocationEpoch,
      long controlEpoch,
      long pageEpoch,
      long privacyEpoch,
      long policyVersion,
      long instructionRevision,
      String payload,
      String payloadHash,
      Instant deadline,
      UUID connectionId,
      Long scopeVersion) {}

  public Dispatch dispatch(UUID commandId) {
    return jdbc.sql(
            """
            SELECT c.id command_id,a.id attempt_id,c.task_id,c.user_id,a.session_id,a.worker_id,
            s.worker_boot_id,s.allocation_epoch,l.epoch control_epoch,s.page_epoch,s.privacy_epoch,
            p.version policy_version,c.instruction_revision,c.payload::text,c.payload_hash,c.deadline,
            s.connection_id,cn.scope_version
            FROM task_commands c JOIN command_attempts a ON a.command_id=c.id
            JOIN browser_sessions s ON s.id=a.session_id
            JOIN browser_control_leases l ON l.session_id=s.id
            JOIN user_policies p ON p.user_id=c.user_id
            LEFT JOIN connections cn ON cn.id=s.connection_id
            WHERE c.id=:id ORDER BY a.attempt_no DESC LIMIT 1
            """)
        .param("id", commandId)
        .query(Dispatch.class)
        .single();
  }

  public record StartAuthorization(
      String controlOwner,
      String controlState,
      String sessionState,
      String privacy,
      Instant leaseExpiresAt,
      Instant budgetDeadlineAt,
      boolean grantActive,
      Integer commandLimit,
      Integer executionLimit,
      long startedCommands,
      long executionMs) {}

  public StartAuthorization startAuthorization(UUID commandId) {
    return jdbc.sql(
            """
            SELECT l.owner_kind control_owner,l.state control_state,s.state session_state,s.privacy,
            l.expires_at lease_expires_at,s.budget_deadline_at,
            (c.client_grant_id IS NULL OR g.status='ACTIVE') grant_active,
            p.max_commands_per_run command_limit,p.max_active_seconds_per_run execution_limit,
            (SELECT count(*) FROM task_commands started WHERE started.task_id=c.task_id
              AND started.started_at IS NOT NULL) started_commands,
            (SELECT coalesce(sum(u.execution_ms),0) FROM session_usage_checkpoints u JOIN browser_sessions bs
              ON bs.id=u.session_id WHERE bs.task_id=c.task_id) execution_ms
            FROM task_commands c JOIN command_attempts a ON a.command_id=c.id
            JOIN browser_sessions s ON s.id=a.session_id JOIN browser_control_leases l ON l.session_id=s.id
            JOIN user_policies p ON p.user_id=c.user_id LEFT JOIN client_grants g ON g.id=c.client_grant_id
            WHERE c.id=:id ORDER BY a.attempt_no DESC LIMIT 1
            """)
        .param("id", commandId)
        .query(StartAuthorization.class)
        .single();
  }

  public void started(UUID commandId, UUID attemptId, UUID permitId) {
    jdbc.sql(
            """
            UPDATE command_attempts SET state='STARTED',start_permit_id=:permit,started_at=now(),
            version=version+1 WHERE id=:id AND state='DISPATCHED'
            """)
        .param("permit", permitId)
        .param("id", attemptId)
        .update();
    jdbc.sql(
            "UPDATE task_commands SET state='STARTED',started_at=now(),version=version+1 WHERE"
                + " id=:id")
        .param("id", commandId)
        .update();
    jdbc.sql(
            """
            UPDATE tasks SET state='RUNNING',started_at=coalesce(started_at,now()),updated_at=now(),
            version=version+1 WHERE id=(SELECT task_id FROM task_commands WHERE id=:id)
            """)
        .param("id", commandId)
        .update();
  }

  public String commandState(UUID commandId) {
    return jdbc.sql("SELECT state FROM task_commands WHERE id=:id FOR UPDATE")
        .param("id", commandId)
        .query(String.class)
        .single();
  }

  public String resultDigest(UUID attemptId) {
    return jdbc.sql("SELECT result_digest FROM command_attempts WHERE id=:id FOR UPDATE")
        .param("id", attemptId)
        .query(String.class)
        .optional()
        .orElse(null);
  }

  public void result(
      Dispatch dispatch, String status, String effect, String digest, JsonNode result) {
    jdbc.sql(
            """
            UPDATE command_attempts SET state=:state,effect_state=:effect,result_digest=:digest,
            result=CAST(:result AS jsonb),finished_at=now(),last_report_at=now(),version=version+1 WHERE id=:id
            """)
        .param("state", status)
        .param("effect", effect)
        .param("digest", digest)
        .param("result", json.write(result))
        .param("id", dispatch.attemptId())
        .update();
    int updated =
        jdbc.sql(
                "UPDATE task_commands SET state=:state,finished_at=now(),version=version+1 WHERE"
                    + " id=:id AND state<>'CANCELLED'")
            .param("state", status)
            .param("id", dispatch.commandId())
            .update();
    if (updated == 0) {
      return;
    }
    String next = status.equals("UNKNOWN") ? "INTERRUPTED" : "WAITING_AGENT";
    jdbc.sql(
            """
            UPDATE tasks SET state=CASE WHEN state='STOPPING' THEN state
            WHEN :unknown OR mutation_barrier THEN 'INTERRUPTED'
            WHEN wait_reason='CONNECTION_REQUIRED' THEN 'WAITING_USER'
            WHEN state='PAUSING' THEN 'PAUSED'
            ELSE :next END,mutation_barrier=mutation_barrier OR :unknown,version=version+1,updated_at=now()
            WHERE id=:id
            """)
        .param("next", next)
        .param("unknown", status.equals("UNKNOWN"))
        .param("id", dispatch.taskId())
        .update();
  }
}
