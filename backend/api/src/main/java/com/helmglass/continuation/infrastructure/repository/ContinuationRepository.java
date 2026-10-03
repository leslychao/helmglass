package com.helmglass.continuation.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.realtime.domain.ChatPresentation;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ContinuationRepository {
  private static final String CURRENT =
      "'WAITING_RESULT','READY','DISPATCHING','DELIVERED','DELIVERY_UNKNOWN','CLAIMED','BLOCKED'";
  private final JdbcClient jdbc;

  public ContinuationRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record Continuation(
      UUID id,
      UUID taskId,
      UUID userId,
      UUID sourceOperationId,
      UUID sourceCommandId,
      long instructionRevision,
      UUID sessionId,
      String state,
      String reason,
      String mode,
      UUID viewScopeId,
      long bindingVersion,
      String destinationClientId,
      UUID destinationGrantId,
      Long destinationGrantVersion,
      Long destinationAccessEpoch,
      Long controlEpoch,
      Long pageEpoch,
      UUID claimId,
      String claimClientId,
      UUID claimGrantId,
      Long claimControlEpoch,
      Instant claimExpiresAt,
      Instant expiresAt,
      long version,
      Instant dispatchNotBefore,
      String blockReason,
      UUID dispatchId,
      UUID dispatchViewerInstanceId,
      Long dispatchPresentationRevision,
      String dispatchText,
      Instant dispatchExpiresAt,
      String deliveryOutcome,
      Instant deliveredAt) {}

  public record TaskBinding(
      UUID id,
      UUID userId,
      long instructionRevision,
      String state,
      boolean mutationBarrier,
      boolean continuationConsent,
      UUID continuationViewScopeId,
      long continuationBindingVersion,
      String originCorrelation,
      String originClientId,
      UUID originGrantId) {}

  public TaskBinding lockTask(UUID taskId) {
    return jdbc.sql(
            """
            SELECT id,user_id,instruction_revision,state,mutation_barrier,continuation_consent,
              continuation_view_scope_id,continuation_binding_version,origin_correlation,
              origin_client_id,origin_grant_id FROM tasks WHERE id=:id FOR UPDATE
            """)
        .param("id", taskId)
        .query(TaskBinding.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public UUID owner(UUID taskId) {
    return jdbc.sql("SELECT user_id FROM tasks WHERE id=:id")
        .param("id", taskId)
        .query(UUID.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public Optional<Continuation> current(UUID taskId) {
    return jdbc.sql(
            "SELECT * FROM task_continuations WHERE task_id=:task AND state IN ("
                + CURRENT
                + ") FOR UPDATE")
        .param("task", taskId)
        .query(Continuation.class)
        .optional();
  }

  public Continuation get(UUID id) {
    return jdbc.sql("SELECT * FROM task_continuations WHERE id=:id")
        .param("id", id)
        .query(Continuation.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public Optional<Continuation> source(UUID taskId, UUID operation, UUID command) {
    return jdbc.sql(
            """
            SELECT * FROM task_continuations WHERE task_id=:task
              AND instruction_revision=(SELECT instruction_revision FROM tasks WHERE id=:task)
              AND (source_operation_id=:operation OR source_command_id=:command)
            """)
        .param("task", taskId)
        .param("operation", operation)
        .param("command", command)
        .query(Continuation.class)
        .optional();
  }

  public Continuation dispatch(UUID dispatchId) {
    return jdbc.sql("SELECT * FROM task_continuations WHERE dispatch_id=:dispatch")
        .param("dispatch", dispatchId)
        .query(Continuation.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void registerOrigin(UUID taskId, String clientId, UUID grantId, String correlation) {
    jdbc.sql(
            """
            UPDATE tasks SET origin_correlation=:correlation,origin_client_id=:client,origin_grant_id=:grant
            WHERE id=:task AND origin_correlation IS NULL
            """)
        .param("task", taskId)
        .param("client", clientId)
        .param("grant", grantId)
        .param("correlation", correlation)
        .update();
  }

  public Optional<Continuation> bind(
      TaskBinding task, ChatPresentation slot, boolean messageVerified) {
    jdbc.sql(
            """
            UPDATE tasks SET continuation_view_scope_id=:scope,
              continuation_preference=CASE WHEN :verified THEN 'WIDGET_RETURN' ELSE 'MANUAL' END
            WHERE id=:task AND continuation_view_scope_id IS NULL
            """)
        .param("task", task.id())
        .param("scope", slot.id())
        .param("verified", messageVerified)
        .update();
    return jdbc.sql(
            """
            UPDATE task_continuations SET view_scope_id=:scope,destination_client_id=:client,
              destination_grant_id=:grant,destination_grant_version=:grantVersion,
              destination_access_epoch=:epoch,mode=CASE WHEN :automatic THEN 'WIDGET_RETURN' ELSE 'MANUAL' END,
              version=version+1
            WHERE task_id=:task AND state IN ('WAITING_RESULT','READY') AND view_scope_id IS NULL
              AND binding_version=:binding AND instruction_revision=:revision AND expires_at>now() RETURNING *
            """)
        .param("task", task.id())
        .param("scope", slot.id())
        .param("client", slot.clientId())
        .param("grant", slot.grantId())
        .param("grantVersion", slot.grantVersion())
        .param("epoch", slot.accessEpoch())
        .param("automatic", messageVerified && task.continuationConsent())
        .param("binding", task.continuationBindingVersion())
        .param("revision", task.instructionRevision())
        .query(Continuation.class)
        .optional();
  }

  public Continuation waitForResult(
      TaskBinding task, UUID operation, UUID command, String reason, boolean widgetEnabled) {
    return jdbc.sql(
            """
            INSERT INTO task_continuations(id,task_id,user_id,source_operation_id,source_command_id,
              instruction_revision,session_id,reason,mode,view_scope_id,binding_version,expires_at,
              destination_client_id,destination_grant_id,destination_grant_version,destination_access_epoch,
              control_epoch,page_epoch,state)
            SELECT :id,t.id,t.user_id,:operation,:command,t.instruction_revision,s.id,:reason,
              CASE WHEN :widget AND t.continuation_consent AND v.id IS NOT NULL THEN 'WIDGET_RETURN' ELSE 'MANUAL' END,
              v.id,t.continuation_binding_version,
              least(now()+interval '2 hours',coalesce(s.budget_deadline_at,now()+interval '2 hours')),
              v.client_id,v.grant_id,v.grant_version,v.access_epoch,l.epoch,s.page_epoch,'WAITING_RESULT'
            FROM tasks t LEFT JOIN chat_view_slots v ON v.id=t.continuation_view_scope_id
              AND v.retired_at IS NULL
            LEFT JOIN browser_sessions s ON s.task_id=t.id AND s.binding_released_at IS NULL
            LEFT JOIN browser_control_leases l ON l.session_id=s.id WHERE t.id=:task RETURNING *
            """)
        .param("id", UUID.randomUUID())
        .param("task", task.id())
        .param("operation", operation)
        .param("command", command)
        .param("reason", reason)
        .param("widget", widgetEnabled)
        .query(Continuation.class)
        .single();
  }

  public void consent(UUID taskId, boolean consent) {
    jdbc.sql("UPDATE tasks SET continuation_consent=:consent WHERE id=:task")
        .param("task", taskId)
        .param("consent", consent)
        .update();
  }

  public Optional<Continuation> enableWaitingDelivery(UUID taskId) {
    return jdbc.sql(
            """
            UPDATE task_continuations SET mode='WIDGET_RETURN',version=version+1
            WHERE task_id=:task AND state='WAITING_RESULT' AND mode='MANUAL'
              AND view_scope_id IS NOT NULL AND destination_grant_id IS NOT NULL
            RETURNING *
            """)
        .param("task", taskId)
        .query(Continuation.class)
        .optional();
  }

  public String sourceState(Continuation value) {
    if (value.sourceCommandId() != null) {
      return jdbc.sql("SELECT state FROM task_commands WHERE id=:id")
          .param("id", value.sourceCommandId())
          .query(String.class)
          .single();
    }
    return jdbc.sql("SELECT state FROM operations WHERE id=:id")
        .param("id", value.sourceOperationId())
        .query(String.class)
        .single();
  }

  public boolean commandNeedsContinuation(UUID commandId) {
    return jdbc.sql("SELECT kind<>'OBSERVE' FROM task_commands WHERE id=:id")
        .param("id", commandId)
        .query(Boolean.class)
        .single();
  }

  public Continuation ready(UUID id, Instant dispatchNotBefore) {
    return jdbc.sql(
            """
            UPDATE task_continuations c SET state='READY',ready_at=now(),dispatch_not_before=:due,
              session_id=s.id,control_epoch=l.epoch,page_epoch=s.page_epoch,
              expires_at=least(c.expires_at,coalesce(s.budget_deadline_at,c.expires_at)),version=c.version+1
            FROM tasks t LEFT JOIN browser_sessions s ON s.task_id=t.id AND s.binding_released_at IS NULL
              LEFT JOIN browser_control_leases l ON l.session_id=s.id
            WHERE c.id=:id AND t.id=c.task_id RETURNING c.*
            """)
        .param("id", id)
        .param("due", Timestamp.from(dispatchNotBefore))
        .query(Continuation.class)
        .single();
  }

  public Continuation transition(UUID id, String state, String reason) {
    return jdbc.sql(
            """
            UPDATE task_continuations SET state=:state,block_reason=:reason,version=version+1
              WHERE id=:id RETURNING *
            """)
        .param("id", id)
        .param("state", state)
        .param("reason", reason)
        .query(Continuation.class)
        .single();
  }

  public Continuation prepare(
      Continuation value, UUID viewer, long revision, String text, Instant expiry) {
    return jdbc.sql(
            """
            UPDATE task_continuations SET state='DISPATCHING',dispatch_id=:dispatch,
              dispatch_viewer_instance_id=:viewer,dispatch_presentation_revision=:revision,
              dispatch_text=:text,dispatch_expires_at=:expiry,dispatched_at=now(),version=version+1
              WHERE id=:id AND state='READY' AND dispatch_id IS NULL RETURNING *
            """)
        .param("id", value.id())
        .param("dispatch", UUID.randomUUID())
        .param("viewer", viewer)
        .param("revision", revision)
        .param("text", text)
        .param("expiry", Timestamp.from(expiry))
        .query(Continuation.class)
        .single();
  }

  public Continuation delivery(Continuation value, String outcome, String state, String reason) {
    return jdbc.sql(
            """
            UPDATE task_continuations SET delivery_outcome=:outcome,state=:state,block_reason=:reason,
              delivered_at=CASE WHEN :outcome='DELIVERED' THEN coalesce(delivered_at,now()) ELSE delivered_at END,
              version=version+1 WHERE id=:id RETURNING *
            """)
        .param("id", value.id())
        .param("outcome", outcome)
        .param("state", state)
        .param("reason", reason)
        .query(Continuation.class)
        .single();
  }

  public Continuation claim(
      UUID id, UUID claim, String client, UUID grant, Long epoch, Instant expiry) {
    return jdbc.sql(
            """
            UPDATE task_continuations SET state='CLAIMED',claim_id=:claim,claim_client_id=:client,
              claim_grant_id=:grant,claim_control_epoch=:epoch,claimed_at=now(),claim_expires_at=:expiry,
              version=version+1 WHERE id=:id RETURNING *
            """)
        .param("id", id)
        .param("claim", claim)
        .param("client", client)
        .param("grant", grant)
        .param("epoch", epoch)
        .param("expiry", Timestamp.from(expiry))
        .query(Continuation.class)
        .single();
  }

  public Continuation consume(UUID id) {
    return jdbc.sql(
            """
            UPDATE task_continuations SET state='CONSUMED',consumed_at=now(),version=version+1
              WHERE id=:id RETURNING *
            """)
        .param("id", id)
        .query(Continuation.class)
        .single();
  }

  public Continuation claimRecovered(UUID id, long epoch) {
    return jdbc.sql(
            """
            UPDATE task_continuations SET state='READY',block_reason=NULL,control_epoch=:epoch,
              claim_id=NULL,claim_client_id=NULL,claim_grant_id=NULL,claim_control_epoch=NULL,
              claim_expires_at=NULL,dispatch_not_before=now(),version=version+1 WHERE id=:id RETURNING *
            """)
        .param("id", id)
        .param("epoch", epoch)
        .query(Continuation.class)
        .single();
  }

  public List<Continuation> cancel(UUID taskId) {
    return jdbc.sql(
            "UPDATE task_continuations SET state='CANCELLED',version=version+1 WHERE task_id=:task"
                + " AND state IN ("
                + CURRENT
                + ") RETURNING *")
        .param("task", taskId)
        .query(Continuation.class)
        .list();
  }

  public List<Continuation> due() {
    return jdbc.sql(
            "SELECT * FROM task_continuations WHERE state IN ("
                + CURRENT
                + ") AND (expires_at<=now() OR (state='CLAIMED' AND claim_expires_at<=now()) OR"
                + " (state='DISPATCHING' AND dispatch_expires_at<=now())) ORDER BY expires_at,id"
                + " LIMIT 50")
        .query(Continuation.class)
        .list();
  }

  public Map<String, Object> snapshot(UUID taskId) {
    var rows =
        jdbc.sql(
                """
                SELECT id,state,reason,mode,version,instruction_revision AS "instructionRevision",
                  expires_at AS "expiresAt",session_id AS "observedSessionId",delivered_at AS "deliveredAt",
                  dispatch_not_before AS "dispatchNotBefore",dispatch_id AS "dispatchId",
                  delivery_outcome AS "deliveryOutcome",
                  CASE WHEN block_reason IS NOT NULL THEN block_reason
                    WHEN mode='MANUAL' AND view_scope_id IS NULL THEN 'CHAT_BINDING_UNVERIFIED'
                    WHEN mode='MANUAL' THEN 'HOST_MESSAGE_UNVERIFIED' ELSE NULL END AS "limitationReason",
                  CASE WHEN dispatch_id IS NOT NULL THEN dispatch_text ELSE NULL END AS "manualMessage"
                FROM task_continuations WHERE task_id=:task ORDER BY created_at DESC,id DESC LIMIT 1
                """)
            .param("task", taskId)
            .query()
            .listOfRows();
    return rows.isEmpty() ? null : rows.getFirst();
  }
}
