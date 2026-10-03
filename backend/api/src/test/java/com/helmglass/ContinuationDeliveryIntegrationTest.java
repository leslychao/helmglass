package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.command.api.CommandContracts;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.continuation.api.ContinuationContracts;
import com.helmglass.continuation.api.ContinuationContracts.DeliveryOutcome;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

@SpringJUnitConfig(WorkflowIntegrationTest.Owners.class)
@TestPropertySource(properties = "helm.continuation.verified-host-message-contract=CHATGPT_WEB:2026-10-03")
class ContinuationDeliveryIntegrationTest {
  private final TaskContinuationService owner;
  private final ContinuationRepository repository;
  private final TaskLifecycleService tasks;
  private final CommandExecutionService commands;
  private final RealtimeDeliveryService realtime;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final JdbcClient jdbc;
  private final ApplicationEventPublisher events;
  private final TransactionTemplate transaction;

  @Autowired
  ContinuationDeliveryIntegrationTest(TaskContinuationService owner, ContinuationRepository repository,
      TaskLifecycleService tasks, CommandExecutionService commands, RealtimeDeliveryService realtime,
      IdentityRepository identities, OperationRepository operations, JdbcClient jdbc,
      ApplicationEventPublisher events, PlatformTransactionManager transactions) {
    this.owner = owner;
    this.repository = repository;
    this.tasks = tasks;
    this.commands = commands;
    this.realtime = realtime;
    this.identities = identities;
    this.operations = operations;
    this.jdbc = jdbc;
    this.events = events;
    transaction = new TransactionTemplate(transactions);
  }

  private record Fixture(AuthenticatedActor actor, HostConversationContext host, UUID task,
      UUID source, UUID continuation, UUID scope, long revision, UUID viewer) {
    ContinuationContracts.PrepareMessage prepare() {
      return new ContinuationContracts.PrepareMessage(continuation, scope, revision, viewer);
    }
  }

  private Fixture fixture(boolean ready) {
    AuthenticatedActor actor = Objects.requireNonNull(transaction.execute(status -> {
      var account = identities.resolve("continuation-tests", UUID.randomUUID().toString(), "Test", "test@example.invalid");
      var scopes = Set.of("tasks:read", "tasks:write", "browser:view", "browser:execute", "results:write");
      UUID grant = identities.admitGrant(account.id(), "helm-mcp", UUID.randomUUID().toString(), List.copyOf(scopes));
      return new AuthenticatedActor(account.id(), null, grant, "helm-mcp", account.displayName(),
          account.email(), account.accessEpoch(), scopes, true);
    }));
    UUID task = tasks.create(actor, new TaskContracts.Create("Continue existing work", "https://example.com",
        List.of(), "TEXT", false, 1800, "PREPARE"), context()).resource().id();
    HostConversationContext host = host();
    var publication = realtime.publishPresentation(actor, task, null, 0, context(), host, Instant.now().plusSeconds(300));
    owner.bindDestination(actor, host, task);
    UUID viewer = UUID.randomUUID();
    realtime.attachPresentation(actor, task, publication.slot().id(), publication.slot().presentationRevision(),
        viewer, host, Instant.now().plusSeconds(300));
    UUID source = Objects.requireNonNull(transaction.execute(status -> {
      UUID operation = operations.createSystem(actor.userId(), "test.continuation", "task", task);
      owner.waitForResult(task, operation, null, "USER_RESPONSE");
      return operation;
    }));
    UUID continuation = (UUID) repository.snapshot(task).get("id");
    Fixture result = new Fixture(actor, host, task, source, continuation, publication.slot().id(),
        publication.slot().presentationRevision(), viewer);
    if (ready) finish(result, "SUCCEEDED");
    return result;
  }

  private void finish(Fixture fixture, String state) {
    transaction.executeWithoutResult(status -> {
      jdbc.sql("UPDATE operations SET state=:state WHERE id=:id").param("state", state).param("id", fixture.source()).update();
      events.publishEvent(new TaskContinuationService.Ready(fixture.task(), fixture.source(), null, "USER_RESPONSE"));
    });
  }

