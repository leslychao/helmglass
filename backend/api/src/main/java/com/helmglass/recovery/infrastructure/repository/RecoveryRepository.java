package com.helmglass.recovery.infrastructure.repository;

import com.helmglass.account.infrastructure.DeletionLedger;
import com.helmglass.api.JsonSupport;
import com.helmglass.recovery.domain.RecoveryProof;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Restore fencing persists before external cleanup and remains closed across process failure. */
@Repository
public class RecoveryRepository {
  private static final List<String> FENCING =
      List.of(
          "UPDATE application_users SET"
              + " access_epoch=access_epoch+1,reauthentication_after=now(),recovery_fence_id=:id,version=version+1"
              + " WHERE id IN (SELECT id FROM application_users WHERE recovery_fence_id IS DISTINCT"
              + " FROM :id LIMIT 500)",
          "UPDATE application_logins SET"
              + " state='REVOKED',revoked_at=now(),revoke_reason='BACKUP_RESTORE',version=version+1"
              + " WHERE id IN (SELECT id FROM application_logins WHERE state='ACTIVE' LIMIT 500)",
          "UPDATE client_grants SET status='REVOKED',version=version+1 WHERE id IN (SELECT id FROM"
              + " client_grants WHERE status='ACTIVE' LIMIT 500)",
          "UPDATE worker_enrollments SET state='REVOKED',expires_at=least(expires_at,now()) WHERE"
              + " ctid IN (SELECT ctid FROM worker_enrollments WHERE state<>'REVOKED' LIMIT 500)",
          "UPDATE browser_workers SET"
              + " observed_state='UNAVAILABLE',inventory_reconciled_at=NULL,version=version+1 WHERE"
              + " id IN (SELECT id FROM browser_workers WHERE observed_state<>'UNAVAILABLE' LIMIT"
              + " 500)",
          "UPDATE command_attempts SET"
              + " state='UNKNOWN',effect_state='UNKNOWN',version=version+1,finished_at=now() WHERE"
              + " id IN (SELECT id FROM command_attempts WHERE state IN ('DISPATCHED','STARTED')"
              + " LIMIT 500)",
          "UPDATE task_commands SET"
              + " state='UNKNOWN',failure_code='RESTORE_EFFECT_UNKNOWN',finished_at=now(),version=version+1"
              + " WHERE id IN (SELECT id FROM task_commands WHERE state IN"
              + " ('ACCEPTED','WAITING_RESOURCE','DISPATCHED','STARTED') LIMIT 500)",
          "UPDATE browser_profile_startups SET state='UNKNOWN' WHERE session_id IN (SELECT"
              + " session_id FROM browser_profile_startups WHERE state NOT IN"
              + " ('READY','FAILED','UNKNOWN') LIMIT 500)",
          "UPDATE human_browser_commands SET state='UNKNOWN',effect_state='UNKNOWN',"
              + " failure_code='RESTORE_EFFECT_UNKNOWN',finished_at=now() WHERE id IN (SELECT id"
              + " FROM human_browser_commands WHERE state IN ('ACCEPTED','STARTED') LIMIT 500)",
          "UPDATE browser_session_operations SET state='UNKNOWN',updated_at=now() WHERE id IN"
              + " (SELECT id FROM browser_session_operations WHERE state IN"
              + " ('QUIESCING','SAVING','RESUMING','CLOSING') LIMIT 500)",
          "UPDATE tasks SET"
              + " state='INTERRUPTED',mutation_barrier=true,version=version+1,updated_at=now()"
              + " WHERE id IN (SELECT id FROM tasks WHERE state NOT IN"
              + " ('DRAFT','COMPLETED','FAILED','CANCELLED') AND (state<>'INTERRUPTED' OR NOT"
              + " mutation_barrier) LIMIT 500)",
          "UPDATE operations SET"
              + " state='NEEDS_ATTENTION',failure_code='RESTORE_EFFECT_UNKNOWN',human_checkpoint=CASE"
              + " WHEN human_checkpoint IS NULL THEN NULL ELSE 'UNKNOWN'"
              + " END,version=version+1,updated_at=now() WHERE id IN (SELECT id FROM operations"
              + " WHERE state IN ('PENDING','RUNNING') OR human_checkpoint='OPEN' LIMIT 500)",
          "UPDATE account_deletion_requests SET"
              + " status='REQUESTED',purge_operation_id=NULL,next_attempt_at=now(),version=version+1"
              + " WHERE id IN (SELECT id FROM account_deletion_requests WHERE status='PURGING'"
              + " LIMIT 500)",
          "UPDATE application_users SET state='DELETING',version=version+1 WHERE id IN (SELECT u.id"
              + " FROM application_users u JOIN account_deletion_requests d ON d.user_id=u.id WHERE"
              + " u.state='PURGING' AND d.status='REQUESTED' LIMIT 500)",
          "UPDATE task_continuations SET"
              + " state='CANCELLED',claim_grant_id=NULL,claim_control_epoch=NULL,version=version+1"
              + " WHERE id IN (SELECT id FROM task_continuations WHERE state NOT IN"
              + " ('CANCELLED','CONSUMED','EXPIRED') LIMIT 500)",
          "UPDATE browser_control_leases SET"
              + " state='QUIESCED',epoch=epoch+1,controller_instance_id=NULL,login_id=NULL,continuation_claim_id=NULL,input_channel_id=NULL,desired_owner=NULL,operation_id=NULL,expires_at=now(),version=version+1"
              + " WHERE session_id IN (SELECT session_id FROM browser_control_leases WHERE"
              + " state<>'QUIESCED' OR controller_instance_id IS NOT NULL OR login_id IS NOT NULL"
              + " OR continuation_claim_id IS NOT NULL OR input_channel_id IS NOT NULL OR"
              + " desired_owner IS NOT NULL OR operation_id IS NOT NULL LIMIT 500)",
          "UPDATE browser_allocations SET"
              + " state='QUARANTINED',start_permit_expires_at=now(),version=version+1 WHERE id IN"
              + " (SELECT id FROM browser_allocations WHERE state NOT IN ('RELEASED','QUARANTINED')"
              + " LIMIT 500)",
          "UPDATE browser_sessions SET"
              + " state='CLOSED',close_reason='BACKUP_RESTORE',closed_at=now(),"
              + " binding_released_at=now(),open_failure_code='RESTORE_EFFECT_UNKNOWN',version=version+1"
              + " WHERE id IN (SELECT s.id FROM browser_sessions s WHERE s.state='REQUESTED' AND"
              + " s.open_operation_id IS NOT NULL AND s.binding_released_at IS NULL AND NOT"
              + " EXISTS(SELECT 1 FROM browser_allocations a WHERE a.session_id=s.id) LIMIT 500)",
          "UPDATE browser_sessions SET"
              + " state='STOPPING',close_reason='BACKUP_RESTORE',allocation_epoch=allocation_epoch+1,page_epoch=page_epoch+1,privacy_epoch=privacy_epoch+1,media_generation=media_generation+1,version=version+1,recovery_control_pending=false"
              + " WHERE id IN (SELECT id FROM browser_sessions WHERE binding_released_at IS NULL"
              + " AND close_reason IS DISTINCT FROM 'BACKUP_RESTORE' LIMIT 500)",
          "UPDATE profile_transfers SET state='REVOKED' WHERE id IN (SELECT id FROM"
              + " profile_transfers WHERE state<>'REVOKED' LIMIT 500)",
          "UPDATE artifact_transfers SET state='REVOKED' WHERE id IN (SELECT id FROM"
              + " artifact_transfers WHERE state<>'REVOKED' LIMIT 500)",
          "UPDATE connection_login_operations SET state='CANCELLED',version=version+1 WHERE id IN"
              + " (SELECT id FROM connection_login_operations WHERE state NOT IN"
              + " ('SUCCEEDED','FAILED','CANCELLED') LIMIT 500)",
          "UPDATE session_operation_commands SET"
              + " state='UNKNOWN',effect_state='UNKNOWN',finished_at=now() WHERE id IN (SELECT id"
              + " FROM session_operation_commands WHERE state IN"
              + " ('ACCEPTED','DISPATCHED','STARTED') LIMIT 500)");
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public RecoveryRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public void closeAdmission() {
    jdbc.sql(
            """
            UPDATE platform_settings SET recovery_previous_accepting=CASE WHEN recovery_state IN ('NORMAL','READY')
              THEN accepting_allocations ELSE recovery_previous_accepting END,
              accepting_allocations=false,recovery_state='REQUIRED',version=version+1,updated_at=now()
            """)
        .update();
  }

