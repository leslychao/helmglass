package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.continuation.api.ContinuationContracts;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.task.api.ResultContracts;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.ResultService;
import com.helmglass.task.application.TaskLifecycleService;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringJUnitConfig(UsageResultIntegrationTest.Owners.class)
class ResultPublicationIntegrationTest {
  private static final Set<String> SCOPES =
      Set.of("tasks:read", "tasks:write", "results:write", "browser:execute");

  private final JdbcClient jdbc;
  private final IdentityRepository identities;
  private final TaskLifecycleService tasks;
  private final ResultService results;
  private final OperationRepository operations;
  private final TaskContinuationService continuations;
  private final ContinuationRepository continuationRecords;
  private final ApplicationEventPublisher events;
  private final TransactionTemplate transaction;

  @Autowired
  ResultPublicationIntegrationTest(
      JdbcClient jdbc,
      IdentityRepository identities,
      TaskLifecycleService tasks,
      ResultService results,
      OperationRepository operations,
      TaskContinuationService continuations,
      ContinuationRepository continuationRecords,
      ApplicationEventPublisher events,
      PlatformTransactionManager transactions) {
    this.jdbc = jdbc;
    this.identities = identities;
    this.tasks = tasks;
    this.results = results;
    this.operations = operations;
    this.continuations = continuations;
    this.continuationRecords = continuationRecords;
    this.events = events;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void lostPublicationResponseReplaysOriginalReceiptWithoutDuplicatingRowsOrOutbox() {
    var actor = actor();
    UUID task = create(actor);
    var input = publication(actor, task, null, List.of());
    var key = context();
    var receipt = results.publish(actor, task, input, key);
    long outbox = outboxCount(actor);
    var retry = new MutationContext(key.key(), UUID.randomUUID());

    assertThat(results.publish(actor, task, input, retry)).isEqualTo(receipt);
    assertThat(operations.lookup(actor, "results.publish:" + task, key.key())).isEqualTo(receipt);
    assertThat(resultCount(task)).isEqualTo(1);
    assertThat(
            count(
                "SELECT count(*) FROM task_result_rows WHERE result_id=:id",
                receipt.resource().id()))
        .isEqualTo(2);
    assertThat(outboxCount(actor)).isEqualTo(outbox);
    assertThat(tasks.get(actor, task).state()).isEqualTo("WAITING_AGENT");
    assertThat(tasks.get(actor, task).outcome()).isNull();

    var changed =
        new ResultContracts.Publish(
            input.expectedTaskVersion(),
            input.instructionRevision(),
            null,
            "Different conclusion",
            input.limitations(),
            input.missing(),
            input.columns(),
            input.rows(),
            input.coverage(),
            input.artifactIds(),
            input.sections(),
            input.sources());
    assertCode(() -> results.publish(actor, task, changed, retry), "IDEMPOTENCY_MISMATCH");
    assertThat(resultCount(task)).isEqualTo(1);

    var secondClient = withClient(actor, "another-approved-client");
    var separate = results.publish(secondClient, task, input, retry);
    assertThat(separate.operationId()).isNotEqualTo(receipt.operationId());
    assertThat(separate.resource().version()).isEqualTo(2);
  }

  @Test
  void concurrentPublicationWithOneKeyCommitsOneResultAndOneReceipt() throws Exception {
    var actor = actor();
    UUID task = create(actor);
    var input = publication(actor, task, null, List.of());
    var key = context();
    var start = new CountDownLatch(1);
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      var first =
          executor.submit(
              () -> {
                assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
                return results.publish(actor, task, input, key);
              });
      var second =
          executor.submit(
              () -> {
                assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
                return results.publish(
                    actor, task, input, new MutationContext(key.key(), UUID.randomUUID()));
              });
      start.countDown();
      assertThat(first.get(15, TimeUnit.SECONDS)).isEqualTo(second.get(15, TimeUnit.SECONDS));
    }
    assertThat(resultCount(task)).isEqualTo(1);
    assertThat(
            count(
                "SELECT count(*) FROM operations WHERE target_id IN"
                    + " (SELECT id FROM task_results WHERE task_id=:id)",
                task))
        .isEqualTo(1);
  }

