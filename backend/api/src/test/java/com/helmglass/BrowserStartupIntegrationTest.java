package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.application.BrowserAllocationService;
import com.helmglass.browser.application.BrowserOpenService;
import com.helmglass.browser.application.BrowserStartupService;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.infrastructure.repository.BrowserOpenRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository;
import com.helmglass.command.api.CommandContracts;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.connection.api.ConnectionContracts;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionResolutionRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.profile.domain.ProfileBinding;
import com.helmglass.profile.infrastructure.ProfileKeyService.WrappedKey;
import com.helmglass.profile.infrastructure.repository.ProfileRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import com.helmglass.usage.application.UsageCheckpointService;
import com.helmglass.usage.application.UsageService;
import com.helmglass.usage.infrastructure.repository.UsageRepository;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
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
import tools.jackson.databind.node.ObjectNode;

@SpringJUnitConfig(BrowserStartupIntegrationTest.Owners.class)
class BrowserStartupIntegrationTest {
  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    CommandExecutionService.class,
    WorkerProtocol.class,
    ConnectionService.class,
    ConnectionRepository.class,
    ConnectionResolutionRepository.class,
    BrowserStartupRepository.class,
    BrowserStartupService.class,
    BrowserOpenService.class,
    BrowserAllocationService.class,
    BrowserOpenRepository.class,
    UsageService.class,
    UsageCheckpointService.class,
    UsageRepository.class,
    ProfileRepository.class
  })
  static class Owners {
    @Bean
    BrowserProfileService profiles() {
      return mock(BrowserProfileService.class);
    }
  }

  private record Fixture(
      AuthenticatedActor actor,
      UUID taskId,
      UUID sessionId,
      UUID workerId,
      UUID bootId,
      UUID commandId,
      UUID operationId,
      UUID transferId) {}

  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final IdentityRepository identities;
  private final TaskLifecycleService tasks;
  private final ConnectionService connections;
  private final CommandExecutionService execution;
  private final CommandRepository commands;
  private final BrowserRepository browsers;
  private final BrowserStartupRepository startups;
  private final BrowserStartupService startup;
  private final BrowserOpenService opens;
  private final ProfileRepository profileRepository;
  private final BrowserProfileService profiles;
  private final OperationRepository operations;
  private final TransactionTemplate transaction;

  @Autowired
  BrowserStartupIntegrationTest(
      JdbcClient jdbc,
      JsonSupport json,
      IdentityRepository identities,
      TaskLifecycleService tasks,
      ConnectionService connections,
      CommandExecutionService execution,
      CommandRepository commands,
      BrowserRepository browsers,
      BrowserStartupRepository startups,
      BrowserStartupService startup,
      BrowserOpenService opens,
      ProfileRepository profileRepository,
      BrowserProfileService profiles,
      OperationRepository operations,
      PlatformTransactionManager transactions) {
    this.jdbc = jdbc;
    this.json = json;
    this.identities = identities;
    this.tasks = tasks;
    this.connections = connections;
    this.execution = execution;
    this.commands = commands;
    this.browsers = browsers;
    this.startups = startups;
    this.startup = startup;
    this.opens = opens;
    this.profileRepository = profileRepository;
    this.profiles = profiles;
    this.operations = operations;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void explicitPausedOpenLoadsPinnedProfileAndNavigatesWithoutInventingATaskCommand() {
    Fixture fixture = fixture(true);
    assertThat(startup.assigned(fixture.sessionId())).isFalse();
    startup.loaded(
        fixture.workerId(),
        fixture.bootId(),
        fixture.sessionId(),
        loadReceipt(fixture, "a".repeat(64)));
    startup.permit(fixture.workerId(), fixture.bootId(), startupPermit(fixture));
    assertThat(startup.result(fixture.workerId(), fixture.bootId(), navigationReceipt(fixture)))
        .isNull();
    startup.acknowledgeReady(
        fixture.workerId(),
        fixture.bootId(),
        fixture.sessionId(),
        WorkerRuntimeReceipts.ready(json, fixture.bootId(), fixture.sessionId(), 1));
    opens.ready(fixture.sessionId());
    assertThat(browsers.owned(fixture.actor().userId(), fixture.sessionId()).state())
        .isEqualTo("ACTIVE");
    assertThat(tasks.get(fixture.actor(), fixture.taskId()).state()).isEqualTo("PAUSED");
    assertThat(operations.owned(fixture.actor().userId(), fixture.operationId()).state())
        .isEqualTo("SUCCEEDED");
    assertThat(
            jdbc.sql("SELECT count(*) FROM task_commands WHERE task_id=:id")
                .param("id", fixture.taskId())
                .query(Long.class)
                .single())
        .isZero();
  }

  @Test
  void originalCommandWaitsForProfileLoadAndSingleConfirmedNavigation() {
    Fixture fixture = fixture();
    assertThat(startup.assigned(fixture.sessionId())).isFalse();
    assertThat(startup.assigned(fixture.sessionId())).isFalse();
    assertThatThrownBy(
            () -> execution.start(fixture.workerId(), fixture.bootId(), commandPermit(fixture)))
        .isInstanceOf(DomainException.class);
    assertThat(browsers.owned(fixture.actor().userId(), fixture.sessionId()).state())
        .isEqualTo("STARTING");
    assertThatThrownBy(
            () ->
                startup.loaded(
                    fixture.workerId(),
                    fixture.bootId(),
                    fixture.sessionId(),
                    loadReceipt(fixture, "b".repeat(64))))
        .isInstanceOf(DomainException.class);
    startup.loaded(
        fixture.workerId(),
        fixture.bootId(),
        fixture.sessionId(),
        loadReceipt(fixture, "a".repeat(64)));
    var permit = startupPermit(fixture);
    startup.permit(fixture.workerId(), fixture.bootId(), permit);
    assertThatThrownBy(() -> startup.permit(fixture.workerId(), fixture.bootId(), permit))
        .isInstanceOf(DomainException.class);
    var receipt = navigationReceipt(fixture);
    assertThat(startup.result(fixture.workerId(), fixture.bootId(), receipt))
        .isEqualTo(fixture.commandId());
    assertThat(startup.result(fixture.workerId(), fixture.bootId(), receipt)).isNull();
    startup.acknowledgeReady(
        fixture.workerId(),
        fixture.bootId(),
        fixture.sessionId(),
        WorkerRuntimeReceipts.ready(json, fixture.bootId(), fixture.sessionId(), 1));
    assertThat(browsers.owned(fixture.actor().userId(), fixture.sessionId()).state())
        .isEqualTo("ACTIVE");
    execution.start(fixture.workerId(), fixture.bootId(), commandPermit(fixture));
    assertThat(commands.get(fixture.actor().userId(), fixture.commandId()))
        .containsEntry("state", "STARTED");
  }

  @Test
  void stoppedTaskCannotBeReactivatedByALateStartupReceipt() {
    Fixture fixture = navigating();
    tasks.stop(fixture.actor(), fixture.taskId(), context());
    JsonNode receipt = navigationReceipt(fixture);
    assertThat(startup.result(fixture.workerId(), fixture.bootId(), receipt)).isNull();
    assertThat(startup.result(fixture.workerId(), fixture.bootId(), receipt)).isNull();
    assertThat(browsers.owned(fixture.actor().userId(), fixture.sessionId()).state())
        .isEqualTo("STOPPING");
    assertThat(commands.get(fixture.actor().userId(), fixture.commandId()))
        .containsEntry("effectState", "NOT_STARTED");
    assertThat(operations.owned(fixture.actor().userId(), fixture.operationId()).state())
        .isEqualTo("FAILED");
  }

  @Test
  void startupDeadlineRecordsOriginalCommandAsNotStartedAndDoesNotFreeAllocation() {
    Fixture fixture = navigating();
    jdbc.sql(
            "UPDATE browser_profile_startups SET deadline=now()-interval '1 second' WHERE"
                + " session_id=:id")
        .param("id", fixture.sessionId())
        .update();
    startup.expire();
    assertThat(commands.get(fixture.actor().userId(), fixture.commandId()))
        .containsEntry("state", "FAILED")
        .containsEntry("effectState", "NOT_STARTED");
    assertThat(
            jdbc.sql("SELECT state FROM browser_allocations WHERE session_id=:id")
                .param("id", fixture.sessionId())
                .query(String.class)
                .single())
        .isEqualTo("ASSIGNED");
    assertThat(startup.result(fixture.workerId(), fixture.bootId(), navigationReceipt(fixture)))
        .isNull();
    assertThat(browsers.owned(fixture.actor().userId(), fixture.sessionId()).state())
        .isEqualTo("STOPPING");
  }

  private Fixture navigating() {
    Fixture fixture = fixture();
    startup.assigned(fixture.sessionId());
    startup.loaded(
        fixture.workerId(),
        fixture.bootId(),
        fixture.sessionId(),
        loadReceipt(fixture, "a".repeat(64)));
    startup.permit(fixture.workerId(), fixture.bootId(), startupPermit(fixture));
    return fixture;
  }

  private JsonNode loadReceipt(Fixture fixture, String checksum) {
    return json.read(
        json.write(
            Map.of("transferId", fixture.transferId(), "sha256", checksum, "byteLength", 64)));
  }

  private ObjectNode startupPermit(Fixture fixture) {
    var row = transaction.execute(status -> startups.forSession(fixture.sessionId()).orElseThrow());
    Objects.requireNonNull(row);
    var request =
        (ObjectNode)
            json.read(
                json.write(BrowserStartupService.scope(startups.context(fixture.sessionId()))));
    request
        .put("commandId", row.navigationId().toString())
        .put("attemptId", row.attemptId().toString())
        .put("actionDigest", row.actionDigest());
    return request;
  }

  private ObjectNode commandPermit(Fixture fixture) {
    var dispatch = commands.dispatch(fixture.commandId());
    var request = (ObjectNode) json.read(json.write(CommandExecutionService.scope(dispatch)));
    request
        .put("commandId", dispatch.commandId().toString())
        .put("attemptId", dispatch.attemptId().toString())
        .put("actionDigest", dispatch.payloadHash());
    return request;
  }

  private JsonNode navigationReceipt(Fixture fixture) {
    var request = startupPermit(fixture);
    var receipt = json.read("{}").deepCopy();
    if (!(receipt instanceof ObjectNode result)) {
      throw new IllegalStateException("Object fixture was not an object");
    }
    for (String field :
        List.of(
            "commandId",
            "attemptId",
            "taskId",
            "browserSessionId",
            "allocationEpoch",
            "controlEpoch",
            "privacyEpoch")) {
      result.set(field, request.get(field));
    }
    result
        .put("schemaVersion", 1)
        .put("pageEpoch", 3)
        .put("status", "SUCCEEDED")
        .put("effectState", "CONFIRMED")
        .put("code", "HANDLER_COMPLETED");
    result.put("digest", json.workerDigest(result));
    return result;
  }

  private Fixture fixture() {
    return fixture(false);
  }

  private Fixture fixture(boolean explicitOpen) {
    var actor =
        Objects.requireNonNull(
            transaction.execute(
                status -> {
                  var account =
                      identities.resolve(
                          "https://issuer.example",
                          UUID.randomUUID().toString(),
                          "Fixture",
                          "fixture@example.test");
                  UUID loginId =
                      identities.admitLogin(
                          account,
                          "https://issuer.example",
                          UUID.randomUUID().toString(),
                          Instant.now(),
                          Instant.now().plusSeconds(300));
                  return new AuthenticatedActor(
                      account.id(),
                      loginId,
                      null,
                      "helm-web",
                      "Fixture",
                      "fixture@example.test",
                      account.accessEpoch(),
                      Set.of(),
                      false);
                }));
    UUID connectionId =
        connections
            .create(
                actor,
                new ConnectionContracts.Create("Account", "https://example.com/home", "SAVE"),
                context())
            .resource()
            .id();
    var profile =
        Objects.requireNonNull(
            transaction.execute(status -> profileRepository.profile(actor.userId(), connectionId)));
    var version =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    profileRepository.stage(
                        UUID.randomUUID(),
                        new ProfileBinding(
                            actor.userId(),
                            connectionId,
                            profile.id(),
                            1,
                            1,
                            1,
                            List.of("https://example.com"),
                            List.of("example.com")),
                        new WrappedKey("fixture", "fixture"),
                        "fixture")));
    // A persisted encrypted object is the boundary of this owner test; storage/crypto have separate
    // tests.
    transaction.executeWithoutResult(
        status -> {
          jdbc.sql(
                  "UPDATE browser_profile_versions SET state='READY',checksum=:hash,size=64 WHERE"
                      + " id=:id")
              .param("hash", "a".repeat(64))
              .param("id", version.id())
              .update();
          jdbc.sql("UPDATE browser_profiles SET current_version_id=:version WHERE id=:id")
              .param("id", profile.id())
              .param("version", version.id())
              .update();
          jdbc.sql("UPDATE connections SET status='SAVED' WHERE id=:id")
              .param("id", connectionId)
              .update();
        });
    UUID taskId =
        tasks
            .create(
                actor,
                new TaskContracts.Create(
                    "Read saved account",
                    "https://example.com/home",
                    List.of(connectionId),
                    "TEXT",
                    false,
                    1800,
                    "PREPARE"),
                context(),
                null)
            .resource()
            .id();
    var task = tasks.get(actor, taskId);
    UUID commandId = explicitOpen ? null : UUID.randomUUID();
    MutationReceipt accepted;
    if (explicitOpen) {
      tasks.pause(actor, taskId, context());
      accepted =
          opens.open(
              actor,
              taskId,
              new BrowserContracts.Open(
                  tasks.get(actor, taskId).version(), "TASK", "SAVE_ON_CLOSE", null, false),
              context());
    } else {
      accepted =
          execution.accept(
              actor,
              taskId,
              new CommandContracts.Submit(
                  commandId,
                  task.version(),
                  task.instructionRevision(),
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  json.read("{\"type\":\"OBSERVE\"}")),
              context(),
              null);
    }
    UUID workerId = UUID.randomUUID();
    UUID bootId = UUID.randomUUID();
    var session =
        Objects.requireNonNull(
            transaction.execute(
                status -> {
                  jdbc.sql(
                          "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                              + " VALUES(:id,:boot,1,'fixture')")
                      .param("id", workerId)
                      .param("boot", bootId)
                      .update();
                  BrowserRepository.Session reserved;
                  if (explicitOpen) {
                    reserved =
                        browsers.allocate(
                            browsers.owned(actor.userId(), accepted.resource().id()),
                            connectionId,
                            new BrowserRepository.Worker(workerId, bootId, 1),
                            1800);
                  } else {
                    reserved =
                        browsers.reserve(
                            actor.userId(),
                            taskId,
                            connectionId,
                            "TASK",
                            new BrowserRepository.Worker(workerId, bootId, 1),
                            1800);
                    browsers.dispatch(browsers.candidate(commandId), reserved);
                  }
                  startups.prepare(
                      reserved.id(),
                      commandId,
                      version.id(),
                      "https://example.com/home",
                      Instant.now().plusSeconds(60));
                  // Launch admission belongs to WorkerRegistryService; this test begins at its
                  // confirmed ACK.
                  jdbc.sql("UPDATE browser_allocations SET state='ASSIGNED' WHERE session_id=:id")
                      .param("id", reserved.id())
                      .update();
                  return reserved;
                }));
    UUID transferId = UUID.randomUUID();
    transaction.executeWithoutResult(
        status ->
            profileRepository.issue(
                transferId,
                version,
                profileRepository.scope(actor.userId(), session.id(), connectionId),
                profile,
                "LOAD",
                "a".repeat(64),
                "fixture-wrapped-token"));
    when(profiles.prepareLoad(actor.userId(), session.id(), connectionId))
        .thenReturn(
            new BrowserProfileService.Grant(
                workerId, version.id(), Map.of("type", "profileLoad", "transferId", transferId)));
    return new Fixture(
        actor,
        taskId,
        session.id(),
        workerId,
        bootId,
        commandId,
        accepted.operationId(),
        transferId);
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