  public String begin(RecoveryProof proof, String hash) {
    jdbc.sql(
            """
            INSERT INTO recovery_runs(id,backup_id,restore_point,wal_loss_window,proof_hash,ledger_manifest_hash,state,fencing_evidence)
            VALUES(:id,:backup,:point,:loss,:hash,:ledger,'FENCING',CAST(:evidence AS jsonb)) ON CONFLICT DO NOTHING
            """)
        .param("id", proof.recoveryId())
        .param("backup", proof.backupId())
        .param("point", proof.restorePoint())
        .param("loss", proof.walLossWindow())
        .param("hash", hash)
        .param("ledger", proof.ledgerManifestSha256())
        .param("evidence", json.write(proof.runtimeFencing()))
        .update();
    String existingHash =
        jdbc.sql("SELECT proof_hash FROM recovery_runs WHERE id=:id FOR UPDATE")
            .param("id", proof.recoveryId())
            .query(String.class)
            .single();
    if (!hash.equals(existingHash)) {
      throw new IllegalStateException("Recovery ID already identifies different evidence");
    }
    String state = state(proof.recoveryId());
    if (state.equals("READY")) {
      throw new IllegalStateException(
          "Recovery already completed; reconcile its read-only receipt instead of replaying it");
    }
    jdbc.sql("UPDATE platform_settings SET recovery_id=:id,recovery_state='RECOVERING'")
        .param("id", proof.recoveryId())
        .update();
    return state;
  }