  @Test
  void unavailableFileRollsBackRowsMembershipReceiptAndContinuationConsumption() {
    var actor = actor();
    UUID task = create(actor);
    UUID continuation = readyContinuation(actor, task);
    var claim =
        continuations.claim(
            actor, null, task, new ContinuationContracts.Claim(continuation, 1L), context());
    UUID firstFile = artifact(actor, task, "READY");
    UUID pendingFile = artifact(actor, task, "UPLOADING");
    var input = publication(actor, task, claim.resource().id(), List.of(firstFile, pendingFile));
    var key = context();
    long outbox = outboxCount(actor);

    assertCode(() -> results.publish(actor, task, input, key), "ARTIFACT_NOT_READY");
    assertThat(resultCount(task)).isZero();
    assertThat(
            count(
                "SELECT count(*) FROM task_result_rows r JOIN task_results t"
                    + " ON t.id=r.result_id WHERE t.task_id=:id",
                task))
        .isZero();
    assertThat(
            count(
                "SELECT count(*) FROM task_artifacts WHERE task_id=:id AND result_id IS NOT NULL",
                task))
        .isZero();
    assertThat(count("SELECT count(*) FROM idempotency_records WHERE key=:key", "key", key.key()))
        .isZero();
    assertThat(outboxCount(actor)).isEqualTo(outbox);
    assertThat(continuationRecords.get(continuation).state()).isEqualTo("CLAIMED");

    jdbc.sql("UPDATE task_artifacts SET state='READY',ready_at=now() WHERE id=:id")
        .param("id", pendingFile)
        .update();
    var receipt = results.publish(actor, task, input, key);
    assertThat(resultCount(task)).isEqualTo(1);
    assertThat(continuationRecords.get(continuation).state()).isEqualTo("CONSUMED");
    assertThat(results.publish(actor, task, input, key)).isEqualTo(receipt);
    assertThat(count("SELECT count(*) FROM browser_sessions WHERE task_id=:id", task)).isZero();
  }

  @Test
  void completionIsExplicitAtomicAndReplayableAfterTaskVersionChanges() {
    var actor = actor();
    UUID task = create(actor);
    var published =
        results.publish(actor, task, publication(actor, task, null, List.of()), context());
    UUID continuation = readyContinuation(actor, task);
    var completion = completion(actor, task, published, null, "PARTIAL");
    assertCode(
        () -> tasks.complete(actor, task, completion, context()), "CONTINUATION_CLAIM_REQUIRED");
    assertThat(finalCount(task)).isZero();

    var claim =
        continuations.claim(
            actor, null, task, new ContinuationContracts.Claim(continuation, 1L), context());
    var accepted = completion(actor, task, published, claim.resource().id(), "PARTIAL");
    var key = context();
    var receipt = tasks.complete(actor, task, accepted, key);
    var current = tasks.get(actor, task);
    assertThat(current.state()).isEqualTo("COMPLETED");
    assertThat(current.outcome()).isEqualTo("PARTIAL");
    assertThat(current.version()).isGreaterThan(accepted.expectedTaskVersion());
    assertThat(finalCount(task)).isEqualTo(1);
    assertThat(continuationRecords.get(continuation).state()).isEqualTo("CONSUMED");
    long outbox = outboxCount(actor);
    assertThat(
            tasks.complete(
                actor, task, accepted, new MutationContext(key.key(), UUID.randomUUID())))
        .isEqualTo(receipt);
    assertThat(operations.lookup(actor, "tasks.complete:" + task, key.key())).isEqualTo(receipt);
    assertThat(outboxCount(actor)).isEqualTo(outbox);
    assertThat(count("SELECT count(*) FROM browser_sessions WHERE task_id=:id", task)).isZero();
    jdbc.sql("UPDATE application_users SET state='BLOCKED' WHERE id=:id")
        .param("id", actor.userId())
        .update();
    assertCode(() -> tasks.complete(actor, task, accepted, key), "ACCOUNT_UNAVAILABLE");
  }

  @Test
  void staleVersionsAndForeignResultCannotFinalizeAnyRevision() {
    var actor = actor();
    UUID task = create(actor);
    var own = results.publish(actor, task, publication(actor, task, null, List.of()), context());
    UUID otherTask = create(actor);
    var other =
        results.publish(
            actor, otherTask, publication(actor, otherTask, null, List.of()), context());
    var current = tasks.get(actor, task);
    assertCode(
        () ->
            tasks.complete(
                actor,
                task,
                new TaskContracts.Completion(
                    current.version() + 1,
                    current.instructionRevision(),
                    own.resource().id(),
                    null,
                    1L,
                    "SUCCESS"),
                context()),
        "VERSION_CONFLICT");
    assertCode(
        () ->
            tasks.complete(
                actor,
                task,
                new TaskContracts.Completion(
                    current.version(),
                    current.instructionRevision() + 1,
                    own.resource().id(),
                    null,
                    1L,
                    "SUCCESS"),
                context()),
        "VERSION_CONFLICT");
    assertCode(
        () ->
            tasks.complete(actor, task, completion(actor, task, other, null, "SUCCESS"), context()),
        "RESULT_REVISION_CONFLICT");
    assertCode(
        () ->
            tasks.complete(
                actor,
                task,
                new TaskContracts.Completion(
                    current.version(),
                    current.instructionRevision(),
                    own.resource().id(),
                    null,
                    2L,
                    "SUCCESS"),
                context()),
        "RESULT_REVISION_CONFLICT");
    assertCode(
        () ->
            tasks.complete(
                actor, task, completion(actor, task, own, null, "TECHNICAL_FAILURE"), context()),
        "INVALID_OUTCOME");
    assertThat(finalCount(task)).isZero();
    assertThat(finalCount(otherTask)).isZero();
    assertThat(tasks.get(actor, task).state()).isEqualTo("WAITING_AGENT");
  }

