package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import com.helmglass.account.application.AccountLifecycleService;
import com.helmglass.account.infrastructure.repository.AccountCleanupRepository;
import com.helmglass.administration.api.AdminContracts;
import com.helmglass.administration.application.AdministrationService;
import com.helmglass.administration.infrastructure.repository.AdministrationRepository;
import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.application.BrowserAllocationService;
import com.helmglass.browser.application.BrowserOpenService;
import com.helmglass.browser.application.BrowserStartupService;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.application.WorkerRegistryService;
import com.helmglass.browser.infrastructure.repository.BrowserOpenRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.command.api.CommandContracts;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionResolutionRepository;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.identity.infrastructure.repository.PolicyRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import com.helmglass.usage.application.UsageCheckpointService;
import com.helmglass.usage.application.UsageService;
import com.helmglass.usage.infrastructure.repository.UsageRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
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
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringJUnitConfig(CoreOwnersIntegrationTest.Owners.class)
class CoreOwnersIntegrationTest {
  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    AdministrationRepository.class,
    AdministrationService.class,
    AccountLifecycleService.class,
    AccountCleanupRepository.class,
    BrowserRepository.class,
    BrowserOpenRepository.class,
    BrowserOpenService.class,
    BrowserAllocationService.class,
    CommandRepository.class,
    CommandExecutionService.class,
    UserPolicyService.class,
    PolicyRepository.class,
    UsageRepository.class,
    UsageService.class,
    UsageCheckpointService.class,
    WorkerProtocol.class,
    WorkerRegistryService.class,
    WorkerRegistryRepository.class,
    BrowserStartupRepository.class,
    BrowserStartupService.class,
    ConnectionService.class,
    ConnectionRepository.class,
    ConnectionResolutionRepository.class
  })
  static class Owners {
    @Bean
    BrowserProfileService profiles() {
      return mock(BrowserProfileService.class);
    }
  }

  private final TaskLifecycleService tasks;
  private final CommandExecutionService commands;
  private final BrowserAllocationService allocator;
  private final BrowserRepository browsers;
  private final WorkerRegistryService registry;
  private final BrowserStartupService startup;
  private final AdministrationService administration;
  private final AccountLifecycleService accounts;
  private final IdentityRepository identities;
  private final UsageCheckpointService checkpoints;
  private final UsageService usage;
  private final JsonSupport json;
  private final TransactionTemplate transaction;

  @Autowired
  CoreOwnersIntegrationTest(
      TaskLifecycleService tasks,
      CommandExecutionService commands,
      BrowserAllocationService allocator,
      BrowserRepository browsers,
      AdministrationService administration,
      AccountLifecycleService accounts,
      IdentityRepository identities,
      UsageCheckpointService checkpoints,
      UsageService usage,
      JsonSupport json,
      PlatformTransactionManager transactions,
      WorkerRegistryService registry,
      BrowserStartupService startup) {
    this.tasks = tasks;
    this.commands = commands;
    this.allocator = allocator;
    this.browsers = browsers;
    this.registry = registry;
    this.startup = startup;
    this.administration = administration;
    this.accounts = accounts;
    this.identities = identities;
    this.checkpoints = checkpoints;
    this.usage = usage;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void staleWorkerEpochCannotStartAnAcceptedAction() {
    var actor = actor(false);
    var task =
        tasks.create(
            actor,
            new TaskContracts.Create(
                "Read page", "https://example.com", List.of(), "TEXT", false, 1800, "PREPARE"),
            context(),
            null);
    var snapshot = tasks.get(actor, task.resource().id());
    UUID commandId = UUID.randomUUID();
    var input =
        new CommandContracts.Submit(
            commandId,
            snapshot.version(),
            snapshot.instructionRevision(),
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            json.read("{\"type\":\"NAVIGATE\",\"url\":\"https://example.com\"}"));
    commands.accept(actor, snapshot.id(), input, context(), null);
    UUID workerId = UUID.randomUUID();
    UUID bootId = UUID.randomUUID();
    register(workerId, bootId);
    var allocated = allocator.allocate(commandId).orElseThrow();
    var dispatch = allocated.dispatch();
    ready(dispatch);
    Map<String, Object> permitRequest = new HashMap<>(CommandExecutionService.scope(dispatch));
    permitRequest.put("commandId", commandId);
    permitRequest.put("attemptId", dispatch.attemptId());
    permitRequest.put("actionDigest", dispatch.payloadHash());
    permitRequest.put("controlEpoch", dispatch.controlEpoch() + 1);
    assertThatThrownBy(() -> commands.start(workerId, bootId, json.read(json.write(permitRequest))))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("authorization changed");
    permitRequest.put("controlEpoch", dispatch.controlEpoch());
    assertThat(commands.start(workerId, bootId, json.read(json.write(permitRequest))))
        .containsKey("permitId");
    assertThatThrownBy(() -> commands.start(workerId, bootId, json.read(json.write(permitRequest))))
        .isInstanceOf(DomainException.class);
    Map<String, Object> observation = new HashMap<>();
    observation.put("taskId", dispatch.taskId());
    observation.put("browserSessionId", dispatch.sessionId());
    observation.put("controlEpoch", dispatch.controlEpoch());
    observation.put("privacyEpoch", dispatch.privacyEpoch());
    observation.put("pageEpoch", dispatch.pageEpoch() + 1);
    observation.put("url", "https://example.com/confirmed?token=secret#fragment");
    Map<String, Object> result = new HashMap<>(observation);
    result.remove("url");
    result.put("allocationEpoch", dispatch.allocationEpoch());
    result.put("schemaVersion", 1);
    result.put("commandId", commandId);
    result.put("attemptId", dispatch.attemptId());
    result.put("status", "SUCCEEDED");
    result.put("effectState", "CONFIRMED");
    result.put("code", "HANDLER_COMPLETED");
    result.put("observation", observation);
    result.put("digest", json.workerDigest(json.read(json.write(result))));
    commands.acceptResult(workerId, bootId, json.read(json.write(result)));
    assertThat(browsers.owned(actor.userId(), dispatch.sessionId()).currentUrl())
        .isEqualTo("https://example.com/confirmed");
  }

  @Test
  void administrationRequiresRoleAndDeletionRestorePreservesBlockedState() {
    var admin = actor(true);
    var user = actor(false);
    assertThatThrownBy(() -> administration.overview(user)).isInstanceOf(DomainException.class);
    accounts.change(
        admin, user.userId(), new AdminContracts.Reason(1L, "Access review"), context(), "block");
    assertThat(identities.isActive(user.userId())).isFalse();
    var current = administration.user(admin, user.userId());
    var deletion =
        accounts.change(
            admin,
            user.userId(),
            new AdminContracts.Reason(
                ((Number) current.get("version")).longValue(), "Scheduled removal"),
            context(),
            "delete");
    accounts.restore(
        admin,
        deletion.resource().id(),
        new AdminContracts.Reason(1L, "Restore requested"),
        context());
    assertThat(administration.user(admin, user.userId())).containsEntry("accountState", "BLOCKED");
    assertThat(identities.isActive(user.userId())).isFalse();
    assertThatThrownBy(
            () ->
                accounts.change(
                    admin,
                    admin.userId(),
                    new AdminContracts.Reason(1L, "Self block"),
                    context(),
                    "block"))
        .isInstanceOf(DomainException.class);
  }

  @Test
  void usageCumulativeReceiptsDoNotDoubleCountAndIncompleteRemainsExplicit() {
    var actor = actor(false);
    var task =
        tasks.create(
            actor,
            new TaskContracts.Create(
                "Measure", "https://example.com", List.of(), "TEXT", false, 1800, "PREPARE"),
            context(),
            null);
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    register(worker, boot);
    var session =
        transaction.execute(
            status -> {
              return browsers.reserve(
                  actor.userId(),
                  task.resource().id(),
                  new BrowserRepository.Worker(worker, boot, 1),
                  1800);
            });
    Objects.requireNonNull(session);
    Map<String, Object> value =
        new HashMap<>(
            Map.of(
                "sourceId",
                boot + ":" + session.id(),
                "sourceSequence",
                1,
                "browserMs",
                1500,
                "executionMs",
                250,
                "humanMs",
                0,
                "loginMs",
                0,
                "browserComplete",
                false));
    value.put(
        "sourceStartedAt", Instant.now().minusSeconds(2).truncatedTo(ChronoUnit.MILLIS).toString());
    checkpoints.record(worker, boot, session.id(), json.read(json.write(value)));
    checkpoints.record(worker, boot, session.id(), json.read(json.write(value)));
    var before =
        json.read(
            json.write(
                usage.summary(
                    actor, Instant.now().minusSeconds(60), Instant.now().plusSeconds(60), "UTC")));
    assertThat(before.path("metrics").path("browser_seconds").path("completeness").asString())
        .isEqualTo("PARTIAL");
    assertThat(before.path("metrics").path("browser_seconds").path("knownValue").asDouble())
        .isEqualTo(1.5);
    value.put("sourceSequence", 2);
    value.put("browserComplete", true);
    checkpoints.record(worker, boot, session.id(), json.read(json.write(value)));
    var after =
        json.read(
            json.write(
                usage.summary(
                    actor, Instant.now().minusSeconds(60), Instant.now().plusSeconds(60), "UTC")));
    assertThat(after.path("metrics").path("browser_seconds").path("value").asDouble())
        .isEqualTo(1.5);
    assertThat(after.path("metrics").path("media_bytes").path("value").isNull()).isTrue();
  }

  private AuthenticatedActor actor(boolean admin) {
    var account =
        transaction.execute(
            status ->
                identities.resolve(
                    "https://issuer.example",
                    UUID.randomUUID().toString(),
                    "Test user",
                    "test@example.test"));
    Objects.requireNonNull(account);
    return new AuthenticatedActor(
        account.id(),
        UUID.randomUUID(),
        null,
        "helm-web",
        account.displayName(),
        account.email(),
        account.accessEpoch(),
        admin ? Set.of("platform_admin") : Set.of(),
        false);
  }

  private void register(UUID worker, UUID boot) {
    Map<String, Object> registration = new HashMap<>();
    registration.put("schemaVersion", 1);
    registration.put("type", "register");
    registration.put("requestId", UUID.randomUUID());
    registration.put("workerId", worker);
    registration.put("bootId", boot);
    registration.put("protocolVersion", 1);
    registration.put("version", "0.1.0");
    registration.put("imageDigest", "test-image");
    registration.put("capacity", 1);
    registration.put("state", "READY");
    registration.put("inventory", List.of());
    registration.put("capabilities", Map.of());
    registry.register(worker, boot, json.read(json.write(registration)));
  }

  private void ready(CommandRepository.Dispatch dispatch) {
    Map<String, Object> assignment = CommandExecutionService.scope(dispatch);
    assignment.put(
        "deadline", browsers.owned(dispatch.userId(), dispatch.sessionId()).budgetDeadlineAt());
    assignment.put("originPolicy", "PUBLIC");
    assignment.put("allowedOrigins", List.of());
    var normalized = registry.assignment(dispatch.workerId(), json.read(json.write(assignment)));
    var permit =
        registry.launchPermit(
            dispatch.workerId(),
            dispatch.workerBootId(),
            json.read(
                json.write(
                    Map.of(
                        "browserSessionId",
                        dispatch.sessionId(),
                        "allocationEpoch",
                        dispatch.allocationEpoch(),
                        "assignmentDigest",
                        json.workerDigest(normalized)))));
    Map<String, Object> receipt =
        new HashMap<>(
            Map.of(
                "startPermitId",
                permit.get("permitId"),
                "runtimeGeneration",
                UUID.randomUUID(),
                "allocationEpoch",
                dispatch.allocationEpoch(),
                "controlEpoch",
                dispatch.controlEpoch(),
                "pageEpoch",
                dispatch.pageEpoch(),
                "privacyEpoch",
                dispatch.privacyEpoch()));
    registry.assigned(
        dispatch.workerId(),
        dispatch.workerBootId(),
        dispatch.sessionId(),
        json.read(json.write(receipt)));
    assertThat(startup.assigned(dispatch.sessionId())).isTrue();
    startup.acknowledgeReady(
        dispatch.workerId(),
        dispatch.workerBootId(),
        dispatch.sessionId(),
        WorkerRuntimeReceipts.ready(
            json, dispatch.workerBootId(), dispatch.sessionId(), dispatch.allocationEpoch()));
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