  public record Receipt(
      UUID recoveryId, String proofHash, String state, Instant finishedAt, String admissionState) {}

  public boolean completed(UUID recoveryId, String hash) {
    return jdbc.sql(
            "SELECT EXISTS(SELECT 1 FROM recovery_runs WHERE id=:id AND proof_hash=:hash AND"
                + " state='READY')")
        .param("id", recoveryId)
        .param("hash", hash)
        .query(Boolean.class)
        .single();
  }

  public Receipt receipt(UUID recoveryId, String hash) {
    return jdbc.sql(
            """
            SELECT r.id recovery_id,r.proof_hash,r.state,r.finished_at,p.recovery_state admission_state
            FROM recovery_runs r CROSS JOIN platform_settings p WHERE r.id=:id AND r.proof_hash=:hash
            """)
        .param("id", recoveryId)
        .param("hash", hash)
        .query(Receipt.class)
        .optional()
        .orElseThrow(
            () ->
                new IllegalStateException(
                    "Recovery receipt for these exact evidence bytes is absent"));
  }

  public String state(UUID recoveryId) {
    return jdbc.sql("SELECT state FROM recovery_runs WHERE id=:id")
        .param("id", recoveryId)
        .query(String.class)
        .single();
  }

  public boolean fenceBatch(UUID recoveryId) {
    for (String statement : FENCING) {
      if (jdbc.sql(statement).param("id", recoveryId).update() > 0) {
        return false;
      }
    }
    phase(recoveryId, "LEDGER");
    return true;
  }

  public void phase(UUID recoveryId, String phase) {
    jdbc.sql("UPDATE recovery_runs SET state=:state WHERE id=:id")
        .param("id", recoveryId)
        .param("state", phase)
        .update();
  }

