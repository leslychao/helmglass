package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import com.helmglass.task.infrastructure.repository.JpaTaskRepository;
import com.helmglass.task.infrastructure.repository.TaskQueries;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;

@SpringJUnitConfig(TaskLifecycleIntegrationTest.DatabaseConfiguration.class)
class TaskEventHistoryIntegrationTest {
  private final TaskLifecycleService tasks;
  private final TaskQueries queries;
  private final JpaTaskRepository repository;
  private final IdentityRepository identities;
  private final JdbcClient jdbc;
  private final TransactionTemplate transaction;
  private final JsonSupport json;
  private final ChangeRepository changes;
  private final ContinuationRepository continuations;

  @Autowired
  TaskEventHistoryIntegrationTest(
      TaskLifecycleService tasks,
      TaskQueries queries,
      JpaTaskRepository repository,
      IdentityRepository identities,
      JdbcClient jdbc,
      PlatformTransactionManager transactionManager,
      JsonSupport json,
      ChangeRepository changes,
      ContinuationRepository continuations) {
    this.tasks = tasks;
    this.queries = queries;
    this.repository = repository;
    this.identities = identities;
    this.jdbc = jdbc;
    transaction = new TransactionTemplate(transactionManager);
    this.json = json;
    this.changes = changes;
    this.continuations = continuations;
  }

  @Test
  void tenThousandEventSnapshotKeepsEveryRowOnceWhileNewEventsAppend() {
    var actor = actor();
    UUID taskId = task(actor);
    jdbc.sql(
            """
            INSERT INTO task_execution_events(task_id,sequence,event_id,type,code,summary)
            SELECT :task,n,gen_random_uuid(),
              CASE n%3 WHEN 0 THEN 'AGENT' WHEN 1 THEN 'BROWSER' ELSE 'SYSTEM' END,
              'SAFE_EVENT','Safe step ' || n FROM generate_series(2,10001) AS n
            """)
        .param("task", taskId)
        .update();
    jdbc.sql(
            """
            UPDATE task_event_counters SET next_sequence=10002,event_count=10001 WHERE task_id=:task
            """)
        .param("task", taskId)
        .update();
    var first = tasks.events(actor, taskId, query(1, null));
    assertThat(first.total()).isEqualTo(10001);
    var seen = new HashSet<Long>();
    first.items().forEach(row -> seen.add(((Number) row.get("sequence")).longValue()));
    append(taskId, "BROWSER", "Browser closed");
    var second = tasks.events(actor, taskId, query(2, first.snapshot()));
    assertThat(second.items().getFirst().get("sequence")).isEqualTo(9991L);
    second
        .items()
        .forEach(row -> assertThat(seen.add(((Number) row.get("sequence")).longValue())).isTrue());
    for (int page = 3; page <= 1001; page++) {
      var result = tasks.events(actor, taskId, query(page, first.snapshot()));
      assertThat(result.total()).isEqualTo(10001);
      assertThat(result.snapshot()).isEqualTo(first.snapshot());
      result
          .items()
          .forEach(
              row -> assertThat(seen.add(((Number) row.get("sequence")).longValue())).isTrue());
    }
    assertThat(seen).hasSize(10001).contains(1L, 10001L).doesNotContain(10002L);
    var fresh = tasks.events(actor, taskId, query(1, null));
    assertThat(fresh.total()).isEqualTo(10002);
    assertThat(fresh.items().getFirst().get("sequence")).isEqualTo(10002L);
    assertThat(first.meta().snapshotSequence()).isEqualTo(10001);
    assertThat(fresh.meta().snapshotSequence()).isEqualTo(10002);
  }

