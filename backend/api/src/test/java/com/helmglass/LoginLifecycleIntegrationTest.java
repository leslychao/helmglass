package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.WorkerRegistryService;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.connection.api.ConnectionContracts;
import com.helmglass.connection.api.LoginContracts;
import com.helmglass.connection.application.ConnectionLoginService;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringJUnitConfig(WorkflowIntegrationTest.Owners.class)
class LoginLifecycleIntegrationTest {
  private final ConnectionLoginService logins;
  private final LoginRepository loginRepository;
  private final ConnectionService connections;
  private final BrowserRepository browsers;
  private final WorkerRegistryService registry;
  private final WorkerRegistryRepository workers;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final TaskLifecycleService tasks;
  private final JsonSupport json;
  private final JdbcClient jdbc;
  private final TransactionTemplate transaction;

  @Autowired
  LoginLifecycleIntegrationTest(
      ConnectionLoginService logins,
      LoginRepository loginRepository,
      ConnectionService connections,
      BrowserRepository browsers,
      WorkerRegistryService registry,
      WorkerRegistryRepository workers,
      IdentityRepository identities,
      OperationRepository operations,
      TaskLifecycleService tasks,
      JsonSupport json,
      JdbcClient jdbc,
      PlatformTransactionManager transactions) {
    this.logins = logins;
    this.loginRepository = loginRepository;
    this.connections = connections;
    this.browsers = browsers;
    this.registry = registry;
    this.workers = workers;
    this.identities = identities;
    this.operations = operations;
    this.tasks = tasks;
    this.json = json;
    this.jdbc = jdbc;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void expiredQueuedLoginFailsItsReceiptAndAllowsANewExplicitLogin() {
    var actor = actor();
    UUID connectionId = connection(actor);
    UUID id = begin(actor, connectionId, null);
    expire(id);
    assertThatThrownBy(() -> logins.complete(actor, id, completion(id), context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("expired");
    logins.reconcileLogins();
    assertThat(loginRepository.get(id).state()).isEqualTo("FAILED");
    var failed = operations.owned(actor.userId(), id);
    assertThat(failed.state()).isEqualTo("FAILED");
    assertThat(failed.failureCode()).isEqualTo("LOGIN_EXPIRED");
    long version = loginRepository.get(id).version();
    logins.reconcileLogins();
    assertThat(loginRepository.get(id).version()).isEqualTo(version);
    assertThat(operations.owned(actor.userId(), id).version()).isEqualTo(failed.version());
    assertThat(begin(actor, connectionId, null)).isNotEqualTo(id);
  }

  @Test
  void expiryClosesLivePrivateRuntimeWithoutReleasingItsPhysicalClaim() {
    var actor = actor();
    UUID connectionId = connection(actor);
    UUID id = begin(actor, connectionId, null);
    var session = allocate(id);
    expire(id);
    assertThatThrownBy(() -> logins.complete(actor, id, completion(id), context()))
        .isInstanceOf(DomainException.class);
    logins.reconcileLogins();
    assertThat(loginRepository.get(id).state()).isEqualTo("FAILED");
    assertThat(browsers.owned(actor.userId(), session.id()).state()).isEqualTo("STOPPING");
    assertThat(allocationState(session.id())).isEqualTo("RESERVED");
    UUID closeIntent =
        jdbc.sql(
                "SELECT id FROM transactional_outbox WHERE aggregate_id=:id"
                    + " AND event_type='worker.close' AND published_at IS NULL")
            .param("id", session.id())
            .query(UUID.class)
            .single();
    assertThatThrownBy(() -> begin(actor, connectionId, null))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("already used");
    long sessionVersion = browsers.owned(actor.userId(), session.id()).version();
    logins.reconcileLogins();
    assertThat(browsers.owned(actor.userId(), session.id()).version()).isEqualTo(sessionVersion);
    assertThat(
            jdbc.sql(
                    "SELECT id FROM transactional_outbox WHERE aggregate_id=:id"
                        + " AND event_type='worker.close' AND published_at IS NULL")
                .param("id", session.id())
                .query(UUID.class)
                .single())
        .isEqualTo(closeIntent);
    confirmClosed(session.id());
    assertThat(allocationState(session.id())).isEqualTo("RELEASED");
    assertThat(
            jdbc.sql("SELECT published_at IS NOT NULL FROM transactional_outbox WHERE id=:id")
                .param("id", closeIntent)
                .query(Boolean.class)
                .single())
        .isTrue();
  }

  @Test
  void closedPrivateRuntimeEndsLoginAndPreservesThePreviouslySavedProfile() {
    var actor = actor();
    UUID connectionId = connection(actor);
    UUID profileVersion = savedProfile(actor, connectionId);
    UUID id = begin(actor, connectionId, null);
    var session = allocate(id);
    confirmClosed(session.id());
    logins.exited(session.workerId(), session.workerBootId(), session.id(), true);
    assertThat(loginRepository.get(id).state()).isEqualTo("FAILED");
    assertThat(operations.owned(actor.userId(), id).failureCode())
        .isEqualTo("LOGIN_BROWSER_CLOSED");
    assertThat(browsers.owned(actor.userId(), session.id()).state()).isEqualTo("CLOSED");
    assertThat(
            jdbc.sql("SELECT current_version_id FROM browser_profiles WHERE connection_id=:id")
                .param("id", connectionId)
                .query(UUID.class)
                .single())
        .isEqualTo(profileVersion);
    assertThat(connections.get(actor, connectionId).accountLabel()).isEqualTo("Saved fixture");
    assertThatThrownBy(() -> logins.cancel(actor, id, context()))
        .isInstanceOf(DomainException.class);
    logins.exited(session.workerId(), session.workerBootId(), session.id(), false);
    assertThat(loginRepository.get(id).state()).isEqualTo("FAILED");
    assertThat(begin(actor, connectionId, null)).isNotEqualTo(id);
  }

  @Test
  void cancellationReplaysAndCompletesOnlyAfterConfirmedClosure() {
    var actor = actor();
    UUID id = begin(actor, connection(actor), null);
    var session = allocate(id);
    var key = context();
    var receipt = logins.cancel(actor, id, key);
    assertThat(logins.cancel(actor, id, key)).isEqualTo(receipt);
    assertThat(operations.owned(actor.userId(), id).state()).isEqualTo("CANCELLED");
    assertThat(operations.owned(actor.userId(), receipt.operationId()).state())
        .isEqualTo("PENDING");
    assertThat(allocationState(session.id())).isEqualTo("RESERVED");
    assertThatThrownBy(() -> logins.cancel(actor, id, context()))
        .isInstanceOf(DomainException.class);
    confirmClosed(session.id());
    logins.reconcileLogins();
    var completed = operations.owned(actor.userId(), receipt.operationId());
    assertThat(completed.state()).isEqualTo("SUCCEEDED");
    logins.reconcileLogins();
    assertThat(operations.owned(actor.userId(), receipt.operationId()).version())
        .isEqualTo(completed.version());
    assertThat(browsers.owned(actor.userId(), session.id()).state()).isEqualTo("CLOSED");
  }

  @Test
  void revokedAuthorizationEndsLoginWithoutReleasingUnconfirmedRuntime() {
    var actor = actor();
    UUID id = begin(actor, connection(actor), null);
    var session = allocate(id);
    jdbc.sql("UPDATE application_logins SET state='REVOKED',revoked_at=now() WHERE id=:id")
        .param("id", actor.loginId())
        .update();
    logins.reconcileLogins();
    assertThat(loginRepository.get(id).state()).isEqualTo("FAILED");
    assertThat(operations.owned(actor.userId(), id).failureCode())
        .isEqualTo("LOGIN_AUTHORIZATION_EXPIRED");
    assertThat(browsers.owned(actor.userId(), session.id()).state()).isEqualTo("STOPPING");
    assertThat(allocationState(session.id())).isEqualTo("RESERVED");
  }

  @Test
  void navigationDeadlineCannotOutliveLoginAndExpiredLoginCannotIssueAPermit() {
    var actor = actor();
    UUID id = begin(actor, connection(actor), null);
    var session = allocate(id);
    jdbc.sql(
            "UPDATE connection_login_operations SET state='STARTING',"
                + " expires_at=now()+interval '30 seconds' WHERE id=:id")
        .param("id", id)
        .update();
    var login = loginRepository.get(id);
    var command =
        Objects.requireNonNull(
            transaction.execute(
                status -> loginRepository.navigation(login, "https://example.com/login")));
    assertThat(command.deadline()).isEqualTo(login.expiresAt());
    expire(id);
    var request =
        json.tree(
            Map.ofEntries(
                Map.entry("commandId", command.id()),
                Map.entry("attemptId", command.attemptId()),
                Map.entry("actionDigest", command.actionDigest()),
                Map.entry("browserSessionId", session.id()),
                Map.entry("allocationEpoch", session.allocationEpoch()),
                Map.entry("controlEpoch", 1),
                Map.entry("pageEpoch", session.pageEpoch()),
                Map.entry("privacyEpoch", session.privacyEpoch()),
                Map.entry("policyVersion", 1),
                Map.entry("instructionRevision", 0)));
    assertThatThrownBy(() -> logins.permit(session.workerId(), session.workerBootId(), request))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("no longer allowed");
    assertThat(loginRepository.command(command.id(), false).permitId()).isNull();
  }

  @Test
  void latePrivateHandbackDoesNotCompleteAnExpiredLogin() {
    var actor = actor();
    UUID id = begin(actor, connection(actor), null);
    var session = allocate(id);
    transaction.executeWithoutResult(status -> loginRepository.state(id, "EXITING_PRIVATE"));
    expire(id);
    logins.exited(session.workerId(), session.workerBootId(), session.id(), false);
    assertThat(loginRepository.get(id).state()).isEqualTo("FAILED");
    assertThat(operations.owned(actor.userId(), id).failureCode()).isEqualTo("LOGIN_EXPIRED");
    assertThat(browsers.owned(actor.userId(), session.id()).state()).isEqualTo("STOPPING");
    assertThat(allocationState(session.id())).isEqualTo("RESERVED");
  }

  @Test
  void expiryPreservesTaskLoginRequestWithoutAutomaticContinuation() {
    var actor = actor();
    UUID connectionId = connection(actor);
    UUID taskId =
        tasks
            .create(
                actor,
                new TaskContracts.Create(
                    "Read fixture",
                    "https://example.com",
                    List.of(connectionId),
                    "TEXT",
                    false,
                    1800,
                    "DRAFT"),
                context(), null)
            .resource()
            .id();
    var initial = tasks.get(actor, taskId);
    connections.resolve(
        actor,
        taskId,
        new ConnectionContracts.Resolve(
            "https://example.com/account", true, initial.version(), initial.instructionRevision()),
        context());
    var before = tasks.get(actor, taskId);
    UUID id = begin(actor, connectionId, taskId);
    expire(id);
    logins.reconcileLogins();
    var after = tasks.get(actor, taskId);
    assertThat(after.state()).isEqualTo(before.state());
    assertThat(after.activeRequest()).isEqualTo(before.activeRequest());
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM task_continuations WHERE task_id=:id AND"
                        + " state='CANCELLED'")
                .param("id", taskId)
                .query(Long.class)
                .single())
        .isEqualTo(1);
  }

  private UUID connection(AuthenticatedActor actor) {
    return connections
        .create(
            actor,
            new ConnectionContracts.Create("Fixture", "https://example.com/login", "ASK"),
            context())
        .resource()
        .id();
  }

  private UUID begin(AuthenticatedActor actor, UUID connectionId, UUID taskId) {
    return logins
        .begin(actor, connectionId, new LoginContracts.Begin(taskId, UUID.randomUUID()), context())
        .resource()
        .id();
  }

  private LoginContracts.Complete completion(UUID id) {
    var login = loginRepository.get(id);
    return new LoginContracts.Complete(
        login.version(),
        "SESSION_ONLY",
        "Fixture",
        List.of(login.expectedOrigin()),
        null,
        "KEEP_PAUSED",
        true,
        login.controllerInstanceId(),
        1L,
        1L);
  }

  private void expire(UUID id) {
    jdbc.sql(
            "UPDATE connection_login_operations SET expires_at=now()-interval '1 second' WHERE"
                + " id=:id")
        .param("id", id)
        .update();
  }

  private BrowserRepository.Session allocate(UUID id) {
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    registry.register(
        worker,
        boot,
        json.tree(
            WorkerGateway.envelope(
                "register",
                UUID.randomUUID(),
                Map.of(
                    "workerId",
                    worker,
                    "bootId",
                    boot,
                    "protocolVersion",
                    1,
                    "version",
                    "fixture",
                    "imageDigest",
                    "fixture",
                    "capacity",
                    1,
                    "state",
                    "READY",
                    "inventory",
                    List.of(),
                    "capabilities",
                    Map.of()))));
    assertThat(logins.allocate(id)).isPresent();
    var login = loginRepository.get(id);
    transaction.executeWithoutResult(
        status -> {
          jdbc.sql("UPDATE browser_sessions SET state='ACTIVE',ready_at=now() WHERE id=:id")
              .param("id", login.sessionId())
              .update();
          loginRepository.state(id, "WAITING_USER");
        });
    return browsers.owned(login.userId(), login.sessionId());
  }

  private void confirmClosed(UUID sessionId) {
    transaction.executeWithoutResult(status -> workers.closed(sessionId));
  }

  private String allocationState(UUID sessionId) {
    return jdbc.sql("SELECT state FROM browser_allocations WHERE session_id=:id")
        .param("id", sessionId)
        .query(String.class)
        .single();
  }

  private UUID savedProfile(AuthenticatedActor actor, UUID connectionId) {
    UUID profile = UUID.randomUUID();
    UUID version = UUID.randomUUID();
    transaction.executeWithoutResult(
        status -> {
          jdbc.sql(
                  "INSERT INTO browser_profiles(id,user_id,connection_id)"
                      + " VALUES(:id,:user,:connection)")
              .param("id", profile)
              .param("user", actor.userId())
              .param("connection", connectionId)
              .update();
          jdbc.sql(
                  """
                      INSERT INTO browser_profile_versions(id,profile_id,revision,object_key,checksum,wrapped_dek,
                  vault_key_ref,runtime_version,origins_manifest,state,size)
                  VALUES(:id,:profile,1,'fixture',repeat('a',64),'fixture','fixture','fixture','{}','READY',100)
                  """)
              .param("id", version)
              .param("profile", profile)
              .update();
          jdbc.sql("UPDATE browser_profiles SET current_version_id=:version WHERE id=:id")
              .param("version", version)
              .param("id", profile)
              .update();
          jdbc.sql(
                  "UPDATE connections SET status='SAVED',account_label='Saved fixture' WHERE"
                      + " id=:id")
              .param("id", connectionId)
              .update();
        });
    return version;
  }

  private AuthenticatedActor actor() {
    return Objects.requireNonNull(
        transaction.execute(
            status -> {
              var account =
                  identities.resolve(
                      "https://issuer.example",
                      UUID.randomUUID().toString(),
                      "Test",
                      "test@example.test");
              UUID login =
                  identities.admitLogin(
                      account,
                      "https://issuer.example",
                      UUID.randomUUID().toString(),
                      Instant.now(),
                      Instant.now().plusSeconds(300));
              return new AuthenticatedActor(
                  account.id(),
                  login,
                  null,
                  "helm-web",
                  "Test",
                  "test@example.test",
                  account.accessEpoch(),
                  Set.of(),
                  false);
            }));
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