  public void mergeDeletion(UUID recoveryId, DeletionLedger.Entry entry) {
    jdbc.sql(
            """
            INSERT INTO application_users(id,issuer,subject,display_name,email,state,identity_hash,recovery_fence_id)
            VALUES(:user,'urn:helm:deleted',:hash,'','','DELETING',:hash,:recovery) ON CONFLICT DO NOTHING
            """)
        .param("user", entry.userId())
        .param("hash", entry.identityHash())
        .param("recovery", recoveryId)
        .update();
    var user =
        jdbc.sql("SELECT id FROM application_users WHERE identity_hash=:hash FOR UPDATE")
            .param("hash", entry.identityHash())
            .query(UUID.class)
            .single();
    if (!user.equals(entry.userId())) {
      throw new IllegalStateException("Deletion ledger owner does not match restored identity");
    }
    jdbc.sql(
            """
            UPDATE account_deletion_requests SET status='CANCELLED',finished_at=now(),version=version+1
            WHERE user_id=:user AND id<>:id AND status IN ('REQUESTED','PURGING')
            """)
        .param("user", entry.userId())
        .param("id", entry.requestId())
        .update();
    jdbc.sql(
            """
            INSERT INTO account_deletion_requests(id,user_id,previous_account_state,status,delete_requested_at,
              restore_until,purge_started_at,recovery_id)
            VALUES(:id,:user,'BLOCKED','REQUESTED',CAST(:time AS timestamptz)-interval '168 hours',:time,:time,:recovery)
            ON CONFLICT(id) DO UPDATE SET status='REQUESTED',purge_operation_id=NULL,ledger_checksum=NULL,
              finished_at=NULL,next_attempt_at=now(),purge_started_at=:time,recovery_id=:recovery,version=account_deletion_requests.version+1
            WHERE account_deletion_requests.recovery_id IS DISTINCT FROM :recovery
            """)
        .param("id", entry.requestId())
        .param("user", entry.userId())
        .param("time", Timestamp.from(entry.purgeStartedAt()))
        .param("recovery", recoveryId)
        .update();
    jdbc.sql(
            """
            UPDATE application_users SET state='DELETING',access_epoch=access_epoch+1,version=version+1
            WHERE id=:user AND state<>'DELETING' AND EXISTS(SELECT 1 FROM account_deletion_requests
              WHERE id=:request AND status='REQUESTED' AND recovery_id=:recovery)
            """)
        .param("user", entry.userId())
        .param("request", entry.requestId())
        .param("recovery", recoveryId)
        .update();
  }

  /** The launcher has proven every previous runtime stopped; effect certainty remains UNKNOWN. */
  public boolean closeFencedRuntimeBatch() {
    int changed =
        jdbc.sql(
                """
                UPDATE browser_sessions SET state='CLOSED',closed_at=now(),binding_released_at=now(),version=version+1
                WHERE id IN (SELECT id FROM browser_sessions WHERE binding_released_at IS NULL LIMIT 500)
                """)
            .update();
    changed +=
        jdbc.sql(
                """
                UPDATE browser_allocations SET state='RELEASED',released_at=now(),version=version+1
                WHERE id IN (SELECT id FROM browser_allocations WHERE state<>'RELEASED' LIMIT 500)
                """)
            .update();
    return changed == 0;
  }

  public boolean pendingDeletions() {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM account_deletion_requests WHERE restore_until<=now()
              AND status IN ('REQUESTED','PURGING'))
            """)
        .query(Boolean.class)
        .single();
  }

  public void complete(UUID recoveryId) {
    if (pendingDeletions()) {
      throw new IllegalStateException("Restored account purge is still incomplete");
    }
    jdbc.sql(
            "UPDATE recovery_runs SET state='READY',finished_at=coalesce(finished_at,now()) WHERE"
                + " id=:id")
        .param("id", recoveryId)
        .update();
    jdbc.sql(
            """
            UPDATE platform_settings SET recovery_state='READY',
              accepting_allocations=coalesce(recovery_previous_accepting,false),version=version+1,updated_at=now()
            WHERE recovery_id=:id
            """)
        .param("id", recoveryId)
        .update();
  }

  public boolean ready() {
    return jdbc.sql("SELECT recovery_state IN ('NORMAL','READY') FROM platform_settings")
        .query(Boolean.class)
        .single();
  }
}
