package com.helmglass.artifact.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.artifact.api.ArtifactContracts;
import com.helmglass.artifact.api.ArtifactContracts.Allocation;
import com.helmglass.artifact.api.ArtifactContracts.CaptureMetadata;
import com.helmglass.artifact.api.ArtifactContracts.Metadata;
import com.helmglass.artifact.api.ArtifactContracts.Receipt;
import com.helmglass.artifact.api.ArtifactContracts.ScreenshotMetadata;
import com.helmglass.artifact.domain.ByteRange;
import com.helmglass.artifact.domain.PngHeader;
import com.helmglass.artifact.infrastructure.MultipartStorage;
import com.helmglass.artifact.infrastructure.MultipartStorage.Part;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.artifact.infrastructure.repository.ArtifactRepository;
import com.helmglass.artifact.infrastructure.repository.ArtifactRepository.Artifact;
import com.helmglass.artifact.infrastructure.repository.ArtifactRepository.Scope;
import com.helmglass.artifact.infrastructure.repository.ArtifactRepository.Transfer;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.usage.application.UsageProjectionService;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.services.s3.model.S3Exception;

/** Owns private immutable artifact admission, resumable transfer, verification and retrieval. */
@Service
@Slf4j
public class ArtifactService {
  public record Content(String mime, String filename, String checksum, ByteRange range) {}

  public record AudioSource(
      UUID artifactId,
      UUID taskId,
      String mimeType,
      long byteLength,
      String sha256,
      Metadata metadata) {}

  private record Upload(Transfer transfer, Artifact artifact) {}

  private static final List<String> AUDIO_MIME =
      List.of(
          "audio/wav",
          "audio/mpeg",
          "audio/ogg",
          "audio/flac",
          "audio/mp4",
          "audio/webm",
          "audio/x-matroska",
          "video/mp4",
          "video/webm",
          "application/octet-stream");
  private final ArtifactRepository artifacts;
  private final IdentityRepository identities;
  private final UserPolicyService policies;
  private final OperationRepository operations;
  private final ChangeRepository changes;
  private final UsageProjectionService usage;
  private final ObjectStorage storage;
  private final MultipartStorage multipart;
  private final JsonSupport json;
  private final TransactionTemplate transaction;
  private final SecureRandom random = new SecureRandom();
  private final ScheduledThreadPoolExecutor downloadTimeouts =
      new ScheduledThreadPoolExecutor(
          1, Thread.ofPlatform().daemon().name("artifact-download-deadline").factory());
  private String cleanupKeyMarker;
  private String cleanupUploadMarker;

  public ArtifactService(
      ArtifactRepository artifacts,
      IdentityRepository identities,
      UserPolicyService policies,
      OperationRepository operations,
      ChangeRepository changes,
      UsageProjectionService usage,
      ObjectStorage storage,
      MultipartStorage multipart,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.artifacts = artifacts;
    this.identities = identities;
    this.policies = policies;
    this.operations = operations;
    this.changes = changes;
    this.usage = usage;
    this.storage = storage;
    this.multipart = multipart;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
    transaction.setTimeout(5);
    downloadTimeouts.setRemoveOnCancelPolicy(true);
  }

  @PreDestroy
  void closeDownloadTimeouts() {
    downloadTimeouts.shutdownNow();
  }

  public Allocation allocate(UUID workerId, UUID bootId, CaptureMetadata metadata) {
    if (metadata instanceof Metadata audio) {
      audio.validateTimeline();
      if (!AUDIO_MIME.contains(audio.mimeType())) {
        throw new DomainException(
            422, "ARTIFACT_FORMAT_INVALID", "Unsupported probed media format");
      }
    }
    return transact(
        () -> {
          UUID userId = artifacts.ownerOfAttempt(metadata.attemptId(), metadata.kind());
          identities.lockActive(userId);
          Scope scope = artifacts.scope(metadata.attemptId(), metadata.kind());
          validateScope(scope, workerId, bootId, metadata);
          policies.authorize(userId, action(metadata.kind()), scope.currentUrl());
          String hash = json.digest(metadata);
          String token = token();
          var existing = artifacts.forAttempt(metadata.attemptId(), metadata.kind());
          Transfer transfer;
          if (existing.isPresent()) {
            transfer = existing.get();
            if (!hash.equals(transfer.metadataHash())) {
              throw DomainException.conflict(
                  "ARTIFACT_METADATA_MISMATCH", "Attempt already has different media");
            }
            requireAvailable(transfer);
            if (transfer.uploadLeaseUntil() != null
                && transfer.uploadLeaseUntil().isAfter(Instant.now())) {
              throw DomainException.conflict("ARTIFACT_UPLOAD_BUSY", "An upload is still active");
            }
            artifacts.rotateToken(transfer.id(), JsonSupport.sha256(token));
          } else {
            Long maximum = policies.getForExecution(userId).maxRetainedMediaBytes();
            if (maximum != null
                && metadata.byteLength() > maximum - artifacts.reservedBytes(userId)) {
              throw new DomainException(
                  409, "MEDIA_QUOTA_EXCEEDED", "Retained media limit is reached");
            }
            transfer = artifacts.create(scope, metadata, hash, JsonSupport.sha256(token));
          }
          return new Allocation(transfer.artifactId(), transfer.id(), token);
        });
  }

