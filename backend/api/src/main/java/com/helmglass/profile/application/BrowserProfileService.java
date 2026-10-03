package com.helmglass.profile.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.artifact.infrastructure.ObjectStorage.ObjectMetadata;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.profile.domain.ProfileBinding;
import com.helmglass.profile.domain.ProfileScope;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import com.helmglass.profile.infrastructure.ProfileKeyService.WrappedKey;
import com.helmglass.profile.infrastructure.repository.ProfileRepository;
import com.helmglass.profile.infrastructure.repository.ProfileRepository.SessionScope;
import com.helmglass.profile.infrastructure.repository.ProfileRepository.Transfer;
import com.helmglass.profile.infrastructure.repository.ProfileRepository.Version;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.SequenceInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import software.amazon.awssdk.core.exception.SdkException;

/** Owns immutable encrypted profile versions and assignment-fenced transfer capabilities. */
@Service
public class BrowserProfileService {
  public record Grant(UUID workerId, UUID profileVersionId, Map<String, Object> message) {
    @Override
    public String toString() {
      return "ProfileTransferGrant[redacted]";
    }
  }

  public record Receipt(String sha256, long byteLength) {}

  public record SaveStatus(String state, Instant expiresAt) {}

  private record Prepared(
      SessionScope scope,
      Version version,
      Transfer transfer,
      ProfileBinding binding,
      String token) {
    @Override
    public String toString() {
      return "PreparedProfile[redacted]";
    }
  }

  private static final long MAX_BYTES = 33_554_464;
  private static final String BUCKET = "hg-browser-profiles";
  private final ProfileRepository profiles;
  private final IdentityRepository identities;
  private final UserPolicyService policies;
  private final ChangeRepository changes;
  private final ProfileKeyService keys;
  private final ObjectStorage storage;
  private final JsonSupport json;
  private final TransactionTemplate transaction;
  private final SecureRandom random = new SecureRandom();

  public BrowserProfileService(
      ProfileRepository profiles,
      IdentityRepository identities,
      UserPolicyService policies,
      ChangeRepository changes,
      ProfileKeyService keys,
      ObjectStorage storage,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.profiles = profiles;
    this.identities = identities;
    this.policies = policies;
    this.changes = changes;
    this.keys = keys;
    this.storage = storage;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
    transaction.setTimeout(5);
  }

  /** Fences profile creators in the connection owner's deletion transaction. */
  public void revokeConnection(UUID userId, UUID connectionId) {
    profiles.revokeConnection(userId, connectionId);
  }

  /** Replays only idempotent deletion after runtime closure and admitted upload leases expire. */
  public boolean deleteConnection(UUID userId, UUID connectionId) {
    boolean ready =
        transact(
            () -> {
              identities.lockState(userId);
              return profiles.deletionReady(userId, connectionId);
            });
    if (!ready || !storage.purgeConnectionProfilesBatch(userId, connectionId)) {
      return false;
    }
    return transact(
        () -> {
          identities.lockState(userId);
          return profiles.deletionReady(userId, connectionId)
              && profiles.deleteConnectionBatch(userId, connectionId);
        });
  }

  /** Called by the connection/control owner after user save intent, at a quiescent boundary. */
  public Grant prepareSave(UUID userId, UUID sessionId, UUID connectionId, boolean confirmed) {
    return transact(
        () -> {
          SessionScope scope = saveScope(userId, sessionId, connectionId, confirmed);
          var profile = profiles.profile(userId, connectionId);
          if (profiles.saveInProgress(connectionId)) {
            throw DomainException.conflict(
                "PROFILE_SAVE_IN_PROGRESS", "A profile save is in progress");
          }
          List<String> origins = admittedOrigins(userId, connectionId);
          // Hold the account admission row across bounded key creation. Purge cannot delete the
          // wrapping key and then race a previously admitted creator into recreating it.
          try (var material = keys.create(userId)) {
            ProfileBinding binding =
                new ProfileBinding(
                    userId,
                    connectionId,
                    profile.id(),
                    profiles.nextRevision(profile.id()),
                    scope.scopeVersion(),
                    1,
                    origins,
                    ProfileScope.cookieDomains(origins));
            Version version =
                profiles.stage(
                    UUID.randomUUID(), binding, material.wrapped(), scope.imageVersion());
            String token = token();
            Transfer transfer =
                profiles.issue(
                    UUID.randomUUID(),
                    version,
                    scope,
                    profile,
                    "SAVE",
                    JsonSupport.sha256(token),
                    wrapToken(userId, token));
            return grant(
                new Prepared(scope, version, transfer, binding, token), material.plaintext());
          }
        });
  }