  @Test
  void typeTextAndSequenceSortApplyToTheSameBoundedPageAndExactTotal() {
    var actor = actor();
    UUID taskId = task(actor);
    for (int index = 0; index < 12; index++) {
      append(taskId, "BROWSER", "Check 100%_literal");
      append(taskId, "AGENT", "Check 100%_literal");
      append(taskId, "SYSTEM", "Check 100%_literal");
    }
    append(taskId, "BROWSER", "Check 100xxliteral");
    var first =
        tasks.events(
            actor, taskId, filtered(1, null, List.of("SYSTEM", "BROWSER"), "100%_literal", "asc"));
    assertThat(first.total()).isEqualTo(24);
    assertThat(first.items())
        .hasSize(10)
        .allSatisfy(
            row -> {
              assertThat(row.get("type")).isIn("BROWSER", "SYSTEM");
              assertThat(row.get("summary")).isEqualTo("Check 100%_literal");
            });
    assertThat(first.items().getFirst().get("sequence")).isEqualTo(2L);
    append(taskId, "BROWSER", "Check 100%_literal");
    // Type order is not a different filter; explicit defaults and omitted defaults are equivalent.
    var second =
        tasks.events(
            actor,
            taskId,
            filtered(2, first.snapshot(), List.of("BROWSER", "SYSTEM"), "100%_literal", "asc"));
    assertThat(second.total()).isEqualTo(24);
    assertThat(second.items().getFirst().get("sequence")).isEqualTo(17L);
    assertThat(
            tasks
                .events(
                    actor,
                    taskId,
                    filtered(
                        3, first.snapshot(), List.of("SYSTEM", "BROWSER"), "100%_literal", "asc"))
                .items())
        .hasSize(4);
    assertThat(
            tasks
                .events(actor, taskId, filtered(1, null, List.of("AGENT"), "absent", "desc"))
                .total())
        .isZero();
  }

  @Test
  void snapshotsCannotCrossUsersTasksFiltersOrSortAndCannotBeTamperedWith() {
    var actor = actor();
    UUID taskId = task(actor);
    var first = tasks.events(actor, taskId, query(1, null));
    assertCode(() -> tasks.events(actor(), taskId, query(1, first.snapshot())), "NOT_FOUND");
    UUID otherTask = task(actor);
    assertCode(
        () -> tasks.events(actor, otherTask, query(1, first.snapshot())), "LIST_SNAPSHOT_EXPIRED");
    assertCode(
        () ->
            tasks.events(
                actor, taskId, filtered(1, first.snapshot(), List.of("BROWSER"), "", "desc")),
        "LIST_SNAPSHOT_EXPIRED");
    assertCode(
        () ->
            tasks.events(
                actor,
                taskId,
                filtered(
                    1, first.snapshot(), List.of("AGENT", "BROWSER", "SYSTEM"), "changed", "desc")),
        "LIST_SNAPSHOT_EXPIRED");
    assertCode(
        () ->
            tasks.events(
                actor,
                taskId,
                filtered(1, first.snapshot(), List.of("AGENT", "BROWSER", "SYSTEM"), "", "asc")),
        "LIST_SNAPSHOT_EXPIRED");
    String token = first.snapshot();
    String tampered = token.substring(0, token.length() - 1) + (token.endsWith("A") ? "B" : "A");
    assertCode(() -> tasks.events(actor, taskId, query(1, tampered)), "LIST_SNAPSHOT_EXPIRED");
    assertCode(
        () -> tasks.events(actor, taskId, query(1, "a".repeat(513))), "LIST_SNAPSHOT_EXPIRED");
    var noReadScope =
        new AuthenticatedActor(
            actor.userId(),
            null,
            UUID.randomUUID(),
            "helm-mcp",
            actor.displayName(),
            actor.email(),
            actor.accessEpoch(),
            Set.of("tasks:write"),
            true);
    assertCode(() -> tasks.events(noReadScope, taskId, query(1, token)), "SCOPE_REQUIRED");
  }