  public Receipt upload(
      UUID id,
      String token,
      UUID workerId,
      UUID bootId,
      long length,
      String checksum,
      InputStream input)
      throws IOException {
    UUID leaseId = UUID.randomUUID();
    Upload upload =
        transact(
            () -> {
              Transfer transfer = authorize(id, token, workerId, bootId);
              Artifact artifact = artifacts.artifact(transfer.artifactId());
              if (length != artifact.size() || !artifact.checksum().equals(checksum)) {
                throw DomainException.conflict(
                    "ARTIFACT_BYTES_MISMATCH", "Upload does not match its immutable metadata");
              }
              if (!transfer.state().equals("READY")) {
                artifacts.claim(id, leaseId);
              }
              return new Upload(transfer, artifact);
            });
    Artifact artifact = upload.artifact();
    if (upload.transfer().state().equals("READY")) {
      return receipt(artifact);
    }
    Runnable guard =
        () ->
            transact(
                () -> {
                  authorize(id, token, workerId, bootId);
                  artifacts.renew(id, leaseId);
                  return true;
                });
    try {
      if (storage.metadata(artifact.bucket(), artifact.objectKey()).isEmpty()) {
        receive(artifact, upload.transfer(), leaseId, input, guard);
      }
      verify(artifact, guard);
      transact(
          () -> {
            Transfer current = authorize(id, token, workerId, bootId);
            artifacts.renew(id, leaseId);
            artifacts.publish(current, artifact);
            usage.refresh(artifact.userId(), artifact.taskId());
            changes.changed(artifact.userId(), "artifacts", artifact.id(), artifact.version() + 1);
            if (current.captureKind().equals("AUDIO")) {
              changes.changed(artifact.userId(), "audio", artifact.id(), artifact.version() + 1);
            }
            changes.changed(artifact.userId(), "usage", artifact.id(), artifact.version() + 1);
            return true;
          });
      return receipt(artifact);
    } finally {
      artifacts.release(id, leaseId);
    }
  }

  public Map<String, Object> metadata(AuthenticatedActor actor, UUID id) {
    Artifact artifact = readable(actor, id);
    return Map.of(
        "id",
        id,
        "taskId",
        artifact.taskId(),
        "state",
        artifact.state(),
        "mimeType",
        artifact.mime(),
        "byteLength",
        artifact.size(),
        "sha256",
        artifact.checksum(),
        "filename",
        artifact.filename(),
        "version",
        artifact.version(),
        "provenance",
        json.read(artifact.provenance()));
  }

  public Content content(AuthenticatedActor actor, UUID id, String range) {
    Artifact artifact = readable(actor, id);
    return new Content(
        artifact.mime(),
        artifact.filename(),
        artifact.checksum(),
        ByteRange.parse(range, artifact.size()));
  }

  public AudioSource audioSource(AuthenticatedActor actor, UUID id) {
    Artifact artifact = readable(actor, id);
    if (!json.read(artifact.provenance()).path("kind").asString().equals("AUDIO")) {
      throw DomainException.notFound();
    }
    Metadata metadata = json.read(artifact.provenance(), Metadata.class);
    return new AudioSource(
        id, artifact.taskId(), artifact.mime(), artifact.size(), artifact.checksum(), metadata);
  }