  /** Called once before any page action in a newly assigned, empty context. */
  public Grant prepareLoad(UUID userId, UUID sessionId, UUID connectionId) {
    Prepared prepared =
        transact(
            () -> {
              identities.lockActive(userId);
              SessionScope scope = profiles.scope(userId, sessionId, connectionId);
              var profile = profiles.profile(userId, connectionId);
              if (profile.currentVersionId() == null) {
                throw DomainException.conflict("PROFILE_MISSING", "A fresh login is required");
              }
              Version version = profiles.version(profile.currentVersionId());
              ProfileBinding binding = json.read(version.originsManifest(), ProfileBinding.class);
              if (!version.state().equals("READY")
                  || !version.runtimeVersion().equals(scope.imageVersion())
                  || binding.scopeVersion() != scope.scopeVersion()
                  || !binding.userId().equals(userId)
                  || !binding.connectionId().equals(connectionId)
                  || !admittedOrigins(userId, connectionId).containsAll(binding.storageOrigins())) {
                throw DomainException.conflict(
                    "PROFILE_INCOMPATIBLE", "Profile scope or runtime has changed");
              }
              String token = token();
              Transfer transfer =
                  profiles.issue(
                      UUID.randomUUID(),
                      version,
                      scope,
                      profile,
                      "LOAD",
                      JsonSupport.sha256(token),
                      wrapToken(userId, token));
              return new Prepared(scope, version, transfer, binding, token);
            });
    byte[] key =
        keys.unwrap(
            userId,
            new WrappedKey(prepared.version().vaultKeyRef(), prepared.version().wrappedDek()));
    try {
      transact(
          () ->
              authorize(
                  prepared.transfer().id(),
                  prepared.token(),
                  prepared.scope().workerId(),
                  prepared.scope().bootId(),
                  "LOAD"));
      return grant(prepared, key);
    } finally {
      Arrays.fill(key, (byte) 0);
    }
  }

  /** Confirms a persisted publication; this acknowledgement does not grant another upload. */
  public Map<String, Object> confirmSaved(
      UUID workerId,
      UUID bootId,
      UUID sessionId,
      UUID transferId,
      String checksum,
      long byteLength) {
    return transact(
        () -> {
          identities.lockState(profiles.transferOwner(transferId));
          Transfer transfer = profiles.transfer(transferId);
          if (!transfer.state().equals("READY")
              || !transfer.direction().equals("SAVE")
              || !workerId.equals(transfer.workerId())
              || !bootId.equals(transfer.bootId())
              || !sessionId.equals(transfer.sessionId())
              || !Objects.equals(checksum, transfer.checksum())
              || transfer.size() == null
              || transfer.size() != byteLength) {
            throw DomainException.conflict(
                "PROFILE_RECEIPT_MISMATCH", "Profile publication receipt does not match");
          }
          return Map.of(
              "browserSessionId",
              sessionId,
              "allocationEpoch",
              transfer.allocationEpoch(),
              "transferId",
              transferId,
              "sha256",
              checksum);
        });
  }

