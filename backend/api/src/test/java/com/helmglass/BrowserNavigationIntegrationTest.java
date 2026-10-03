package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.artifact.api.ArtifactContracts;
import com.helmglass.artifact.application.ArtifactService;
import com.helmglass.artifact.infrastructure.MultipartStorage;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.artifact.infrastructure.repository.ArtifactRepository;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.browser.application.HumanBrowserCommandService;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.HumanBrowserCommandRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.application.ChannelTicketService;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.http.AbortableInputStream;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import tools.jackson.databind.JsonNode;

@SpringJUnitConfig(BrowserNavigationIntegrationTest.Owners.class)
@TestPropertySource(properties = "helm.public-origin=https://helm.example")
class BrowserNavigationIntegrationTest {
  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    ArtifactPersistenceIntegrationTest.TestConfiguration.class,
    HumanBrowserCommandRepository.class,
    HumanBrowserCommandService.class,
    BrowserControlService.class,
    BrowserSessionService.class,
    ConnectionRepository.class,
    LoginRepository.class,
    WorkerProtocol.class
  })
  static class Owners {
    @Bean
    ChannelTicketService tickets() {
      return mock(ChannelTicketService.class);
    }
  }

  private record Fixture(
      AuthenticatedActor actor, UUID task, UUID session, UUID worker, UUID boot, UUID controller) {}

  private final HumanBrowserCommandService navigation;
  private final HumanBrowserCommandRepository repository;
  private final BrowserControlService controls;
  private final BrowserSessionService sessions;
  private final BrowserRepository browsers;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final TransactionTemplate transaction;
  @Autowired private ArtifactService artifacts;
  @Autowired private ArtifactRepository artifactRepository;
  @Autowired private ObjectStorage storage;
  @Autowired private MultipartStorage multipart;

  @BeforeEach
  void resetArtifactTransports() {
    reset(storage, multipart);
  }

  @Autowired
  BrowserNavigationIntegrationTest(
      HumanBrowserCommandService navigation,
      HumanBrowserCommandRepository repository,
      BrowserControlService controls,
      BrowserSessionService sessions,
      BrowserRepository browsers,
      IdentityRepository identities,
      OperationRepository operations,
      JdbcClient jdbc,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.navigation = navigation;
    this.repository = repository;
    this.controls = controls;
    this.sessions = sessions;
    this.browsers = browsers;
    this.identities = identities;
    this.operations = operations;
    this.jdbc = jdbc;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void navigationHasOnePermitAndReplayPreservesTheSamePageReceipt() {
    var fixture = fixture(false);
    var input = input(fixture);
    var key = context();
    var receipt = navigation.navigate(fixture.actor(), fixture.session(), input, key);
    assertThat(navigation.navigate(fixture.actor(), fixture.session(), input, key))
        .isEqualTo(receipt);
    assertThatThrownBy(
            () -> navigation.navigate(fixture.actor(), fixture.session(), input, context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("previous navigation");
    var command = transaction.execute(status -> repository.lock(receipt.operationId()));
    Objects.requireNonNull(command);
    var request = request(command);
    var permit = navigation.permit(fixture.worker(), fixture.boot(), request);
    assertThat(permit)
        .containsEntry("executionMode", "HUMAN")
        .containsEntry("controllerInstance", fixture.controller());
    assertThatThrownBy(() -> navigation.permit(fixture.worker(), fixture.boot(), request))
        .isInstanceOf(DomainException.class);
    JsonNode result =
        result(
            command,
            "SUCCEEDED",
            "CONFIRMED",
            Map.of("safeUrl", "https://example.com/next?token=secret#part"));
    navigation.result(fixture.worker(), fixture.boot(), result);
    navigation.result(fixture.worker(), fixture.boot(), result);
    assertThat(operations.owned(fixture.actor().userId(), receipt.operationId()).state())
        .isEqualTo("SUCCEEDED");
    assertThat(browsers.owned(fixture.actor().userId(), fixture.session()).currentUrl())
        .isEqualTo("https://example.com/next");
    assertThat(browsers.owned(fixture.actor().userId(), fixture.session()).pageEpoch())
        .isEqualTo(2);
    assertThatThrownBy(
            () ->
                navigation.result(
                    fixture.worker(),
                    fixture.boot(),
                    result(command, "FAILED", "NOT_STARTED", Map.of())))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("already has a receipt");
  }

  @Test
  void controllerLoginAndEpochAreRequiredAtAdmissionAndImmediatelyBeforePermit() {
    var fixture = fixture(false);
    var actor = fixture.actor();
    var otherLogin =
        new AuthenticatedActor(
            actor.userId(),
            UUID.randomUUID(),
            null,
            "helm-web",
            actor.displayName(),
            actor.email(),
            actor.accessEpoch(),
            Set.of(),
            false);
    assertThatThrownBy(
            () -> navigation.navigate(otherLogin, fixture.session(), input(fixture), context()))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(
            () ->
                controls.renew(
                    otherLogin,
                    fixture.session(),
                    new BrowserContracts.Renew(1L, fixture.controller())))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(
            () ->
                navigation.navigate(
                    actor,
                    fixture.session(),
                    new BrowserContracts.Navigation("BACK", null, 1L, 1L, 2L, fixture.controller()),
                    context()))
        .isInstanceOf(DomainException.class)
        .hasMessage("Resource changed");
    var receipt = navigation.navigate(actor, fixture.session(), input(fixture), context());
    var command = transaction.execute(status -> repository.lock(receipt.operationId()));
    Objects.requireNonNull(command);
    jdbc.sql("UPDATE application_logins SET state='REVOKED' WHERE id=:id")
        .param("id", actor.loginId())
        .update();
    assertThatThrownBy(() -> navigation.permit(fixture.worker(), fixture.boot(), request(command)))
        .isInstanceOf(DomainException.class);
    navigation.reconcile();
    assertThat(operations.owned(actor.userId(), receipt.operationId()).state()).isEqualTo("FAILED");
    assertThat(
            jdbc.sql("SELECT permit_id FROM human_browser_commands WHERE id=:id")
                .param("id", receipt.operationId())
                .query(UUID.class)
                .optional())
        .isEmpty();
  }

  @Test
  void lostStartedReceiptRemainsUnknownAfterLateEvidenceAndNeedsReconciliation() {
    var fixture = fixture(false);
    var receipt =
        navigation.navigate(fixture.actor(), fixture.session(), input(fixture), context());
    var command = transaction.execute(status -> repository.lock(receipt.operationId()));
    Objects.requireNonNull(command);
    navigation.permit(fixture.worker(), fixture.boot(), request(command));
    jdbc.sql("UPDATE human_browser_commands SET deadline=now()-interval '1 second' WHERE id=:id")
        .param("id", receipt.operationId())
        .update();
    navigation.reconcile();
    navigation.result(
        fixture.worker(), fixture.boot(), result(command, "SUCCEEDED", "CONFIRMED", Map.of()));
    assertThat(operations.owned(fixture.actor().userId(), receipt.operationId()).state())
        .isEqualTo("NEEDS_ATTENTION");
    assertThat(
            jdbc.sql("SELECT human_checkpoint FROM operations WHERE id=:id")
                .param("id", receipt.operationId())
                .query(String.class)
                .single())
        .isEqualTo("UNKNOWN");
    assertThat(
            jdbc.sql("SELECT state FROM tasks WHERE id=:id")
                .param("id", fixture.task())
                .query(String.class)
                .single())
        .isEqualTo("INTERRUPTED");
    assertThatThrownBy(
            () ->
                navigation.navigate(fixture.actor(), fixture.session(), input(fixture), context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("previous effect");
  }

  @Test
  void privateNavigationNeverPublishesAnObservationOrAddressAndCannotLeavePrivacyByAcquire() {
    var fixture = fixture(true);
    var receipt =
        navigation.navigate(fixture.actor(), fixture.session(), input(fixture), context());
    var command = transaction.execute(status -> repository.lock(receipt.operationId()));
    Objects.requireNonNull(command);
    assertThat(navigation.permit(fixture.worker(), fixture.boot(), request(command)))
        .containsEntry("executionMode", "HUMAN_PRIVATE");
    assertThatThrownBy(
            () ->
                navigation.result(
                    fixture.worker(),
                    fixture.boot(),
                    result(
                        command,
                        "SUCCEEDED",
                        "CONFIRMED",
                        Map.of("safeUrl", "https://example.com/private"))))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(
            () ->
                navigation.result(
                    fixture.worker(),
                    fixture.boot(),
                    result(
                        command,
                        "SUCCEEDED",
                        "CONFIRMED",
                        Map.of("observation", Map.of("url", "https://example.com")))))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(
            () ->
                controls.acquire(
                    fixture.actor(),
                    fixture.session(),
                    new BrowserContracts.TakeControl(1L, 1L, fixture.controller(), false, false),
                    context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("private login");
    navigation.result(
        fixture.worker(), fixture.boot(), result(command, "SUCCEEDED", "CONFIRMED", Map.of()));
    assertThat(browsers.owned(fixture.actor().userId(), fixture.session()).currentUrl()).isNull();
  }

  @Test
  void anotherLoginCannotObtainSelfCapabilitiesByReusingTheControllerIdentifier() {
    var fixture = fixture(true);
    var actor = fixture.actor();
    var other =
        new AuthenticatedActor(
            actor.userId(),
            UUID.randomUUID(),
            null,
            "helm-web",
            actor.displayName(),
            actor.email(),
            actor.accessEpoch(),
            Set.of(),
            false);
    var view = json.read(json.write(sessions.get(other, fixture.session(), fixture.controller())));
    assertThat(view.path("controllerRelation").asString()).isEqualTo("OTHER");
    assertThat(view.path("capabilities").path("input").path("allowed").asBoolean()).isFalse();
    assertThat(view.path("capabilities").path("view").path("allowed").asBoolean()).isFalse();
    assertThat(view.path("capabilities").path("transfer").path("allowed").asBoolean()).isTrue();
    assertThat(view.path("capabilities").path("view").path("reason").asString())
        .contains("другой вкладке");
  }

  @ParameterizedTest
  @ValueSource(strings = {"ACTIVE", "QUIESCED"})
  void expiredPrivateControlCanBeAcquiredAgainWithoutCreatingAnotherBrowser(String controlState) {
    var fixture = fixture(true);
    jdbc.sql(
            "UPDATE browser_control_leases SET state=:state,expires_at=now()-interval '1 second'"
                + " WHERE session_id=:id")
        .param("state", controlState)
        .param("id", fixture.session())
        .update();
    var view =
        json.read(
            json.write(sessions.get(fixture.actor(), fixture.session(), fixture.controller())));
    assertThat(view.path("state").asString()).isEqualTo("ACTIVE");
    assertThat(view.path("controllerRelation").asString()).isEqualTo("NONE");
    assertThat(view.path("capabilities").path("view").path("allowed").asBoolean()).isFalse();
    assertThat(view.path("capabilities").path("view").path("reason").asString())
        .contains("Сеанс управления прерван");
    assertThat(view.path("capabilities").path("acquire").path("allowed").asBoolean()).isTrue();
    assertThatThrownBy(
            () ->
                controls.renew(
                    fixture.actor(),
                    fixture.session(),
                    new BrowserContracts.Renew(1L, fixture.controller())))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("acquired again");
    var receipt =
        controls.acquire(
            fixture.actor(),
            fixture.session(),
            new BrowserContracts.TakeControl(1L, 1L, fixture.controller(), true, false),
            context());
    assertThat(receipt.resource().id()).isEqualTo(fixture.session());
    var transferring =
        json.read(
            json.write(sessions.get(fixture.actor(), fixture.session(), fixture.controller())));
    assertThat(transferring.path("controlState").asString()).isEqualTo("TRANSFERRING");
    assertThat(transferring.path("capabilities").path("acquire").path("allowed").asBoolean())
        .isFalse();
    assertThat(transferring.path("capabilities").path("view").path("reason").asString())
        .contains("передачу управления");
    controls.acknowledge(fixture.worker(), fixture.boot(), fixture.session(), 2L);
    var restored =
        json.read(
            json.write(sessions.get(fixture.actor(), fixture.session(), fixture.controller())));
    assertThat(restored.path("capabilities").path("view").path("allowed").asBoolean()).isTrue();
    assertThat(restored.path("privacyMode").asString()).isEqualTo("LOGIN_PRIVATE");
    assertThat(restored.path("capabilities").path("release").path("visible").asBoolean()).isFalse();
    assertThat(restored.path("id").asString()).isEqualTo(fixture.session().toString());
  }

  @Test
  void screenshotPublishesOneVerifiedArtifactAndItsReceiptCannotReferenceAnotherFile()
      throws IOException {
    var fixture = fixture(false);
    var input = snapshotInput(fixture);
    var key = context();
    var receipt = navigation.snapshot(fixture.actor(), fixture.session(), input, key);
    assertThat(navigation.snapshot(fixture.actor(), fixture.session(), input, key))
        .isEqualTo(receipt);
    var command =
        Objects.requireNonNull(
            transaction.execute(status -> repository.lock(receipt.operationId())));
    navigation.permit(fixture.worker(), fixture.boot(), request(command));
    byte[] bytes = png();
    var metadata = screenshot(command, bytes);
    var grant = artifacts.allocate(fixture.worker(), fixture.boot(), metadata);
    assertThat(artifacts.allocate(fixture.worker(), fixture.boot(), metadata).artifactId())
        .isEqualTo(grant.artifactId());
    stored(bytes);
    var ready =
        artifacts.upload(
            grant.transferId(),
            artifacts.allocate(fixture.worker(), fixture.boot(), metadata).transferToken(),
            fixture.worker(),
            fixture.boot(),
            bytes.length,
            metadata.sha256(),
            new ByteArrayInputStream(bytes));
    assertThat(artifactRepository.artifact(ready.artifactId()).state()).isEqualTo("READY");
    var forged =
        new ArtifactContracts.Receipt(
            UUID.randomUUID(), ready.sha256(), ready.byteLength(), "READY");
    assertThatThrownBy(
            () ->
                navigation.result(
                    fixture.worker(),
                    fixture.boot(),
                    result(
                        command,
                        "SUCCEEDED",
                        "CONFIRMED",
                        Map.of("pageEpoch", 1, "artifact", forged))))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("differs");
    var result =
        result(command, "SUCCEEDED", "CONFIRMED", Map.of("pageEpoch", 1, "artifact", ready));
    navigation.result(fixture.worker(), fixture.boot(), result);
    navigation.result(fixture.worker(), fixture.boot(), result);
    var operation = operations.owned(fixture.actor().userId(), receipt.operationId());
    assertThat(operation.state()).isEqualTo("SUCCEEDED");
    assertThat(operation.targetType()).isEqualTo("artifact");
    assertThat(operation.targetId()).isEqualTo(ready.artifactId());
    assertThat(
            jdbc.sql("SELECT metric FROM usage_measurements WHERE source_id=:id")
                .param("id", ready.artifactId())
                .query(String.class)
                .list())
        .containsExactly("media_bytes");
    assertThatThrownBy(() -> artifacts.audioSource(fixture.actor(), ready.artifactId()))
        .isInstanceOf(DomainException.class);
    assertThat(artifacts.metadata(fixture.actor(), ready.artifactId()))
        .containsEntry("mimeType", "image/png");
  }

  @Test
  void screenshotIsUnavailablePrivatelyAndPrivacyOrLogoutRevokesAnIssuedUpload()
      throws IOException {
    var privateFixture = fixture(true);
    assertThatThrownBy(
            () ->
                navigation.snapshot(
                    privateFixture.actor(),
                    privateFixture.session(),
                    snapshotInput(privateFixture),
                    context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("ordinary task browser");
    for (String revoked : List.of("privacy", "login")) {
      var fixture = fixture(false);
      var receipt =
          navigation.snapshot(
              fixture.actor(), fixture.session(), snapshotInput(fixture), context());
      var command =
          Objects.requireNonNull(
              transaction.execute(status -> repository.lock(receipt.operationId())));
      navigation.permit(fixture.worker(), fixture.boot(), request(command));
      byte[] bytes = png();
      var metadata = screenshot(command, bytes);
      var grant = artifacts.allocate(fixture.worker(), fixture.boot(), metadata);
      if (revoked.equals("privacy")) {
        jdbc.sql(
                "UPDATE browser_sessions SET privacy='LOGIN_PRIVATE',privacy_epoch=privacy_epoch+1"
                    + " WHERE id=:id")
            .param("id", fixture.session())
            .update();
      } else {
        jdbc.sql("UPDATE application_logins SET state='REVOKED' WHERE id=:id")
            .param("id", fixture.actor().loginId())
            .update();
      }
      assertThatThrownBy(
              () ->
                  artifacts.upload(
                      grant.transferId(),
                      grant.transferToken(),
                      fixture.worker(),
                      fixture.boot(),
                      bytes.length,
                      metadata.sha256(),
                      new ByteArrayInputStream(bytes)))
          .isInstanceOf(DomainException.class)
          .hasMessageContaining("authorization");
    }
    verifyNoInteractions(storage, multipart);
  }

  @Test
  void confirmedScreenshotSurvivesLostCommandReceiptWithoutRepeatingCapture() throws IOException {
    var fixture = fixture(false);
    var receipt =
        navigation.snapshot(fixture.actor(), fixture.session(), snapshotInput(fixture), context());
    var command =
        Objects.requireNonNull(
            transaction.execute(status -> repository.lock(receipt.operationId())));
    navigation.permit(fixture.worker(), fixture.boot(), request(command));
    byte[] bytes = png();
    var metadata = screenshot(command, bytes);
    var grant = artifacts.allocate(fixture.worker(), fixture.boot(), metadata);
    stored(bytes);
    artifacts.upload(
        grant.transferId(),
        grant.transferToken(),
        fixture.worker(),
        fixture.boot(),
        bytes.length,
        metadata.sha256(),
        new ByteArrayInputStream(bytes));
    jdbc.sql("UPDATE human_browser_commands SET deadline=now()-interval '1 second' WHERE id=:id")
        .param("id", receipt.operationId())
        .update();
    navigation.reconcile();
    assertThat(operations.owned(fixture.actor().userId(), receipt.operationId()).state())
        .isEqualTo("SUCCEEDED");
    assertThat(operations.owned(fixture.actor().userId(), receipt.operationId()).targetId())
        .isEqualTo(grant.artifactId());
    assertThat(
            jdbc.sql("SELECT mutation_barrier FROM tasks WHERE id=:id")
                .param("id", fixture.task())
                .query(Boolean.class)
                .single())
        .isFalse();
    verifyNoInteractions(multipart);
  }

  @Test
  void screenshotHeaderMismatchNeverPublishesAndUnknownCaptureDoesNotInventAWebsiteEffect()
      throws IOException {
    var fixture = fixture(false);
    var receipt =
        navigation.snapshot(fixture.actor(), fixture.session(), snapshotInput(fixture), context());
    var command =
        Objects.requireNonNull(
            transaction.execute(status -> repository.lock(receipt.operationId())));
    navigation.permit(fixture.worker(), fixture.boot(), request(command));
    byte[] bytes = png();
    bytes[0] = 0;
    var metadata = screenshot(command, bytes);
    var grant = artifacts.allocate(fixture.worker(), fixture.boot(), metadata);
    stored(bytes);
    assertThatThrownBy(
            () ->
                artifacts.upload(
                    grant.transferId(),
                    grant.transferToken(),
                    fixture.worker(),
                    fixture.boot(),
                    bytes.length,
                    metadata.sha256(),
                    new ByteArrayInputStream(bytes)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("PNG");
    assertThat(artifactRepository.artifact(grant.artifactId()).state()).isEqualTo("UPLOADING");
    jdbc.sql("UPDATE human_browser_commands SET deadline=now()-interval '1 second' WHERE id=:id")
        .param("id", receipt.operationId())
        .update();
    navigation.reconcile();
    assertThat(operations.owned(fixture.actor().userId(), receipt.operationId()).state())
        .isEqualTo("NEEDS_ATTENTION");
    assertThat(
            jdbc.sql("SELECT mutation_barrier FROM tasks WHERE id=:id")
                .param("id", fixture.task())
                .query(Boolean.class)
                .single())
        .isFalse();
    Boolean effectsKnown =
        transaction.execute(status -> repository.effectsKnown(fixture.session()));
    assertThat(effectsKnown).isTrue();
  }

  @Test
  void controlAcknowledgementsCommitTheMatchingOperationInvalidation() {
    var fixture = fixture(false);
    var acquisition =
        controls.acquire(
            fixture.actor(),
            fixture.session(),
            new BrowserContracts.TakeControl(1L, 1L, fixture.controller(), false, false),
            context());
    controls.acknowledge(fixture.worker(), fixture.boot(), fixture.session(), 2);
    assertOperationInvalidated(fixture.actor(), acquisition.operationId());
    var release =
        controls.release(
            fixture.actor(),
            fixture.session(),
            new BrowserContracts.ReleaseControl(2L, fixture.controller(), "KEEP_PAUSED"),
            context());
    controls.acknowledge(fixture.worker(), fixture.boot(), fixture.session(), 3);
    assertOperationInvalidated(fixture.actor(), release.operationId());
  }

  private void assertOperationInvalidated(AuthenticatedActor actor, UUID operationId) {
    var operation = operations.owned(actor.userId(), operationId);
    assertThat(operation.state()).isEqualTo("SUCCEEDED");
    assertThat(
            jdbc.sql(
                    """
                    SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:id
                      AND aggregate_version=:version AND event_type='operations'
                    """)
                .param("id", operationId)
                .param("version", operation.version())
                .query(Long.class)
                .single())
        .isEqualTo(1);
  }

  private static BrowserContracts.Snapshot snapshotInput(Fixture fixture) {
    return new BrowserContracts.Snapshot(1L, 1L, 1L, fixture.controller());
  }

  private static byte[] png() throws IOException {
    try (var output = new ByteArrayOutputStream()) {
      assertThat(
              ImageIO.write(
                  new BufferedImage(1280, 720, BufferedImage.TYPE_INT_RGB), "png", output))
          .isTrue();
      return output.toByteArray();
    }
  }

  private static ArtifactContracts.ScreenshotMetadata screenshot(
      HumanBrowserCommandRepository.HumanCommand command, byte[] bytes) {
    return new ArtifactContracts.ScreenshotMetadata(
        1,
        command.id(),
        command.attemptId(),
        command.sessionId(),
        1,
        1,
        1,
        "SCREENSHOT",
        "image/png",
        bytes.length,
        JsonSupport.sha256(bytes),
        "BROWSER_SCREENSHOT",
        new ArtifactContracts.ScreenshotViewport(1280, 720));
  }

  private void stored(byte[] bytes) {
    when(storage.metadata(anyString(), anyString()))
        .thenReturn(
            Optional.of(new ObjectStorage.ObjectMetadata(bytes.length, JsonSupport.sha256(bytes))));
    when(storage.open(anyString(), anyString()))
        .thenAnswer(
            invocation ->
                new ResponseInputStream<>(
                    GetObjectResponse.builder().contentLength((long) bytes.length).build(),
                    AbortableInputStream.create(new ByteArrayInputStream(bytes))));
  }

  private Fixture fixture(boolean privateMode) {
    var account =
        transaction.execute(
            status ->
                identities.resolve(
                    "https://issuer.example",
                    UUID.randomUUID().toString(),
                    "Navigation fixture",
                    "navigation@example.com"));
    Objects.requireNonNull(account);
    UUID login = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO application_logins(id,user_id,issuer,sid,auth_time,admitted_access_epoch,expires_at)
            VALUES(:id,:user,'https://issuer.example',:sid,now(),1,now()+interval '1 hour')
            """)
        .param("id", login)
        .param("user", account.id())
        .param("sid", login.toString())
        .update();
    var actor =
        new AuthenticatedActor(
            account.id(),
            login,
            null,
            "helm-web",
            account.displayName(),
            account.email(),
            account.accessEpoch(),
            Set.of(),
            false);
    UUID task = UUID.randomUUID();
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    UUID session = UUID.randomUUID();
    UUID controller = UUID.randomUUID();
    jdbc.sql(
            "INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)"
                + " VALUES(:id,:user,'Read','Read','TEXT','ANGULAR','PAUSED')")
        .param("id", task)
        .param("user", account.id())
        .update();
    jdbc.sql(
            "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                + " VALUES(:id,:boot,1,'fixture')")
        .param("id", worker)
        .param("boot", boot)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_id,worker_boot_id,purpose,state,privacy,
            idle_deadline_at,budget_deadline_at) VALUES(:id,:user,:task,:worker,:boot,'TASK','ACTIVE',:privacy,
            now()+interval '5 minutes',now()+interval '10 minutes')
            """)
        .param("id", session)
        .param("user", account.id())
        .param("task", task)
        .param("worker", worker)
        .param("boot", boot)
        .param("privacy", privateMode ? "LOGIN_PRIVATE" : "NORMAL")
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_control_leases(session_id,owner_id,owner_kind,controller_instance_id,login_id,expires_at)
            VALUES(:session,:user,'HUMAN',:controller,:login,now()+interval '60 seconds')
            """)
        .param("session", session)
        .param("user", account.id())
        .param("controller", controller)
        .param("login", login)
        .update();
    return new Fixture(actor, task, session, worker, boot, controller);
  }

  private JsonNode request(HumanBrowserCommandRepository.HumanCommand command) {
    var value = new HashMap<>(json.map(command.scope()));
    value.put("commandId", command.id());
    value.put("attemptId", command.attemptId());
    value.put("actionDigest", command.actionDigest());
    return json.read(json.write(value));
  }

  private JsonNode result(
      HumanBrowserCommandRepository.HumanCommand command,
      String status,
      String effect,
      Map<String, Object> extra) {
    Map<String, Object> value = new HashMap<>();
    JsonNode scope = json.read(command.scope());
    value.put("schemaVersion", 1);
    value.put("commandId", command.id());
    value.put("attemptId", command.attemptId());
    value.put("taskId", scope.get("taskId"));
    value.put("browserSessionId", command.sessionId());
    value.put("allocationEpoch", 1);
    value.put("controlEpoch", 1);
    value.put("privacyEpoch", 1);
    value.put("pageEpoch", 2);
    value.put("status", status);
    value.put("effectState", effect);
    value.put("code", "HANDLER_COMPLETED");
    value.putAll(extra);
    value.put("digest", json.workerDigest(json.read(json.write(value))));
    return json.read(json.write(value));
  }

  private static BrowserContracts.Navigation input(Fixture fixture) {
    return new BrowserContracts.Navigation(
        "GOTO", "https://example.com", 1L, 1L, 1L, fixture.controller());
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
