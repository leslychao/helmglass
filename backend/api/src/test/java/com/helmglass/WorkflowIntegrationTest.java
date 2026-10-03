package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.BrowserAllocationService;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserOpenService;
import com.helmglass.browser.application.BrowserStartupService;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.application.WorkerRegistryService;
import com.helmglass.browser.infrastructure.repository.BrowserOpenRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.command.api.CommandContracts;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.connection.api.ConnectionContracts;
import com.helmglass.connection.api.LoginContracts;
import com.helmglass.connection.application.ConnectionLoginService;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionResolutionRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.continuation.api.ContinuationContracts;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.task.api.ActionRequestContracts;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.ActionRequestService;
import com.helmglass.task.application.TaskLifecycleService;
import com.helmglass.task.infrastructure.repository.ActionRequestRepository;
import com.helmglass.usage.application.UsageCheckpointService;
import com.helmglass.usage.application.UsageService;
import com.helmglass.usage.infrastructure.repository.UsageRepository;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.context.event.EventListener;
import org.springframework.core.io.ClassPathResource;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

@SpringJUnitConfig(WorkflowIntegrationTest.Owners.class)
class WorkflowIntegrationTest {
  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    CommandExecutionService.class,
    WorkerProtocol.class,
    ConnectionService.class,
    ConnectionResolutionRepository.class,
    ActionRequestService.class,
    ActionRequestRepository.class,
    ConnectionRepository.class,
    ConnectionLoginService.class,
    LoginRepository.class,
    BrowserControlService.class,
    WorkerRegistryService.class,
    WorkerRegistryRepository.class,
    BrowserStartupService.class,
    BrowserOpenService.class,
    BrowserAllocationService.class,
    BrowserOpenRepository.class,
    UsageService.class,
    UsageCheckpointService.class,
    UsageRepository.class,
    BrowserStartupRepository.class
  })
  static class Owners {
    @Bean
    BrowserProfileService profiles() {
      return mock(BrowserProfileService.class);
    }

    @Bean
    Messages messages() {
      return new Messages();
    }
  }

  static class Messages {
    private final List<BrowserControlService.ControlIntent> messages = new CopyOnWriteArrayList<>();

    @EventListener
    public void record(BrowserControlService.ControlIntent intent) {
      messages.add(intent);
    }

    Map<String, Object> last(String type) {
      return messages.reversed().stream()
          .map(BrowserControlService.ControlIntent::message)
          .filter(message -> type.equals(message.get("type")))
          .findFirst()
          .orElseThrow();
    }
  }

  private final TaskLifecycleService tasks;
  private final TaskContinuationService continuations;
  private final CommandExecutionService commands;
  private final ConnectionService connections;
  private final ActionRequestService actions;
  private final ConnectionLoginService logins;
  private final LoginRepository loginRepository;
  private final BrowserRepository browsers;
  private final WorkerRegistryService registry;
  private final BrowserStartupService startup;
  private final BrowserControlService controlOwner;
  private final ControlRepository controls;
  private final IdentityRepository identities;
  private final JsonSupport json;
  private final Messages messages;
  private final TransactionTemplate transaction;

  @Autowired
  WorkflowIntegrationTest(
      TaskLifecycleService tasks,
      TaskContinuationService continuations,
      CommandExecutionService commands,
      ConnectionService connections,
      ConnectionLoginService logins,
      LoginRepository loginRepository,
      BrowserRepository browsers,
      BrowserControlService controlOwner,
      ControlRepository controls,
      IdentityRepository identities,
      JsonSupport json,
      Messages messages,
      PlatformTransactionManager transactions,
      ActionRequestService actions,
      WorkerRegistryService registry,
      BrowserStartupService startup) {
    this.tasks = tasks;
    this.continuations = continuations;
    this.commands = commands;
    this.connections = connections;
    this.actions = actions;
    this.logins = logins;
    this.loginRepository = loginRepository;
    this.browsers = browsers;
    this.registry = registry;
    this.startup = startup;
    this.controlOwner = controlOwner;
    this.controls = controls;
    this.identities = identities;
    this.json = json;
    this.messages = messages;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void resolverKeepsAnExplicitAccountAndReplaysTheExactResolution() {
    var actor = actor();
    UUID account =
        connections
            .create(
                actor,
                new ConnectionContracts.Create("First", "https://example.com", "ASK"),
                context())
            .resource()
            .id();
    UUID id =
        tasks
            .create(
                actor,
                new TaskContracts.Create(
                    "Read account data",
                    "https://example.com",
                    List.of(account),
                    "TEXT",
                    false,
                    1800,
                    "DRAFT"),
                context())
            .resource()
            .id();
    var initial = tasks.get(actor, id);
    var request =
        new ConnectionContracts.Resolve(
            "https://example.com/account", true, initial.version(), initial.instructionRevision());
    var key = context();
    var accepted = connections.resolve(actor, id, request, key);
    assertThat(json.write(accepted)).contains("LOGIN_REQUIRED", account.toString());
    assertThat(json.read(json.write(connections.resolve(actor, id, request, key))))
        .isEqualTo(json.read(json.write(accepted)));
    var current = tasks.get(actor, id);
    assertThat(current.activeRequest()).containsEntry("kind", "LOGIN");
    assertThatThrownBy(
            () ->
                actions.answer(
                    actor,
                    (UUID) current.activeRequest().get("id"),
                    new ActionRequestContracts.Answer(
                        ((Number) current.activeRequest().get("version")).longValue(),
                        (String) current.activeRequest().get("intentHash"),
                        "ANSWER",
                        "I logged in",
                        null),
                    context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("private login");
  }

  @Test
  void resolverAsksForEqualRecencyAndOnlyAcceptsAnOfferedAccount() {
    var actor = actor();
    UUID first =
        connections
            .create(
                actor,
                new ConnectionContracts.Create("First", "https://example.com", "ASK"),
                context())
            .resource()
            .id();
    connections.create(
        actor, new ConnectionContracts.Create("Second", "https://example.com", "ASK"), context());
    UUID id =
        tasks
            .create(
                actor,
                new TaskContracts.Create(
                    "Choose account",
                    "https://example.com",
                    List.of(),
                    "TEXT",
                    false,
                    1800,
                    "DRAFT"),
                context())
            .resource()
            .id();
    var initial = tasks.get(actor, id);
    var accepted =
        connections.resolve(
            actor,
            id,
            new ConnectionContracts.Resolve(
                "https://example.com/account",
                true,
                initial.version(),
                initial.instructionRevision()),
            context());
    assertThat(json.write(accepted)).contains("ACCOUNT_SELECTION_REQUIRED");
    var request = tasks.get(actor, id).activeRequest();
    UUID requestId = (UUID) request.get("id");
    long version = ((Number) request.get("version")).longValue();
    String hash = (String) request.get("intentHash");
    assertThatThrownBy(
            () ->
                actions.answer(
                    actor,
                    requestId,
                    new ActionRequestContracts.Answer(
                        version, hash, "ANSWER", null, UUID.randomUUID()),
                    context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("not part");
    actions.answer(
        actor,
        requestId,
        new ActionRequestContracts.Answer(version, hash, "ANSWER", null, first),
        context());
    var current = tasks.get(actor, id);
    var selected =
        connections.resolve(
            actor,
            id,
            new ConnectionContracts.Resolve(
                "https://example.com/account",
                true,
                current.version(),
                current.instructionRevision()),
            context());
    assertThat(json.write(selected)).contains("LOGIN_REQUIRED", first.toString());
  }

  @Test
  void taskListSortsAndProjectionDoNotInventUsage() {
    var actor = actor();
    UUID id =
        tasks
            .create(
                actor,
                new TaskContracts.Create(
                    "List a task", "https://example.com", List.of(), "TEXT", false, 1800, "DRAFT"),
                context())
            .resource()
            .id();
    for (String sort :
        List.of(
            "title",
            "site",
            "state",
            "activeSeconds",
            "humanSeconds",
            "mediaSeconds",
            "mediaBytes",
            "summary")) {
      var parameters = new LinkedMultiValueMap<String, String>();
      parameters.add("sort", sort);
      parameters.add("direction", "asc");
      var page = tasks.list(actor, PageQuery.from(parameters));
      assertThat(page.items()).hasSize(1);
      assertThat(page.items().getFirst()).containsEntry("id", id).containsKey("usage");
    }
    assertThat(tasks.summary(actor)).containsEntry("total", 1L).containsEntry("active", 0L);
  }

  @Test
  void onlyTheClaimedContinuationCanAcceptTheNextCommand() {
    var actor = actor();
    UUID taskId =
        tasks
            .create(
                actor,
                new TaskContracts.Create(
                    "Read", "https://example.com", List.of(), "TEXT", false, 1800, "PREPARE"),
                context())
            .resource()
            .id();
    tasks.pause(actor, taskId, context());
    tasks.resume(
        actor,
        taskId,
        new TaskContracts.Resume(tasks.get(actor, taskId).version(), null, false),
        context());
    var snapshot = tasks.get(actor, taskId);
    UUID continuationId = (UUID) snapshot.continuation().get("id");
    var claimInput =
        new ContinuationContracts.Claim(continuationId, snapshot.instructionRevision());
    var claimKey = context();
    var claim = continuations.claim(actor, null, taskId, claimInput, claimKey);
    assertThat(continuations.claim(actor, null, taskId, claimInput, claimKey)).isEqualTo(claim);
    assertThatThrownBy(() -> continuations.claim(actor, null, taskId, claimInput, context()))
        .isInstanceOf(DomainException.class);
    JsonNode action = json.read("{\"type\":\"NAVIGATE\",\"url\":\"https://example.com\"}");
    var missingClaim =
        new CommandContracts.Submit(
            UUID.randomUUID(),
            snapshot.version(),
            snapshot.instructionRevision(),
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            action);
    assertThatThrownBy(() -> commands.accept(actor, taskId, missingClaim, context()))
        .isInstanceOf(DomainException.class);
    var accepted =
        new CommandContracts.Submit(
            UUID.randomUUID(),
            snapshot.version(),
            snapshot.instructionRevision(),
            null,
            null,
            null,
            null,
            claim.resource().id(),
            null,
            null,
            action);
    commands.accept(actor, taskId, accepted, context());
    assertThat(tasks.get(actor, taskId).continuation())
        .containsEntry("state", "WAITING_RESULT")
        .doesNotContainEntry("id", continuationId);
  }

  @Test
  void standaloneLoginReadMatchesThePublicContractInPendingAndTerminalStates() throws IOException {
    var actor = actor();
    UUID connectionId =
        connections
            .create(
                actor,
                new ConnectionContracts.Create("Example", "https://example.com/login", "ASK"),
                context())
            .resource()
            .id();
    UUID id =
        logins
            .begin(
                actor, connectionId, new LoginContracts.Begin(null, UUID.randomUUID()), context())
            .resource()
            .id();
    JsonNode definitions =
        json.read(new ClassPathResource("openapi.json").getContentAsString(StandardCharsets.UTF_8))
            .path("components")
            .path("schemas");
    ObjectNode responseSchema = (ObjectNode) definitions.path("LoginOperation").deepCopy();
    ObjectNode capabilities = (ObjectNode) responseSchema.path("properties").path("capabilities");
    assertThat(capabilities.path("additionalProperties").path("$ref").asString())
        .isEqualTo("#/components/schemas/Capability");
    capabilities.set("additionalProperties", definitions.path("Capability"));
    var schema =
        SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
            .getSchema(responseSchema);
    for (String state :
        List.of("WAITING_RESOURCE", "WAITING_USER", "SUCCEEDED", "FAILED", "CANCELLED")) {
      transaction.executeWithoutResult(status -> loginRepository.state(id, state));
      JsonNode response = json.read(json.write(logins.get(actor, id)));
      assertThat(schema.validate(response)).as("LoginOperation response in %s", state).isEmpty();
      assertThat(response.path("taskId").isNull()).isTrue();
      assertThat(response.path("sessionId").isNull()).isTrue();
      assertThat(response.path("capabilities").path("complete").path("allowed").asBoolean())
          .isFalse();
    }
    assertThatThrownBy(() -> logins.get(actor(), id)).isInstanceOf(DomainException.class);
  }

  @Test
  void sessionOnlyLoginPreservesSavedConnectionMetadataAndWaitsForPrivateExitAck() {
    var actor = actor();
    UUID connectionId =
        connections
            .create(
                actor,
                new ConnectionContracts.Create("Example", "https://example.com/login", "ASK"),
                context())
            .resource()
            .id();
    var original = connections.get(actor, connectionId);
    UUID operationId =
        logins
            .begin(
                actor, connectionId, new LoginContracts.Begin(null, UUID.randomUUID()), context())
            .resource()
            .id();
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    registry.register(
        worker,
        boot,
        json.read(
            json.write(
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
                        Map.of())))));
    var assignment = logins.allocate(operationId).orElseThrow();
    assertThat(assignment.message()).containsEntry("type", "assign");
    UUID sessionId = loginRepository.get(operationId).sessionId();
    assertThat(browsers.owned(actor.userId(), sessionId).privacy()).isEqualTo("LOGIN_PRIVATE");
    JsonNode scope =
        registry.assignment(worker, json.read(json.write(assignment.message())).path("assignment"));
    var launch =
        registry.launchPermit(
            worker,
            boot,
            json.read(
                json.write(
                    Map.of(
                        "browserSessionId",
                        sessionId,
                        "allocationEpoch",
                        1,
                        "assignmentDigest",
                        json.workerDigest(scope)))));
    registry.assigned(
        worker,
        boot,
        sessionId,
        json.read(
            json.write(
                Map.of(
                    "startPermitId",
                    launch.get("permitId"),
                    "runtimeGeneration",
                    UUID.randomUUID(),
                    "allocationEpoch",
                    1,
                    "controlEpoch",
                    1,
                    "pageEpoch",
                    1,
                    "privacyEpoch",
                    1))));
    assertThat(startup.assigned(sessionId)).isTrue();
    startup.acknowledgeReady(
        worker, boot, sessionId, WorkerRuntimeReceipts.ready(json, boot, sessionId, 1));
    logins.assigned(worker, boot, sessionId);
    JsonNode command = json.read(json.write(messages.last("command"))).path("command");
    var permitRequest = (ObjectNode) json.read(json.write(command));
    permitRequest.put("actionDigest", json.workerDigest(command.path("action")));
    for (String field :
        List.of(
            "allocationEpoch",
            "controlEpoch",
            "pageEpoch",
            "privacyEpoch",
            "policyVersion",
            "instructionRevision")) {
      permitRequest.set(field, scope.get(field));
    }
    logins.permit(worker, boot, permitRequest);
    var result = (ObjectNode) json.read(json.write(command));
    result.remove("action");
    result
        .put("schemaVersion", 1)
        .put("status", "SUCCEEDED")
        .put("effectState", "CONFIRMED")
        .put("code", "HANDLER_COMPLETED");
    result
        .put("allocationEpoch", 1)
        .put("controlEpoch", 1)
        .put("privacyEpoch", 1)
        .put("pageEpoch", 4);
    result.put("digest", json.workerDigest(result));
    logins.result(worker, boot, result);
    controlOwner.acknowledge(worker, boot, sessionId, controls.get(sessionId).epoch());
    var login = loginRepository.get(operationId);
    assertThatThrownBy(
            () ->
                logins.complete(
                    actor,
                    operationId,
                    new LoginContracts.Complete(
                        login.version(),
                        "SESSION_ONLY",
                        "My account",
                        List.of("https://example.com"),
                        null,
                        "KEEP_PAUSED",
                        true,
                        UUID.randomUUID(),
                        controls.get(sessionId).epoch(),
                        browsers.owned(actor.userId(), sessionId).pageEpoch()),
                    context()))
        .isInstanceOf(DomainException.class);
    logins.complete(
        actor,
        operationId,
        new LoginContracts.Complete(
            login.version(),
            "SESSION_ONLY",
            "My account",
            List.of("https://example.com"),
            null,
            "KEEP_PAUSED",
            true,
            login.controllerInstanceId(),
            controls.get(sessionId).epoch(),
            browsers.owned(actor.userId(), sessionId).pageEpoch()),
        context());
    logins.checked(
        worker,
        boot,
        sessionId,
        json.read(
            json.write(
                Map.of(
                    "status",
                    "SAFE",
                    "verification",
                    "USER_ASSERTED",
                    "allocationEpoch",
                    1,
                    "controlEpoch",
                    controls.get(sessionId).epoch(),
                    "pageEpoch",
                    browsers.owned(actor.userId(), sessionId).pageEpoch(),
                    "privacyEpoch",
                    browsers.owned(actor.userId(), sessionId).privacyEpoch(),
                    "policyVersion",
                    1))));
    assertThat(loginRepository.get(operationId).state()).isEqualTo("EXITING_PRIVATE");
    controlOwner.acknowledge(worker, boot, sessionId, controls.get(sessionId).epoch());
    logins.exited(worker, boot, sessionId, false);
    assertThat(loginRepository.get(operationId).state()).isEqualTo("SUCCEEDED");
    var current = connections.get(actor, connectionId);
    assertThat(current.status()).isEqualTo(original.status());
    assertThat(current.accountLabel()).isEqualTo(original.accountLabel());
    assertThat(current.lastSuccessfulLoginAt()).isNull();
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