  /** Reconstructs the original capability without creating a new transfer or profile revision. */
  public Grant reissueSave(UUID userId, UUID transferId) {
    return transact(
        () -> {
          identities.lockActive(userId);
          Transfer transfer = profiles.transfer(transferId);
          if (!transfer.userId().equals(userId)) {
            throw DomainException.notFound();
          }
          if (transfer.wrappedToken() == null || transfer.state().equals("READY")) {
            throw DomainException.conflict(
                "PROFILE_REDELIVERY_UNAVAILABLE", "The transfer cannot be redelivered");
          }
          byte[] tokenBytes =
              keys.unwrap(userId, new WrappedKey("profiles/" + userId, transfer.wrappedToken()));
          try {
            String token = Base64.getUrlEncoder().withoutPadding().encodeToString(tokenBytes);
            authorize(transferId, token, transfer.workerId(), transfer.bootId(), "SAVE");
            SessionScope scope =
                profiles.scope(userId, transfer.sessionId(), transfer.connectionId());
            Version version = profiles.version(transfer.versionId());
            ProfileBinding binding = json.read(version.originsManifest(), ProfileBinding.class);
            byte[] key =
                keys.unwrap(userId, new WrappedKey(version.vaultKeyRef(), version.wrappedDek()));
            try {
              return grant(new Prepared(scope, version, transfer, binding, token), key);
            } finally {
              Arrays.fill(key, (byte) 0);
            }
          } finally {
            Arrays.fill(tokenBytes, (byte) 0);
          }
        });
  }

  public Grant reissueSavedVersion(UUID userId, UUID profileVersionId) {
    return reissueSave(userId, profiles.saveTransferId(userId, profileVersionId));
  }

  public SaveStatus saveStatus(UUID userId, UUID transferId) {
    return transact(
        () -> {
          identities.lockActive(userId);
          Transfer transfer = profiles.transfer(transferId);
          if (!transfer.userId().equals(userId) || !transfer.direction().equals("SAVE")) {
            throw DomainException.notFound();
          }
          return new SaveStatus(transfer.state(), transfer.expiresAt());
        });
  }

  public void requireCurrentVersion(UUID userId, UUID connectionId, UUID expectedVersion) {
    if (!profiles.currentVersionMatches(userId, connectionId, expectedVersion)) {
      throw DomainException.conflict(
          "PROFILE_VERSION_CONFLICT", "Refresh the connection profile before saving");
    }
  }