  @Test
  void expiredAndDeletedSnapshotsRequireRefreshAndRepositoryRestartPreservesValidToken()
      throws Exception {
    var actor = actor();
    UUID taskId = task(actor);
    var first = tasks.events(actor, taskId, query(1, null));
    String[] parts = first.snapshot().split("\\.");
    String[] payload =
        new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8).split(":");
    payload[2] = Long.toString(Instant.now().minusSeconds(1).getEpochSecond());
    String expiredPayload =
        Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(String.join(":", payload).getBytes(StandardCharsets.UTF_8));
    String key =
        jdbc.sql("SELECT snapshot_key FROM task_event_counters WHERE task_id=:task")
            .param("task", taskId)
            .query(String.class)
            .single();
    Mac hmac = Mac.getInstance("HmacSHA256");
    hmac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    String expired =
        expiredPayload
            + "."
            + Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString(hmac.doFinal(expiredPayload.getBytes(StandardCharsets.US_ASCII)));
    assertCode(() -> tasks.events(actor, taskId, query(1, expired)), "LIST_SNAPSHOT_EXPIRED");
    // The repository has no process-local key or snapshot cache.
    var restarted = new TaskQueries(jdbc, changes, continuations, json);
    var reread =
        transaction.execute(
            status -> restarted.events(actor.userId(), taskId, query(1, first.snapshot())));
    assertThat(reread).isEqualTo(first);
    jdbc.sql("DELETE FROM task_execution_events WHERE task_id=:task")
        .param("task", taskId)
        .update();
    jdbc.sql("DELETE FROM task_event_counters WHERE task_id=:task").param("task", taskId).update();
    assertCode(
        () -> tasks.events(actor, taskId, query(1, first.snapshot())), "LIST_SNAPSHOT_EXPIRED");
  }

  @Test
  void invalidFiltersAndUnboundedPagesAreRejectedInsteadOfReturningPartialData() {
    var actor = actor();
    UUID taskId = task(actor);
    assertCode(() -> tasks.events(actor, taskId, query(2, null)), "EVENT_SNAPSHOT_REQUIRED");
    assertCode(
        () -> tasks.events(actor, taskId, filtered(1, null, List.of("PRIVATE"), "", "desc")),
        "INVALID_EVENT_FILTER");
    var parameters = new LinkedMultiValueMap<>(query(1, null).filters());
    parameters.set("pageSize", "100");
    assertCode(
        () -> tasks.events(actor, taskId, PageQuery.from(parameters)), "INVALID_EVENT_PAGINATION");
    parameters.set("pageSize", "10");
    parameters.set("sort", "occurredAt");
    assertCode(
        () -> tasks.events(actor, taskId, PageQuery.from(parameters)), "INVALID_EVENT_PAGINATION");
    parameters.set("sort", "sequence");
    parameters.set("page", "10002");
    assertCode(
        () -> tasks.events(actor, taskId, PageQuery.from(parameters)), "INVALID_EVENT_PAGINATION");
    parameters.set("page", "1");
    parameters.set("q", "x".repeat(201));
    assertCode(() -> PageQuery.from(parameters), "INVALID_PAGE");
  }

  @Test
  void eventAndSafeInvalidationCommitTogetherAndRollbackDoesNotConsumeSequence() {
    var actor = actor();
    UUID taskId = task(actor);
    var before = tasks.events(actor, taskId, query(1, null));
    long intents = countIntents(taskId);
    transaction.executeWithoutResult(
        status -> {
          queries.event(
              repository.findById(taskId).orElseThrow(), "SYSTEM", "SAFE_EVENT", "Browser closed");
          status.setRollbackOnly();
        });
    assertThat(tasks.events(actor, taskId, query(1, null)).total()).isEqualTo(before.total());
    assertThat(countIntents(taskId)).isEqualTo(intents);
    append(taskId, "BROWSER", "Browser closed");
    var after = tasks.events(actor, taskId, query(1, null));
    assertThat(after.meta().snapshotSequence()).isEqualTo(before.meta().snapshotSequence() + 1);
    assertThat(countIntents(taskId)).isEqualTo(intents + 1);
    String payload =
        jdbc.sql(
                """
                SELECT payload::text FROM transactional_outbox
                WHERE aggregate_id=:task AND event_type='events' ORDER BY aggregate_version DESC LIMIT 1
                """)
            .param("task", taskId)
            .query(String.class)
            .single();
    assertThat(json.map(payload))
        .containsOnlyKeys("resources", "resourceId")
        .containsEntry("resources", List.of("events"))
        .containsEntry("resourceId", taskId.toString());
    assertThat(payload)
        .doesNotContain("Private goal", "Browser closed", "snapshot_key", "cookie", "clipboard");
  }

  @Test
  void snapshotDoesNotAdmitAnEventWhoseCounterIncrementHasNotCommitted() throws Exception {
    var actor = actor();
    UUID taskId = task(actor);
    var written = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      var pending =
          executor.submit(
              () ->
                  transaction.executeWithoutResult(
                      status -> {
                        queries.event(
                            repository.findById(taskId).orElseThrow(),
                            "BROWSER",
                            "SAFE_EVENT",
                            "Browser closed");
                        written.countDown();
                        await(release);
                      }));
      try {
        assertThat(written.await(5, TimeUnit.SECONDS)).isTrue();
        var during = tasks.events(actor, taskId, query(1, null));
        assertThat(during.meta().snapshotSequence()).isEqualTo(1);
        assertThat(during.total()).isEqualTo(1);
        release.countDown();
        pending.get(10, TimeUnit.SECONDS);
        assertThat(tasks.events(actor, taskId, query(1, during.snapshot())).total()).isEqualTo(1);
        assertThat(tasks.events(actor, taskId, query(1, null)).total()).isEqualTo(2);
      } finally {
        release.countDown();
      }
    }
  }

  @Test
  void databaseQueryTimeoutIsAnExplicitErrorNotAnEmptyHistory() throws Exception {
    var actor = actor();
    UUID taskId = task(actor);
    var locked = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      var pending =
          executor.submit(
              () ->
                  transaction.executeWithoutResult(
                      status -> {
                        jdbc.sql("LOCK TABLE task_execution_events IN ACCESS EXCLUSIVE MODE")
                            .update();
                        locked.countDown();
                        await(release);
                      }));
      try {
        assertThat(locked.await(5, TimeUnit.SECONDS)).isTrue();
        assertCode(
            () -> tasks.events(actor, taskId, query(1, null)), "EVENT_HISTORY_QUERY_TIMEOUT");
      } finally {
        release.countDown();
      }
      pending.get(10, TimeUnit.SECONDS);
    }
    assertThat(tasks.events(actor, taskId, query(1, null)).total()).isEqualTo(1);
  }

  private long countIntents(UUID taskId) {
    return jdbc.sql(
            "SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:task AND"
                + " event_type='events'")
        .param("task", taskId)
        .query(Long.class)
        .single();
  }

  private static void await(CountDownLatch latch) {
    try {
      if (!latch.await(10, TimeUnit.SECONDS)) {
        throw new IllegalStateException("Fixture synchronization timed out");
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Fixture interrupted", error);
    }
  }

  private static void assertCode(Runnable action, String code) {
    assertThatThrownBy(action::run)
        .isInstanceOfSatisfying(
            DomainException.class, error -> assertThat(error.getCode()).isEqualTo(code));
  }

  private static PageQuery filtered(
      int page, String snapshot, List<String> types, String text, String direction) {
    var values = new LinkedMultiValueMap<>(query(page, snapshot).filters());
    values.put("type", types);
    values.set("q", text);
    values.set("direction", direction);
    return PageQuery.from(values);
  }

  private void append(UUID taskId, String type, String summary) {
    transaction.executeWithoutResult(
        status ->
            queries.event(repository.findById(taskId).orElseThrow(), type, "SAFE_EVENT", summary));
  }

  private UUID task(AuthenticatedActor actor) {
    return tasks
        .create(
            actor,
            new TaskContracts.Create(
                "Private goal is not an event payload",
                null,
                List.of(),
                "TEXT",
                true,
                1800,
                "DRAFT"),
            new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID()),
            null)
        .resource()
        .id();
  }

  private AuthenticatedActor actor() {
    var account =
        transaction.execute(
            status ->
                identities.resolve(
                    "https://issuer.example",
                    UUID.randomUUID().toString(),
                    "History owner",
                    "history@example.test"));
    if (account == null) {
      throw new IllegalStateException("Account transaction returned no result");
    }
    return new AuthenticatedActor(
        account.id(),
        UUID.randomUUID(),
        null,
        "helm-web",
        account.displayName(),
        account.email(),
        account.accessEpoch(),
        Set.of(),
        false);
  }

  private static PageQuery query(int page, String snapshot) {
    var values = new LinkedMultiValueMap<String, String>();
    values.set("page", Integer.toString(page));
    values.set("pageSize", "10");
    values.set("sort", "sequence");
    values.set("direction", "desc");
    if (snapshot != null) {
      values.set("snapshot", snapshot);
    }
    return PageQuery.from(values);
  }
}
