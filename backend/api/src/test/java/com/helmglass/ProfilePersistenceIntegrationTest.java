package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserSessionOperationService;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserCloseOutboxRepository;
import com.helmglass.browser.infrastructure.repository.BrowserSessionOperationRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.connection.application.ConnectionLoginService;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.identity.infrastructure.repository.PolicyRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.profile.domain.ProfileBinding;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import com.helmglass.profile.infrastructure.ProfileKeyService.WrappedKey;
import com.helmglass.profile.infrastructure.repository.ProfileRepository;
import com.helmglass.profile.infrastructure.repository.ProfileRepository.Profile;
import com.helmglass.profile.infrastructure.repository.ProfileRepository.Transfer;
import com.helmglass.profile.infrastructure.repository.ProfileRepository.Version;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
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
import tools.jackson.databind.JsonNode;

@SpringJUnitConfig(ProfilePersistenceIntegrationTest.TestConfiguration.class)
class ProfilePersistenceIntegrationTest {
  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    ProfileRepository.class,
    PolicyRepository.class,
    UserPolicyService.class,
    BrowserProfileService.class,
    BrowserSessionOperationRepository.class,
    BrowserSessionOperationService.class,
    BrowserControlService.class,
    ConnectionRepository.class,
    LoginRepository.class,
    ConnectionLoginService.class,
    WorkerProtocol.class
  })
  static class TestConfiguration {
    @Bean
    ObjectStorage objectStorage() {
      return mock(ObjectStorage.class);
    }

    @Bean
    ProfileKeyService profileKeyService() {
      return mock(ProfileKeyService.class);
    }
  }

  private record Fixture(
      UUID userId,
      UUID connectionId,
      UUID sessionId,
      UUID workerId,
      UUID bootId,
      Profile profile,
      Version version,
      Transfer transfer,
      String token) {}

  private final JdbcClient jdbc;
  private final IdentityRepository identities;
  private final ProfileRepository profiles;
  private final BrowserProfileService service;
  private final ObjectStorage storage;
  private final ProfileKeyService keys;
  private final TransactionTemplate transaction;
  private final BrowserSessionOperationService sessionOperations;
  private final BrowserSessionOperationRepository sessionRepository;
  private final BrowserRepository browsers;
  private final BrowserCloseOutboxRepository closeOutbox;
  private final ControlRepository controls;
  private final OperationRepository operations;
  private final JsonSupport json;
  private final ConnectionLoginService logins;

  private record ManualFixture(
      Fixture profile, AuthenticatedActor actor, UUID task, UUID controller) {}

  @Autowired
  ProfilePersistenceIntegrationTest(
      JdbcClient jdbc,
      IdentityRepository identities,
      ProfileRepository profiles,
      BrowserProfileService service,
      ObjectStorage storage,
      ProfileKeyService keys,
      PlatformTransactionManager transactions,
      BrowserSessionOperationService sessionOperations,
      BrowserSessionOperationRepository sessionRepository,
      BrowserRepository browsers,
      BrowserCloseOutboxRepository closeOutbox,
      ControlRepository controls,
      OperationRepository operations,
      JsonSupport json,
      ConnectionLoginService logins) {
    this.jdbc = jdbc;
    this.identities = identities;
    this.profiles = profiles;
    this.service = service;
    this.storage = storage;
    this.keys = keys;
    transaction = new TransactionTemplate(transactions);
    this.sessionOperations = sessionOperations;
    this.sessionRepository = sessionRepository;
    this.browsers = browsers;
    this.closeOutbox = closeOutbox;
    this.controls = controls;
    this.operations = operations;
    this.json = json;
    this.logins = logins;
  }

  @BeforeEach
  void isolateExternalBoundaries() {
    reset(storage, keys);
  }

  @Test
  void privacyControlAndPolicyChangesRevokePreviouslyIssuedTransfers() {
    List<String> mutations =
        List.of(
            "UPDATE browser_sessions SET privacy_epoch=privacy_epoch+1 WHERE id=:id",
            "UPDATE browser_control_leases SET epoch=epoch+1 WHERE session_id=:id",
            "UPDATE user_policies SET version=version+1 WHERE user_id=:id");
    for (int index = 0; index < mutations.size(); index++) {
      Fixture fixture = fixture();
      jdbc.sql(mutations.get(index))
          .param("id", index == 2 ? fixture.userId() : fixture.sessionId())
          .update();
      assertThatThrownBy(
              () ->
                  service.upload(
                      fixture.transfer().id(),
                      fixture.token(),
                      fixture.workerId(),
                      fixture.bootId(),
                      64,
                      "a".repeat(64),
                      new ByteArrayInputStream(new byte[64])))
          .isInstanceOf(DomainException.class)
          .hasMessage("Profile assignment has changed");
    }
    verifyNoInteractions(storage);
  }

  @Test
  void quiescentAcceptedSaveUsesTransferDeadlineAfterTheHumanHeartbeatStops() throws IOException {
    Fixture fixture = fixture();
    jdbc.sql(
            "UPDATE browser_control_leases SET state='QUIESCED',expires_at=now()-interval '1"
                + " second' WHERE session_id=:id")
        .param("id", fixture.sessionId())
        .update();
    when(storage.metadata("hg-browser-profiles", fixture.version().objectKey()))
        .thenReturn(Optional.of(new ObjectStorage.ObjectMetadata(64, "a".repeat(64))));
    assertThat(
            service
                .upload(
                    fixture.transfer().id(),
                    fixture.token(),
                    fixture.workerId(),
                    fixture.bootId(),
                    64,
                    "a".repeat(64),
                    new ByteArrayInputStream(new byte[64]))
                .sha256())
        .isEqualTo("a".repeat(64));
    assertThat(profiles.version(fixture.version().id()).state()).isEqualTo("READY");
    jdbc.sql("UPDATE profile_transfers SET expires_at=now()-interval '1 second' WHERE id=:id")
        .param("id", fixture.transfer().id())
        .update();
    assertThatThrownBy(
            () ->
                service.upload(
                    fixture.transfer().id(),
                    fixture.token(),
                    fixture.workerId(),
                    fixture.bootId(),
                    64,
                    "a".repeat(64),
                    new ByteArrayInputStream(new byte[64])))
        .isInstanceOf(DomainException.class)
        .hasMessage("Profile transfer is no longer authorized");
  }

  @Test
  void explicitSaveCanPersistTemporaryLoginWithoutEnablingAutomaticSave() {
    Fixture fixture = fixture();
    jdbc.sql("UPDATE connections SET save_preference='SESSION_ONLY' WHERE id=:id")
        .param("id", fixture.connectionId())
        .update();
    jdbc.sql("UPDATE profile_transfers SET state='REVOKED' WHERE id=:id")
        .param("id", fixture.transfer().id())
        .update();
    jdbc.sql("UPDATE browser_control_leases SET state='QUIESCED' WHERE session_id=:id")
        .param("id", fixture.sessionId())
        .update();
    allowKeys(fixture);
    assertThatThrownBy(
            () ->
                service.prepareSave(
                    fixture.userId(), fixture.sessionId(), fixture.connectionId(), false))
        .isInstanceOf(DomainException.class)
        .hasMessage("Profile saving requires user consent");
    var grant =
        service.prepareSave(fixture.userId(), fixture.sessionId(), fixture.connectionId(), true);
    assertThat(grant.profileVersionId()).isNotEqualTo(fixture.version().id());
    UUID transferId = (UUID) grant.message().get("transferId");
    // The initial delivery can be lost after commit. Recovery uses no process-local grant state.
    assertThat(service.reissueSave(fixture.userId(), transferId)).isEqualTo(grant);
    assertThat(service.reissueSave(fixture.userId(), transferId)).isEqualTo(grant);
    assertThat(
            jdbc.sql("SELECT count(*) FROM profile_transfers WHERE connection_id=:id")
                .param("id", fixture.connectionId())
                .query(Long.class)
                .single())
        .isEqualTo(2);
    jdbc.sql("UPDATE browser_control_leases SET epoch=epoch+1 WHERE session_id=:id")
        .param("id", fixture.sessionId())
        .update();
    assertThatThrownBy(() -> service.reissueSave(fixture.userId(), transferId))
        .isInstanceOf(DomainException.class)
        .hasMessage("Profile assignment has changed");
    assertThat(
            jdbc.sql("SELECT save_preference FROM connections WHERE id=:id")
                .param("id", fixture.connectionId())
                .query(String.class)
                .single())
        .isEqualTo("SESSION_ONLY");
  }

  @Test
  void manualSaveWaitsForQuiescencePublishesOnceAndRequiresTheResumeReceipt() throws IOException {
    var fixture = manualFixture();
    var profile = fixture.profile();
    allowKeys(profile);
    var input = new BrowserContracts.Save(1L, 1L, 1L, fixture.controller(), null);
    var context = context();
    var receipt = sessionOperations.save(fixture.actor(), profile.sessionId(), input, context);
    assertThat(sessionOperations.save(fixture.actor(), profile.sessionId(), input, context))
        .isEqualTo(receipt);
    assertThat(controls.get(profile.sessionId()).state()).isEqualTo("QUIESCING");
    assertThat(
            jdbc.sql("SELECT count(*) FROM profile_transfers WHERE connection_id=:id")
                .param("id", profile.connectionId())
                .query(Long.class)
                .single())
        .isEqualTo(1);
    assertThat(
            sessionOperations.acknowledge(
                profile.workerId(),
                profile.bootId(),
                profile.sessionId(),
                boundary(fixture, "QUIESCED", 3, 3)))
        .isTrue();
    var pending =
        Objects.requireNonNull(
            transaction.execute(status -> sessionRepository.lock(receipt.operationId())));
    assertThat(pending.state()).isEqualTo("SAVING");
    var grant = service.reissueSave(profile.userId(), pending.transferId());
    sessionOperations.progress(receipt.operationId());
    assertThat(
            jdbc.sql("SELECT count(*) FROM profile_transfers WHERE connection_id=:id")
                .param("id", profile.connectionId())
                .query(Long.class)
                .single())
        .isEqualTo(2);
    var version = profiles.version(pending.profileVersionId());
    when(storage.metadata("hg-browser-profiles", version.objectKey()))
        .thenReturn(Optional.of(new ObjectStorage.ObjectMetadata(64, "b".repeat(64))));
    service.upload(
        pending.transferId(),
        (String) grant.message().get("transferToken"),
        profile.workerId(),
        profile.bootId(),
        64,
        "b".repeat(64),
        new ByteArrayInputStream(new byte[64]));
    assertThat(
            service.confirmSaved(
                profile.workerId(),
                profile.bootId(),
                profile.sessionId(),
                pending.transferId(),
                "b".repeat(64),
                64))
        .containsEntry("transferId", pending.transferId());
    assertThatThrownBy(
            () ->
                service.confirmSaved(
                    profile.workerId(),
                    profile.bootId(),
                    profile.sessionId(),
                    pending.transferId(),
                    "c".repeat(64),
                    64))
        .isInstanceOf(DomainException.class);
    // Publication is durable even when profileSaved was lost before reaching the API.
    sessionOperations.progress(receipt.operationId());
    assertThat(operations.owned(profile.userId(), receipt.operationId()).state())
        .isEqualTo("PENDING");
    assertThat(controls.get(profile.sessionId()).state()).isEqualTo("TRANSFERRING");
    sessionOperations.acknowledge(
        profile.workerId(),
        profile.bootId(),
        profile.sessionId(),
        boundary(fixture, "HUMAN", 0, 0));
    assertThat(operations.owned(profile.userId(), receipt.operationId()).state())
        .isEqualTo("SUCCEEDED");
    assertThat(browsers.owned(profile.userId(), profile.sessionId()).profileVersionId()).isNull();
    assertThat(
            jdbc.sql("SELECT current_version_id FROM browser_profiles WHERE id=:id")
                .param("id", profile.profile().id())
                .query(UUID.class)
                .single())
        .isEqualTo(version.id());
    assertThat(
            jdbc.sql("SELECT save_preference FROM connections WHERE id=:id")
                .param("id", profile.connectionId())
                .query(String.class)
                .single())
        .isEqualTo("SESSION_ONLY");
  }

  @Test
  void closeWithoutSavingPausesTaskAndWaitsForPhysicalClosure() {
    var fixture = manualFixture();
    var profile = fixture.profile();
    var receipt =
        sessionOperations.close(
            fixture.actor(),
            profile.sessionId(),
            new BrowserContracts.Close(1L, 1L, 1L, fixture.controller(), null, false),
            context());
    sessionOperations.acknowledge(
        profile.workerId(),
        profile.bootId(),
        profile.sessionId(),
        boundary(fixture, "QUIESCED", 2, 2));
    assertThat(browsers.owned(profile.userId(), profile.sessionId()).state()).isEqualTo("STOPPING");
    assertThat(
            jdbc.sql("SELECT state FROM tasks WHERE id=:id")
                .param("id", fixture.task())
                .query(String.class)
                .single())
        .isEqualTo("PAUSED");
    assertThat(operations.owned(profile.userId(), receipt.operationId()).state())
        .isEqualTo("PENDING");
    jdbc.sql("UPDATE browser_sessions SET state='CLOSED',binding_released_at=now() WHERE id=:id")
        .param("id", profile.sessionId())
        .update();
    sessionOperations.progress(receipt.operationId());
    assertThat(operations.owned(profile.userId(), receipt.operationId()).state())
        .isEqualTo("SUCCEEDED");
    verifyNoInteractions(keys, storage);
  }

  @Test
  void incompleteInputCheckpointPreventsSavingAndMarksEffectUnknown() {
    var fixture = manualFixture();
    var profile = fixture.profile();
    var receipt =
        sessionOperations.save(
            fixture.actor(),
            profile.sessionId(),
            new BrowserContracts.Save(1L, 1L, 1L, fixture.controller(), null),
            context());
    sessionOperations.acknowledge(
        profile.workerId(),
        profile.bootId(),
        profile.sessionId(),
        boundary(fixture, "QUIESCED", 4, 3));
    assertThat(operations.owned(profile.userId(), receipt.operationId()).state())
        .isEqualTo("NEEDS_ATTENTION");
    assertThat(
            jdbc.sql("SELECT mutation_barrier FROM tasks WHERE id=:id")
                .param("id", fixture.task())
                .query(Boolean.class)
                .single())
        .isTrue();
    verifyNoInteractions(keys, storage);
  }

  @Test
  void saveRequiresCurrentControlAndProfileAndExpiresWithoutInventingAnInputReceipt() {
    var fixture = manualFixture();
    var profile = fixture.profile();
    assertThatThrownBy(
            () ->
                sessionOperations.save(
                    fixture.actor(),
                    profile.sessionId(),
                    new BrowserContracts.Save(1L, 1L, 1L, UUID.randomUUID(), null),
                    context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Acquire control");
    assertThatThrownBy(
            () ->
                sessionOperations.save(
                    fixture.actor(),
                    profile.sessionId(),
                    new BrowserContracts.Save(1L, 1L, 1L, fixture.controller(), UUID.randomUUID()),
                    context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Refresh");
    var receipt =
        sessionOperations.save(
            fixture.actor(),
            profile.sessionId(),
            new BrowserContracts.Save(1L, 1L, 1L, fixture.controller(), null),
            context());
    jdbc.sql(
            "UPDATE browser_session_operations SET deadline=now()-interval '1 second' WHERE id=:id")
        .param("id", receipt.operationId())
        .update();
    sessionOperations.progress(receipt.operationId());
    assertThat(operations.owned(profile.userId(), receipt.operationId()).state())
        .isEqualTo("NEEDS_ATTENTION");
    verifyNoInteractions(keys, storage);
  }

  private JsonNode boundary(ManualFixture fixture, String mode, long accepted, long applied) {
    var session = browsers.owned(fixture.profile().userId(), fixture.profile().sessionId());
    var control = controls.get(session.id());
    return json.read(
        json.write(
            Map.of(
                "allocationEpoch",
                session.allocationEpoch(),
                "controlEpoch",
                control.epoch(),
                "privacyEpoch",
                session.privacyEpoch(),
                "pageEpoch",
                session.pageEpoch(),
                "mode",
                mode,
                "lastAcceptedInputSequence",
                accepted,
                "lastAppliedInputSequence",
                applied)));
  }

  @Test
  void loginSaveRecoveryRedeliversOriginalTransferAndDoesNotInferAuthenticatedState()
      throws IOException {
    var fixture = manualFixture();
    var profile = fixture.profile();
    String initialStatus =
        jdbc.sql("SELECT status FROM connections WHERE id=:id")
            .param("id", profile.connectionId())
            .query(String.class)
            .single();
    allowKeys(profile);
    jdbc.sql("UPDATE browser_sessions SET privacy='LOGIN_PRIVATE' WHERE id=:id")
        .param("id", profile.sessionId())
        .update();
    jdbc.sql("UPDATE browser_control_leases SET state='QUIESCED' WHERE session_id=:id")
        .param("id", profile.sessionId())
        .update();
    var grant =
        service.prepareSave(profile.userId(), profile.sessionId(), profile.connectionId(), true);
    var login =
        operations.save(
            fixture.actor(),
            "connections.login:" + profile.connectionId(),
            context(),
            Map.of(),
            "connection",
            profile.connectionId(),
            1,
            false);
    var completion =
        operations.save(
            fixture.actor(),
            "login.complete:" + login.operationId(),
            context(),
            Map.of(),
            "loginOperation",
            login.operationId(),
            1,
            false);
    jdbc.sql(
            """
            INSERT INTO connection_login_operations(id,connection_id,user_id,session_id,task_id,kind,state,
              controller_instance_id,expected_origin,save_mode,complete_operation_id,profile_version_id,login_id)
            VALUES(:id,:connection,:user,:session,:task,'LOGIN','SAVING',:controller,'https://example.com',
              'SAVE_PROFILE',:completion,:profile,:login)
            """)
        .param("id", login.operationId())
        .param("connection", profile.connectionId())
        .param("user", profile.userId())
        .param("session", profile.sessionId())
        .param("task", fixture.task())
        .param("controller", fixture.controller())
        .param("completion", completion.operationId())
        .param("profile", grant.profileVersionId())
        .param("login", fixture.actor().loginId())
        .update();
    logins.reconcileProfileSaves();
    logins.reconcileProfileSaves();
    assertThat(
            jdbc.sql("SELECT count(*) FROM profile_transfers WHERE connection_id=:id")
                .param("id", profile.connectionId())
                .query(Long.class)
                .single())
        .isEqualTo(2);
    var version = profiles.version(grant.profileVersionId());
    when(storage.metadata("hg-browser-profiles", version.objectKey()))
        .thenReturn(Optional.of(new ObjectStorage.ObjectMetadata(64, "d".repeat(64))));
    service.upload(
        (UUID) grant.message().get("transferId"),
        (String) grant.message().get("transferToken"),
        profile.workerId(),
        profile.bootId(),
        64,
        "d".repeat(64),
        new ByteArrayInputStream(new byte[64]));
    logins.reconcileProfileSaves();
    assertThat(
            jdbc.sql("SELECT state FROM connection_login_operations WHERE id=:id")
                .param("id", login.operationId())
                .query(String.class)
                .single())
        .isEqualTo("SAVED_VERIFYING");
    assertThat(operations.owned(profile.userId(), completion.operationId()).state())
        .isEqualTo("PENDING");
    assertThat(
            jdbc.sql("SELECT status FROM connections WHERE id=:id")
                .param("id", profile.connectionId())
                .query(String.class)
                .single())
        .isEqualTo(initialStatus);
  }

  private ManualFixture manualFixture() {
    return manualFixture(fixture());
  }

  private ManualFixture manualFixture(Fixture profile) {
    UUID login = UUID.randomUUID();
    UUID controller = UUID.randomUUID();
    UUID task = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO application_logins(id,user_id,issuer,sid,auth_time,admitted_access_epoch,expires_at)
              VALUES(:id,:user,'https://identity.example',:sid,now(),1,now()+interval '1 hour')
            """)
        .param("id", login)
        .param("user", profile.userId())
        .param("sid", login.toString())
        .update();
    jdbc.sql(
            """
            INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)
              VALUES(:id,:user,'Read','Read','TEXT','ANGULAR','WAITING_AGENT')
            """)
        .param("id", task)
        .param("user", profile.userId())
        .update();
    jdbc.sql(
            "UPDATE browser_sessions SET task_id=:task,purpose='TASK',privacy='NORMAL' WHERE"
                + " id=:id")
        .param("id", profile.sessionId())
        .param("task", task)
        .update();
    jdbc.sql("UPDATE profile_transfers SET state='REVOKED' WHERE id=:id AND state='ISSUED'")
        .param("id", profile.transfer().id())
        .update();
    jdbc.sql("UPDATE connections SET save_preference='SESSION_ONLY' WHERE id=:id")
        .param("id", profile.connectionId())
        .update();
    jdbc.sql(
            "UPDATE browser_control_leases SET controller_instance_id=:controller,login_id=:login"
                + " WHERE session_id=:id")
        .param("id", profile.sessionId())
        .param("controller", controller)
        .param("login", login)
        .update();
    return new ManualFixture(
        profile,
        new AuthenticatedActor(
            profile.userId(),
            login,
            null,
            "helm-web",
            "Fixture",
            "fixture@example.com",
            1,
            Set.of(),
            false),
        task,
        controller);
  }

  @Test
  void savePolicyUpdatesCurrentAndFutureConsentAtomicallyWithoutDeletingTheSavedProfile() {
    Fixture profile = fixture();
    transaction.executeWithoutResult(
        status -> profiles.publish(profile.transfer(), profile.version(), "a".repeat(64), 64));
    var fixture = manualFixture(profile);
    assertThatThrownBy(
            () ->
                sessionOperations.savePolicy(
                    fixture.actor(),
                    profile.sessionId(),
                    new BrowserContracts.SavePolicy(1L, 99L, "SAVE_ON_CLOSE"),
                    context()))
        .isInstanceOf(DomainException.class);
    assertThat(browsers.owned(profile.userId(), profile.sessionId()).savePolicy())
        .isEqualTo("DISCARD_CHANGES");
    MutationContext context = context();
    var input = new BrowserContracts.SavePolicy(1L, 1L, "SAVE_ON_CLOSE");
    var receipt =
        sessionOperations.savePolicy(fixture.actor(), profile.sessionId(), input, context);
    assertThat(sessionOperations.savePolicy(fixture.actor(), profile.sessionId(), input, context))
        .isEqualTo(receipt);
    assertThat(browsers.owned(profile.userId(), profile.sessionId()).savePolicy())
        .isEqualTo("SAVE_ON_CLOSE");
    assertThat(
            jdbc.sql("SELECT save_preference FROM connections WHERE id=:id")
                .param("id", profile.connectionId())
                .query(String.class)
                .single())
        .isEqualTo("SAVE");
    sessionOperations.savePolicy(
        fixture.actor(),
        profile.sessionId(),
        new BrowserContracts.SavePolicy(2L, 2L, "DISCARD_CHANGES"),
        context());
    assertThat(
            jdbc.sql("SELECT save_preference FROM connections WHERE id=:id")
                .param("id", profile.connectionId())
                .query(String.class)
                .single())
        .isEqualTo("SESSION_ONLY");
    assertThat(
            jdbc.sql("SELECT current_version_id FROM browser_profiles WHERE id=:id")
                .param("id", profile.profile().id())
                .query(UUID.class)
                .single())
        .isEqualTo(profile.version().id());
    assertThat(profiles.version(profile.version().id()).state()).isEqualTo("READY");
    verifyNoInteractions(keys, storage);
  }

  @Test
  void deadlineCloseUsesPersistedConsentWithoutAWebLeaseAndWaitsForPublication()
      throws IOException {
    var fixture = automaticCloseFixture("NORMAL");
    var profile = fixture.profile();
    allowKeys(profile);
    jdbc.sql(
            "UPDATE browser_sessions SET state='STOPPING',budget_deadline_at=now()-interval '1"
                + " second' WHERE id=:id")
        .param("id", profile.sessionId())
        .update();
    jdbc.sql("UPDATE application_logins SET revoked_at=now() WHERE id=:id")
        .param("id", fixture.actor().loginId())
        .update();
    sessionOperations.prepareDueClosures();
    sessionOperations.prepareDueClosures();
    UUID operationId = sessionRepository.pendingForSession(profile.sessionId()).orElseThrow();
    var operation = transaction.execute(status -> sessionRepository.lock(operationId));
    assertThat(operation).isNotNull();
    assertThat(operation.initiator()).isEqualTo("SYSTEM");
    assertThat(operation.loginId()).isNull();
    assertThat(operation.controllerInstanceId()).isNull();
    closeOutbox.enqueueDue();
    assertThat(closeOutbox.due())
        .noneMatch(row -> profile.sessionId().equals(row.sessionId()));
    sessionOperations.acknowledge(
        profile.workerId(),
        profile.bootId(),
        profile.sessionId(),
        boundary(fixture, "QUIESCED", 0, 0));
    var saving =
        Objects.requireNonNull(transaction.execute(status -> sessionRepository.lock(operationId)));
    var grant = service.reissueSave(profile.userId(), saving.transferId());
    var transfer = transaction.execute(status -> profiles.transfer(saving.transferId()));
    assertThat(transfer).isNotNull();
    assertThat(transfer.expiresAt()).isBeforeOrEqualTo(operation.deadline());
    var version = profiles.version(saving.profileVersionId());
    when(storage.metadata("hg-browser-profiles", version.objectKey()))
        .thenReturn(Optional.of(new ObjectStorage.ObjectMetadata(64, "e".repeat(64))));
    service.upload(
        saving.transferId(),
        (String) grant.message().get("transferToken"),
        profile.workerId(),
        profile.bootId(),
        64,
        "e".repeat(64),
        new ByteArrayInputStream(new byte[64]));
    sessionOperations.progress(operationId);
    closeOutbox.enqueueDue();
    assertThat(closeOutbox.due())
        .anyMatch(row -> profile.sessionId().equals(row.sessionId()));
    assertThat(operations.owned(profile.userId(), operationId).state()).isEqualTo("PENDING");
    jdbc.sql("UPDATE browser_sessions SET state='CLOSED',binding_released_at=now() WHERE id=:id")
        .param("id", profile.sessionId())
        .update();
    sessionOperations.progress(operationId);
    assertThat(operations.owned(profile.userId(), operationId).state()).isEqualTo("SUCCEEDED");
    assertThat(
            jdbc.sql("SELECT count(*) FROM browser_session_operations WHERE session_id=:id")
                .param("id", profile.sessionId())
                .query(Long.class)
                .single())
        .isEqualTo(1);
  }

  @Test
  void privateDeadlineDoesNotInventConsentToCaptureLoginState() {
    var fixture = automaticCloseFixture("LOGIN_PRIVATE");
    var profile = fixture.profile();
    sessionOperations.prepareDueClosures();
    UUID operationId = sessionRepository.pendingForSession(profile.sessionId()).orElseThrow();
    sessionOperations.acknowledge(
        profile.workerId(),
        profile.bootId(),
        profile.sessionId(),
        boundary(fixture, "QUIESCED", 0, 0));
    jdbc.sql("UPDATE browser_sessions SET state='CLOSED',binding_released_at=now() WHERE id=:id")
        .param("id", profile.sessionId())
        .update();
    sessionOperations.progress(operationId);
    var operation = operations.owned(profile.userId(), operationId);
    assertThat(operation.state()).isEqualTo("FAILED");
    assertThat(operation.failureCode()).isEqualTo("PROFILE_SAVE_UNAVAILABLE_AT_CLOSE");
    verifyNoInteractions(keys, storage);
  }

  @Test
  void revocationPreemptsAutomaticSaveAndCannotDelayPhysicalClosure() {
    var fixture = automaticCloseFixture("NORMAL");
    var profile = fixture.profile();
    allowKeys(profile);
    sessionOperations.prepareDueClosures();
    UUID operationId = sessionRepository.pendingForSession(profile.sessionId()).orElseThrow();
    sessionOperations.acknowledge(
        profile.workerId(),
        profile.bootId(),
        profile.sessionId(),
        boundary(fixture, "QUIESCED", 0, 0));
    var saving =
        Objects.requireNonNull(transaction.execute(status -> sessionRepository.lock(operationId)));
    var grant = service.reissueSave(profile.userId(), saving.transferId());
    jdbc.sql(
            "UPDATE application_users SET state='BLOCKED',access_epoch=access_epoch+1 WHERE id=:id")
        .param("id", profile.userId())
        .update();
    closeOutbox.enqueueDue();
    assertThat(closeOutbox.due())
        .anyMatch(row -> profile.sessionId().equals(row.sessionId()));
    assertThatThrownBy(
            () ->
                service.upload(
                    saving.transferId(),
                    (String) grant.message().get("transferToken"),
                    profile.workerId(),
                    profile.bootId(),
                    64,
                    "f".repeat(64),
                    new ByteArrayInputStream(new byte[64])))
        .isInstanceOf(DomainException.class);
    verifyNoInteractions(storage);
  }

  private ManualFixture automaticCloseFixture(String privacy) {
    var fixture = manualFixture();
    var profile = fixture.profile();
    jdbc.sql(
            "UPDATE browser_sessions SET"
                + " runtime_generation=:generation,save_policy='SAVE_ON_CLOSE',privacy=:privacy,idle_deadline_at=now()-interval"
                + " '1 second' WHERE id=:id")
        .param("generation", UUID.randomUUID())
        .param("privacy", privacy)
        .param("id", profile.sessionId())
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_allocations(id,session_id,user_id,worker_id,connection_id,slot_index,allocation_epoch,state)
            VALUES(:id,:session,:user,:worker,:connection,0,1,'ASSIGNED')
            """)
        .param("id", UUID.randomUUID())
        .param("session", profile.sessionId())
        .param("user", profile.userId())
        .param("worker", profile.workerId())
        .param("connection", profile.connectionId())
        .update();
    return fixture;
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }

  private void allowKeys(Fixture fixture) {
    when(keys.create(fixture.userId()))
        .thenReturn(
            new ProfileKeyService.KeyMaterial(
                new WrappedKey("profiles/" + fixture.userId(), "fixture-wrapped-key"),
                new byte[32]));
    when(keys.wrapTransferToken(eq(fixture.userId()), any(byte[].class)))
        .thenAnswer(
            call ->
                new WrappedKey(
                    "profiles/" + fixture.userId(),
                    "fixture-token:"
                        + Base64.getEncoder().encodeToString(call.getArgument(1, byte[].class))));
    when(keys.unwrap(eq(fixture.userId()), any(WrappedKey.class)))
        .thenAnswer(
            call -> {
              WrappedKey wrapped = call.getArgument(1, WrappedKey.class);
              return wrapped.ciphertext().startsWith("fixture-token:")
                  ? Base64.getDecoder()
                      .decode(wrapped.ciphertext().substring("fixture-token:".length()))
                  : new byte[32];
            });
  }

  @Test
  void staleProfilePublicationCannotReplaceACommittedNewerPointer() {
    Fixture fixture = fixture();
    String checksum = "a".repeat(64);
    transaction.executeWithoutResult(
        status -> profiles.publish(fixture.transfer(), fixture.version(), checksum, 64));
    Version competing =
        transaction.execute(
            status ->
                profiles.stage(
                    UUID.randomUUID(),
                    new ProfileBinding(
                        fixture.userId(),
                        fixture.connectionId(),
                        fixture.profile().id(),
                        2,
                        1,
                        1,
                        List.of("https://example.com"),
                        List.of("example.com")),
                    new WrappedKey("profiles/" + fixture.userId(), "fixture-wrapped-key"),
                    "sha256:fixture"));
    assertThat(competing).isNotNull();
    assertThatThrownBy(
            () ->
                transaction.executeWithoutResult(
                    status -> profiles.publish(fixture.transfer(), competing, checksum, 64)))
        .isInstanceOf(DomainException.class)
        .extracting(error -> ((DomainException) error).getCode())
        .isEqualTo("PROFILE_VERSION_CONFLICT");
    Profile current =
        transaction.execute(status -> profiles.profile(fixture.userId(), fixture.connectionId()));
    assertThat(current).isNotNull();
    assertThat(current.currentVersionId()).isEqualTo(fixture.version().id());
    assertThat(profiles.version(competing.id()).state()).isEqualTo("STAGED");
  }

  @Test
  void changedScopeRejectsCiphertextBeforeItReachesStorage() {
    Fixture fixture = fixture();
    jdbc.sql("UPDATE connections SET scope_version=scope_version+1 WHERE id=:id")
        .param("id", fixture.connectionId())
        .update();
    assertThatThrownBy(
            () ->
                service.upload(
                    fixture.transfer().id(),
                    fixture.token(),
                    fixture.workerId(),
                    fixture.bootId(),
                    64,
                    "a".repeat(64),
                    new ByteArrayInputStream(new byte[64])))
        .isInstanceOf(DomainException.class)
        .extracting(error -> ((DomainException) error).getCode())
        .isEqualTo("PROFILE_TRANSFER_STALE");
    verifyNoInteractions(storage);
  }

  @Test
  void anotherWorkerAndBlockedAccountCannotUseAnOtherwiseValidTransfer() {
    Fixture fixture = fixture();
    assertThatThrownBy(
            () ->
                service.upload(
                    fixture.transfer().id(),
                    fixture.token(),
                    UUID.randomUUID(),
                    fixture.bootId(),
                    64,
                    "a".repeat(64),
                    new ByteArrayInputStream(new byte[64])))
        .isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE application_users SET state='BLOCKED' WHERE id=:id")
        .param("id", fixture.userId())
        .update();
    assertThatThrownBy(
            () ->
                service.upload(
                    fixture.transfer().id(),
                    fixture.token(),
                    fixture.workerId(),
                    fixture.bootId(),
                    64,
                    "a".repeat(64),
                    new ByteArrayInputStream(new byte[64])))
        .isInstanceOf(DomainException.class);
    verifyNoInteractions(storage);
  }

  private Fixture fixture() {
    Fixture fixture =
        transaction.execute(
            status -> {
              UUID user =
                  identities
                      .resolve(
                          "https://identity.example",
                          UUID.randomUUID().toString(),
                          "Fixture",
                          "fixture@example.com")
                      .id();
              UUID site = UUID.randomUUID();
              UUID connection = UUID.randomUUID();
              UUID worker = UUID.randomUUID();
              UUID boot = UUID.randomUUID();
              UUID session = UUID.randomUUID();
              jdbc.sql(
                      "INSERT INTO sites(id,normalized_host,display_name)"
                          + " VALUES(:id,:host,'Fixture')")
                  .param("id", site)
                  .param("host", site + ".example")
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO connections(id,user_id,site_id,display_name,start_url,origin,save_preference)
                      VALUES(:id,:user,:site,'Fixture','https://example.com','https://example.com','SAVE')
                      """)
                  .param("id", connection)
                  .param("user", user)
                  .param("site", site)
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO connection_origins(id,connection_id,user_id,origin,role,admitted_scope_version,confirmation_source)
                      VALUES(:id,:connection,:user,'https://example.com','APP',1,'EXPLICIT_CREATE')
                      """)
                  .param("id", UUID.randomUUID())
                  .param("connection", connection)
                  .param("user", user)
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO browser_workers(id,boot_id,capacity,image_version)
                      VALUES(:id,:boot,1,'sha256:fixture')
                      """)
                  .param("id", worker)
                  .param("boot", boot)
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO browser_sessions(id,user_id,connection_id,worker_id,worker_boot_id,purpose,
                        state,privacy,idle_deadline_at,budget_deadline_at)
                      VALUES(:id,:user,:connection,:worker,:boot,'CONNECTION_LOGIN','ACTIVE','LOGIN_PRIVATE',
                        now()+interval '5 minutes',now()+interval '10 minutes')
                      """)
                  .param("id", session)
                  .param("user", user)
                  .param("connection", connection)
                  .param("worker", worker)
                  .param("boot", boot)
                  .update();
              jdbc.sql(
                      """
                      INSERT INTO browser_control_leases(session_id,owner_kind,owner_id,expires_at)
                      VALUES(:id,'HUMAN',:user,now()+interval '5 minutes')
                      """)
                  .param("id", session)
                  .param("user", user)
                  .update();
              Profile profile = profiles.profile(user, connection);
              ProfileBinding binding =
                  new ProfileBinding(
                      user,
                      connection,
                      profile.id(),
                      1,
                      1,
                      1,
                      List.of("https://example.com"),
                      List.of("example.com"));
              Version version =
                  profiles.stage(
                      UUID.randomUUID(),
                      binding,
                      new WrappedKey("profiles/" + user, "fixture-wrapped-key"),
                      "sha256:fixture");
              String token = UUID.randomUUID().toString();
              Transfer transfer =
                  profiles.issue(
                      UUID.randomUUID(),
                      version,
                      profiles.scope(user, session, connection),
                      profile,
                      "SAVE",
                      JsonSupport.sha256(token),
                      "fixture-wrapped-token");
              return new Fixture(
                  user, connection, session, worker, boot, profile, version, transfer, token);
            });
    if (fixture == null) {
      throw new IllegalStateException("Fixture transaction failed");
    }
    return fixture;
  }
}