  public Receipt upload(
      UUID transferId,
      String token,
      UUID workerId,
      UUID bootId,
      long length,
      String checksum,
      InputStream bytes)
      throws IOException {
    if (length < 33
        || length > MAX_BYTES
        || checksum == null
        || !checksum.matches("[a-f0-9]{64}")) {
      throw new DomainException(
          422, "PROFILE_UPLOAD_INVALID", "Ciphertext size and checksum are required");
    }
    Transfer transfer =
        transact(
            () -> {
              Transfer current = authorize(transferId, token, workerId, bootId, "SAVE");
              if (current.checksum() != null
                  && (!current.checksum().equals(checksum)
                      || current.size() == null
                      || current.size() != length)) {
                throw DomainException.conflict(
                    "PROFILE_UPLOAD_MISMATCH", "Transfer bytes cannot be replaced");
              }
              if (!current.state().equals("READY")) {
                if (current.uploadLeaseUntil() == null
                    || !current.uploadLeaseUntil().isAfter(Instant.now())) {
                  profiles.beginUpload(transferId, checksum, length);
                }
              }
              return current;
            });
    if (transfer.state().equals("READY")) {
      return new Receipt(checksum, length);
    }
    Version version = profiles.version(transfer.versionId());
    var confirmed = storage.metadata(BUCKET, version.objectKey());
    if (confirmed.isEmpty()) {
      if (transfer.uploadLeaseUntil() != null
          && transfer.uploadLeaseUntil().isAfter(Instant.now())) {
        throw DomainException.conflict(
            "PROFILE_UPLOAD_PENDING", "The existing upload is still being resolved");
      }
      byte[] header = bytes.readNBytes(4);
      if (!Arrays.equals(header, new byte[] {'H', 'G', 'P', '1'})) {
        throw new DomainException(
            422, "PROFILE_FORMAT", "Only encrypted profile format v1 is accepted");
      }
      // Reading a stalled request prefix can outlive deletion or the admitted upload lease.
      // Recheck before any external PUT and leave time to reconcile an unconfirmed response.
      Instant uploadDeadline =
          transact(
              () -> {
                Transfer current = authorize(transferId, token, workerId, bootId, "SAVE");
                if (current.uploadLeaseUntil() == null) {
                  throw DomainException.conflict(
                      "PROFILE_UPLOAD_PENDING", "Upload admission is missing");
                }
                Instant leaseDeadline = current.uploadLeaseUntil().minusSeconds(30);
                return leaseDeadline.isBefore(current.expiresAt())
                    ? leaseDeadline
                    : current.expiresAt();
              });
      try {
        storage.putImmutable(
            BUCKET,
            version.objectKey(),
            new SequenceInputStream(new ByteArrayInputStream(header), bytes),
            length,
            checksum,
            "application/vnd.helm.profile-encrypted",
            uploadDeadline);
      } catch (SdkException error) {
        // PUT is conditional and immutable. Only a matching stored checksum can resolve a lost
        // response; absence is reported as unknown, never treated as successful publication.
        confirmed = storage.metadata(BUCKET, version.objectKey());
        if (confirmed.isEmpty()) {
          throw new DomainException(
              503, "PROFILE_UPLOAD_UNCONFIRMED", "Encrypted upload is unconfirmed");
        }
      }
      if (confirmed.isEmpty()) {
        confirmed = storage.metadata(BUCKET, version.objectKey());
      }
    }
    ObjectMetadata metadata =
        confirmed.orElseThrow(
            () ->
                new DomainException(
                    503, "PROFILE_UPLOAD_UNCONFIRMED", "Encrypted object is not confirmed"));
    if (metadata.size() != length || !checksum.equals(metadata.sha256())) {
      throw DomainException.conflict(
          "PROFILE_OBJECT_MISMATCH", "Stored object does not match the transfer");
    }
    transact(
        () -> {
          Transfer current = authorize(transferId, token, workerId, bootId, "SAVE");
          if (!current.state().equals("READY")) {
            profiles.publish(current, version, checksum, length);
            changes.changed(
                current.userId(), "connections", current.connectionId(), current.scopeVersion());
          }
          profiles.finishUpload(transferId);
          return true;
        });
    return new Receipt(checksum, length);
  }

