package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.artifact.api.ArtifactContracts.Coverage;
import com.helmglass.artifact.api.ArtifactContracts.Interval;
import com.helmglass.artifact.api.ArtifactContracts.Metadata;
import com.helmglass.artifact.api.ArtifactContracts.SourceKind;
import com.helmglass.artifact.application.ArtifactService;
import com.helmglass.artifact.domain.ByteRange;
import com.helmglass.artifact.infrastructure.MultipartStorage;
import com.helmglass.artifact.infrastructure.MultipartStorage.Inventory;
import com.helmglass.artifact.infrastructure.MultipartStorage.Part;
import com.helmglass.artifact.infrastructure.MultipartStorage.Pending;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.artifact.infrastructure.ObjectStorage.ObjectMetadata;
import com.helmglass.artifact.infrastructure.repository.ArtifactRepository;
import com.helmglass.identity.api.PolicyContracts;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.identity.infrastructure.repository.PolicyRepository;
import com.helmglass.media.application.MediaAnalysisService;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.exception.SdkClientException;
import software.amazon.awssdk.http.AbortableInputStream;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;

/** Real PostgreSQL publication/fencing checks; object transports are explicitly test doubles. */
@SpringJUnitConfig(ArtifactPersistenceIntegrationTest.TestConfiguration.class)
class ArtifactPersistenceIntegrationTest {
  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    PolicyRepository.class,
    UserPolicyService.class,
    ArtifactRepository.class,
    ArtifactService.class,
    MediaAnalysisService.class
  })
  static class TestConfiguration {
    @Bean
    ObjectStorage objectStorage() {
      return mock(ObjectStorage.class);
    }

    @Bean
    MultipartStorage multipartStorage() {
      return mock(MultipartStorage.class);
    }
  }

  private record Fixture(
      AuthenticatedActor actor, UUID workerId, UUID bootId, Metadata metadata, byte[] bytes) {}

  private final JdbcClient jdbc;
  private final IdentityRepository identities;
  private final ArtifactRepository repository;
  private final ArtifactService service;
  private final MediaAnalysisService media;
  private final UserPolicyService policies;
  private final ObjectStorage storage;
  private final MultipartStorage multipart;
  private final TransactionTemplate transaction;

  @Autowired
  ArtifactPersistenceIntegrationTest(
      JdbcClient jdbc,
      IdentityRepository identities,
      ArtifactRepository repository,
      ArtifactService service,
      MediaAnalysisService media,
      UserPolicyService policies,
      ObjectStorage storage,
      MultipartStorage multipart,
      PlatformTransactionManager transactions) {
    this.jdbc = jdbc;
    this.identities = identities;
    this.repository = repository;
    this.service = service;
    this.media = media;
    this.policies = policies;
    this.storage = storage;
    this.multipart = multipart;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void mediaBlockDeniesCaptureAllocationAndEverySavedAudioReadWithoutDeletingTheArtifact()
      throws Exception {
    Fixture fixture = fixture();
    var grant = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    var artifact = repository.artifact(grant.artifactId());
    jdbc.sql("UPDATE task_artifacts SET state='READY',ready_at=now() WHERE id=:id")
        .param("id", artifact.id())
        .update();
    var audio = media.inline(fixture.actor(), artifact.id(), artifact.taskId());
    var content = service.content(fixture.actor(), artifact.id(), null);
    blockedActions(fixture.actor(), List.of("MEDIA"));
    assertMediaDenied(
        () -> service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata()));
    assertMediaDenied(() -> media.get(fixture.actor(), artifact.id(), artifact.taskId()));
    assertMediaDenied(() -> media.inline(fixture.actor(), artifact.id(), artifact.taskId()));
    assertMediaDenied(
        () ->
            media.segments(
                fixture.actor(), artifact.id(), artifact.taskId(), "CAPTIONS", null, 100));
    assertMediaDenied(() -> service.metadata(fixture.actor(), artifact.id()));
    assertMediaDenied(() -> service.content(fixture.actor(), artifact.id(), null));
    assertMediaDenied(() -> service.content(fixture.actor(), artifact.id(), "bytes=0-7"));
    assertMediaDenied(
        () ->
            service.download(
                fixture.actor(),
                artifact.id(),
                content,
                OutputStream.nullOutputStream(),
                Instant.now().plusSeconds(5)));
    assertMediaDenied(
        () ->
            media.deliver(
                fixture.actor(),
                audio,
                OutputStream.nullOutputStream(),
                Instant.now().plusSeconds(5)));
    verifyNoInteractions(storage, multipart);
    assertThat(repository.artifact(artifact.id()).state()).isEqualTo("READY");
    blockedActions(fixture.actor(), List.of("READ"));
    assertThat(
            media.inline(fixture.actor(), artifact.id(), artifact.taskId()).source().artifactId())
        .isEqualTo(artifact.id());
    when(storage.open(anyString(), anyString(), any(), any())).thenReturn(stream(fixture.bytes()));
    var output = new ByteArrayOutputStream();
    media.deliver(fixture.actor(), audio, output, Instant.now().plusSeconds(5));
    assertThat(output.toByteArray()).isEqualTo(fixture.bytes());
  }

  @Test
  void mediaPolicyUsesStoredPurposeEvenWhenHistoricalProvenanceIsEmpty() throws Exception {
    Fixture fixture = fixture();
    var grant = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    UUID artifactId = grant.artifactId();
    jdbc.sql("UPDATE task_artifacts SET state='READY',ready_at=now(),provenance='{}' WHERE id=:id")
        .param("id", artifactId)
        .update();
    var content = service.content(fixture.actor(), artifactId, null);
    blockedActions(fixture.actor(), List.of("MEDIA"));
    assertMediaDenied(() -> service.metadata(fixture.actor(), artifactId));
    assertMediaDenied(() -> service.content(fixture.actor(), artifactId, "bytes=0-7"));
    assertMediaDenied(
        () -> service.download(fixture.actor(), artifactId, content,
            OutputStream.nullOutputStream(), Instant.now().plusSeconds(5)));
    verifyNoInteractions(storage, multipart);
    assertThat(repository.artifact(artifactId).state()).isEqualTo("READY");

    // Policy is about artifact purpose, not a MIME heuristic or optional provenance field.
    jdbc.sql("UPDATE task_artifacts SET purpose='FILE' WHERE id=:id")
        .param("id", artifactId)
        .update();
    assertThat(service.metadata(fixture.actor(), artifactId)).containsEntry("id", artifactId);
    when(storage.open(anyString(), anyString(), any(), any())).thenReturn(stream(fixture.bytes()));
    var output = new ByteArrayOutputStream();
    service.download(fixture.actor(), artifactId, content, output, Instant.now().plusSeconds(5));
    assertThat(output.toByteArray()).isEqualTo(fixture.bytes());
  }

  @Test
  void mediaBlockDuringDownloadStopsTheExistingStreamAtItsAuthorizationCheckpoint() {
    Fixture fixture = fixture();
    var grant = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    var artifact = repository.artifact(grant.artifactId());
    byte[] bytes = new byte[2 * 1_048_576];
    jdbc.sql("UPDATE task_artifacts SET state='READY',ready_at=now(),size=:size WHERE id=:id")
        .param("id", artifact.id())
        .param("size", bytes.length)
        .update();
    var content = service.content(fixture.actor(), artifact.id(), null);
    AtomicBoolean aborted = new AtomicBoolean();
    when(storage.open(anyString(), anyString(), any(), any()))
        .thenReturn(
            new ResponseInputStream<>(
                GetObjectResponse.builder().contentLength((long) bytes.length).build(),
                AbortableInputStream.create(
                    new ByteArrayInputStream(bytes), () -> aborted.set(true))));
    var delivered = new ByteArrayOutputStream();
    var output =
        new OutputStream() {
          @Override
          public void write(int value) {
            throw new AssertionError("Expected bounded block writes");
          }

          @Override
          public void write(byte[] block, int offset, int length) {
            if (delivered.size() == 0) {
              blockedActions(fixture.actor(), List.of("MEDIA"));
            }
            delivered.write(block, offset, length);
          }
        };
    assertMediaDenied(
        () ->
            service.download(
                fixture.actor(), artifact.id(), content, output, Instant.now().plusSeconds(5)));
    assertThat(delivered.size()).isPositive().isLessThanOrEqualTo(1_048_576);
    assertThat(aborted).isTrue();
    assertThat(repository.artifact(artifact.id()).state()).isEqualTo("READY");
  }

  private void blockedActions(AuthenticatedActor actor, List<String> actions) {
    policies.update(
        actor,
        new PolicyContracts.Update(
            policies.get(actor).version(),
            "ALL",
            "AUTO",
            actions,
            false,
            List.of(),
            null,
            null,
            null,
            null,
            null,
            null),
        new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID()));
  }

  private static void assertMediaDenied(ThrowingCallable action) {
    assertThatThrownBy(action)
        .isInstanceOfSatisfying(
            DomainException.class,
            error -> assertThat(error.getCode()).isEqualTo("ACTION_PROHIBITED"));
  }

  @BeforeEach
  void resetStorageDoubles() {
    reset(storage, multipart);
  }

  @Test
  void replayKeepsOneArtifactAndQuotaIncludesUnfinishedUploads() {
    Fixture fixture = fixture();
    var first = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    var second = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    assertThat(second.artifactId()).isEqualTo(first.artifactId());
    assertThat(repository.reservedBytes(fixture.actor().userId()))
        .isEqualTo(fixture.bytes().length);
    Fixture limited = fixture();
    jdbc.sql("UPDATE user_policies SET max_retained_media_bytes=1 WHERE user_id=:id")
        .param("id", limited.actor().userId())
        .update();
    assertThatThrownBy(
            () -> service.allocate(limited.workerId(), limited.bootId(), limited.metadata()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("limit");
    verifyNoInteractions(storage, multipart);
  }

  @Test
  void executingCaptureUsesCommandAndBudgetDeadlinesInsteadOfTheIdleClock() {
    Fixture fixture = fixture();
    jdbc.sql("UPDATE browser_sessions SET idle_deadline_at=now()-interval '1 minute' WHERE id=:id")
        .param("id", fixture.metadata().browserSessionId())
        .update();
    var allocated = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    assertThat(allocated.artifactId()).isNotNull();
    jdbc.sql(
            "UPDATE browser_sessions SET budget_deadline_at=now()-interval '1 second' WHERE id=:id")
        .param("id", fixture.metadata().browserSessionId())
        .update();
    assertThatThrownBy(
            () -> service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("authorization");
    verifyNoInteractions(storage, multipart);
  }

  @Test
  void privacyTransitionRevokesAlreadyIssuedUploadBeforeStorageAccess() {
    Fixture fixture = fixture();
    var grant = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    jdbc.sql(
            "UPDATE browser_sessions SET privacy='LOGIN_PRIVATE',privacy_epoch=privacy_epoch+1"
                + " WHERE id=:id")
        .param("id", fixture.metadata().browserSessionId())
        .update();
    assertThatThrownBy(
            () ->
                service.upload(
                    grant.transferId(),
                    grant.transferToken(),
                    fixture.workerId(),
                    fixture.bootId(),
                    fixture.bytes().length,
                    fixture.metadata().sha256(),
                    new ByteArrayInputStream(fixture.bytes())))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("authorization");
    verifyNoInteractions(storage, multipart);
    assertThat(repository.artifact(grant.artifactId()).state()).isEqualTo("UPLOADING");
  }

  @Test
  void lostCompleteResponseRequiresFullChecksumBeforePublicationAndUsage() throws Exception {
    Fixture fixture = fixture();
    var grant = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    when(storage.metadata(anyString(), anyString()))
        .thenReturn(Optional.empty())
        .thenReturn(Optional.of(new ObjectMetadata(fixture.bytes().length, null)));
    when(multipart.create(anyString(), anyString(), anyString(), anyString()))
        .thenReturn("fixture-upload");
    when(multipart.parts(anyString(), anyString(), anyString())).thenReturn(List.of());
    when(multipart.upload(
            anyString(), anyString(), anyString(), anyInt(), any(byte[].class), anyString()))
        .thenReturn(
            new Part(1, fixture.bytes().length, fixture.metadata().sha256(), "not-a-sha256-etag"));
    doThrow(SdkClientException.create("Fixture lost completion response"))
        .when(multipart)
        .complete(anyString(), anyString(), anyString(), any());
    when(storage.open(anyString(), anyString())).thenReturn(stream(fixture.bytes()));
    var receipt =
        service.upload(
            grant.transferId(),
            grant.transferToken(),
            fixture.workerId(),
            fixture.bootId(),
            fixture.bytes().length,
            fixture.metadata().sha256(),
            new ByteArrayInputStream(fixture.bytes()));
    assertThat(receipt.state()).isEqualTo("READY");
    assertThat(repository.artifact(grant.artifactId()).state()).isEqualTo("READY");
    assertThat(
            jdbc.sql("SELECT count(*) FROM usage_measurements WHERE source_id=:id")
                .param("id", grant.artifactId())
                .query(Long.class)
                .single())
        .isEqualTo(2);
    var replay =
        service.upload(
            grant.transferId(),
            grant.transferToken(),
            fixture.workerId(),
            fixture.bootId(),
            fixture.bytes().length,
            fixture.metadata().sha256(),
            new ByteArrayInputStream(new byte[0]));
    assertThat(replay).isEqualTo(receipt);
    assertThat(
            jdbc.sql("SELECT count(*) FROM usage_measurements WHERE source_id=:id")
                .param("id", grant.artifactId())
                .query(Long.class)
                .single())
        .isEqualTo(2);
    assertThat(service.metadata(fixture.actor(), grant.artifactId()))
        .containsEntry("state", "READY");
    Fixture foreign = fixture();
    assertThatThrownBy(() -> service.metadata(foreign.actor(), grant.artifactId()))
        .isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE application_users SET state='BLOCKED' WHERE id=:id")
        .param("id", fixture.actor().userId())
        .update();
    assertThatThrownBy(() -> service.metadata(fixture.actor(), grant.artifactId()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("revoked");
  }

  @Test
  void wrongFullDigestNeverPublishesAndDifferentPartCannotReplaceReservedBytes() {
    Fixture fixture = fixture();
    var grant = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    repository.reservePart(
        grant.artifactId(), 1, fixture.metadata().sha256(), fixture.bytes().length);
    assertThatThrownBy(
            () ->
                repository.reservePart(
                    grant.artifactId(), 1, "a".repeat(64), fixture.bytes().length))
        .isInstanceOf(DomainException.class);
    when(storage.metadata(anyString(), anyString()))
        .thenReturn(
            Optional.of(new ObjectMetadata(fixture.bytes().length, fixture.metadata().sha256())));
    when(storage.open(anyString(), anyString()))
        .thenReturn(stream(new byte[fixture.bytes().length]));
    assertThatThrownBy(
            () ->
                service.upload(
                    grant.transferId(),
                    grant.transferToken(),
                    fixture.workerId(),
                    fixture.bootId(),
                    fixture.bytes().length,
                    fixture.metadata().sha256(),
                    new ByteArrayInputStream(fixture.bytes())))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("checksum");
    assertThat(repository.artifact(grant.artifactId()).state()).isEqualTo("UPLOADING");
    verifyNoInteractions(multipart);
  }

  @Test
  void lostCreateResponseIsReconciledWithoutCreatingAnotherMultipartUpload() throws Exception {
    Fixture fixture = fixture();
    var grant = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    when(multipart.create(anyString(), anyString(), anyString(), anyString()))
        .thenThrow(SdkClientException.create("Fixture lost create response"));
    assertThatThrownBy(
            () ->
                service.upload(
                    grant.transferId(),
                    grant.transferToken(),
                    fixture.workerId(),
                    fixture.bootId(),
                    fixture.bytes().length,
                    fixture.metadata().sha256(),
                    new ByteArrayInputStream(fixture.bytes())))
        .isInstanceOf(SdkClientException.class);
    assertThat(repository.transfer(grant.transferId()).createRequestedAt()).isNotNull();
    assertThatThrownBy(
            () ->
                service.upload(
                    grant.transferId(),
                    grant.transferToken(),
                    fixture.workerId(),
                    fixture.bootId(),
                    fixture.bytes().length,
                    fixture.metadata().sha256(),
                    new ByteArrayInputStream(fixture.bytes())))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("creation outcome");

    var artifact = repository.artifact(grant.artifactId());
    when(multipart.pending(artifact.bucket(), artifact.objectKey()))
        .thenReturn(List.of(new Pending(artifact.objectKey(), "recovered-upload")));
    when(multipart.upload(
            anyString(), anyString(), anyString(), anyInt(), any(byte[].class), anyString()))
        .thenReturn(
            new Part(1, fixture.bytes().length, fixture.metadata().sha256(), "fixture-etag"));
    when(storage.metadata(anyString(), anyString()))
        .thenReturn(Optional.empty())
        .thenReturn(Optional.of(new ObjectMetadata(fixture.bytes().length, null)));
    when(storage.open(anyString(), anyString())).thenReturn(stream(fixture.bytes()));
    assertThat(
            service
                .upload(
                    grant.transferId(),
                    grant.transferToken(),
                    fixture.workerId(),
                    fixture.bootId(),
                    fixture.bytes().length,
                    fixture.metadata().sha256(),
                    new ByteArrayInputStream(fixture.bytes()))
                .state())
        .isEqualTo("READY");
    assertThat(repository.artifact(artifact.id()).uploadId()).isEqualTo("recovered-upload");
    verify(multipart, times(1)).create(anyString(), anyString(), anyString(), anyString());
  }

  @Test
  void cleanupWaitsForActiveUploadAndNeverAbortsUnownedStorageKeys() {
    Fixture fixture = fixture();
    var grant = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    var artifact = repository.artifact(grant.artifactId());
    UUID lease = UUID.randomUUID();
    repository.claim(grant.transferId(), lease);
    repository.markDeleting(artifact.id());
    var pending = new Pending(artifact.objectKey(), "lost-create-upload");
    when(multipart.inventory(anyString(), anyString(), any(), any()))
        .thenReturn(
            new Inventory(
                List.of(pending, new Pending("u/foreign/key", "foreign-upload")), null, null));
    when(multipart.pending(artifact.bucket(), artifact.objectKey())).thenReturn(List.of(pending));
    service.clean();
    verify(multipart, times(0)).abort(anyString(), anyString(), anyString());
    assertThat(repository.artifact(artifact.id()).state()).isEqualTo("DELETING");
    repository.release(grant.transferId(), lease);
    service.clean();
    assertThat(repository.artifact(artifact.id()).state()).isEqualTo("DELETED");
    verify(multipart, times(0)).abort("hg-artifacts", "u/foreign/key", "foreign-upload");
    verify(multipart, times(2))
        .abort(artifact.bucket(), artifact.objectKey(), "lost-create-upload");
  }

  @Test
  void inlineAudioReadsExactCompleteWavAndRejectsForeignTaskUserAndRevokedGrant() throws Exception {
    Fixture fixture = fixture();
    var grant = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    var artifact = repository.artifact(grant.artifactId());
    jdbc.sql("UPDATE task_artifacts SET state='READY',ready_at=now() WHERE id=:id")
        .param("id", artifact.id())
        .update();
    UUID clientGrant =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    identities.admitGrant(
                        fixture.actor().userId(),
                        "helm-mcp",
                        UUID.randomUUID().toString(),
                        List.of("tasks:read"))));
    var actor =
        new AuthenticatedActor(
            fixture.actor().userId(),
            null,
            clientGrant,
            "helm-mcp",
            "Fixture",
            "fixture@example.com",
            1,
            Set.of("tasks:read"),
            true);
    var audio = media.inline(actor, artifact.id(), artifact.taskId());
    when(storage.open(anyString(), anyString(), any(), any())).thenReturn(stream(fixture.bytes()));
    var output = new ByteArrayOutputStream();
    media.deliver(actor, audio, output, Instant.now().plusSeconds(5));
    assertThat(output.toByteArray()).isEqualTo(fixture.bytes());
    assertThat(new String(output.toByteArray(), 0, 4, StandardCharsets.US_ASCII)).isEqualTo("RIFF");
    assertThat(audio.metadata())
        .containsEntry(
            "delivery", Map.of("status", "UNVERIFIED", "reason", "HOST_AUDIO_ACCESS_NOT_VERIFIED"));
    assertThatThrownBy(() -> media.inline(actor, artifact.id(), UUID.randomUUID()))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(() -> media.inline(fixture().actor(), artifact.id(), artifact.taskId()))
        .isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE client_grants SET status='REVOKED' WHERE id=:id")
        .param("id", clientGrant)
        .update();
    assertThatThrownBy(() -> media.inline(actor, artifact.id(), artifact.taskId()))
        .isInstanceOf(DomainException.class);
  }

  @Test
  void inlineAudioLimitDoesNotReadOrModifyLargeArtifactsAndRejectsNonAudioMime() {
    Fixture fixture = fixture();
    var allocated = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    var artifact = repository.artifact(allocated.artifactId());
    jdbc.sql("UPDATE task_artifacts SET state='READY',ready_at=now(),size=:size WHERE id=:id")
        .param("size", MediaAnalysisService.MAX_INLINE_AUDIO_BYTES)
        .param("id", artifact.id())
        .update();
    assertThat(
            media.inline(fixture.actor(), artifact.id(), artifact.taskId()).source().byteLength())
        .isEqualTo(MediaAnalysisService.MAX_INLINE_AUDIO_BYTES);
    jdbc.sql("UPDATE task_artifacts SET size=size+1 WHERE id=:id")
        .param("id", artifact.id())
        .update();
    assertThatThrownBy(() -> media.inline(fixture.actor(), artifact.id(), artifact.taskId()))
        .isInstanceOfSatisfying(
            DomainException.class,
            error -> assertThat(error.getCode()).isEqualTo("INLINE_AUDIO_LIMIT"));
    assertThat(repository.artifact(artifact.id()).state()).isEqualTo("READY");
    assertThat(repository.artifact(artifact.id()).size())
        .isEqualTo(MediaAnalysisService.MAX_INLINE_AUDIO_BYTES + 1);
    jdbc.sql("UPDATE task_artifacts SET size=8,mime='video/webm' WHERE id=:id")
        .param("id", artifact.id())
        .update();
    assertThatThrownBy(() -> media.inline(fixture.actor(), artifact.id(), artifact.taskId()))
        .isInstanceOfSatisfying(
            DomainException.class,
            error -> assertThat(error.getCode()).isEqualTo("INLINE_AUDIO_FORMAT_UNSUPPORTED"));
    verifyNoInteractions(storage, multipart);
  }

  @Test
  void downloadDeadlineAbortsAStalledStorageStreamAndClientFailureAbortsUnreadBytes()
      throws Exception {
    Fixture fixture = fixture();
    var allocated = service.allocate(fixture.workerId(), fixture.bootId(), fixture.metadata());
    var artifact = repository.artifact(allocated.artifactId());
    jdbc.sql("UPDATE task_artifacts SET state='READY',ready_at=now() WHERE id=:id")
        .param("id", artifact.id())
        .update();
    var content = service.content(fixture.actor(), artifact.id(), null);
    var aborted = new CountDownLatch(1);
    InputStream stalled =
        new InputStream() {
          @Override
          public int read() throws IOException {
            try {
              if (!aborted.await(2, TimeUnit.SECONDS)) {
                throw new IOException("Fixture deadline did not abort storage");
              }
            } catch (InterruptedException error) {
              Thread.currentThread().interrupt();
              throw new IOException(error);
            }
            throw new IOException("Storage aborted");
          }
        };
    when(storage.open(anyString(), anyString(), any(), any()))
        .thenReturn(
            new ResponseInputStream<>(
                GetObjectResponse.builder().contentLength(artifact.size()).build(),
                AbortableInputStream.create(stalled, aborted::countDown)));
    assertThatThrownBy(
            () ->
                service.download(
                    fixture.actor(),
                    artifact.id(),
                    content,
                    OutputStream.nullOutputStream(),
                    Instant.now().plusMillis(100)))
        .isInstanceOf(IOException.class)
        .hasMessageContaining("Storage aborted");
    assertThat(aborted.getCount()).isZero();
    var disconnected = new AtomicBoolean();
    when(storage.open(anyString(), anyString(), any(), any()))
        .thenReturn(
            new ResponseInputStream<>(
                GetObjectResponse.builder().contentLength(artifact.size()).build(),
                AbortableInputStream.create(
                    new ByteArrayInputStream(fixture.bytes()), () -> disconnected.set(true))));
    OutputStream failed =
        new OutputStream() {
          @Override
          public void write(int value) throws IOException {
            throw new IOException("Client closed");
          }
        };
    assertThatThrownBy(
            () ->
                service.download(
                    fixture.actor(), artifact.id(), content, failed, Instant.now().plusSeconds(5)))
        .isInstanceOf(IOException.class)
        .hasMessage("Client closed");
    assertThat(disconnected).isTrue();
  }

  @Test
  void byteRangesAreBoundedAndMultiRangesRejected() {
    assertThat(ByteRange.parse("bytes=2-1000", 10)).isEqualTo(new ByteRange(2, 9, 10, true));
    assertThat(ByteRange.parse("bytes=-3", 10)).isEqualTo(new ByteRange(7, 9, 10, true));
    assertThatThrownBy(() -> ByteRange.parse("bytes=1-2,4-5", 10))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(() -> ByteRange.parse("bytes=10-", 10)).isInstanceOf(DomainException.class);
  }

  private Fixture fixture() {
    return Objects.requireNonNull(
        transaction.execute(
            status -> {
              var user =
                  identities.resolve(
                      "https://identity.example",
                      UUID.randomUUID().toString(),
                      "Fixture",
                      "fixture@example.com");
              UUID task = UUID.randomUUID();
              UUID worker = UUID.randomUUID();
              UUID boot = UUID.randomUUID();
              UUID session = UUID.randomUUID();
              UUID command = UUID.randomUUID();
              UUID attempt = UUID.randomUUID();
              UUID login = UUID.randomUUID();
              jdbc.sql(
                      """
                      INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)
                      VALUES(:id,:user,'Fixture','Fixture','TEXT','ANGULAR','RUNNING')
                      """)
                  .param("id", task)
                  .param("user", user.id())
                  .update();
              jdbc.sql(
                      "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                          + " VALUES(:id,:boot,1,'fixture')")
                  .param("id", worker)
                  .param("boot", boot)
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO browser_sessions(id,user_id,task_id,worker_id,worker_boot_id,purpose,state,
                        idle_deadline_at,budget_deadline_at,current_url)
                      VALUES(:id,:user,:task,:worker,:boot,'TASK','ACTIVE',now()+interval '10 minutes',
                        now()+interval '10 minutes','https://example.com')
                      """)
                  .param("id", session)
                  .param("user", user.id())
                  .param("task", task)
                  .param("worker", worker)
                  .param("boot", boot)
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO browser_control_leases(session_id,owner_kind,owner_id,expires_at)
                      VALUES(:id,'AGENT',:user,now()+interval '10 minutes')
                      """)
                  .param("id", session)
                  .param("user", user.id())
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO task_commands(id,task_id,user_id,command_sequence,kind,payload,payload_hash,
                        accepted_task_version,instruction_revision,expected_session_id,control_epoch,page_epoch,
                        privacy_epoch,deadline,state)
                      VALUES(:id,:task,:user,1,'READ_MEDIA','{}','fixture',1,1,:session,1,1,1,
                        now()+interval '10 minutes','STARTED')
                      """)
                  .param("id", command)
                  .param("task", task)
                  .param("user", user.id())
                  .param("session", session)
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO command_attempts(id,command_id,session_id,worker_id,attempt_no,
                        assignment_epoch,control_epoch,state,start_permit_id)
                      VALUES(:id,:command,:session,:worker,1,1,1,'STARTED',:permit)
                      """)
                  .param("id", attempt)
                  .param("command", command)
                  .param("session", session)
                  .param("worker", worker)
                  .param("permit", UUID.randomUUID())
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO application_logins(id,user_id,issuer,sid,auth_time,admitted_access_epoch,expires_at)
                      VALUES(:id,:user,'https://identity.example',:sid,now(),1,now()+interval '10 minutes')
                      """)
                  .param("id", login)
                  .param("user", user.id())
                  .param("sid", login.toString())
                  .update();
              byte[] bytes = wav();
              Metadata metadata =
                  new Metadata(
                      1,
                      command,
                      attempt,
                      session,
                      1,
                      1,
                      1,
                      "AUDIO",
                      "audio/wav",
                      bytes.length,
                      JsonSupport.sha256(bytes),
                      SourceKind.FILE,
                      Coverage.FULL,
                      List.of(new Interval(BigDecimal.ZERO, BigDecimal.ONE)),
                      BigDecimal.ONE,
                      "pcm_s16le",
                      1,
                      8000,
                      List.of(),
                      null);
              var actor =
                  new AuthenticatedActor(
                      user.id(),
                      login,
                      null,
                      "helm-web",
                      user.displayName(),
                      user.email(),
                      1,
                      Set.of(),
                      false);
              return new Fixture(actor, worker, boot, metadata, bytes);
            }));
  }

  private static ResponseInputStream<GetObjectResponse> stream(byte[] bytes) {
    return new ResponseInputStream<>(
        GetObjectResponse.builder().contentLength((long) bytes.length).build(),
        AbortableInputStream.create(new ByteArrayInputStream(bytes)));
  }

  private static byte[] wav() {
    var bytes = ByteBuffer.allocate(16044).order(ByteOrder.LITTLE_ENDIAN);
    bytes.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(16036);
    bytes.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16);
    bytes.putShort((short) 1).putShort((short) 1).putInt(8000).putInt(16000);
    bytes.putShort((short) 2).putShort((short) 16);
    bytes.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(16000);
    while (bytes.hasRemaining()) {
      bytes.putShort((short) 1000);
    }
    return bytes.array();
  }
}
