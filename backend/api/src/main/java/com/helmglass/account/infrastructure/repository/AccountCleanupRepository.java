package com.helmglass.account.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Durable account cleanup progress; external effects are coordinated by the account owner. */
@Repository
public class AccountCleanupRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public AccountCleanupRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public record Identity(UUID userId, String subject, String state, long version,
      UUID operationId, long desiredVersion, long completedVersion, int attempts) {}

  public record Purge(UUID id, UUID userId, String status, Instant restoreUntil,
      UUID purgeOperationId, Instant purgeStartedAt, String ledgerChecksum,
      String identityHash, String subject) {}

  public record Stage(String itemKey, String phase, String state) {}

  public record CleanupOperation(UUID id, String kind, String state, long version, UUID targetId,
      UUID targetUserId) {}

  public CleanupOperation lockOperation(UUID id) {
    return jdbc.sql("""
        SELECT o.id,o.kind,o.state,o.version,o.target_id,
        coalesce(d.user_id,j.user_id,o.target_id) target_user_id FROM operations o
        LEFT JOIN account_deletion_requests d ON d.id=o.target_id
        LEFT JOIN account_identity_jobs j ON j.operation_id=o.id
        WHERE o.id=:id AND (o.kind='ACCOUNT_PURGE' OR o.kind LIKE 'admin.account.%'
          OR o.kind LIKE 'admin.deletion.cancel:%') FOR UPDATE OF o
        """).param("id", id).query(CleanupOperation.class).optional().orElseThrow(DomainException::notFound);
  }

  public Map<String, Object> operation(UUID id) {
    var result = jdbc.sql("""
        SELECT id,kind,state,version,progress,failure_code AS "failureCode",updated_at AS "updatedAt"
        FROM operations WHERE id=:id AND (kind='ACCOUNT_PURGE' OR kind LIKE 'admin.%')
        """).param("id", id).query().listOfRows().stream().findFirst().orElseThrow(DomainException::notFound);
    result.put("items", jdbc.sql("""
        SELECT item_key AS "key",phase,state,updated_at AS "updatedAt" FROM operation_items
        WHERE operation_id=:id ORDER BY item_key LIMIT 100
        """).param("id", id).query().listOfRows());
    long count = jdbc.sql("SELECT count(*) FROM operation_items WHERE operation_id=:id")
        .param("id", id).query(Long.class).single();
    result.put("totalItems", count);
    result.put("hasMoreItems", count > 100);
    return result;
  }

  public void retry(CleanupOperation operation) {
    jdbc.sql("""
        UPDATE operations SET state='RUNNING',attempts=0,failure_code=NULL,updated_at=now(),version=version+1
        WHERE id=:id
        """).param("id", operation.id()).update();
    if (operation.kind().equals("ACCOUNT_PURGE")) {
      ready(operation.targetId());
    } else {
      jdbc.sql("""
          UPDATE account_identity_jobs SET attempts=0,failure_code=NULL,next_attempt_at=now()
          WHERE operation_id=:id
          """).param("id", operation.id()).update();
    }
  }

  public void scheduleIdentity(UUID userId, UUID operationId) {
    jdbc.sql("""
        UPDATE operations SET state='CANCELLED',failure_code='SUPERSEDED',updated_at=now(),version=version+1
        WHERE id=(SELECT operation_id FROM account_identity_jobs WHERE user_id=:user
          AND completed_version<desired_version) AND state IN ('PENDING','RUNNING','NEEDS_ATTENTION')
        """).param("user", userId).update();
    jdbc.sql("""
        INSERT INTO account_identity_jobs(user_id,operation_id,desired_version)
        SELECT id,:operation,version FROM application_users WHERE id=:user
        ON CONFLICT(user_id) DO UPDATE SET operation_id=:operation,
        desired_version=excluded.desired_version,attempts=0,next_attempt_at=now(),failure_code=NULL
        """).param("user", userId).param("operation", operationId).update();
    jdbc.sql("""
        INSERT INTO operation_items(operation_id,item_key,target_id,phase)
        VALUES(:operation,'identity',:user,'IDENTITY_SYNC') ON CONFLICT DO NOTHING
        """).param("operation", operationId).param("user", userId).update();
    jdbc.sql("""
        INSERT INTO operation_items(operation_id,item_key,target_id,phase)
        SELECT :operation,'browser:'||id,id,'CLOSE_BROWSER' FROM browser_sessions
        WHERE user_id=:user AND binding_released_at IS NULL ON CONFLICT DO NOTHING
        """).param("operation", operationId).param("user", userId).update();
  }

  public List<UUID> pendingIdentity() {
    return jdbc.sql("""
        SELECT user_id FROM account_identity_jobs WHERE completed_version<desired_version
        AND attempts<3 AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 10
        """).query(UUID.class).list();
  }

  public Identity lockIdentity(UUID userId) {
    return jdbc.sql("""
        SELECT u.id user_id,u.subject,u.state,u.version,j.operation_id,j.desired_version,j.completed_version,j.attempts
        FROM application_users u JOIN account_identity_jobs j ON j.user_id=u.id
        WHERE u.id=:user FOR UPDATE OF u,j
        """).param("user", userId).query(Identity.class).single();
  }

  public void identityComplete(Identity identity) {
    jdbc.sql("""
        UPDATE account_identity_jobs SET completed_version=:version,attempts=0,failure_code=NULL
        WHERE user_id=:user AND desired_version=:version
        """).param("user", identity.userId()).param("version", identity.desiredVersion()).update();
    stageComplete(identity.operationId(), "identity", Map.of("accountVersion", identity.version()));
  }

  public void identityFailed(UUID userId) {
    jdbc.sql("""
        UPDATE account_identity_jobs SET attempts=attempts+1,next_attempt_at=now()+interval '10 seconds',
        failure_code='IDENTITY_CLEANUP_PENDING' WHERE user_id=:user
        """).param("user", userId).update();
    jdbc.sql("""
        UPDATE operations SET state='NEEDS_ATTENTION',failure_code='IDENTITY_CLEANUP_PENDING',
        version=version+1,updated_at=now() WHERE id=(SELECT operation_id FROM account_identity_jobs
        WHERE user_id=:user AND attempts>=3) AND state IN ('PENDING','RUNNING')
        """).param("user", userId).update();
  }

  public void refreshStops() {
    jdbc.sql("""
        UPDATE operation_items i SET state='SUCCEEDED',version=version+1,updated_at=now()
        WHERE (i.operation_id,i.item_key) IN (SELECT operation_id,item_key FROM operation_items
          WHERE state IN ('PENDING','RUNNING') AND phase IN ('CLOSE_BROWSER','STOP_TASK')
          ORDER BY updated_at LIMIT 500) AND
        ((i.phase='CLOSE_BROWSER' AND EXISTS(SELECT 1 FROM browser_sessions s WHERE s.id=i.target_id
          AND s.binding_released_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM browser_allocations a
          WHERE a.session_id=s.id AND a.state<>'RELEASED')))
        OR (i.phase='STOP_TASK' AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=i.target_id
          AND t.state IN ('DRAFT','CANCELLED','COMPLETED','FAILED') AND NOT EXISTS(
            SELECT 1 FROM browser_sessions s WHERE s.task_id=t.id AND s.binding_released_at IS NULL))))
        """).update();
    jdbc.sql("""
        UPDATE operations o SET state='SUCCEEDED',progress=100,finished_at=now(),updated_at=now(),
        version=version+1 WHERE o.state IN ('PENDING','RUNNING') AND
        (o.kind LIKE 'admin.account.%' OR o.kind LIKE 'admin.stop%' OR o.kind LIKE 'admin.deletion.cancel:%')
        AND o.id IN (SELECT id FROM operations WHERE state IN ('PENDING','RUNNING')
          ORDER BY updated_at LIMIT 500)
        AND NOT EXISTS(SELECT 1 FROM operation_items i WHERE i.operation_id=o.id AND i.state<>'SUCCEEDED')
        """).update();
  }

  public List<UUID> duePurges() {
    return jdbc.sql("""
        SELECT d.id FROM account_deletion_requests d LEFT JOIN operations o ON o.id=d.purge_operation_id
        WHERE d.restore_until<=now() AND d.status IN ('REQUESTED','PURGING')
        AND d.next_attempt_at<=now() AND (o.id IS NULL OR o.state IN ('PENDING','RUNNING'))
        ORDER BY d.next_attempt_at,d.restore_until LIMIT 10
        """).query(UUID.class).list();
  }

  public Purge lockPurge(UUID id) {
    return jdbc.sql("""
        SELECT d.id,d.user_id,d.status,d.restore_until,d.purge_operation_id,d.purge_started_at,
        d.ledger_checksum,u.identity_hash,u.subject
        FROM account_deletion_requests d JOIN application_users u ON u.id=d.user_id
        WHERE d.id=:id FOR UPDATE OF d,u
        """).param("id", id).query(Purge.class).single();
  }

  public Purge begin(Purge request) {
    if (!request.status().equals("REQUESTED") || request.restoreUntil().isAfter(Instant.now())) {
      return request;
    }
    UUID operationId = UUID.randomUUID();
    jdbc.sql("""
        INSERT INTO operations(id,kind,target_type,target_id,request_id,state)
        VALUES(:id,'ACCOUNT_PURGE','deletionRequest',:request,:id,'RUNNING')
        """).param("id", operationId).param("request", request.id()).update();
    jdbc.sql("""
        UPDATE account_deletion_requests SET status='PURGING',purge_started_at=coalesce(purge_started_at,now()),
        purge_operation_id=:operation,version=version+1 WHERE id=:id AND status='REQUESTED'
        """).param("id", request.id()).param("operation", operationId).update();
    int changed = jdbc.sql("""
        UPDATE application_users SET state='PURGING',version=version+1,access_epoch=access_epoch+1,
        updated_at=now() WHERE id=:user AND state='DELETING'
        """).param("user", request.userId()).update();
    if (changed != 1) {
      throw DomainException.conflict("PURGE_STATE_CONFLICT", "Account is not awaiting deletion");
    }
    for (String phase : List.of("01_LEDGER", "02_RUNTIME", "03_ARTIFACTS", "04_PROFILES",
        "05_STAGING", "06_KEYS", "07_REDIS", "08_IDENTITY", "09_METADATA", "10_VERIFY")) {
      jdbc.sql("INSERT INTO operation_items(operation_id,item_key,target_id,phase) VALUES(:operation,:phase,:user,:phase)")
          .param("operation", operationId).param("phase", phase).param("user", request.userId()).update();
    }
    jdbc.sql("UPDATE profile_transfers SET state='REVOKED' WHERE user_id=:user AND state<>'REVOKED'")
        .param("user", request.userId()).update();
    jdbc.sql("UPDATE artifact_transfers SET state='REVOKED' WHERE user_id=:user AND state<>'REVOKED'")
        .param("user", request.userId()).update();
    audit(request.userId(), operationId, "PURGE_STARTED");
    return lockPurge(request.id());
  }

  public Stage nextStage(UUID operationId) {
    return jdbc.sql("""
        SELECT item_key,phase,state FROM operation_items WHERE operation_id=:id AND state<>'SUCCEEDED'
        ORDER BY item_key LIMIT 1 FOR UPDATE
        """).param("id", operationId).query(Stage.class).optional().orElse(null);
  }

  public boolean claim(UUID requestId) {
    return jdbc.sql("""
        UPDATE account_deletion_requests SET next_attempt_at=now()+interval '10 minutes'
        WHERE id=:id AND status='PURGING' AND next_attempt_at<=now()
        AND EXISTS(SELECT 1 FROM operations o WHERE o.id=purge_operation_id AND o.state IN ('PENDING','RUNNING'))
        """).param("id", requestId).update() == 1;
  }

  public void ready(UUID requestId) {
    jdbc.sql("UPDATE account_deletion_requests SET next_attempt_at=now() WHERE id=:id")
        .param("id", requestId).update();
  }

  public void deferIdentity(UUID userId) {
    jdbc.sql("UPDATE account_identity_jobs SET next_attempt_at=now()+interval '1 second' WHERE user_id=:id")
        .param("id", userId).update();
  }

  public boolean runtimesClosed(UUID userId) {
    return !jdbc.sql("""
        SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE user_id=:user AND binding_released_at IS NULL)
        OR EXISTS(SELECT 1 FROM browser_allocations WHERE user_id=:user AND state<>'RELEASED')
        OR EXISTS(SELECT 1 FROM artifact_transfers WHERE user_id=:user AND upload_lease_until>now())
        OR EXISTS(SELECT 1 FROM profile_transfers WHERE user_id=:user AND upload_lease_until>now())
        """).param("user", userId).query(Boolean.class).single();
  }

  public void stageComplete(UUID operationId, String stage, Map<String, Object> receipt) {
    jdbc.sql("""
        UPDATE operation_items SET state='SUCCEEDED',external_receipt=CAST(:receipt AS jsonb),
        updated_at=now(),version=version+1 WHERE operation_id=:operation AND item_key=:stage
        """).param("operation", operationId).param("stage", stage).param("receipt", json.write(receipt)).update();
    jdbc.sql("""
        UPDATE operations SET progress=(SELECT count(*) FILTER(WHERE state='SUCCEEDED')*100/count(*)
        FROM operation_items WHERE operation_id=:id),attempts=0,updated_at=now(),version=version+1 WHERE id=:id
        """).param("id", operationId).update();
  }

  public void ledger(Purge purge, String checksum) {
    jdbc.sql("UPDATE account_deletion_requests SET ledger_checksum=:hash WHERE id=:id")
        .param("id", purge.id()).param("hash", checksum).update();
  }

  public void defer(UUID requestId, String code, boolean failure) {
    jdbc.sql("UPDATE account_deletion_requests SET next_attempt_at=now()+interval '10 seconds' WHERE id=:id")
        .param("id", requestId).update();
    if (failure) {
      jdbc.sql("""
          UPDATE operations SET attempts=attempts+1,failure_code=:code,
          state=CASE WHEN attempts>=2 THEN 'NEEDS_ATTENTION' ELSE state END,updated_at=now(),version=version+1
          WHERE id=(SELECT purge_operation_id FROM account_deletion_requests WHERE id=:id)
          """).param("id", requestId).param("code", code).update();
    }
  }

  public void complete(Purge purge) {
    if (!runtimesClosed(purge.userId()) || purge.ledgerChecksum() == null) {
      throw DomainException.conflict("PURGE_UNCONFIRMED", "External cleanup is not confirmed");
    }
    jdbc.sql("""
        UPDATE operation_items SET state='SUCCEEDED',version=version+1,updated_at=now()
        WHERE operation_id IN (SELECT id FROM operations WHERE
          (kind LIKE 'admin.account.%' OR kind LIKE 'admin.stop%')
          AND target_id IN (:user,:request)) AND state IN ('PENDING','RUNNING')
        """).param("user", purge.userId()).param("request", purge.id()).update();
    refreshStops();
    jdbc.sql("""
        UPDATE application_users SET state='DELETED',issuer='urn:helm:deleted',subject=identity_hash,
        display_name='',email='',version=version+1,updated_at=now() WHERE id=:user AND state='PURGING'
        """).param("user", purge.userId()).update();
    jdbc.sql("UPDATE account_deletion_requests SET status='PURGED',finished_at=now(),version=version+1 WHERE id=:id")
        .param("id", purge.id()).update();
    jdbc.sql("UPDATE operations SET state='SUCCEEDED',progress=100,finished_at=now(),updated_at=now(),version=version+1 WHERE id=:id")
        .param("id", purge.purgeOperationId()).update();
    audit(purge.userId(), purge.purgeOperationId(), "PURGE_COMPLETED");
  }

  private void audit(UUID userId, UUID operationId, String action) {
    jdbc.sql("""
        INSERT INTO admin_audit_log(id,actor_id,actor_name,actor_email,target_id,target_type,target_user_id,
        action,reason,previous_value,new_value,operation_id,request_id)
        VALUES(:id,:actor,'System','',:user,'user',:user,:action,'Retention deadline',
        '{}'::jsonb,'{}'::jsonb,:operation,:operation)
        """).param("id", UUID.randomUUID()).param("actor", new UUID(0, 0)).param("user", userId)
        .param("action", action).param("operation", operationId).update();
  }
}