  public void download(
      AuthenticatedActor actor, UUID id, Content content, OutputStream output, Instant deadline)
      throws IOException {
    Artifact artifact = readable(actor, id);
    ByteRange range = content.range();
    if (range.total() != artifact.size() || !content.checksum().equals(artifact.checksum())) {
      throw DomainException.conflict("ARTIFACT_CHANGED", "Artifact changed before download");
    }
    Duration remaining = Duration.between(Instant.now(), deadline);
    if (remaining.isNegative() || remaining.isZero()) {
      throw new DomainException(
          504, "ARTIFACT_DOWNLOAD_TIMEOUT", "Artifact download deadline expired");
    }
    try (var input =
        storage.open(artifact.bucket(), artifact.objectKey(), range.requestHeader(), remaining)) {
      long remainingNanos = Math.max(0, Duration.between(Instant.now(), deadline).toNanos());
      var timeout = downloadTimeouts.schedule(input::abort, remainingNanos, TimeUnit.NANOSECONDS);
      boolean complete = false;
      try {
        if (input.response().contentLength() != range.length()) {
          throw new DomainException(
              503, "ARTIFACT_STORAGE_MISMATCH", "Stored artifact length is unverified");
        }
        copyBounded(
            input,
            output,
            range.length(),
            () -> {
              if (Thread.currentThread().isInterrupted() || !Instant.now().isBefore(deadline)) {
                throw new DomainException(
                    504, "ARTIFACT_DOWNLOAD_TIMEOUT", "Artifact download deadline expired");
              }
              readable(actor, id);
            },
            null);
        complete = true;
      } finally {
        timeout.cancel(false);
        if (!complete) {
          input.abort();
        }
      }
    }
  }

  public MutationReceipt delete(
      AuthenticatedActor actor, UUID id, long version, MutationContext context) {
    actor.requireScope("tasks:write");
    return transact(
        () -> {
          identities.lockActive(actor.userId());
          var payload = Map.of("artifactId", id, "expectedVersion", version);
          var replay = operations.replay(actor, "artifacts.delete:" + id, context, payload);
          if (replay.isPresent()) {
            return replay.get();
          }
          Artifact artifact = artifacts.owned(actor.userId(), id);
          DomainException.requireVersion(artifact.version(), version);
          artifacts.markDeleting(id);
          changes.changed(actor.userId(), "artifacts", id, artifact.version() + 1);
          return operations.save(
              actor,
              "artifacts.delete:" + id,
              context,
              payload,
              "artifact",
              id,
              artifact.version() + 1,
              false);
        });
  }

  @Scheduled(fixedDelay = 10000)
  public synchronized void clean() {
    for (UUID id : artifacts.expired()) {
      transact(
          () -> {
            artifacts.lockOwner(artifacts.artifact(id).userId());
            artifacts.markDeleting(id);
            return true;
          });
    }
    for (Artifact artifact : artifacts.deletions()) {
      try {
        for (var pending : multipart.pending(artifact.bucket(), artifact.objectKey())) {
          abort(artifact.bucket(), pending.key(), pending.uploadId());
        }
        storage.delete(artifact.bucket(), artifact.objectKey());
        transact(
            () -> {
              artifacts.deleted(artifact.id());
              operations.completeForTarget(artifact.id(), "artifacts.delete:" + artifact.id());
              changes.changed(
                  artifact.userId(), "artifacts", artifact.id(), artifact.version() + 1);
              return true;
            });
      } catch (SdkException error) {
        log.warn("Artifact deletion awaits storage reconciliation: {}", artifact.id());
      }
    }
    cleanOrphanUploads();
  }

  private void cleanOrphanUploads() {
    try {
      var page = multipart.inventory("hg-artifacts", "u/", cleanupKeyMarker, cleanupUploadMarker);
      for (var pending : page.uploads()) {
        if (artifacts.mayRemoveUpload("hg-artifacts", pending.key())) {
          abort("hg-artifacts", pending.key(), pending.uploadId());
        }
      }
      cleanupKeyMarker = page.keyMarker();
      cleanupUploadMarker = page.uploadIdMarker();
    } catch (SdkException error) {
      log.warn("Artifact multipart reconciliation awaits storage availability");
    }
  }

  private void abort(String bucket, String key, String uploadId) {
    try {
      multipart.abort(bucket, key, uploadId);
    } catch (S3Exception error) {
      if (error.statusCode() != 404) {
        throw error;
      }
    }
  }