  @ParameterizedTest
  @ValueSource(strings = {"ACCEPTED", "WAITING_RESOURCE", "DISPATCHED", "STARTED"})
  void outstandingCommandCannotBeTurnedIntoTaskSuccess(String commandState) {
    var actor = actor();
    UUID task = create(actor);
    var published =
        results.publish(actor, task, publication(actor, task, null, List.of()), context());
    jdbc.sql(
            """
            INSERT INTO task_commands(id,task_id,user_id,command_sequence,kind,payload,payload_hash,
              accepted_task_version,instruction_revision,deadline,state)
            VALUES(:id,:task,:user,1,'OBSERVE','{}',repeat('a',64),1,1,now()+interval '1 minute',:state)
            """)
        .param("id", UUID.randomUUID())
        .param("task", task)
        .param("user", actor.userId())
        .param("state", commandState)
        .update();
    assertCode(
        () ->
            tasks.complete(
                actor, task, completion(actor, task, published, null, "SUCCESS"), context()),
        "COMMAND_OUTSTANDING");
    assertThat(finalCount(task)).isZero();
    assertThat(tasks.get(actor, task).outcome()).isNull();
  }

  @ParameterizedTest
  @ValueSource(strings = {"WAITING_USER", "PAUSED", "FAILED", "CANCELLED"})
  void nonReadyTaskRetainsPreliminaryResultWithoutInventingFinalOutcome(String state) {
    var actor = actor();
    UUID task = create(actor);
    var published =
        results.publish(actor, task, publication(actor, task, null, List.of()), context());
    jdbc.sql("UPDATE tasks SET state=:state WHERE id=:id")
        .param("state", state)
        .param("id", task)
        .update();
    assertCode(
        () ->
            tasks.complete(
                actor, task, completion(actor, task, published, null, "SUCCESS"), context()),
        "INVALID_TASK_STATE");
    assertThat(finalCount(task)).isZero();
    assertThat(resultCount(task)).isEqualTo(1);
    assertThat(tasks.get(actor, task).outcome()).isNull();
  }

  @Test
  void unresolvedEffectAndBlockedAccountCannotBeBypassedByCompletionOrReplay() {
    var actor = actor();
    UUID task = create(actor);
    var input = publication(actor, task, null, List.of());
    var key = context();
    var published = results.publish(actor, task, input, key);
    jdbc.sql("UPDATE tasks SET mutation_barrier=true WHERE id=:id").param("id", task).update();
    assertCode(
        () ->
            tasks.complete(
                actor, task, completion(actor, task, published, null, "SUCCESS"), context()),
        "EFFECT_UNRESOLVED");
    assertThat(finalCount(task)).isZero();
    jdbc.sql("UPDATE application_users SET state='BLOCKED' WHERE id=:id")
        .param("id", actor.userId())
        .update();
    assertCode(() -> results.publish(actor, task, input, key), "ACCOUNT_UNAVAILABLE");
    assertThat(resultCount(task)).isEqualTo(1);
  }

  @Test
  void publicationRequiresItsScopeAndOwnedTaskBeforeAnyReceiptIsReturned() {
    var actor = actor();
    UUID task = create(actor);
    var input = publication(actor, task, null, List.of());
    var key = context();
    var published = results.publish(actor, task, input, key);
    var other = actor();
    assertCode(() -> results.publish(other, task, input, key), "NOT_FOUND");
    var readOnly =
        new AuthenticatedActor(
            actor.userId(),
            actor.loginId(),
            actor.grantId(),
            actor.clientId(),
            actor.displayName(),
            actor.email(),
            actor.accessEpoch(),
            Set.of("tasks:read"),
            true);
    assertCode(() -> results.publish(readOnly, task, input, key), "SCOPE_REQUIRED");
    assertCode(
        () ->
            tasks.complete(
                other,
                task,
                new TaskContracts.Completion(
                    1L, 1L, published.resource().id(), null, 1L, "SUCCESS"),
                context()),
        "NOT_FOUND");
    assertThat(resultCount(task)).isEqualTo(1);
    assertThat(finalCount(task)).isZero();
  }