  @Test
  void acceptedWaitingSurvivesRollbackAndDuplicateCompletionKeepsOneIdentity() {
    Fixture fixture = fixture(false);
    assertThat(repository.get(fixture.continuation()).state()).isEqualTo("WAITING_RESULT");
    transaction.executeWithoutResult(status -> owner.waitForResult(fixture.task(), fixture.source(), null, "USER_RESPONSE"));
    finish(fixture, "SUCCEEDED");
    long version = repository.get(fixture.continuation()).version();
    finish(fixture, "SUCCEEDED");
    assertThat(repository.get(fixture.continuation()).version()).isEqualTo(version);
    assertThat(repository.get(fixture.continuation()).state()).isEqualTo("READY");
    assertThat(count("SELECT count(*) FROM task_continuations WHERE task_id=:id", fixture.task())).isEqualTo(1);

    Fixture rollback = fixture(false);
    transaction.executeWithoutResult(status -> {
      owner.cancel(rollback.task());
      UUID source = operations.createSystem(rollback.actor().userId(), "test.rollback", "task", rollback.task());
      owner.waitForResult(rollback.task(), source, null, "USER_RESPONSE");
      status.setRollbackOnly();
    });
    assertThat(repository.get(rollback.continuation()).state()).isEqualTo("WAITING_RESULT");
    assertThat(count("SELECT count(*) FROM task_continuations WHERE task_id=:id", rollback.task())).isEqualTo(1);
  }

