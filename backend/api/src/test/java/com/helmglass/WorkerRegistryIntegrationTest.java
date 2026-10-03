package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.application.BrowserAllocationService;
import com.helmglass.browser.application.BrowserStartupService;
import com.helmglass.browser.application.WorkerRegistryService;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.command.api.CommandContracts;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import java.util.HashMap;
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
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

@SpringJUnitConfig(CoreOwnersIntegrationTest.Owners.class)
class WorkerRegistryIntegrationTest {
  private final WorkerRegistryService registry;
  private final WorkerRegistryRepository workers;
  private final BrowserRepository browsers;
  private final BrowserAllocationService allocator;
  private final BrowserStartupService startup;
  private final CommandExecutionService commands;
  private final TaskLifecycleService tasks;
  private final IdentityRepository identities;
  private final JsonSupport json;
  private final JdbcClient jdbc;
  private final TransactionTemplate transaction;

  @Autowired
  WorkerRegistryIntegrationTest(
      WorkerRegistryService registry,
      WorkerRegistryRepository workers,
      BrowserRepository browsers,
      BrowserAllocationService allocator,
      BrowserStartupService startup,
      CommandExecutionService commands,
      TaskLifecycleService tasks,
      IdentityRepository identities,
      JsonSupport json,
      JdbcClient jdbc,
      PlatformTransactionManager transactions) {
    this.registry = registry;
    this.workers = workers;
    this.browsers = browsers;
    this.allocator = allocator;
    this.startup = startup;
    this.commands = commands;
    this.tasks = tasks;
    this.identities = identities;
    this.json = json;
    this.jdbc = jdbc;
    transaction = new TransactionTemplate(transactions);
  }

  record Runtime(
      CommandRepository.Dispatch dispatch,
      JsonNode assignment,
      Map<String, Object> permit,
      UUID generation) {}