  private UUID readyContinuation(AuthenticatedActor actor, UUID task) {
    transaction.executeWithoutResult(
        status -> {
          UUID operation = operations.createSystem(actor.userId(), "test.result", "task", task);
          continuations.waitForResult(task, operation, null, "USER_RESPONSE");
          jdbc.sql("UPDATE operations SET state='SUCCEEDED' WHERE id=:id")
              .param("id", operation)
              .update();
          events.publishEvent(
              new TaskContinuationService.Ready(task, operation, null, "USER_RESPONSE"));
        });
    UUID id = (UUID) continuationRecords.snapshot(task).get("id");
    assertThat(continuationRecords.get(id).state()).isEqualTo("READY");
    return id;
  }

  private UUID artifact(AuthenticatedActor actor, UUID task, String state) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO task_artifacts(id,user_id,task_id,purpose,bucket,object_key,mime,size,filename,
              state,checksum,ready_at)
            VALUES(:id,:user,:task,'FILE','hg-artifacts',:key,'text/plain',12,'report.txt',:state,
              repeat('a',64),CASE WHEN :state='READY' THEN now() ELSE NULL END)
            """)
        .param("id", id)
        .param("user", actor.userId())
        .param("task", task)
        .param("key", id.toString())
        .param("state", state)
        .update();
    return id;
  }

  private AuthenticatedActor actor() {
    return Objects.requireNonNull(
        transaction.execute(
            status -> {
              var account =
                  identities.resolve(
                      "result-tests",
                      UUID.randomUUID().toString(),
                      "Result test",
                      "result@example.invalid");
              UUID grant =
                  identities.admitGrant(
                      account.id(), "helm-mcp", UUID.randomUUID().toString(), List.copyOf(SCOPES));
              return new AuthenticatedActor(
                  account.id(),
                  null,
                  grant,
                  "helm-mcp",
                  account.displayName(),
                  account.email(),
                  account.accessEpoch(),
                  SCOPES,
                  true);
            }));
  }

  private AuthenticatedActor withClient(AuthenticatedActor actor, String client) {
    UUID grant =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    identities.admitGrant(
                        actor.userId(),
                        client,
                        UUID.randomUUID().toString(),
                        List.copyOf(SCOPES))));
    return new AuthenticatedActor(
        actor.userId(),
        actor.loginId(),
        grant,
        client,
        actor.displayName(),
        actor.email(),
        actor.accessEpoch(),
        actor.permissions(),
        actor.mcp());
  }

  private UUID create(AuthenticatedActor actor) {
    return tasks
        .create(
            actor,
            new TaskContracts.Create(
                "Collect confirmed values", null, List.of(), "TABLE", false, 1800, "PREPARE"),
            context(),
            null)
        .resource()
        .id();
  }

  private ResultContracts.Publish publication(
      AuthenticatedActor actor, UUID task, UUID claim, List<UUID> files) {
    var view = tasks.get(actor, task);
    return new ResultContracts.Publish(
        view.version(),
        view.instructionRevision(),
        claim,
        "Two confirmed values",
        List.of("Public source only"),
        List.of("Private fields"),
        List.of(new ResultContracts.Column("amount", "Amount", "NUMBER")),
        List.of(Map.of("amount", 1), Map.of("amount", 2)),
        Map.of("complete", false),
        files,
        List.of(new ResultContracts.Section("Evidence", "Observed values")),
        List.of(new ResultContracts.Source("Public source", "https://example.com")));
  }

  private TaskContracts.Completion completion(
      AuthenticatedActor actor,
      UUID task,
      MutationReceipt publication,
      UUID claim,
      String outcome) {
    var view = tasks.get(actor, task);
    return new TaskContracts.Completion(
        view.version(),
        view.instructionRevision(),
        publication.resource().id(),
        claim,
        publication.resource().version(),
        outcome);
  }

  private long resultCount(UUID task) {
    return count("SELECT count(*) FROM task_results WHERE task_id=:id", task);
  }

  private long finalCount(UUID task) {
    return count("SELECT count(*) FROM task_results WHERE task_id=:id AND final", task);
  }

  private long outboxCount(AuthenticatedActor actor) {
    return count("SELECT count(*) FROM transactional_outbox WHERE user_id=:id", actor.userId());
  }

  private long count(String sql, UUID id) {
    return count(sql, "id", id);
  }

  private long count(String sql, String parameter, Object value) {
    return jdbc.sql(sql).param(parameter, value).query(Long.class).single();
  }

  private static void assertCode(Runnable action, String code) {
    assertThatThrownBy(action::run)
        .isInstanceOf(DomainException.class)
        .extracting("code")
        .isEqualTo(code);
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
