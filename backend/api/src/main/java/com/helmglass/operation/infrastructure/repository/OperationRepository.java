package com.helmglass.operation.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class OperationRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final ChangeRepository changes;

  public OperationRepository(JdbcClient jdbc, JsonSupport json, ChangeRepository changes) {
    this.jdbc = jdbc;
    this.json = json;
    this.changes = changes;
  }

  public record OperationView(
      UUID id,
      String kind,
      String targetType,
      UUID targetId,
      String state,
      long version,
      int progress,
      String failureCode,
      Instant createdAt,
      Instant updatedAt,
      String reconciliationOutcome,
      UUID sourceCommandId,
      UUID sourceHumanOperationId) {}

  public Optional<MutationReceipt> replay(
      AuthenticatedActor actor, String kind, MutationContext context, Object payload) {
    record Existing(String payloadHash, String response) {}
    Optional<Existing> existing =
        jdbc.sql(
                """
                SELECT payload_hash,response::text FROM idempotency_records
                WHERE user_id=:user AND client_id=:client AND operation_kind=:kind AND key=:key
                """)
            .param("user", actor.userId())
            .param("client", actor.clientId())
            .param("kind", kind)
            .param("key", context.key())
            .query(Existing.class)
            .optional();
    if (existing.isEmpty()) {
      return Optional.empty();
    }
    if (!existing.get().payloadHash().equals(json.digest(payload))) {
      throw DomainException.conflict("IDEMPOTENCY_MISMATCH", "Key belongs to a different request");
    }
    return Optional.of(json.read(existing.get().response(), MutationReceipt.class));
  }

  public MutationReceipt save(
      AuthenticatedActor actor,
      String kind,
      MutationContext context,
      Object payload,
      String type,
      UUID targetId,
      long version,
      boolean complete) {
    return saveWithId(
        UUID.randomUUID(), actor, kind, context, payload, type, targetId, version, complete);
  }

  public MutationReceipt saveWithId(
      UUID id,
      AuthenticatedActor actor,
      String kind,
      MutationContext context,
      Object payload,
      String type,
      UUID targetId,
      long version,
      boolean complete) {
    MutationReceipt receipt =
        new MutationReceipt(
            id,
            new MutationReceipt.ResourceReference(type, targetId, version),
            "/api/v1/operations/" + id,
            context.requestId());
    jdbc.sql(
            """
            INSERT INTO operations(id,user_id,kind,target_type,target_id,state,request_id,input_hash,
            progress,finished_at) VALUES(:id,:user,:kind,:type,:target,:state,:request,:hash,:progress,
            CASE WHEN :complete THEN now() ELSE NULL END)
            """)
        .param("id", id)
        .param("user", actor.userId())
        .param("kind", kind)
        .param("type", type)
        .param("target", targetId)
        .param("state", complete ? "SUCCEEDED" : "PENDING")
        .param("request", context.requestId())
        .param("hash", json.digest(payload))
        .param("progress", complete ? 100 : 0)
        .param("complete", complete)
        .update();
    jdbc.sql(
            """
            INSERT INTO idempotency_records(user_id,client_id,operation_kind,key,payload_hash,
            operation_id,response,http_status) VALUES(:user,:client,:kind,:key,:hash,:operation,
            CAST(:response AS jsonb),:status)
            """)
        .param("user", actor.userId())
        .param("client", actor.clientId())
        .param("kind", kind)
        .param("key", context.key())
        .param("hash", json.digest(payload))
        .param("operation", id)
        .param("response", json.write(receipt))
        .param("status", complete ? 200 : 202)
        .update();
    changes.changed(actor.userId(), "operations", id, 1);
    return receipt;
  }

  /** Creates a durable system operation without fabricating an authenticated client request. */
  public UUID createSystem(UUID userId, String kind, String targetType, UUID targetId) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO operations(id,user_id,kind,target_type,target_id,state,request_id,input_hash)
            VALUES(:id,:user,:kind,:type,:target,'PENDING',:request,:hash)
            """)
        .param("id", id)
        .param("user", userId)
        .param("kind", kind)
        .param("type", targetType)
        .param("target", targetId)
        .param("request", UUID.randomUUID())
        .param("hash", json.digest(targetId))
        .update();
    changes.changed(userId, "operations", id, 1);
    return id;
  }

  public MutationReceipt bindExisting(
      AuthenticatedActor actor,
      String kind,
      MutationContext context,
      Object payload,
      UUID operationId,
      String type,
      UUID targetId,
      long version) {
    MutationReceipt receipt =
        new MutationReceipt(
            operationId,
            new MutationReceipt.ResourceReference(type, targetId, version),
            "/api/v1/operations/" + operationId,
            context.requestId());
    jdbc.sql(
            """
            INSERT INTO idempotency_records(user_id,client_id,operation_kind,key,payload_hash,
            operation_id,response,http_status) VALUES(:user,:client,:kind,:key,:hash,:operation,
            CAST(:response AS jsonb),200)
            """)
        .param("user", actor.userId())
        .param("client", actor.clientId())
        .param("kind", kind)
        .param("key", context.key())
        .param("hash", json.digest(payload))
        .param("operation", operationId)
        .param("response", json.write(receipt))
        .update();
    return receipt;
  }

  public OperationView owned(UUID userId, UUID id) {
    return jdbc.sql(
            """
            SELECT id,kind,target_type,target_id,state,version,progress,failure_code,created_at,updated_at,
            reconciliation_outcome,source_command_id,source_human_operation_id
            FROM operations WHERE id=:id AND user_id=:user
            """)
        .param("id", id)
        .param("user", userId)
        .query(OperationView.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public MutationReceipt lookup(AuthenticatedActor actor, String kind, String key) {
    return jdbc.sql(
            """
            SELECT response::text FROM idempotency_records WHERE user_id=:user AND client_id=:client
            AND operation_kind=:kind AND key=:key
            """)
        .param("user", actor.userId())
        .param("client", actor.clientId())
        .param("kind", kind)
        .param("key", key)
        .query(String.class)
        .optional()
        .map(value -> json.read(value, MutationReceipt.class))
        .orElseThrow(DomainException::notFound);
  }

  private record Transition(UUID id, UUID userId, long version) {}

  public void completeControl(UUID operationId) {
    var changed =
        jdbc.sql(
                """
                UPDATE operations SET state='SUCCEEDED',progress=100,finished_at=now(),updated_at=now(),
                  version=version+1 WHERE id=:id AND state IN ('PENDING','RUNNING')
                  AND (kind LIKE 'control.%' OR kind LIKE 'tasks.continue:%') RETURNING id,user_id,version
                """)
            .param("id", operationId)
            .query(Transition.class)
            .optional();
    changed.ifPresent(this::changed);
  }

  public void expireClaim(UUID operationId) {
    var expired =
        jdbc.sql(
                """
                UPDATE operations SET state='FAILED',failure_code='CLAIM_EXPIRED',finished_at=now(),
                  updated_at=now(),version=version+1 WHERE id=:id AND state IN ('PENDING','RUNNING')
                  AND kind LIKE 'tasks.continue:%' RETURNING id,user_id,version
                """)
            .param("id", operationId)
            .query(Transition.class)
            .optional();
    expired.ifPresent(this::changed);
  }

  public void completeForTarget(UUID targetId, String kind) {
    var completed =
        jdbc.sql(
                """
                UPDATE operations SET state='SUCCEEDED',version=version+1,progress=100,updated_at=now(),
                  finished_at=now() WHERE target_id=:target AND kind=:kind AND state IN ('PENDING','RUNNING')
                  RETURNING id,user_id,version
                """)
            .param("target", targetId)
            .param("kind", kind)
            .query(Transition.class)
            .list();
    completed.forEach(this::changed);
  }

  public void completeCommandTarget(UUID commandId, String kind, String state) {
    var completed =
        jdbc.sql(
                """
                UPDATE operations o SET state=:state,version=o.version+1,progress=100,updated_at=now(),
                  finished_at=now(),failure_code=c.failure_code FROM task_commands c
                  WHERE o.target_id=:command AND c.id=:command AND o.kind=:kind
                  AND o.state IN ('PENDING','RUNNING') RETURNING o.id,o.user_id,o.version
                """)
            .param("command", commandId)
            .param("kind", kind)
            .param("state", state)
            .query(Transition.class)
            .list();
    completed.forEach(this::changed);
  }

  public void finishLogin(UUID userId, UUID loginId, String state, String failureCode) {
    var completed =
        jdbc.sql(
                """
                UPDATE operations SET state=:state,failure_code=:code,progress=100,
                  finished_at=now(),updated_at=now(),version=version+1
                WHERE user_id=:user AND target_type='loginOperation' AND target_id=:id
                  AND state IN ('PENDING','RUNNING') AND kind NOT LIKE 'login.cancel:%'
                RETURNING id,user_id,version
                """)
            .param("user", userId)
            .param("id", loginId)
            .param("state", state)
            .param("code", failureCode)
            .query(Transition.class)
            .list();
    completed.forEach(this::changed);
  }

  private void changed(Transition transition) {
    changes.changed(transition.userId(), "operations", transition.id(), transition.version());
  }
}