  @Test
  void lostPrepareResponseReplaysOneImmutableUnexpiredDispatch() {
    Fixture fixture = fixture(true);
    MutationContext key = context();
    var first = owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), key);
    var second = owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), key);
    assertThat(second).isEqualTo(first);
    assertThat(first.text()).contains(fixture.task().toString(), fixture.continuation().toString(), "tasks.continue");
    assertThat(first.expiresAt()).isBeforeOrEqualTo(Instant.now().plusSeconds(120));
    assertThatThrownBy(() -> owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), context()))
        .isInstanceOf(DomainException.class).extracting("code").isEqualTo("CONTINUATION_NOT_READY");
    assertThat(count("SELECT count(*) FROM task_continuations WHERE task_id=:id AND dispatch_id IS NOT NULL", fixture.task())).isEqualTo(1);
  }

  @Test
  void concurrentPrepareRequestsCannotAuthorizeTwoMessages() throws Exception {
    Fixture fixture = fixture(true);
    CountDownLatch start = new CountDownLatch(1);
    try (var executor = Executors.newFixedThreadPool(2)) {
      var first = executor.submit(() -> prepareAfter(start, fixture));
      var second = executor.submit(() -> prepareAfter(start, fixture));
      start.countDown();
      assertThat(List.of(first.get(10, TimeUnit.SECONDS), second.get(10, TimeUnit.SECONDS)))
          .containsExactlyInAnyOrder("DISPATCHED", "CONTINUATION_NOT_READY");
    }
  }

  private String prepareAfter(CountDownLatch start, Fixture fixture) throws InterruptedException {
    if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Concurrent test did not start");
    try {
      owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), context());
      return "DISPATCHED";
    } catch (DomainException error) { return error.getCode(); }
  }

  @Test
  void lateDeliveryAndLostReceiptDoNotDowngradeClaimOrAuthorizeResend() {
    Fixture fixture = fixture(true);
    MutationContext prepareKey = context();
    var dispatch = owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), prepareKey);
    var claimInput = new ContinuationContracts.Claim(fixture.continuation(), 1L);
    var claim = owner.claim(fixture.actor(), fixture.host(), fixture.task(), claimInput, context());
    var input = new ContinuationContracts.RecordDelivery(dispatch.dispatchId(), DeliveryOutcome.DELIVERED);
    MutationContext deliveryKey = context();
    var receipt = owner.recordDelivery(fixture.actor(), fixture.host(), input, deliveryKey);
    assertThat(owner.recordDelivery(fixture.actor(), fixture.host(), input, deliveryKey)).isEqualTo(receipt);
    assertThat(repository.get(fixture.continuation()).state()).isEqualTo("CLAIMED");
    assertThat(repository.get(fixture.continuation()).deliveredAt()).isNotNull();
    assertThatThrownBy(() -> owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), prepareKey))
        .isInstanceOf(DomainException.class).extracting("code").isEqualTo("DISPATCH_NOT_SENDABLE");
    transaction.executeWithoutResult(status -> owner.consume(fixture.actor(), fixture.task(), 1, claim.resource().id()));
    owner.recordDelivery(fixture.actor(), fixture.host(), input, context());
    assertThat(repository.get(fixture.continuation()).state()).isEqualTo("CONSUMED");
  }

  @Test
  void unknownReceiptExpiresWithoutResendAndRejectedHostStillAllowsOneManualClaim() {
    Fixture fixture = fixture(true);
    var dispatch = owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), context());
    jdbc.sql("UPDATE task_continuations SET dispatch_expires_at=now()-interval '1 second' WHERE id=:id")
        .param("id", fixture.continuation()).update();
    owner.expire();
    assertThat(repository.get(fixture.continuation()).state()).isEqualTo("DELIVERY_UNKNOWN");
    assertThatThrownBy(() -> owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), context()))
        .isInstanceOf(DomainException.class);
    owner.recordDelivery(fixture.actor(), fixture.host(),
        new ContinuationContracts.RecordDelivery(dispatch.dispatchId(), DeliveryOutcome.DELIVERED), context());
    assertThat(repository.get(fixture.continuation()).state()).isEqualTo("DELIVERED");

    Fixture rejected = fixture(true);
    var rejectedDispatch = owner.prepareMessage(rejected.actor(), rejected.host(), rejected.task(), rejected.prepare(), context());
    owner.recordDelivery(rejected.actor(), rejected.host(),
        new ContinuationContracts.RecordDelivery(rejectedDispatch.dispatchId(), DeliveryOutcome.REJECTED), context());
    assertThat(repository.get(rejected.continuation()).state()).isEqualTo("BLOCKED");
    var claimInput = new ContinuationContracts.Claim(rejected.continuation(), 1L);
    owner.claim(rejected.actor(), rejected.host(), rejected.task(), claimInput, context());
    assertThatThrownBy(() -> owner.claim(rejected.actor(), rejected.host(), rejected.task(), claimInput, context()))
        .isInstanceOf(DomainException.class).extracting("code").isEqualTo("CONTINUATION_BUSY");
  }

  @Test
  void destinationGrantRevisionAndExpiryAreRecheckedBeforeDispatch() {
    Fixture fixture = fixture(true);
    assertThatThrownBy(() -> owner.prepareMessage(fixture.actor(), host(), fixture.task(), fixture.prepare(), context()))
        .isInstanceOf(DomainException.class);
    var stale = new ContinuationContracts.PrepareMessage(fixture.continuation(), fixture.scope(), 0L, fixture.viewer());
    assertThatThrownBy(() -> owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), stale, context()))
        .isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE client_grants SET status='REVOKED',version=version+1 WHERE id=:id")
        .param("id", fixture.actor().grantId()).update();
    assertThatThrownBy(() -> owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), context()))
        .isInstanceOf(DomainException.class);

    Fixture expired = fixture(true);
    jdbc.sql("UPDATE task_continuations SET expires_at=now()-interval '1 second' WHERE id=:id").param("id", expired.continuation()).update();
    owner.expire();
    assertThat(repository.get(expired.continuation()).state()).isEqualTo("EXPIRED");
    assertThatThrownBy(() -> owner.claim(expired.actor(), expired.host(), expired.task(),
        new ContinuationContracts.Claim(expired.continuation(), 1L), context())).isInstanceOf(DomainException.class);
  }

  @Test
  void pauseCancelsReadinessAndUnknownSourceBlocksAutomaticProgress() {
    Fixture fixture = fixture(true);
    tasks.pause(fixture.actor(), fixture.task(), context());
    assertThat(repository.get(fixture.continuation()).state()).isEqualTo("CANCELLED");
    assertThatThrownBy(() -> owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), context()))
        .isInstanceOf(DomainException.class);

    Fixture unknown = fixture(false);
    finish(unknown, "NEEDS_ATTENTION");
    assertThat(repository.get(unknown.continuation()).state()).isEqualTo("BLOCKED");
    assertThat(repository.get(unknown.continuation()).blockReason()).isEqualTo("RECONCILIATION_REQUIRED");
    assertThatThrownBy(() -> owner.claim(unknown.actor(), unknown.host(), unknown.task(),
        new ContinuationContracts.Claim(unknown.continuation(), 1L), context())).isInstanceOf(DomainException.class);
  }

  @Test
  void commandAdmissionConsumesPriorClaimAndRegistersOneWaitingIntentButObserveDoesNot() {
    Fixture fixture = fixture(true);
    var claim = owner.claim(fixture.actor(), fixture.host(), fixture.task(),
        new ContinuationContracts.Claim(fixture.continuation(), 1L), context());
    UUID commandId = UUID.randomUUID();
    var command = command(fixture, commandId, claim.resource().id(), "NAVIGATE");
    MutationContext key = context();
    commands.accept(fixture.actor(), fixture.task(), command, key);
    commands.accept(fixture.actor(), fixture.task(), command, key);
    assertThat(repository.get(fixture.continuation()).state()).isEqualTo("CONSUMED");
    assertThat(repository.snapshot(fixture.task())).containsEntry("state", "WAITING_RESULT");
    assertThat(count("SELECT count(*) FROM task_continuations WHERE source_command_id=:id", commandId)).isEqualTo(1);
    transaction.executeWithoutResult(status -> {
      jdbc.sql("UPDATE task_commands SET state='SUCCEEDED' WHERE id=:id").param("id", commandId).update();
      jdbc.sql("UPDATE tasks SET state='WAITING_AGENT' WHERE id=:id").param("id", fixture.task()).update();
      commands.dispositionChanged(fixture.actor().userId(), fixture.task(), commandId);
    });
    UUID next = (UUID) repository.snapshot(fixture.task()).get("id");
    assertThat(repository.get(next).dispatchNotBefore()).isAfter(Instant.now());
    assertThatThrownBy(() -> owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(),
        new ContinuationContracts.PrepareMessage(next, fixture.scope(), fixture.revision(), fixture.viewer()), context()))
        .isInstanceOf(DomainException.class).extracting("code").isEqualTo("CONTINUATION_NOT_READY");

    Fixture observation = fixture(true);
    var observedClaim = owner.claim(observation.actor(), observation.host(), observation.task(),
        new ContinuationContracts.Claim(observation.continuation(), 1L), context());
    UUID observeId = UUID.randomUUID();
    commands.accept(observation.actor(), observation.task(), command(observation, observeId, observedClaim.resource().id(), "OBSERVE"), context());
    assertThat(count("SELECT count(*) FROM task_continuations WHERE source_command_id=:id", observeId)).isZero();
  }

  @Test
  void eachContinuationVersionHasASeparateTaskInvalidationAndReadyGraceIsDurable() {
    Fixture fixture = fixture(true);
    var dispatch = owner.prepareMessage(fixture.actor(), fixture.host(), fixture.task(), fixture.prepare(), context());
    owner.recordDelivery(fixture.actor(), fixture.host(),
        new ContinuationContracts.RecordDelivery(dispatch.dispatchId(), DeliveryOutcome.DELIVERED), context());
    assertThat(count("SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:id AND event_type='tasks'", fixture.continuation()))
        .isEqualTo(4);
    assertThat(jdbc.sql("SELECT bool_and(payload->>'resourceId'=:task) FROM transactional_outbox WHERE aggregate_id=:id")
        .param("task", fixture.task().toString()).param("id", fixture.continuation()).query(Boolean.class).single()).isTrue();
  }

  private CommandContracts.Submit command(Fixture fixture, UUID id, UUID claim, String type) {
    var action = JsonMapper.builder().build().createObjectNode().put("type", type);
    if (type.equals("NAVIGATE")) action.put("url", "https://example.com");
    return new CommandContracts.Submit(id, tasks.get(fixture.actor(), fixture.task()).version(), 1L,
        null, null, null, null, claim, null, null, action);
  }

  private long count(String sql, UUID id) {
    return jdbc.sql(sql).param("id", id).query(Long.class).single();
  }

  private static MutationContext context() { return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID()); }
  private static HostConversationContext host() {
    return new HostConversationContext("CHATGPT_WEB", "2026-10-03", UUID.randomUUID().toString().replace("-", "").repeat(2));
  }
}

