package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.application.BrowserAllocationService;
import com.helmglass.browser.application.BrowserStartupService;
import com.helmglass.browser.application.WorkerRegistryService;
import com.helmglass.browser.application.WorkerRegistryService.StoppedAllocation;
import com.helmglass.browser.application.WorkerRegistryService.StoppedWorkerProof;
import com.helmglass.browser.infrastructure.repository.BrowserCloseOutboxRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.command.api.CommandContracts;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.IllegalTransactionStateException;
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
  private final BrowserCloseOutboxRepository closeOutbox;
  private final OperationRepository operations;

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
      BrowserCloseOutboxRepository closeOutbox,
      OperationRepository operations,
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
    this.closeOutbox = closeOutbox;
    this.operations = operations;
    transaction = new TransactionTemplate(transactions);
  }

  record Runtime(
      CommandRepository.Dispatch dispatch,
      JsonNode assignment,
      Map<String, Object> permit,
      UUID generation) {}

  @ParameterizedTest
  @ValueSource(booleans = {false, true})
  void stopReceiptCompletesOnlyWithPhysicalClosureAndReplaysStably(boolean operator) {
    Runtime runtime = allocate();
    ready(runtime);
    complete(runtime);
    if (operator) {
      lose(runtime);
    }
    var dispatch = runtime.dispatch();
    var actor = taskActor(runtime);
    var request = context();
    var receipt = tasks.stop(actor, dispatch.taskId(), request);
    assertThat(operationState(receipt.operationId())).isEqualTo("PENDING");
    var proof = operator ? stoppedProof(runtime) : null;
    transaction.executeWithoutResult(
        status -> {
          if (operator) {
            registry.confirmStopped(proof);
          } else {
            registry.closed(
                dispatch.workerId(),
                dispatch.workerBootId(),
                dispatch.sessionId(),
                inventory(runtime));
          }
          assertThat(operationState(receipt.operationId())).isEqualTo("SUCCEEDED");
          status.setRollbackOnly();
        });
    assertThat(workers.claim(dispatch.sessionId()).taskState()).isEqualTo("STOPPING");
    assertThat(operationState(receipt.operationId())).isEqualTo("PENDING");
    if (operator) {
      confirm(proof);
    } else {
      registry.closed(
          dispatch.workerId(), dispatch.workerBootId(), dispatch.sessionId(), inventory(runtime));
    }
    assertThat(workers.claim(dispatch.sessionId()).taskState()).isEqualTo("CANCELLED");
    assertThat(operationState(receipt.operationId())).isEqualTo("SUCCEEDED");
    assertThat(
            jdbc.sql("SELECT progress=100 AND finished_at IS NOT NULL FROM operations WHERE id=:id")
                .param("id", receipt.operationId())
                .query(Boolean.class)
                .single())
        .isTrue();
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:id AND"
                        + " event_type='operations'")
                .param("id", receipt.operationId())
                .query(Long.class)
                .single())
        .isEqualTo(2);
    var closed = workers.claim(dispatch.sessionId());
    registry.closed(
        dispatch.workerId(), dispatch.workerBootId(), dispatch.sessionId(), inventory(runtime));
    assertThat(tasks.stop(actor, dispatch.taskId(), request)).isEqualTo(receipt);
    assertThat(workers.claim(dispatch.sessionId())).isEqualTo(closed);
    assertThat(
            jdbc.sql("SELECT version FROM operations WHERE id=:id")
                .param("id", receipt.operationId())
                .query(Long.class)
                .single())
        .isEqualTo(2);
  }

  private AuthenticatedActor taskActor(Runtime runtime) {
    return new AuthenticatedActor(
        runtime.dispatch().userId(),
        UUID.randomUUID(),
        null,
        "helm-web",
        "Worker test",
        "worker@example.test",
        1,
        Set.of(),
        false);
  }

  private String operationState(UUID id) {
    return jdbc.sql("SELECT state FROM operations WHERE id=:id")
        .param("id", id)
        .query(String.class)
        .single();
  }

  @Test
  void stopCompletionKeepsUnknownCommandAndBarrierWithoutReplayingEffect() {
    Runtime runtime = allocate();
    ready(runtime);
    start(runtime);
    lose(runtime);
    var dispatch = runtime.dispatch();
    var receipt = tasks.stop(taskActor(runtime), dispatch.taskId(), context());
    confirm(stoppedProof(runtime));
    assertThat(operationState(receipt.operationId())).isEqualTo("SUCCEEDED");
    assertThat(workers.claim(dispatch.sessionId()).taskState()).isEqualTo("CANCELLED");
    assertThat(commandState(dispatch.commandId())).isEqualTo("UNKNOWN");
    assertThat(commandOperationState(dispatch.commandId())).isEqualTo("NEEDS_ATTENTION");
    assertThat(
            jdbc.sql("SELECT mutation_barrier FROM tasks WHERE id=:id")
                .param("id", dispatch.taskId())
                .query(Boolean.class)
                .single())
        .isTrue();
    assertThat(registry.claimCommandDelivery(dispatch.commandId())).isFalse();
  }

  @Test
  void reconcilesOnlyOwnedStoppedReceiptsAfterEveryBindingIsReleased() {
    Runtime runtime = allocate();
    ready(runtime);
    complete(runtime);
    var dispatch = runtime.dispatch();
    var actor = taskActor(runtime);
    var request = context();
    var receipt = tasks.stop(actor, dispatch.taskId(), request);
    Runtime foreign = allocate();
    UUID unrelated =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    operations.createSystem(
                        dispatch.userId(),
                        "tasks.pause:" + dispatch.taskId(),
                        "task",
                        dispatch.taskId())));
    UUID foreignOperation =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    operations.createSystem(
                        foreign.dispatch().userId(),
                        "tasks.stop:" + dispatch.taskId(),
                        "task",
                        dispatch.taskId())));

    // This is the stored state left by the former closure path: task terminal, receipt pending.
    jdbc.sql("UPDATE tasks SET state='CANCELLED',version=version+1 WHERE id=:id")
        .param("id", dispatch.taskId())
        .update();
    assertThat(tasks.uncompletedStops())
        .noneMatch(target -> target.taskId().equals(dispatch.taskId()));
    tasks.confirmStopped(dispatch.userId(), dispatch.taskId());
    assertThat(operationState(receipt.operationId())).isEqualTo("PENDING");
    transaction.executeWithoutResult(status -> workers.closed(dispatch.sessionId()));
    transaction.executeWithoutResult(
        status -> {
          for (int index = 0; index < 101; index++) {
            operations.createSystem(
                dispatch.userId(), "tasks.stop:" + dispatch.taskId(), "task", dispatch.taskId());
          }
        });
    assertThat(tasks.uncompletedStops())
        .anyMatch(target -> target.taskId().equals(dispatch.taskId()));
    var closed = workers.claim(dispatch.sessionId());
    tasks.confirmStopped(dispatch.userId(), dispatch.taskId());
    assertThat(operationState(receipt.operationId())).isEqualTo("SUCCEEDED");
    assertThat(operationState(unrelated)).isEqualTo("PENDING");
    assertThat(operationState(foreignOperation)).isEqualTo("PENDING");
    assertThat(workers.claim(dispatch.sessionId())).isEqualTo(closed);
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM operations WHERE user_id=:user AND target_id=:task"
                        + " AND kind=:kind AND state='PENDING'")
                .param("user", dispatch.userId())
                .param("task", dispatch.taskId())
                .param("kind", "tasks.stop:" + dispatch.taskId())
                .query(Long.class)
                .single())
        .isEqualTo(2);
    assertThat(tasks.uncompletedStops())
        .anyMatch(target -> target.taskId().equals(dispatch.taskId()));
    tasks.confirmStopped(dispatch.userId(), dispatch.taskId());
    assertThat(tasks.uncompletedStops())
        .noneMatch(target -> target.taskId().equals(dispatch.taskId()));
    assertThat(tasks.stop(actor, dispatch.taskId(), request)).isEqualTo(receipt);
  }

  @Test
  void operatorProofClosesLostRuntimePreservesResultAndReplaysWithoutMutation() {
    Runtime runtime = allocate();
    ready(runtime);
    complete(runtime);
    lose(runtime);
    var proof = stoppedProof(runtime);
    var dispatch = runtime.dispatch();
    jdbc.sql("UPDATE tasks SET state='STOPPING',version=version+1 WHERE id=:id")
        .param("id", dispatch.taskId())
        .update();
    transaction.executeWithoutResult(status -> closeOutbox.request(dispatch.sessionId()));
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:id AND"
                        + " event_type='worker.close' AND published_at IS NULL")
                .param("id", dispatch.sessionId())
                .query(Long.class)
                .single())
        .isEqualTo(1);
    assertThat(confirm(proof)).isEqualTo(1);
    var closed = workers.claim(dispatch.sessionId());
    assertThat(closed.sessionState()).isEqualTo("CLOSED");
    assertThat(closed.state()).isEqualTo("RELEASED");
    assertThat(closed.bindingReleasedAt()).isNotNull();
    assertThat(closed.taskState()).isEqualTo("CANCELLED");
    assertThat(commandState(dispatch.commandId())).isEqualTo("SUCCEEDED");
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:id AND"
                        + " event_type='worker.close' AND published_at IS NULL")
                .param("id", dispatch.sessionId())
                .query(Long.class)
                .single())
        .isZero();
    assertCurrentLifecycleEvents(runtime);
    long events = lifecycleEvents(runtime);
    assertThat(confirm(proof)).isZero();
    assertThat(workers.claim(dispatch.sessionId())).isEqualTo(closed);
    assertThat(lifecycleEvents(runtime)).isEqualTo(events);
  }

  @Test
  void stoppedProofPreservesUnknownEffectAndReconciliationBarrier() {
    Runtime runtime = allocate();
    ready(runtime);
    var dispatch = runtime.dispatch();
    start(runtime);
    lose(runtime);
    var proof = stoppedProof(runtime);
    assertThat(commandState(dispatch.commandId())).isEqualTo("UNKNOWN");
    assertThat(confirm(proof)).isEqualTo(1);
    assertThat(commandState(dispatch.commandId())).isEqualTo("UNKNOWN");
    assertThat(commandOperationState(dispatch.commandId())).isEqualTo("NEEDS_ATTENTION");
    assertThat(workers.claim(dispatch.sessionId()).taskState()).isEqualTo("INTERRUPTED");
    assertThat(
            jdbc.sql("SELECT mutation_barrier FROM tasks WHERE id=:id")
                .param("id", dispatch.taskId())
                .query(Boolean.class)
                .single())
        .isTrue();
    assertThat(
            jdbc.sql("SELECT effect_state FROM command_attempts WHERE id=:id")
                .param("id", dispatch.attemptId())
                .query(String.class)
                .single())
        .isEqualTo("UNKNOWN");
    assertThat(registry.claimCommandDelivery(dispatch.commandId())).isFalse();
  }

  @Test
  void closingLostRuntimeInvalidatesTaskProjectionEvenWhenTaskVersionIsUnchanged() {
    Runtime runtime = allocate();
    ready(runtime);
    complete(runtime);
    lose(runtime);
    var proof = stoppedProof(runtime);
    var before = workers.claim(runtime.dispatch().sessionId());
    assertThat(confirm(proof)).isEqualTo(1);
    var after = workers.claim(runtime.dispatch().sessionId());
    assertThat(after.taskVersion()).isEqualTo(before.taskVersion());
    assertThat(
            jdbc.sql(
                    """
                    SELECT count(*) FROM transactional_outbox
                    WHERE aggregate_id=:session AND aggregate_version=:version AND event_type='tasks'
                      AND payload->>'resourceId'=:task
                    """)
                .param("session", after.sessionId())
                .param("version", after.sessionVersion())
                .param("task", after.taskId().toString())
                .query(Long.class)
                .single())
        .isEqualTo(1);
  }

  @Test
  void stoppedProofRequiresOfflineExactBootAndEarlierRegistryTimestamps() {
    Runtime runtime = allocate();
    ready(runtime);
    var liveProof = stoppedProof(runtime);
    assertThatThrownBy(() -> confirm(liveProof)).isInstanceOf(DomainException.class);
    lose(runtime);
    var proof = stoppedProof(runtime);
    var valid = proof;
    var wrongBoot =
        new StoppedWorkerProof(
            proof.installationId(),
            proof.engineId(),
            proof.containerId(),
            proof.previousStartedAt(),
            0,
            proof.observedStartedAt(),
            1,
            proof.workerId(),
            UUID.randomUUID(),
            proof.allocations());
    assertThatThrownBy(() -> confirm(wrongBoot)).isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE browser_workers SET heartbeat_at=:at WHERE id=:id")
        .param("id", proof.workerId())
        .param("at", Timestamp.from(proof.observedStartedAt()))
        .update();
    assertThatThrownBy(() -> confirm(valid)).isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE browser_workers SET heartbeat_at=:at,registered_at=:at WHERE id=:id")
        .param("id", proof.workerId())
        .param("at", Timestamp.from(proof.observedStartedAt()))
        .update();
    assertThatThrownBy(() -> confirm(valid)).isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE browser_workers SET boot_id=:boot WHERE id=:id")
        .param("id", proof.workerId())
        .param("boot", UUID.randomUUID())
        .update();
    assertThatThrownBy(() -> confirm(valid)).isInstanceOf(DomainException.class);
    assertThat(workers.claim(runtime.dispatch().sessionId()).bindingReleasedAt()).isNull();
  }

  @Test
  void stoppedProofRejectsWrongEpochGenerationForeignAndOmittedClaims() {
    Runtime runtime = allocate();
    ready(runtime);
    lose(runtime);
    var proof = stoppedProof(runtime);
    var allocation = proof.allocations().getFirst();
    List<List<StoppedAllocation>> invalid =
        List.of(
            List.of(
                new StoppedAllocation(
                    allocation.sessionId(),
                    allocation.allocationEpoch() + 1,
                    allocation.runtimeGeneration())),
            List.of(
                new StoppedAllocation(
                    allocation.sessionId(), allocation.allocationEpoch(), UUID.randomUUID())),
            List.of(new StoppedAllocation(UUID.randomUUID(), allocation.allocationEpoch(), null)));
    for (List<StoppedAllocation> claims : invalid) {
      assertThatThrownBy(() -> confirm(withAllocations(proof, claims)))
          .isInstanceOf(DomainException.class);
    }
    Runtime foreign = allocate();
    ready(foreign);
    var foreignClaim =
        new StoppedAllocation(
            foreign.dispatch().sessionId(),
            foreign.dispatch().allocationEpoch(),
            foreign.generation());
    assertThatThrownBy(() -> confirm(withAllocations(proof, List.of(allocation, foreignClaim))))
        .isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE browser_sessions SET worker_id=:worker,worker_boot_id=:boot WHERE id=:id")
        .param("id", foreign.dispatch().sessionId())
        .param("worker", proof.workerId())
        .param("boot", proof.bootId())
        .update();
    assertThatThrownBy(() -> confirm(proof)).isInstanceOf(DomainException.class);
    assertThat(workers.claim(runtime.dispatch().sessionId()).bindingReleasedAt()).isNull();
    assertThat(workers.claim(foreign.dispatch().sessionId()).bindingReleasedAt()).isNull();
  }

  @Test
  void stoppedProofRollbackRestoresBindingTaskAndOutbox() {
    Runtime runtime = allocate();
    ready(runtime);
    complete(runtime);
    lose(runtime);
    var proof = stoppedProof(runtime);
    var before = workers.claim(runtime.dispatch().sessionId());
    long events = lifecycleEvents(runtime);
    transaction.executeWithoutResult(
        status -> {
          assertThat(registry.confirmStopped(proof)).isEqualTo(1);
          status.setRollbackOnly();
        });
    assertThat(workers.claim(runtime.dispatch().sessionId())).isEqualTo(before);
    assertThat(lifecycleEvents(runtime)).isEqualTo(events);
    assertThatThrownBy(() -> registry.confirmStopped(proof))
        .isInstanceOf(IllegalTransactionStateException.class);
  }

  @Test
  void stoppedProofIsBoundedImmutableAndAllowsNeverAssignedRuntime() {
    Runtime runtime = allocate();
    lose(runtime);
    var proof = stoppedProof(runtime);
    var claims = new ArrayList<>(proof.allocations());
    var copied = withAllocations(proof, claims);
    claims.clear();
    assertThat(copied.allocations()).hasSize(1);
    assertThat(copied.allocations().getFirst().runtimeGeneration()).isNull();
    assertThat(confirm(copied)).isEqualTo(1);
    assertThatThrownBy(() -> withAllocations(proof, List.of())).isInstanceOf(DomainException.class);
    assertThatThrownBy(
            () ->
                withAllocations(
                    proof, List.of(proof.allocations().getFirst(), proof.allocations().getFirst())))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(
            () ->
                new StoppedWorkerProof(
                    proof.installationId(),
                    proof.engineId(),
                    "bad",
                    proof.previousStartedAt(),
                    0,
                    proof.observedStartedAt(),
                    1,
                    proof.workerId(),
                    proof.bootId(),
                    proof.allocations()))
        .isInstanceOf(DomainException.class);
    var future =
        new StoppedWorkerProof(
            proof.installationId(),
            proof.engineId(),
            proof.containerId(),
            proof.previousStartedAt(),
            0,
            Instant.now().plusSeconds(60),
            1,
            proof.workerId(),
            proof.bootId(),
            proof.allocations());
    assertThatThrownBy(() -> confirm(future)).isInstanceOf(DomainException.class);
  }

  private int confirm(StoppedWorkerProof proof) {
    return Objects.requireNonNull(transaction.execute(status -> registry.confirmStopped(proof)));
  }

  private StoppedWorkerProof stoppedProof(Runtime runtime) {
    var dispatch = runtime.dispatch();
    Instant observed = Instant.now().minusSeconds(1);
    jdbc.sql(
            "UPDATE browser_workers SET registered_at=:registered,heartbeat_at=:heartbeat WHERE"
                + " id=:id")
        .param("id", dispatch.workerId())
        .param("registered", Timestamp.from(observed.minusSeconds(60)))
        .param("heartbeat", Timestamp.from(observed.minusSeconds(30)))
        .update();
    var claim = workers.claim(dispatch.sessionId());
    return new StoppedWorkerProof(
        "test-installation",
        UUID.randomUUID(),
        "a".repeat(64),
        observed.minusSeconds(120),
        0,
        observed,
        1,
        dispatch.workerId(),
        dispatch.workerBootId(),
        List.of(
            new StoppedAllocation(
                dispatch.sessionId(), dispatch.allocationEpoch(), claim.runtimeGeneration())));
  }

  private StoppedWorkerProof withAllocations(
      StoppedWorkerProof proof, List<StoppedAllocation> allocations) {
    return new StoppedWorkerProof(
        proof.installationId(),
        proof.engineId(),
        proof.containerId(),
        proof.previousStartedAt(),
        proof.previousRestartCount(),
        proof.observedStartedAt(),
        proof.observedRestartCount(),
        proof.workerId(),
        proof.bootId(),
        allocations);
  }

  @Test
  void losingIdleRuntimePublishesTaskAndSessionWithoutAChangedCommand() {
    Runtime runtime = allocate();
    ready(runtime);
    complete(runtime);
    var dispatch = runtime.dispatch();
    lose(runtime);
    assertThat(workers.claim(dispatch.sessionId()).taskState()).isEqualTo("INTERRUPTED");
    assertThat(commandState(dispatch.commandId())).isEqualTo("SUCCEEDED");
    assertCurrentLifecycleEvents(runtime);
    long events = lifecycleEvents(runtime);
    registry.expireRecovery(dispatch.sessionId());
    assertThat(lifecycleEvents(runtime)).isEqualTo(events);
  }

  @Test
  void physicalClosurePublishesCancellationWithoutAChangedCommand() {
    Runtime runtime = allocate();
    ready(runtime);
    complete(runtime);
    var dispatch = runtime.dispatch();
    jdbc.sql("UPDATE tasks SET state='STOPPING',version=version+1 WHERE id=:id")
        .param("id", dispatch.taskId())
        .update();
    registry.closed(
        dispatch.workerId(), dispatch.workerBootId(), dispatch.sessionId(), inventory(runtime));
    assertThat(workers.claim(dispatch.sessionId()).taskState()).isEqualTo("CANCELLED");
    assertThat(commandState(dispatch.commandId())).isEqualTo("SUCCEEDED");
    assertCurrentLifecycleEvents(runtime);
    long events = lifecycleEvents(runtime);
    registry.closed(
        dispatch.workerId(), dispatch.workerBootId(), dispatch.sessionId(), inventory(runtime));
    assertThat(lifecycleEvents(runtime)).isEqualTo(events);
  }

  private void complete(Runtime runtime) {
    var dispatch = runtime.dispatch();
    start(runtime);
    Map<String, Object> result = new HashMap<>();
    result.put("schemaVersion", 1);
    result.put("commandId", dispatch.commandId());
    result.put("attemptId", dispatch.attemptId());
    result.put("taskId", dispatch.taskId());
    result.put("browserSessionId", dispatch.sessionId());
    result.put("allocationEpoch", dispatch.allocationEpoch());
    result.put("controlEpoch", dispatch.controlEpoch());
    result.put("pageEpoch", dispatch.pageEpoch());
    result.put("privacyEpoch", dispatch.privacyEpoch());
    result.put("status", "SUCCEEDED");
    result.put("effectState", "CONFIRMED");
    result.put("code", "HANDLER_COMPLETED");
    result.put("digest", json.workerDigest(json.read(json.write(result))));
    commands.acceptResult(
        dispatch.workerId(), dispatch.workerBootId(), json.read(json.write(result)));
  }

  private void start(Runtime runtime) {
    var dispatch = runtime.dispatch();
    Map<String, Object> request = new HashMap<>(CommandExecutionService.scope(dispatch));
    request.put("commandId", dispatch.commandId());
    request.put("attemptId", dispatch.attemptId());
    request.put("actionDigest", dispatch.payloadHash());
    commands.start(dispatch.workerId(), dispatch.workerBootId(), json.read(json.write(request)));
  }

  private void lose(Runtime runtime) {
    var dispatch = runtime.dispatch();
    jdbc.sql("UPDATE browser_workers SET heartbeat_at=now()-interval '21 seconds' WHERE id=:id")
        .param("id", dispatch.workerId())
        .update();
    registry.expireWorker(dispatch.workerId());
    jdbc.sql(
            "UPDATE browser_sessions SET recovery_started_at=now()-interval '31 seconds' WHERE"
                + " id=:id")
        .param("id", dispatch.sessionId())
        .update();
    registry.expireRecovery(dispatch.sessionId());
  }

  private String commandState(UUID commandId) {
    return jdbc.sql("SELECT state FROM task_commands WHERE id=:id")
        .param("id", commandId)
        .query(String.class)
        .single();
  }

  private void assertCurrentLifecycleEvents(Runtime runtime) {
    var dispatch = runtime.dispatch();
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM transactional_outbox o JOIN tasks t ON"
                        + " t.id=o.aggregate_id WHERE t.id=:id AND o.event_type='tasks' AND"
                        + " o.aggregate_version=t.version")
                .param("id", dispatch.taskId())
                .query(Long.class)
                .single())
        .isEqualTo(1);
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM transactional_outbox o JOIN browser_sessions s ON"
                        + " s.id=o.aggregate_id WHERE s.id=:id AND o.event_type='sessions' AND"
                        + " o.aggregate_version=s.version")
                .param("id", dispatch.sessionId())
                .query(Long.class)
                .single())
        .isEqualTo(1);
  }

  private long lifecycleEvents(Runtime runtime) {
    return jdbc.sql(
            "SELECT count(*) FROM transactional_outbox WHERE aggregate_id IN (:task,:session)"
                + " AND event_type IN ('tasks','sessions')")
        .param("task", runtime.dispatch().taskId())
        .param("session", runtime.dispatch().sessionId())
        .query(Long.class)
        .single();
  }

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
                context(),
                null)
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
        context(),
        null);
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