  private void receive(
      Artifact artifact, Transfer transfer, UUID leaseId, InputStream input, Runnable guard)
      throws IOException {
    String uploadId = artifact.uploadId();
    if (uploadId == null) {
      guard.run();
      boolean firstRequest = transact(() -> artifacts.requestCreate(transfer.id(), leaseId));
      if (firstRequest) {
        uploadId =
            multipart.create(
                artifact.bucket(), artifact.objectKey(), artifact.mime(), artifact.checksum());
      } else {
        var pending = multipart.pending(artifact.bucket(), artifact.objectKey());
        if (pending.size() != 1) {
          throw new DomainException(
              503, "ARTIFACT_CREATE_UNCONFIRMED", "Multipart creation outcome is unconfirmed");
        }
        uploadId = pending.getFirst().uploadId();
      }
      guard.run();
      artifacts.uploadId(artifact.id(), uploadId, transfer.id(), leaseId);
    }
    List<Part> remote = multipart.parts(artifact.bucket(), artifact.objectKey(), uploadId);
    long remaining = artifact.size();
    int number = 1;
    while (remaining > 0) {
      guard.run();
      int count = (int) Math.min(remaining, ArtifactContracts.PART_BYTES);
      byte[] bytes = input.readNBytes(count);
      if (bytes.length != count) {
        throw new IOException("Artifact upload was truncated");
      }
      String digest = JsonSupport.sha256(bytes);
      artifacts.reservePart(artifact.id(), number, digest, bytes.length);
      Part uploaded = findPart(remote, number);
      if (uploaded != null && (uploaded.size() != count || !uploaded.sha256().equals(digest))) {
        throw DomainException.conflict("ARTIFACT_PART_MISMATCH", "Stored multipart bytes differ");
      }
      if (uploaded == null) {
        try {
          uploaded =
              multipart.upload(
                  artifact.bucket(), artifact.objectKey(), uploadId, number, bytes, digest);
        } catch (SdkException error) {
          uploaded =
              findPart(multipart.parts(artifact.bucket(), artifact.objectKey(), uploadId), number);
          if (uploaded == null || uploaded.size() != count || !uploaded.sha256().equals(digest)) {
            throw new DomainException(
                503, "ARTIFACT_PART_UNCONFIRMED", "Part upload outcome is unconfirmed");
          }
        }
      }
      guard.run();
      artifacts.confirmPart(artifact.id(), uploaded);
      remaining -= count;
      number++;
    }
    if (input.read() != -1) {
      throw new DomainException(413, "ARTIFACT_SIZE_EXCEEDED", "Upload exceeds its admitted size");
    }
    guard.run();
    try {
      multipart.complete(
          artifact.bucket(), artifact.objectKey(), uploadId, artifacts.parts(artifact.id()));
    } catch (SdkException error) {
      if (storage.metadata(artifact.bucket(), artifact.objectKey()).isEmpty()) {
        throw new DomainException(
            503, "ARTIFACT_COMPLETE_UNCONFIRMED", "Multipart completion is unconfirmed");
      }
    }
  }

  private void verify(Artifact artifact, Runnable guard) throws IOException {
    var head =
        storage
            .metadata(artifact.bucket(), artifact.objectKey())
            .orElseThrow(
                () ->
                    new DomainException(
                        503, "ARTIFACT_NOT_STORED", "Object storage has not confirmed the upload"));
    if (head.size() != artifact.size()) {
      throw DomainException.conflict("ARTIFACT_CHECKSUM_MISMATCH", "Stored artifact size differs");
    }
    // Verify bytes even when a backend supplies a checksum: deployment acceptance must establish
    // full-object SHA-256 semantics before a HEAD-only optimization can be enabled.
    MessageDigest digest = sha256();
    try (var input = storage.open(artifact.bucket(), artifact.objectKey())) {
      long remaining = artifact.size();
      if (artifact.mime().equals("image/png")) {
        var metadata = json.read(artifact.provenance(), ScreenshotMetadata.class);
        guard.run();
        byte[] header = input.readNBytes(PngHeader.BYTES);
        PngHeader.verify(header, metadata.viewport().width(), metadata.viewport().height());
        digest.update(header);
        remaining -= header.length;
      }
      copyBounded(input, OutputStream.nullOutputStream(), remaining, guard, digest);
    }
    if (!artifact.checksum().equals(HexFormat.of().formatHex(digest.digest()))) {
      throw DomainException.conflict(
          "ARTIFACT_CHECKSUM_MISMATCH", "Stored artifact checksum differs");
    }
  }

  private Transfer authorize(UUID id, String token, UUID workerId, UUID bootId) {
    identities.lockActive(artifacts.transferOwner(id));
    Transfer transfer = artifacts.transfer(id);
    requireAvailable(transfer);
    if (token == null
        || token.length() > 512
        || !MessageDigest.isEqual(
            transfer.tokenHash().getBytes(StandardCharsets.US_ASCII),
            JsonSupport.sha256(token).getBytes(StandardCharsets.US_ASCII))
        || !transfer.workerId().equals(workerId)
        || !transfer.bootId().equals(bootId)) {
      throw new DomainException(
          403, "ARTIFACT_TRANSFER_DENIED", "Transfer identity is not authorized");
    }
    Scope scope = artifacts.scope(transfer.captureAttemptId(), transfer.captureKind());
    if (!scope.workerId().equals(workerId)
        || !scope.bootId().equals(bootId)
        || scope.allocationEpoch() != transfer.allocationEpoch()
        || scope.pageEpoch() != transfer.pageEpoch()
        || scope.privacyEpoch() != transfer.privacyEpoch()
        || scope.controlEpoch() != transfer.controlEpoch()
        || scope.policyVersion() != transfer.policyVersion()) {
      throw new DomainException(
          403, "ARTIFACT_TRANSFER_STALE", "Browser capture scope has changed");
    }
    policies.authorize(transfer.userId(), action(transfer.captureKind()), scope.currentUrl());
    return transfer;
  }

