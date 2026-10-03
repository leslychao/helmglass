package com.helmglass.artifact.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.artifact.api.ArtifactContracts.CaptureMetadata;
import com.helmglass.artifact.api.ArtifactContracts.Metadata;
import com.helmglass.artifact.infrastructure.MultipartStorage.Part;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ArtifactRepository {
  public record Scope(
      UUID userId,
      UUID taskId,
      UUID commandId,
      UUID attemptId,
      UUID sessionId,
      UUID workerId,
      UUID bootId,
      long allocationEpoch,
      long pageEpoch,
      long privacyEpoch,
      long controlEpoch,
      long policyVersion,
      String currentUrl,
      int viewportWidth,
      int viewportHeight) {}

  public record Artifact(
      UUID id,
      UUID userId,
      UUID taskId,
      String bucket,
      String objectKey,
      String mime,
      long size,
      String checksum,
      String filename,
      String state,
      long version,
      String uploadId,
      String provenance,
      Instant createdAt) {}

  public record Transfer(
      UUID id,
      UUID artifactId,
      UUID userId,
      UUID attemptId,
      UUID commandId,
      UUID sessionId,
      UUID workerId,
      UUID bootId,
      long allocationEpoch,
      long pageEpoch,
      long privacyEpoch,
      long controlEpoch,
      long policyVersion,
      String metadataHash,
      String tokenHash,
      String state,
      UUID uploadLeaseId,
      Instant uploadLeaseUntil,
      Instant expiresAt,
      Instant createRequestedAt,
      UUID humanCommandId,
      UUID humanAttemptId) {
    public String captureKind() {
      return humanAttemptId == null ? "AUDIO" : "SCREENSHOT";
    }

    public UUID captureAttemptId() {
      return humanAttemptId == null ? attemptId : humanAttemptId;
    }
  }

  private final JdbcClient jdbc;
  private final JsonSupport json;

  public ArtifactRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public UUID ownerOfAttempt(UUID attemptId, String kind) {
    if (kind.equals("SCREENSHOT")) {
      return jdbc.sql("SELECT user_id FROM human_browser_commands WHERE attempt_id=:id")
          .param("id", attemptId)
          .query(UUID.class)
          .optional()
          .orElseThrow(DomainException::notFound);
    }
    return jdbc.sql(
            """
            SELECT c.user_id FROM command_attempts a JOIN task_commands c ON c.id=a.command_id
            WHERE a.id=:id
            """)
        .param("id", attemptId)
        .query(UUID.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public Scope scope(UUID attemptId, String kind) {
    if (kind.equals("SCREENSHOT")) {
      return screenshotScope(attemptId);
    }
    return jdbc.sql(
            """
            SELECT c.user_id,c.task_id,c.id command_id,a.id attempt_id,s.id session_id,
            s.worker_id,s.worker_boot_id boot_id,s.allocation_epoch,s.page_epoch,s.privacy_epoch,
            l.epoch control_epoch,p.version policy_version,s.current_url,s.viewport_width,s.viewport_height
            FROM command_attempts a JOIN task_commands c ON c.id=a.command_id
            JOIN tasks t ON t.id=c.task_id JOIN browser_sessions s ON s.id=a.session_id
            JOIN browser_workers w ON w.id=s.worker_id
            JOIN browser_control_leases l ON l.session_id=s.id
            JOIN user_policies p ON p.user_id=c.user_id
            WHERE a.id=:id AND a.state='STARTED' AND c.state='STARTED' AND c.kind='READ_MEDIA'
            AND a.start_permit_id IS NOT NULL AND a.assignment_epoch=s.allocation_epoch
            AND a.control_epoch=l.epoch AND a.worker_id=s.worker_id AND c.cancel_requested_at IS NULL
            AND c.deadline>now() AND s.budget_deadline_at>now() AND s.idle_deadline_at>now()
            AND s.state='ACTIVE' AND s.privacy='NORMAL' AND s.binding_released_at IS NULL
            AND t.state='RUNNING' AND NOT t.mutation_barrier
            AND l.owner_kind='AGENT' AND l.state='ACTIVE' AND l.expires_at>now()
            AND w.boot_id=s.worker_boot_id AND w.heartbeat_at>now()-interval '20 seconds'
            AND (c.client_grant_id IS NULL OR EXISTS(SELECT 1 FROM client_grants g
              WHERE g.id=c.client_grant_id AND g.user_id=c.user_id AND g.status='ACTIVE'))
            FOR UPDATE OF a,c,t,s,l,p
            """)
        .param("id", attemptId)
        .query(Scope.class)
        .optional()
        .orElseThrow(
            () ->
                new DomainException(
                    403, "ARTIFACT_CAPTURE_REVOKED", "Capture authorization is no longer active"));
  }

  private Scope screenshotScope(UUID attemptId) {
    return jdbc.sql(
            """
            SELECT h.user_id,s.task_id,h.id command_id,h.attempt_id,s.id session_id,
            s.worker_id,s.worker_boot_id boot_id,s.allocation_epoch,s.page_epoch,s.privacy_epoch,
            l.epoch control_epoch,p.version policy_version,s.current_url,s.viewport_width,s.viewport_height
            FROM human_browser_commands h JOIN browser_sessions s ON s.id=h.session_id
            JOIN browser_workers w ON w.id=s.worker_id
            JOIN browser_control_leases l ON l.session_id=s.id
            JOIN user_policies p ON p.user_id=h.user_id
            JOIN application_logins login ON login.id=h.login_id
            JOIN application_users u ON u.id=h.user_id
            WHERE h.attempt_id=:id AND h.state='STARTED' AND h.permit_id IS NOT NULL
            AND h.action->>'type'='SNAPSHOT' AND h.execution_mode='HUMAN'
            AND h.deadline>now() AND s.budget_deadline_at>now() AND s.idle_deadline_at>now()
            AND s.state='ACTIVE' AND s.privacy='NORMAL' AND s.binding_released_at IS NULL
            AND s.purpose='TASK' AND s.task_id IS NOT NULL
            AND l.owner_kind='HUMAN' AND l.state='ACTIVE' AND l.expires_at>now()
            AND l.login_id=h.login_id AND l.controller_instance_id=h.controller_instance_id
            AND login.state='ACTIVE' AND login.revoked_at IS NULL AND login.expires_at>now()
            AND login.user_id=h.user_id AND login.admitted_access_epoch=u.access_epoch
            AND u.state='ACTIVE' AND w.boot_id=s.worker_boot_id
            AND w.heartbeat_at>now()-interval '20 seconds'
            AND (h.scope->>'workerBootId')::uuid=s.worker_boot_id
            AND (h.scope->>'allocationEpoch')::bigint=s.allocation_epoch
            AND (h.scope->>'controlEpoch')::bigint=l.epoch
            AND (h.scope->>'pageEpoch')::bigint=s.page_epoch
            AND (h.scope->>'privacyEpoch')::bigint=s.privacy_epoch
            AND (h.scope->>'policyVersion')::bigint=p.version
            FOR UPDATE OF h,s,l,p
            """)
        .param("id", attemptId)
        .query(Scope.class)
        .optional()
        .orElseThrow(
            () ->
                new DomainException(
                    403, "ARTIFACT_CAPTURE_REVOKED", "Capture authorization is no longer active"));
  }

  public long reservedBytes(UUID userId) {
    return jdbc.sql(
            """
            SELECT coalesce(sum(size),0) FROM task_artifacts
            WHERE user_id=:user AND state IN ('UPLOADING','READY')
            """)
        .param("user", userId)
        .query(Long.class)
        .single();
  }

  public Optional<Transfer> forAttempt(UUID attemptId, String kind) {
    String column = kind.equals("SCREENSHOT") ? "human_attempt_id" : "attempt_id";
    return jdbc.sql("SELECT * FROM artifact_transfers WHERE " + column + "=:id FOR UPDATE")
        .param("id", attemptId)
        .query(Transfer.class)
        .optional();
  }

  public Transfer transfer(UUID id) {
    return jdbc.sql("SELECT * FROM artifact_transfers WHERE id=:id FOR UPDATE")
        .param("id", id)
        .query(Transfer.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public UUID transferOwner(UUID id) {
    return jdbc.sql("SELECT user_id FROM artifact_transfers WHERE id=:id")
        .param("id", id)
        .query(UUID.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void lockOwner(UUID id) {
    jdbc.sql("SELECT id FROM application_users WHERE id=:id FOR UPDATE")
        .param("id", id)
        .query(UUID.class)
        .single();
  }

  public Artifact artifact(UUID id) {
    return jdbc.sql("SELECT * FROM task_artifacts WHERE id=:id")
        .param("id", id)
        .query(Artifact.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public Artifact owned(UUID userId, UUID id) {
    return jdbc.sql("SELECT * FROM task_artifacts WHERE id=:id AND user_id=:user AND state='READY'")
        .param("id", id)
        .param("user", userId)
        .query(Artifact.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public Transfer create(Scope scope, CaptureMetadata input, String hash, String tokenHash) {
    UUID artifactId = UUID.randomUUID();
    UUID transferId = UUID.randomUUID();
    String key = "u/" + scope.userId() + "/t/" + scope.taskId() + "/a/" + artifactId + "/1";
    jdbc.sql(
            """
            INSERT INTO task_artifacts(id,user_id,task_id,purpose,bucket,object_key,mime,size,
            checksum,filename,provenance,coverage)
            VALUES(:id,:user,:task,:purpose,'hg-artifacts',:key,:mime,:size,:checksum,:filename,
            CAST(:metadata AS jsonb),CAST(:coverage AS jsonb))
            """)
        .param("id", artifactId)
        .param("user", scope.userId())
        .param("task", scope.taskId())
        .param("purpose", input.kind())
        .param("key", key)
        .param("mime", input.mimeType())
        .param("size", input.byteLength())
        .param("checksum", input.sha256())
        .param(
            "filename",
            (input.kind().equals("SCREENSHOT") ? "screenshot-" : "audio-")
                + artifactId
                + extension(input.mimeType()))
        .param("metadata", json.write(input))
        .param("coverage", input instanceof Metadata audio ? json.write(audio.coverage()) : "{}")
        .update();
    jdbc.sql(
            """
            INSERT INTO artifact_transfers(id,artifact_id,attempt_id,command_id,session_id,user_id,
            worker_id,boot_id,allocation_epoch,page_epoch,privacy_epoch,control_epoch,policy_version,
            metadata_hash,token_hash,human_command_id,human_attempt_id) VALUES(:id,:artifact,:attempt,:command,:session,:user,:worker,
            :boot,:allocation,:page,:privacy,:control,:policy,:hash,:token,:humanCommand,:humanAttempt)
            """)
        .param("id", transferId)
        .param("artifact", artifactId)
        .param("attempt", input.kind().equals("AUDIO") ? scope.attemptId() : null)
        .param("command", input.kind().equals("AUDIO") ? scope.commandId() : null)
        .param("humanAttempt", input.kind().equals("SCREENSHOT") ? scope.attemptId() : null)
        .param("humanCommand", input.kind().equals("SCREENSHOT") ? scope.commandId() : null)
        .param("session", scope.sessionId())
        .param("user", scope.userId())
        .param("worker", scope.workerId())
        .param("boot", scope.bootId())
        .param("allocation", scope.allocationEpoch())
        .param("page", scope.pageEpoch())
        .param("privacy", scope.privacyEpoch())
        .param("control", scope.controlEpoch())
        .param("policy", scope.policyVersion())
        .param("hash", hash)
        .param("token", tokenHash)
        .update();
    return transfer(transferId);
  }

  public void rotateToken(UUID id, String hash) {
    jdbc.sql("UPDATE artifact_transfers SET token_hash=:hash,updated_at=now() WHERE id=:id")
        .param("hash", hash)
        .param("id", id)
        .update();
  }

  public void claim(UUID id, UUID leaseId) {
    if (jdbc.sql(
                """
                UPDATE artifact_transfers SET upload_lease_id=:lease,
                upload_lease_until=now()+interval '150 seconds',state='UPLOADING',updated_at=now()
                WHERE id=:id AND state IN ('ISSUED','UPLOADING','VERIFYING')
                AND (upload_lease_until IS NULL OR upload_lease_until<now())
                """)
            .param("id", id)
            .param("lease", leaseId)
            .update()
        != 1) {
      throw DomainException.conflict("ARTIFACT_UPLOAD_BUSY", "An upload is still active");
    }
  }

  public void renew(UUID id, UUID leaseId) {
    if (jdbc.sql(
                """
                UPDATE artifact_transfers SET upload_lease_until=now()+interval '150 seconds',updated_at=now()
                WHERE id=:id AND upload_lease_id=:lease AND upload_lease_until>now()
                """)
            .param("id", id)
            .param("lease", leaseId)
            .update()
        != 1) {
      throw DomainException.conflict("ARTIFACT_UPLOAD_LEASE_LOST", "Upload ownership changed");
    }
  }

  public void release(UUID id, UUID leaseId) {
    jdbc.sql(
            """
            UPDATE artifact_transfers SET upload_lease_id=NULL,upload_lease_until=NULL
            WHERE id=:id AND upload_lease_id=:lease
            """)
        .param("id", id)
        .param("lease", leaseId)
        .update();
  }

  public boolean requestCreate(UUID transferId, UUID leaseId) {
    return jdbc.sql(
                """
                UPDATE artifact_transfers SET create_requested_at=now()
                WHERE id=:id AND upload_lease_id=:lease AND upload_lease_until>now()
                AND state='UPLOADING' AND create_requested_at IS NULL
                """)
            .param("id", transferId)
            .param("lease", leaseId)
            .update()
        == 1;
  }

  public void uploadId(UUID id, String uploadId, UUID transferId, UUID leaseId) {
    if (jdbc.sql(
                """
                UPDATE task_artifacts a SET upload_id=:upload FROM artifact_transfers t
                WHERE a.id=:id AND a.upload_id IS NULL AND a.state='UPLOADING'
                AND t.artifact_id=a.id AND t.id=:transfer AND t.upload_lease_id=:lease
                AND t.upload_lease_until>now() AND t.state='UPLOADING'
                """)
            .param("id", id)
            .param("upload", uploadId)
            .param("transfer", transferId)
            .param("lease", leaseId)
            .update()
        != 1) {
      throw DomainException.conflict("ARTIFACT_UPLOAD_LEASE_LOST", "Upload ownership changed");
    }
  }

  public boolean mayRemoveUpload(String bucket, String key) {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM task_artifacts a WHERE a.bucket=:bucket AND a.object_key=:key
              AND a.state IN ('DELETING','DELETED') AND NOT EXISTS(
                SELECT 1 FROM artifact_transfers t WHERE t.artifact_id=a.id AND t.upload_lease_until>now()))
            """)
        .param("bucket", bucket)
        .param("key", key)
        .query(Boolean.class)
        .single();
  }

  public void reservePart(UUID artifactId, int number, String checksum, int size) {
    record Existing(String checksum, long size) {}
    var existing =
        jdbc.sql(
                """
                SELECT checksum,size FROM upload_parts WHERE artifact_id=:id AND part_number=:number
                """)
            .param("id", artifactId)
            .param("number", number)
            .query(Existing.class)
            .optional();
    if (existing.isPresent()) {
      if (!existing.get().checksum().equals(checksum) || existing.get().size() != size) {
        throw DomainException.conflict(
            "ARTIFACT_PART_MISMATCH", "A stored part cannot be replaced");
      }
      return;
    }
    jdbc.sql(
            """
            INSERT INTO upload_parts(artifact_id,part_number,checksum,size,state)
            VALUES(:id,:number,:checksum,:size,'RESERVED')
            """)
        .param("id", artifactId)
        .param("number", number)
        .param("checksum", checksum)
        .param("size", size)
        .update();
  }

  public void confirmPart(UUID artifactId, Part part) {
    jdbc.sql(
            """
            UPDATE upload_parts SET etag=:etag,state='READY'
            WHERE artifact_id=:id AND part_number=:number AND checksum=:checksum AND size=:size
            """)
        .param("id", artifactId)
        .param("number", part.number())
        .param("etag", part.etag())
        .param("checksum", part.sha256())
        .param("size", part.size())
        .update();
  }

  public List<Part> parts(UUID artifactId) {
    return jdbc.sql(
            """
            SELECT part_number number,size,checksum sha256,etag FROM upload_parts
            WHERE artifact_id=:id AND state='READY' ORDER BY part_number
            """)
        .param("id", artifactId)
        .query(Part.class)
        .list();
  }

  public void publish(Transfer transfer, Artifact artifact) {
    jdbc.sql(
            """
            UPDATE task_artifacts SET state='READY',ready_at=now(),version=version+1
            WHERE id=:id AND state='UPLOADING'
            """)
        .param("id", artifact.id())
        .update();
    jdbc.sql(
            """
            UPDATE artifact_transfers SET state='READY',updated_at=now() WHERE id=:id
            """)
        .param("id", transfer.id())
        .update();
    measurement(transfer, artifact, "media_bytes", artifact.size(), "byte");
    if (transfer.captureKind().equals("AUDIO")) {
      Metadata metadata = json.read(artifact.provenance(), Metadata.class);
      long milliseconds =
          metadata
              .durationSeconds()
              .movePointRight(3)
              .setScale(0, RoundingMode.HALF_UP)
              .longValueExact();
      measurement(transfer, artifact, "media_seconds", milliseconds, "millisecond");
    }
  }

  public Optional<Artifact> readyScreenshot(UUID commandId, UUID attemptId) {
    return jdbc.sql(
            """
            SELECT a.* FROM artifact_transfers t JOIN task_artifacts a ON a.id=t.artifact_id
            WHERE t.human_command_id=:command AND t.human_attempt_id=:attempt
            AND t.state='READY' AND a.state='READY' AND a.purpose='SCREENSHOT'
            """)
        .param("command", commandId)
        .param("attempt", attemptId)
        .query(Artifact.class)
        .optional();
  }

  public void markDeleting(UUID id) {
    jdbc.sql(
            """
            UPDATE task_artifacts SET state='DELETING',version=version+1
            WHERE id=:id AND state<>'DELETED'
            """)
        .param("id", id)
        .update();
    jdbc.sql("UPDATE artifact_transfers SET state='REVOKED' WHERE artifact_id=:id")
        .param("id", id)
        .update();
  }

  public List<Artifact> deletions() {
    return jdbc.sql(
            """
            SELECT a.* FROM task_artifacts a WHERE a.state='DELETING'
            AND NOT EXISTS(SELECT 1 FROM artifact_transfers t WHERE t.artifact_id=a.id
              AND t.upload_lease_until>now()) ORDER BY a.id LIMIT 20
            """)
        .query(Artifact.class)
        .list();
  }

  public void deleted(UUID id) {
    jdbc.sql(
            """
            UPDATE task_artifacts SET state='DELETED',deleted_at=now(),version=version+1 WHERE id=:id
            """)
        .param("id", id)
        .update();
  }

  public List<UUID> expired() {
    return jdbc.sql(
            """
            SELECT artifact_id FROM artifact_transfers WHERE expires_at<=now()
            AND state NOT IN ('READY','REVOKED') ORDER BY expires_at LIMIT 20
            """)
        .query(UUID.class)
        .list();
  }

  private void measurement(
      Transfer transfer, Artifact artifact, String metric, long value, String unit) {
    jdbc.sql(
            """
            INSERT INTO usage_measurements(id,user_id,task_id,session_id,attempt_id,metric,value,unit,
            interval_start,interval_end,completeness,source_id,source_sequence)
            VALUES(:id,:user,:task,:session,:attempt,:metric,:value,:unit,now(),now(),'COMPLETE',:source,1)
            ON CONFLICT(source_id,source_sequence,metric) DO NOTHING
            """)
        .param("id", UUID.randomUUID())
        .param("user", artifact.userId())
        .param("task", artifact.taskId())
        .param("session", transfer.sessionId())
        .param("attempt", transfer.attemptId())
        .param("metric", metric)
        .param("value", value)
        .param("unit", unit)
        .param("source", artifact.id())
        .update();
  }

  private static String extension(String mime) {
    return switch (mime) {
      case "image/png" -> ".png";
      case "audio/wav" -> ".wav";
      case "audio/mpeg" -> ".mp3";
      case "audio/ogg" -> ".ogg";
      case "audio/flac" -> ".flac";
      case "audio/mp4" -> ".m4a";
      case "audio/webm" -> ".webm";
      case "video/webm" -> ".webm";
      case "video/mp4" -> ".mp4";
      case "audio/x-matroska" -> ".mka";
      default -> ".bin";
    };
  }
}
