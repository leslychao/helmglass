package com.helmglass.profile.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.profile.domain.ProfileBinding;
import com.helmglass.profile.infrastructure.ProfileKeyService.WrappedKey;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ProfileRepository {
  public record SessionScope(
      UUID userId,
      UUID sessionId,
      UUID connectionId,
      UUID workerId,
      UUID bootId,
      long allocationEpoch,
      long privacyEpoch,
      long controlEpoch,
      long policyVersion,
      long scopeVersion,
      String sessionState,
      String privacyMode,
      String controlState,
      String ownerKind,
      String savePreference,
      String imageVersion,
      Instant controlExpiresAt) {}

  public record Profile(UUID id, UUID currentVersionId, long version) {}

  public record Version(
      UUID id,
      UUID profileId,
      long revision,
      String objectKey,
      String checksum,
      Long size,
      String wrappedDek,
      String vaultKeyRef,
      String runtimeVersion,
      String originsManifest,
      String state) {}

  public record Transfer(
      UUID id,
      UUID versionId,
      UUID userId,
      UUID connectionId,
      UUID sessionId,
      UUID workerId,
      UUID bootId,
      long allocationEpoch,
      long privacyEpoch,
      long controlEpoch,
      long policyVersion,
      long scopeVersion,
      long expectedProfileVersion,
      String direction,
      String tokenHash,
      String wrappedToken,
      String state,
      String checksum,
      Long size,
      Instant expiresAt,
      Instant uploadLeaseUntil) {}

  private final JdbcClient jdbc;
  private final JsonSupport json;

  public ProfileRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public SessionScope scope(UUID userId, UUID sessionId, UUID connectionId) {
    return jdbc.sql(
            """
            SELECT s.user_id,s.id session_id,c.id connection_id,s.worker_id,s.worker_boot_id boot_id,
              s.allocation_epoch,s.privacy_epoch,l.epoch control_epoch,p.version policy_version,
              c.scope_version,s.state session_state,s.privacy privacy_mode,l.state control_state,
              l.owner_kind,c.save_preference,w.image_version,l.expires_at control_expires_at
            FROM browser_sessions s JOIN application_users u ON u.id=s.user_id
              JOIN connections c ON c.id=s.connection_id AND c.user_id=s.user_id
              JOIN browser_control_leases l ON l.session_id=s.id
              JOIN user_policies p ON p.user_id=s.user_id
              JOIN browser_workers w ON w.id=s.worker_id AND w.boot_id=s.worker_boot_id
            WHERE s.id=:session AND s.user_id=:user AND c.id=:connection
              AND u.state='ACTIVE' AND c.status NOT IN ('DELETING','DELETED')
              AND s.binding_released_at IS NULL AND (s.state IN ('STARTING','ACTIVE')
                OR s.state='STOPPING' AND EXISTS(SELECT 1 FROM browser_session_operations o
                  WHERE o.session_id=s.id AND o.initiator='SYSTEM' AND o.state IN ('QUIESCING','SAVING')
                    AND o.deadline>now()))
              AND w.heartbeat_at>now()-interval '20 seconds'
            FOR UPDATE OF s,c,l,u,p
            """)
        .param("session", sessionId)
        .param("user", userId)
        .param("connection", connectionId)
        .query(SessionScope.class)
        .optional()
        .orElseThrow(
            () ->
                new DomainException(
                    403, "PROFILE_ASSIGNMENT_STALE", "Profile assignment is no longer active"));
  }

  public List<String> origins(UUID userId, UUID connectionId) {
    return jdbc.sql(
            """
            SELECT origin FROM connection_origins WHERE user_id=:user AND connection_id=:connection
              AND status='ACTIVE' ORDER BY origin LIMIT 65
            """)
        .param("user", userId)
        .param("connection", connectionId)
        .query(String.class)
        .list();
  }

  public Profile profile(UUID userId, UUID connectionId) {
    jdbc.sql(
            """
            INSERT INTO browser_profiles(id,user_id,connection_id) VALUES(:id,:user,:connection)
            ON CONFLICT(connection_id) DO NOTHING
            """)
        .param("id", UUID.randomUUID())
        .param("user", userId)
        .param("connection", connectionId)
        .update();
    return jdbc.sql(
            """
            SELECT id,current_version_id,version FROM browser_profiles
            WHERE connection_id=:connection AND user_id=:user AND state='ACTIVE' FOR UPDATE
            """)
        .param("user", userId)
        .param("connection", connectionId)
        .query(Profile.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public long nextRevision(UUID profileId) {
    return jdbc.sql(
            "SELECT COALESCE(max(revision),0)+1 FROM browser_profile_versions WHERE profile_id=:id")
        .param("id", profileId)
        .query(Long.class)
        .single();
  }

  public void revokeConnection(UUID userId, UUID connectionId) {
    jdbc.sql(
            """
            UPDATE profile_transfers SET state='REVOKED',wrapped_token=NULL
            WHERE user_id=:user AND connection_id=:connection
              AND (state<>'REVOKED' OR wrapped_token IS NOT NULL)
            """)
        .param("user", userId)
        .param("connection", connectionId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_profiles SET state='DELETING',version=version+1,updated_at=now()
            WHERE user_id=:user AND connection_id=:connection AND state='ACTIVE'
            """)
        .param("user", userId)
        .param("connection", connectionId)
        .update();
  }

  public boolean deletionReady(UUID userId, UUID connectionId) {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM connections WHERE user_id=:user AND id=:connection
              AND status='DELETING')
              AND NOT EXISTS(SELECT 1 FROM browser_sessions WHERE user_id=:user
                AND connection_id=:connection AND binding_released_at IS NULL)
              AND NOT EXISTS(SELECT 1 FROM profile_transfers WHERE user_id=:user
                AND connection_id=:connection AND upload_lease_until>now())
            """)
        .param("user", userId)
        .param("connection", connectionId)
        .query(Boolean.class)
        .single();
  }

  /** Removes one bounded metadata batch only after the entire object prefix was confirmed empty. */
  public boolean deleteConnectionBatch(UUID userId, UUID connectionId) {
    jdbc.sql(
            """
            UPDATE browser_profiles SET current_version_id=NULL
            WHERE user_id=:user AND connection_id=:connection AND state='DELETING'
            """)
        .param("user", userId)
        .param("connection", connectionId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_profile_versions SET state='DELETED',wrapped_dek='',vault_key_ref='',
              origins_manifest='{}'::jsonb,version=version+1 WHERE id IN (
              SELECT v.id FROM browser_profile_versions v JOIN browser_profiles p ON p.id=v.profile_id
              WHERE p.user_id=:user AND p.connection_id=:connection AND v.state<>'DELETED'
              ORDER BY v.id LIMIT 100)
            """)
        .param("user", userId)
        .param("connection", connectionId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_profiles p SET state='DELETED',version=version+1,updated_at=now()
            WHERE p.user_id=:user AND p.connection_id=:connection
              AND p.state='DELETING' AND NOT EXISTS(
                SELECT 1 FROM browser_profile_versions v WHERE v.profile_id=p.id AND v.state<>'DELETED')
            """)
        .param("user", userId)
        .param("connection", connectionId)
        .update();
    return !jdbc.sql(
            "SELECT EXISTS(SELECT 1 FROM browser_profiles WHERE user_id=:user AND"
                + " connection_id=:connection AND state<>'DELETED')")
        .param("user", userId)
        .param("connection", connectionId)
        .query(Boolean.class)
        .single();
  }

  public boolean saveInProgress(UUID connectionId) {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM profile_transfers WHERE connection_id=:connection
              AND direction='SAVE' AND state IN ('ISSUED','UPLOADING') AND expires_at>now())
            """)
        .param("connection", connectionId)
        .query(Boolean.class)
        .single();
  }

  public Version stage(
      UUID versionId, ProfileBinding binding, WrappedKey key, String runtimeVersion) {
    String objectKey =
        "u/"
            + binding.userId()
            + "/c/"
            + binding.connectionId()
            + "/p/"
            + binding.profileId()
            + "/v/"
            + binding.revision()
            + ".enc";
    jdbc.sql(
            """
            INSERT INTO browser_profile_versions(id,profile_id,revision,object_key,wrapped_dek,
              vault_key_ref,runtime_version,origins_manifest)
            VALUES(:id,:profile,:revision,:key,:wrapped,:reference,:runtime,CAST(:manifest AS jsonb))
            """)
        .param("id", versionId)
        .param("profile", binding.profileId())
        .param("revision", binding.revision())
        .param("key", objectKey)
        .param("wrapped", key.ciphertext())
        .param("reference", key.reference())
        .param("runtime", runtimeVersion)
        .param("manifest", json.write(binding))
        .update();
    return version(versionId);
  }

  public Version version(UUID id) {
    return jdbc.sql(
            """
            SELECT id,profile_id,revision,object_key,checksum,size,wrapped_dek,vault_key_ref,
              runtime_version,origins_manifest,state FROM browser_profile_versions WHERE id=:id
            """)
        .param("id", id)
        .query(Version.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public Transfer issue(
      UUID transferId,
      Version version,
      SessionScope scope,
      Profile profile,
      String direction,
      String tokenHash,
      String wrappedToken) {
    jdbc.sql(
            """
            INSERT INTO profile_transfers(id,version_id,user_id,connection_id,session_id,worker_id,
              boot_id,allocation_epoch,privacy_epoch,control_epoch,policy_version,scope_version,
              expected_profile_version,direction,token_hash,wrapped_token,expires_at)
            VALUES(:id,:version,:user,:connection,:session,:worker,:boot,:allocation,:privacy,:control,
              :policy,:scope,:profileVersion,:direction,:token,:wrapped,
              least(now()+interval '2 minutes',(SELECT deadline FROM browser_session_operations
                WHERE session_id=:session AND state IN ('QUIESCING','SAVING'))))
            """)
        .param("id", transferId)
        .param("version", version.id())
        .param("user", scope.userId())
        .param("connection", scope.connectionId())
        .param("session", scope.sessionId())
        .param("worker", scope.workerId())
        .param("boot", scope.bootId())
        .param("allocation", scope.allocationEpoch())
        .param("privacy", scope.privacyEpoch())
        .param("control", scope.controlEpoch())
        .param("policy", scope.policyVersion())
        .param("scope", scope.scopeVersion())
        .param("profileVersion", profile.version())
        .param("direction", direction)
        .param("token", tokenHash)
        .param("wrapped", wrappedToken)
        .update();
    return transfer(transferId);
  }

  public Transfer transfer(UUID id) {
    return jdbc.sql("SELECT * FROM profile_transfers WHERE id=:id FOR UPDATE")
        .param("id", id)
        .query(Transfer.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public UUID transferOwner(UUID id) {
    return jdbc.sql("SELECT user_id FROM profile_transfers WHERE id=:id")
        .param("id", id)
        .query(UUID.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public UUID saveTransferId(UUID userId, UUID versionId) {
    return jdbc.sql(
            "SELECT id FROM profile_transfers WHERE user_id=:user AND version_id=:version AND"
                + " direction='SAVE'")
        .param("user", userId)
        .param("version", versionId)
        .query(UUID.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public boolean currentVersionMatches(UUID userId, UUID connectionId, UUID expectedVersion) {
    return jdbc.sql(
            """
            SELECT (SELECT current_version_id FROM browser_profiles WHERE connection_id=:id AND user_id=:user)
              IS NOT DISTINCT FROM CAST(:expected AS uuid)
            """)
        .param("id", connectionId)
        .param("user", userId)
        .param("expected", expectedVersion)
        .query(Boolean.class)
        .single();
  }

  public void beginUpload(UUID id, String checksum, long size) {
    jdbc.sql(
            """
            UPDATE profile_transfers SET state='UPLOADING',checksum=:checksum,size=:size,
            upload_lease_until=now()+interval '3 minutes' WHERE id=:id
            """)
        .param("id", id)
        .param("checksum", checksum)
        .param("size", size)
        .update();
  }

  public void finishUpload(UUID id) {
    jdbc.sql("UPDATE profile_transfers SET upload_lease_until=NULL WHERE id=:id")
        .param("id", id)
        .update();
  }

  public void publish(Transfer transfer, Version version, String checksum, long size) {
    if (jdbc.sql(
                """
                UPDATE browser_profile_versions SET state='READY',checksum=:checksum,size=:size,
                  version=version+1 WHERE id=:id AND state='STAGED'
                """)
            .param("checksum", checksum)
            .param("size", size)
            .param("id", version.id())
            .update()
        != 1) {
      throw DomainException.conflict(
          "PROFILE_VERSION_CONFLICT", "The staged profile is no longer publishable");
    }
    if (jdbc.sql(
                """
                UPDATE browser_profiles SET current_version_id=:version,version=version+1,updated_at=now()
                WHERE id=:profile AND version=:expected AND state='ACTIVE'
                """)
            .param("version", version.id())
            .param("profile", version.profileId())
            .param("expected", transfer.expectedProfileVersion())
            .update()
        != 1) {
      throw DomainException.conflict(
          "PROFILE_VERSION_CONFLICT", "A newer profile is already current");
    }
    jdbc.sql("UPDATE profile_transfers SET state='READY' WHERE id=:id")
        .param("id", transfer.id())
        .update();
  }
}