  @Test
  void physicalLaunchHasOneDurablePermitAndRejectsChangedInstruction() {
    Runtime runtime = allocate();
    var dispatch = runtime.dispatch();
    var claim = workers.claim(dispatch.sessionId());
    assertThat(claim.state()).isEqualTo("ASSIGNED");
    assertThat(claim.runtimeGeneration()).isNull();
    assertThat(claim.startPermitId()).isEqualTo(runtime.permit().get("permitId"));
    assertThat(
            registry.launchPermit(
                dispatch.workerId(), dispatch.workerBootId(), launchRequest(runtime)))
        .isEqualTo(runtime.permit());
    ObjectNode altered = launchRequest(runtime).deepCopy();
    altered.put("assignmentDigest", "0".repeat(64));
    assertThatThrownBy(
            () -> registry.launchPermit(dispatch.workerId(), dispatch.workerBootId(), altered))
        .isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE tasks SET instruction_revision=instruction_revision+1 WHERE id=:id")
        .param("id", dispatch.taskId())
        .update();
    assertThatThrownBy(
            () ->
                registry.launchPermit(
                    dispatch.workerId(), dispatch.workerBootId(), launchRequest(runtime)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("owners");
    assertThat(workers.claim(dispatch.sessionId()).startPermitId())
        .isEqualTo(claim.startPermitId());
  }

  @Test
  void sameRuntimeNeedsNewControlReceiptBeforeBecomingActive() {
    Runtime runtime = allocate();
    ready(runtime);
    var dispatch = runtime.dispatch();
    register(dispatch.workerId(), dispatch.workerBootId(), List.of(inventory(runtime)), "READY");
    var recovering = workers.claim(dispatch.sessionId());
    assertThat(recovering.sessionState()).isEqualTo("RECOVERING");
    assertThat(recovering.state()).isEqualTo("QUARANTINED");
    assertThat(recovering.controlEpoch()).isEqualTo(dispatch.controlEpoch() + 1);
    var intents = registry.recoveryIntents(dispatch.workerId(), dispatch.workerBootId());
    assertThat(intents).hasSize(1);
    ObjectNode receipt = inventory(runtime);
    receipt.put("controlEpoch", recovering.controlEpoch());
    receipt.put("mode", "AGENT");
    assertThat(
            registry.acknowledgeRecovery(
                dispatch.workerId(), dispatch.workerBootId(), dispatch.sessionId(), receipt))
        .isTrue();
    assertThat(workers.claim(dispatch.sessionId()).sessionState()).isEqualTo("ACTIVE");
    assertThat(workers.claim(dispatch.sessionId()).runtimeGeneration())
        .isEqualTo(runtime.generation());
    assertThat(registry.recoveryIntents(dispatch.workerId(), dispatch.workerBootId())).isEmpty();
  }

  @Test
  void changedBootDoesNotReleaseQuotaOrReplayAnEffectWithUnknownOutcome() {
    Runtime runtime = allocate();
    ready(runtime);
    var dispatch = runtime.dispatch();
    Map<String, Object> request = new HashMap<>(CommandExecutionService.scope(dispatch));
    request.put("commandId", dispatch.commandId());
    request.put("attemptId", dispatch.attemptId());
    request.put("actionDigest", dispatch.payloadHash());
    commands.start(dispatch.workerId(), dispatch.workerBootId(), json.read(json.write(request)));
    UUID nextBoot = UUID.randomUUID();
    register(dispatch.workerId(), nextBoot, List.of(), "READY");
    assertThat(workers.claim(dispatch.sessionId()).state()).isEqualTo("QUARANTINED");
    assertThat(registry.claimCommandDelivery(dispatch.commandId())).isFalse();
    jdbc.sql(
            "UPDATE browser_sessions SET recovery_started_at=now()-interval '31 seconds' WHERE"
                + " id=:id")
        .param("id", dispatch.sessionId())
        .update();
    registry.expireRecovery(dispatch.sessionId());
    assertThat(workers.claim(dispatch.sessionId()).sessionState()).isEqualTo("LOST");
    assertThat(workers.claim(dispatch.sessionId()).state()).isEqualTo("QUARANTINED");
    assertThat(
            jdbc.sql("SELECT effect_state FROM command_attempts WHERE id=:id")
                .param("id", dispatch.attemptId())
                .query(String.class)
                .single())
        .isEqualTo("UNKNOWN");
    assertThat(
            jdbc.sql("SELECT mutation_barrier FROM tasks WHERE id=:id")
                .param("id", dispatch.taskId())
                .query(Boolean.class)
                .single())
        .isTrue();
    assertThat(commandOperationState(dispatch.commandId())).isEqualTo("NEEDS_ATTENTION");
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM operations WHERE kind='RECONCILE_EFFECT' AND"
                        + " source_command_id=:id")
                .param("id", dispatch.commandId())
                .query(Long.class)
                .single())
        .isEqualTo(1);
    registry.expireRecovery(dispatch.sessionId());
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM operations WHERE kind='RECONCILE_EFFECT' AND"
                        + " source_command_id=:id")
                .param("id", dispatch.commandId())
                .query(Long.class)
                .single())
        .isEqualTo(1);
    assertThatThrownBy(
            () ->
                registry.closed(
                    dispatch.workerId(), nextBoot, dispatch.sessionId(), inventory(runtime)))
        .isInstanceOf(DomainException.class);
  }

  @Test
  void expiredUnstartedCommandFailsOnceAfterPhysicalClosure() {
    Runtime runtime = allocate();
    var dispatch = runtime.dispatch();
    jdbc.sql("UPDATE task_commands SET deadline=now()-interval '1 second' WHERE id=:id")
        .param("id", dispatch.commandId())
        .update();
    register(dispatch.workerId(), dispatch.workerBootId(), List.of(), "READY");
    assertThat(commandOperationState(dispatch.commandId())).isEqualTo("FAILED");
    long version =
        jdbc.sql("SELECT version FROM tasks WHERE id=:id")
            .param("id", dispatch.taskId())
            .query(Long.class)
            .single();
    registry.closed(
        dispatch.workerId(), dispatch.workerBootId(), dispatch.sessionId(), inventory(runtime));
    assertThat(
            jdbc.sql("SELECT version FROM tasks WHERE id=:id")
                .param("id", dispatch.taskId())
                .query(Long.class)
                .single())
        .isEqualTo(version);
    assertThat(workers.claim(dispatch.sessionId()).state()).isEqualTo("RELEASED");
    assertThat(
            jdbc.sql("SELECT effect_state FROM command_attempts WHERE id=:id")
                .param("id", dispatch.attemptId())
                .query(String.class)
                .single())
        .isEqualTo("NOT_STARTED");
  }

  @Test
  void lostAssignedReceiptRecoversBeforeCanonicalStartupMarksReady() {
    Runtime runtime = allocate();
    var dispatch = runtime.dispatch();
    register(dispatch.workerId(), dispatch.workerBootId(), List.of(inventory(runtime)), "READY");
    var claim = workers.claim(dispatch.sessionId());
    assertThat(claim.runtimeGeneration()).isEqualTo(runtime.generation());
    assertThat(claim.readyAt()).isNull();
    ObjectNode receipt = inventory(runtime);
    receipt.put("controlEpoch", claim.controlEpoch());
    receipt.put("mode", "AGENT");
    assertThat(
            registry.acknowledgeRecovery(
                dispatch.workerId(), dispatch.workerBootId(), dispatch.sessionId(), receipt))
        .isTrue();
    assertThat(workers.claim(dispatch.sessionId()).sessionState()).isEqualTo("STARTING");
    assertThat(startup.assigned(dispatch.sessionId())).isTrue();
    startup.acknowledgeReady(
        dispatch.workerId(),
        dispatch.workerBootId(),
        dispatch.sessionId(),
        WorkerRuntimeReceipts.ready(
            json, dispatch.workerBootId(), dispatch.sessionId(), dispatch.allocationEpoch()));
    assertThat(workers.claim(dispatch.sessionId()).sessionState()).isEqualTo("ACTIVE");
    assertThat(workers.claim(dispatch.sessionId()).runtimeGeneration())
        .isEqualTo(runtime.generation());
  }

  private String commandOperationState(UUID commandId) {
    return jdbc.sql("SELECT state FROM operations WHERE target_id=:id AND target_type='command'")
        .param("id", commandId)
        .query(String.class)
        .single();
  }

  @Test
  void freshSameBootEmptyInventoryClosesPhysicalClaimWithoutInventingAnEffect() {
    Runtime runtime = allocate();
    var dispatch = runtime.dispatch();
    register(dispatch.workerId(), dispatch.workerBootId(), List.of(), "READY");
    assertThat(workers.claim(dispatch.sessionId()).state()).isEqualTo("RELEASED");
    assertThat(workers.claim(dispatch.sessionId()).sessionState()).isEqualTo("CLOSED");
    assertThat(
            jdbc.sql("SELECT state FROM task_commands WHERE id=:id")
                .param("id", dispatch.commandId())
                .query(String.class)
                .single())
        .isEqualTo("WAITING_RESOURCE");
    var replacement = allocator.allocate(dispatch.commandId()).orElseThrow();
    assertThat(replacement.dispatch().attemptId()).isNotEqualTo(dispatch.attemptId());
    assertThat(replacement.dispatch().sessionId()).isNotEqualTo(dispatch.sessionId());
  }

  @Test
  void drainingWorkerAndIncompatibleSchemaCannotEnterReadyPool() {
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    ObjectNode request = registration(worker, boot, List.of(), "DRAINING");
    registry.register(worker, boot, request);
    assertThat(
            jdbc.sql("SELECT observed_state FROM browser_workers WHERE id=:id")
                .param("id", worker)
                .query(String.class)
                .single())
        .isEqualTo("DRAINING");
    request.put("protocolVersion", 2);
    assertThatThrownBy(() -> registry.register(worker, boot, request))
        .isInstanceOf(DomainException.class);
    assertThat(
            jdbc.sql("SELECT observed_state FROM browser_workers WHERE id=:id")
                .param("id", worker)
                .query(String.class)
                .single())
        .isEqualTo("DRAINING");
  }

  private Runtime allocate() {
    var account =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    identities.resolve(
                        "https://issuer.example",
                        UUID.randomUUID().toString(),
                        "Worker test",
                        "worker@example.test")));
    var actor =
        new AuthenticatedActor(
            account.id(),
            UUID.randomUUID(),
            null,
            "helm-web",
            account.displayName(),
            account.email(),
            account.accessEpoch(),
            Set.of(),
            false);
    UUID taskId =
        tasks
            .create(
                actor,
                new TaskContracts.Create(
                    "Read page", "https://example.com", List.of(), "TEXT", false, 1800, "PREPARE"),
                context(), null)
            .resource()
            .id();
    var task = tasks.get(actor, taskId);
    UUID commandId = UUID.randomUUID();
    commands.accept(
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
            json.read("{\"type\":\"NAVIGATE\",\"url\":\"https://example.com\"}")),
        context());
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    register(worker, boot, List.of(), "READY");
    var dispatch = allocator.allocate(commandId).orElseThrow().dispatch();
    Map<String, Object> assignment = CommandExecutionService.scope(dispatch);
    assignment.put(
        "deadline", browsers.owned(actor.userId(), dispatch.sessionId()).budgetDeadlineAt());
    assignment.put("originPolicy", "PUBLIC");
    assignment.put("allowedOrigins", List.of());
    JsonNode normalized = registry.assignment(worker, json.read(json.write(assignment)));
    var runtime = new Runtime(dispatch, normalized, Map.of(), UUID.randomUUID());
    var permit = registry.launchPermit(worker, boot, launchRequest(runtime));
    return new Runtime(dispatch, normalized, permit, runtime.generation());
  }

  private void ready(Runtime runtime) {
    var dispatch = runtime.dispatch();
    registry.assigned(
        dispatch.workerId(), dispatch.workerBootId(), dispatch.sessionId(), inventory(runtime));
    assertThat(startup.assigned(dispatch.sessionId())).isTrue();
    startup.acknowledgeReady(
        dispatch.workerId(),
        dispatch.workerBootId(),
        dispatch.sessionId(),
        WorkerRuntimeReceipts.ready(
            json, dispatch.workerBootId(), dispatch.sessionId(), dispatch.allocationEpoch()));
  }

  private ObjectNode launchRequest(Runtime runtime) {
    return (ObjectNode)
        json.read(
            json.write(
                Map.of(
                    "browserSessionId",
                    runtime.dispatch().sessionId(),
                    "allocationEpoch",
                    runtime.dispatch().allocationEpoch(),
                    "assignmentDigest",
                    json.workerDigest(runtime.assignment()))));
  }

  private ObjectNode inventory(Runtime runtime) {
    var dispatch = runtime.dispatch();
    Map<String, Object> value = new HashMap<>();
    value.put("browserSessionId", dispatch.sessionId());
    value.put("taskId", dispatch.taskId());
    value.put("allocationEpoch", dispatch.allocationEpoch());
    value.put("controlEpoch", dispatch.controlEpoch());
    value.put("pageEpoch", dispatch.pageEpoch());
    value.put("privacyEpoch", dispatch.privacyEpoch());
    value.put("runtimeGeneration", runtime.generation());
    value.put("pageId", UUID.randomUUID());
    value.put("startPermitId", runtime.permit().get("permitId"));
    value.put("mode", "QUIESCED");
    value.put("closed", false);
    value.put("unknown", false);
    value.put("pendingResults", List.of());
    value.put("lastAcceptedInputSequence", 0);
    value.put("lastAppliedInputSequence", 0);
    return (ObjectNode) json.read(json.write(value));
  }

  private void register(UUID worker, UUID boot, List<JsonNode> inventory, String state) {
    registry.register(worker, boot, registration(worker, boot, inventory, state));
  }

  private ObjectNode registration(UUID worker, UUID boot, List<JsonNode> inventory, String state) {
    Map<String, Object> value = new HashMap<>();
    value.put("schemaVersion", 1);
    value.put("type", "register");
    value.put("requestId", UUID.randomUUID());
    value.put("workerId", worker);
    value.put("bootId", boot);
    value.put("protocolVersion", 1);
    value.put("version", "0.1.0");
    value.put("imageDigest", "fixture");
    value.put("capacity", 1);
    value.put("state", state);
    value.put("inventory", inventory);
    value.put("capabilities", Map.of());
    return (ObjectNode) json.read(json.write(value));
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