  private Artifact readable(AuthenticatedActor actor, UUID id) {
    actor.requireScope("tasks:read");
    if (!identities.authorizationActive(
        actor.userId(), actor.loginId(), actor.grantId(), actor.accessEpoch())) {
      throw new DomainException(403, "ARTIFACT_ACCESS_REVOKED", "Artifact access has been revoked");
    }
    return artifacts.owned(actor.userId(), id);
  }

  private static void validateScope(
      Scope scope, UUID workerId, UUID bootId, CaptureMetadata metadata) {
    if (!scope.workerId().equals(workerId)
        || !scope.bootId().equals(bootId)
        || !scope.commandId().equals(metadata.commandId())
        || !scope.sessionId().equals(metadata.browserSessionId())
        || scope.allocationEpoch() != metadata.allocationEpoch()
        || scope.pageEpoch() != metadata.pageEpoch()
        || scope.privacyEpoch() != metadata.privacyEpoch()
        || metadata instanceof ScreenshotMetadata screenshot
            && (scope.viewportWidth() != screenshot.viewport().width()
                || scope.viewportHeight() != screenshot.viewport().height())) {
      throw new DomainException(
          403, "ARTIFACT_CAPTURE_STALE", "Capture does not match the active assignment");
    }
  }

  /** Verifies the worker receipt against the immutable publication for this human attempt. */
  public Receipt requireReadyScreenshot(UUID commandId, UUID attemptId, Receipt receipt) {
    var artifact =
        artifacts
            .readyScreenshot(commandId, attemptId)
            .orElseThrow(
                () ->
                    DomainException.conflict(
                        "SCREENSHOT_NOT_READY", "Screenshot publication is unconfirmed"));
    Receipt committed = receipt(artifact);
    if (!committed.equals(receipt)) {
      throw DomainException.conflict(
          "SCREENSHOT_RECEIPT_MISMATCH", "Screenshot receipt differs from publication");
    }
    return committed;
  }

  public Optional<Receipt> readyScreenshot(UUID commandId, UUID attemptId) {
    return artifacts.readyScreenshot(commandId, attemptId).map(ArtifactService::receipt);
  }

  private static String action(String kind) {
    return kind.equals("SCREENSHOT") ? "SNAPSHOT" : "READ_MEDIA";
  }

  private static void requireAvailable(Transfer transfer) {
    if (transfer.state().equals("REVOKED") || !transfer.expiresAt().isAfter(Instant.now())) {
      throw new DomainException(
          403, "ARTIFACT_TRANSFER_EXPIRED", "Artifact transfer is no longer available");
    }
  }

  private static Part findPart(List<Part> parts, int number) {
    return parts.stream().filter(part -> part.number() == number).findFirst().orElse(null);
  }

  private static Receipt receipt(Artifact artifact) {
    return new Receipt(artifact.id(), artifact.checksum(), artifact.size(), "READY");
  }

  private static void copyBounded(
      InputStream input, OutputStream output, long expected, Runnable guard, MessageDigest digest)
      throws IOException {
    byte[] buffer = new byte[65_536];
    long copied = 0;
    long checkedAt = 0;
    long lastCheck = 0;
    int count;
    while ((count = input.read(buffer)) != -1) {
      long now = System.nanoTime();
      if (copied == 0 || copied - checkedAt >= 1_048_576 || now - lastCheck > 1_000_000_000L) {
        guard.run();
        checkedAt = copied;
        lastCheck = now;
      }
      copied += count;
      if (copied > expected) {
        throw new IOException("Artifact exceeds its committed size");
      }
      if (digest != null) {
        digest.update(buffer, 0, count);
      }
      output.write(buffer, 0, count);
    }
    if (copied != expected) {
      throw new IOException("Artifact data is truncated");
    }
  }

  private static MessageDigest sha256() {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException("Required SHA-256 is unavailable", error);
    }
  }

  private String token() {
    byte[] bytes = new byte[32];
    random.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  private <T> T transact(Supplier<T> action) {
    T result = transaction.execute(status -> action.get());
    if (result == null) {
      throw new IllegalStateException("Artifact transaction returned no result");
    }
    return result;
  }
}
