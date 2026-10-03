package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.application.BrowserOpenService;
import com.helmglass.browser.application.BrowserStartupService;
import com.helmglass.browser.application.WorkerRegistryService;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** PostgreSQL admission and launch receipts; these tests do not claim a native browser launch. */
@SpringJUnitConfig(CoreOwnersIntegrationTest.Owners.class)
class BrowserOpenIntegrationTest {
  private final BrowserOpenService opens;
  private final TaskLifecycleService tasks;
  private final BrowserRepository browsers;
  private final BrowserStartupRepository startups;
  private final BrowserStartupService startup;
  private final WorkerRegistryService registry;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final TransactionTemplate transaction;

  @Autowired
  BrowserOpenIntegrationTest(
      BrowserOpenService opens,
      TaskLifecycleService tasks,
      BrowserRepository browsers,
      BrowserStartupRepository startups,
      BrowserStartupService startup,
      WorkerRegistryService registry,
      IdentityRepository identities,
      OperationRepository operations,
      JdbcClient jdbc,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.opens = opens;
    this.tasks = tasks;
    this.browsers = browsers;
    this.startups = startups;
    this.startup = startup;
    this.registry = registry;
    this.identities = identities;
    this.operations = operations;
    this.jdbc = jdbc;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void concurrentOpenUsesOneBindingAndOneOperationWithoutResumingPausedTask() throws Exception {
    var actor = actor();
    UUID task = pausedTask(actor);
    var input = input(actor, task, null, false);
    MutationReceipt first;
    MutationReceipt second;
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      var a = executor.submit(() -> opens.open(actor, task, input, context()));
      var b = executor.submit(() -> opens.open(actor, task, input, context()));
      first = a.get(10, TimeUnit.SECONDS);
      second = b.get(10, TimeUnit.SECONDS);
    }
    assertThat(first.resource().id()).isEqualTo(second.resource().id());
    assertThat(first.operationId()).isEqualTo(second.operationId());
    assertThat(browsers.binding(task).orElseThrow().state()).isEqualTo("REQUESTED");
    assertThat(tasks.get(actor, task).state()).isEqualTo("PAUSED");
    assertThat(count("task_commands", "task_id", task)).isZero();
    assertThatThrownBy(
            () ->
                opens.open(
                    actor,
                    task,
                    new BrowserContracts.Open(
                        input.expectedVersion(), "TASK", "SAVE_ON_CLOSE", null, false),
                    context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("parameters");
  }

  @Test
  void launchRequiresDurableOpenIntentAndReadyReusesSameEmptyContext() {
    var actor = actor();
    UUID task = pausedTask(actor);
    var first = opens.open(actor, task, input(actor, task, null, false), context());
    registerWorker();
    var allocated = opens.advance(first.resource().id()).orElseThrow().session();
    ready(allocated);
    opens.ready(allocated.id());
    assertThat(operations.owned(actor.userId(), first.operationId()).state())
        .isEqualTo("SUCCEEDED");
    assertThat(browsers.owned(actor.userId(), allocated.id()).state()).isEqualTo("ACTIVE");
    assertThat(tasks.get(actor, task).state()).isEqualTo("PAUSED");
    var again = opens.open(actor, task, input(actor, task, allocated.id(), false), context());
    assertThat(again.resource().id()).isEqualTo(allocated.id());
    assertThat(again.operationId()).isEqualTo(first.operationId());
    assertThat(count("task_commands", "task_id", task)).isZero();
    assertThat(count("browser_allocations", "session_id", allocated.id())).isEqualTo(1);
  }

  @Test
  void quotaWaitAndQueueExpiryDoNotLaunchOrReleaseSomeoneElsesRuntime() {
    var actor = actor();
    UUID occupiedTask = pausedTask(actor);
    UUID requestedTask = pausedTask(actor);
    registerWorker();
    var occupied =
        opens.open(actor, occupiedTask, input(actor, occupiedTask, null, false), context());
    var occupiedSession = opens.advance(occupied.resource().id()).orElseThrow().session();
    jdbc.sql("UPDATE user_policies SET browser_limit=1 WHERE user_id=:id")
        .param("id", actor.userId())
        .update();
    var waiting =
        opens.open(actor, requestedTask, input(actor, requestedTask, null, false), context());
    assertThat(opens.advance(waiting.resource().id())).isEmpty();
    assertThat(browsers.binding(requestedTask).orElseThrow().state()).isEqualTo("REQUESTED");
    jdbc.sql(
            "UPDATE browser_sessions SET open_request_deadline=now()-interval '1 second' WHERE"
                + " id=:id")
        .param("id", waiting.resource().id())
        .update();
    assertThat(opens.advance(waiting.resource().id())).isEmpty();
    assertThat(browsers.binding(requestedTask)).isEmpty();
    assertThat(operations.owned(actor.userId(), waiting.operationId()).state()).isEqualTo("FAILED");
    assertThat(browsers.binding(occupiedTask).orElseThrow().id()).isEqualTo(occupiedSession.id());
    assertThat(count("browser_allocations", "session_id", waiting.resource().id())).isZero();
  }

  @Test
  void lostBindingAndClosedContextRequireCleanupThenExplicitConsent() {
    var actor = actor();
    UUID task = pausedTask(actor);
    var first = opens.open(actor, task, input(actor, task, null, false), context());
    UUID session = first.resource().id();
    // Simulate owner-confirmed loss and subsequent physical cleanup, not a new runtime.
    jdbc.sql("UPDATE browser_sessions SET state='LOST' WHERE id=:id").param("id", session).update();
    assertThatThrownBy(() -> opens.open(actor, task, input(actor, task, session, true), context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("closure");
    jdbc.sql(
            "UPDATE browser_sessions SET state='CLOSED',binding_released_at=now(),closed_at=now()"
                + " WHERE id=:id")
        .param("id", session)
        .update();
    assertThatThrownBy(() -> opens.open(actor, task, input(actor, task, session, false), context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("loss");
    var reopened = opens.open(actor, task, input(actor, task, session, true), context());
    assertThat(reopened.resource().id()).isNotEqualTo(session);
    assertThat(tasks.get(actor, task).state()).isEqualTo("PAUSED");
  }

  @Test
  void reusingAnOrdinaryStartingSessionSharesReceiptAndReconcilesFailureWithoutFreeingItsSlot() {
    var actor = actor();
    UUID task = pausedTask(actor);
    registerWorker();
    var session =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    browsers.reserve(
                        actor.userId(), task, browsers.freeWorker().orElseThrow(), 1800)));
    var first = opens.open(actor, task, input(actor, task, session.id(), false), context());
    var duplicate = opens.open(actor, task, input(actor, task, session.id(), false), context());
    assertThat(first.operationId()).isEqualTo(duplicate.operationId());
    assertThat(opens.pending()).contains(session.id());
    jdbc.sql("UPDATE browser_sessions SET state='STOPPING' WHERE id=:id")
        .param("id", session.id())
        .update();
    assertThat(opens.advance(session.id())).isEmpty();
    assertThat(operations.owned(actor.userId(), first.operationId()).state()).isEqualTo("FAILED");
    assertThat(browsers.binding(task).orElseThrow().id()).isEqualTo(session.id());
    assertThat(count("browser_allocations", "session_id", session.id())).isEqualTo(1);
  }

  @Test
  void changedInstructionsFenceLaunchAndForeignActorCannotOpenTask() {
    var actor = actor();
    UUID task = pausedTask(actor);
    assertThatThrownBy(() -> opens.open(actor(), task, input(actor, task, null, false), context()))
        .isInstanceOf(DomainException.class);
    var requested = opens.open(actor, task, input(actor, task, null, false), context());
    registerWorker();
    var session = opens.advance(requested.resource().id()).orElseThrow().session();
    jdbc.sql("UPDATE tasks SET instruction_revision=instruction_revision+1 WHERE id=:id")
        .param("id", task)
        .update();
    assertThatThrownBy(
            () ->
                registry.assignment(session.workerId(), json.read(json.write(assignment(session)))))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("owners");
    assertThat(opens.advance(session.id())).isEmpty();
    assertThat(browsers.owned(actor.userId(), session.id()).state()).isEqualTo("STOPPING");
    assertThat(count("browser_allocations", "session_id", session.id())).isEqualTo(1);
  }

  private AuthenticatedActor actor() {
    return Objects.requireNonNull(
        transaction.execute(
            status -> {
              var account =
                  identities.resolve(
                      "https://issuer.example",
                      UUID.randomUUID().toString(),
                      "Fixture",
                      "fixture@example.test");
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
                  "Fixture",
                  "fixture@example.test",
                  account.accessEpoch(),
                  Set.of(),
                  false);
            }));
  }

  private UUID pausedTask(AuthenticatedActor actor) {
    UUID id =
        tasks
            .create(
                actor,
                new TaskContracts.Create(
                    "Explicit browser",
                    "https://example.com",
                    List.of(),
                    "TEXT",
                    false,
                    1800,
                    "PREPARE"),
                context(),
                null)
            .resource()
            .id();
    tasks.pause(actor, id, context());
    return id;
  }

  private BrowserContracts.Open input(
      AuthenticatedActor actor, UUID task, UUID previous, boolean consent) {
    return new BrowserContracts.Open(
        tasks.get(actor, task).version(), "TASK", "DISCARD_CHANGES", previous, consent);
  }

  private void registerWorker() {
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
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

  private Map<String, Object> assignment(BrowserRepository.Session session) {
    Map<String, Object> message = BrowserStartupService.scope(startups.context(session.id()));
    message.put("deadline", session.budgetDeadlineAt());
    message.put("originPolicy", "PUBLIC");
    message.put("allowedOrigins", List.of());
    return message;
  }

  private void ready(BrowserRepository.Session session) {
    var normalized =
        registry.assignment(session.workerId(), json.read(json.write(assignment(session))));
    var permit =
        registry.launchPermit(
            session.workerId(),
            session.workerBootId(),
            json.read(
                json.write(
                    Map.of(
                        "browserSessionId",
                        session.id(),
                        "allocationEpoch",
                        session.allocationEpoch(),
                        "assignmentDigest",
                        json.workerDigest(normalized)))));
    var scope = startups.context(session.id());
    var receipt =
        json.read(
            json.write(
                Map.of(
                    "startPermitId",
                    permit.get("permitId"),
                    "runtimeGeneration",
                    UUID.randomUUID(),
                    "allocationEpoch",
                    scope.allocationEpoch(),
                    "controlEpoch",
                    scope.controlEpoch(),
                    "pageEpoch",
                    scope.pageEpoch(),
                    "privacyEpoch",
                    scope.privacyEpoch())));
    registry.assigned(session.workerId(), session.workerBootId(), session.id(), receipt);
    assertThat(startup.assigned(session.id())).isTrue();
    assertThat(browsers.owned(session.userId(), session.id()).state()).isEqualTo("STARTING");
    var ready =
        WorkerRuntimeReceipts.ready(
            json, session.workerBootId(), session.id(), session.allocationEpoch());
    startup.acknowledgeReady(session.workerId(), session.workerBootId(), session.id(), ready);
    startup.acknowledgeReady(session.workerId(), session.workerBootId(), session.id(), ready);
  }

  private long count(String table, String field, UUID id) {
    // Only fixed test-owned identifiers call this helper.
    return jdbc.sql("SELECT count(*) FROM " + table + " WHERE " + field + "=:id")
        .param("id", id)
        .query(Long.class)
        .single();
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