  public void download(
      UUID transferId, String token, UUID workerId, UUID bootId, OutputStream output)
      throws IOException {
    Transfer transfer = transact(() -> authorize(transferId, token, workerId, bootId, "LOAD"));
    Version version = profiles.version(transfer.versionId());
    try (var input = storage.open(BUCKET, version.objectKey())) {
      if (version.size() == null
          || !version.size().equals(input.response().contentLength())
          || version.size() > MAX_BYTES) {
        throw new DomainException(
            503, "PROFILE_OBJECT_MISMATCH", "Encrypted profile size is unverified");
      }
      byte[] buffer = new byte[65_536];
      long copied = 0;
      long checkedAt = 0;
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (copied == 0 || copied - checkedAt >= 1_048_576) {
          transact(() -> authorize(transferId, token, workerId, bootId, "LOAD"));
          checkedAt = copied;
        }
        copied += count;
        if (copied > version.size()) {
          throw new IOException("Encrypted object exceeded its committed size");
        }
        output.write(buffer, 0, count);
      }
      if (copied != version.size()) {
        throw new IOException("Encrypted object was truncated");
      }
    }
  }

  private SessionScope saveScope(
      UUID userId, UUID sessionId, UUID connectionId, boolean confirmed) {
    identities.lockActive(userId);
    SessionScope scope = profiles.scope(userId, sessionId, connectionId);
    if (!confirmed && !scope.savePreference().equals("SAVE")) {
      throw new DomainException(
          403, "PROFILE_SAVE_CONSENT", "Profile saving requires user consent");
    }
    if (!scope.controlState().equals("QUIESCED")) {
      throw DomainException.conflict(
          "PROFILE_NOT_QUIESCENT", "Pause browser actions before saving");
    }
    return scope;
  }

  private Transfer authorize(
      UUID transferId, String token, UUID workerId, UUID bootId, String direction) {
    identities.lockActive(profiles.transferOwner(transferId));
    Transfer transfer = profiles.transfer(transferId);
    if (token == null
        || !MessageDigest.isEqual(
            JsonSupport.sha256(token).getBytes(StandardCharsets.US_ASCII),
            transfer.tokenHash().getBytes(StandardCharsets.US_ASCII))
        || !transfer.workerId().equals(workerId)
        || !transfer.bootId().equals(bootId)
        || !transfer.direction().equals(direction)
        || transfer.state().equals("REVOKED")
        || !transfer.expiresAt().isAfter(Instant.now())) {
      throw new DomainException(
          403, "PROFILE_TRANSFER_DENIED", "Profile transfer is no longer authorized");
    }
    SessionScope scope =
        profiles.scope(transfer.userId(), transfer.sessionId(), transfer.connectionId());
    if (!scope.workerId().equals(workerId)
        || !scope.bootId().equals(bootId)
        || scope.allocationEpoch() != transfer.allocationEpoch()
        || scope.controlEpoch() != transfer.controlEpoch()
        || scope.privacyEpoch() != transfer.privacyEpoch()
        || scope.policyVersion() != transfer.policyVersion()
        || scope.scopeVersion() != transfer.scopeVersion()
        || (scope.ownerKind().equals("HUMAN")
            && !scope.controlState().equals("QUIESCED")
            && !scope.controlExpiresAt().isAfter(Instant.now()))) {
      throw new DomainException(403, "PROFILE_TRANSFER_STALE", "Profile assignment has changed");
    }
    return transfer;
  }

  private List<String> admittedOrigins(UUID userId, UUID connectionId) {
    List<String> origins = profiles.origins(userId, connectionId);
    for (String origin : origins) {
      policies.authorize(userId, "NAVIGATE", origin);
    }
    return origins;
  }

  private Grant grant(Prepared prepared, byte[] key) {
    SessionScope scope = prepared.scope();
    Map<String, Object> message = new LinkedHashMap<>();
    message.put("schemaVersion", 1);
    message.put("requestId", prepared.transfer().id());
    message.put(
        "type", prepared.transfer().direction().equals("SAVE") ? "profileSave" : "profileLoad");
    message.put("browserSessionId", scope.sessionId());
    message.put("allocationEpoch", scope.allocationEpoch());
    message.put("privacyEpoch", scope.privacyEpoch());
    message.put("controlEpoch", scope.controlEpoch());
    message.put("policyVersion", scope.policyVersion());
    message.put("expiresAt", prepared.transfer().expiresAt());
    message.put("transferId", prepared.transfer().id());
    message.put("transferToken", prepared.token());
    message.put("dek", Base64.getEncoder().encodeToString(key));
    message.put("binding", prepared.binding());
    return new Grant(scope.workerId(), prepared.version().id(), Map.copyOf(message));
  }

  private String token() {
    byte[] bytes = new byte[32];
    random.nextBytes(bytes);
    try {
      return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    } finally {
      Arrays.fill(bytes, (byte) 0);
    }
  }

  private String wrapToken(UUID userId, String token) {
    byte[] bytes = Base64.getUrlDecoder().decode(token);
    try {
      return keys.wrapTransferToken(userId, bytes).ciphertext();
    } finally {
      Arrays.fill(bytes, (byte) 0);
    }
  }

  private <T> T transact(Supplier<T> operation) {
    T result = transaction.execute(status -> operation.get());
    if (result == null) {
      throw new IllegalStateException("Profile transaction returned no result");
    }
    return result;
  }
}
