package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;

import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import com.helmglass.usage.application.UsageCheckpointService;
import com.helmglass.usage.application.UsageProjectionService;
import com.helmglass.usage.application.UsageService;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import tools.jackson.databind.JsonNode;

@SpringJUnitConfig(TaskUsageProjectionIntegrationTest.Owners.class)
class TaskUsageProjectionIntegrationTest {
  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    UsageService.class,
    UsageCheckpointService.class
  })
  static class Owners {}

  private final JdbcClient jdbc;
  private final IdentityRepository identities;
  private final TaskLifecycleService tasks;
  private final UsageCheckpointService checkpoints;
  private final UsageProjectionService projections;
  private final UsageService usage;
  private final JsonSupport json;
  private final TransactionTemplate transaction;

  @Autowired
  TaskUsageProjectionIntegrationTest(
      JdbcClient jdbc,
      IdentityRepository identities,
      TaskLifecycleService tasks,
      UsageCheckpointService checkpoints,
      UsageProjectionService projections,
      UsageService usage,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.jdbc = jdbc;
    this.identities = identities;
    this.tasks = tasks;
    this.checkpoints = checkpoints;
    this.projections = projections;
    this.usage = usage;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void listAndDetailUseLedgerValuesAndSortUnknownLastWithoutLosingKnownZero() {
    var actor = actor();
    UUID measured = task(actor);
    UUID zero = task(actor);
    UUID unknown = task(actor);
    task(actor());
    Source first = source(actor, measured);
    checkpoint(first, 1, 10_000, 2500, 1000, 1500, true);
    checkpoint(source(actor, zero), 1, 1000, 0, 0, 0, true);

    var detail = tree(tasks.get(actor, measured).usage());
    assertThat(detail.path("browserSeconds").decimalValue()).isEqualByComparingTo("10");
    assertThat(detail.path("activeSeconds").decimalValue()).isEqualByComparingTo("2.5");
    assertThat(detail.path("humanSeconds").decimalValue()).isEqualByComparingTo("1.5");
    assertThat(detail.path("humanControlSeconds").decimalValue()).isEqualByComparingTo("1");
    assertThat(detail.path("mediaSeconds").isNull()).isTrue();
    assertThat(detail.path("mediaBytes").isNull()).isTrue();
    assertThat(detail.path("metrics"))
        .isEqualTo(tree(usage.task(actor, measured, page()).metrics()));

    var parameters = new LinkedMultiValueMap<String, String>();
    parameters.set("sort", "activeSeconds");
    parameters.set("direction", "desc");
    parameters.set("pageSize", "1");
    var firstPage = tasks.list(actor, PageQuery.from(parameters));
    assertThat(firstPage.total()).isEqualTo(3);
    assertThat(firstPage.items().getFirst().get("id")).isEqualTo(measured);
    assertThat(tree(firstPage.items().getFirst().get("usage"))).isEqualTo(detail);
    parameters.set("snapshot", firstPage.snapshot());
    parameters.set("page", "2");
    var second = tasks.list(actor, PageQuery.from(parameters)).items().getFirst();
    assertThat(second.get("id")).isEqualTo(zero);
    assertThat(tree(second.get("usage")).path("activeSeconds").decimalValue()).isZero();
    parameters.set("page", "3");
    assertThat(tasks.list(actor, PageQuery.from(parameters)).items().getFirst().get("id"))
        .isEqualTo(unknown);
  }

  @Test
  void projectionCanBeRebuiltAndNewSessionRetainsLowerBoundInsteadOfFalseCompleteness() {
    var actor = actor();
    UUID task = task(actor);
    checkpoint(source(actor, task), 1, 4000, 1000, 0, 0, true);
    var complete = tree(tasks.get(actor, task).usage());
    jdbc.sql("DELETE FROM task_usage_totals WHERE task_id=:task").param("task", task).update();
    assertThat(projections.rebuildMissing()).isPositive();
    assertThat(tree(tasks.get(actor, task).usage())).isEqualTo(complete);

    source(actor, task);
    transaction.executeWithoutResult(status -> projections.refresh(actor.userId(), task));
    var incomplete = tree(tasks.get(actor, task).usage());
    assertThat(incomplete.path("browserSeconds").isNull()).isTrue();
    assertThat(incomplete.path("metrics").path("browser_seconds").path("knownValue").decimalValue())
        .isEqualByComparingTo("4");
    assertThat(incomplete.path("metrics").path("browser_seconds").path("completeness").asString())
        .isEqualTo("PARTIAL");
    assertThat(
            jdbc.sql("SELECT source_watermark FROM task_usage_totals WHERE task_id=:task")
                .param("task", task)
                .query(Long.class)
                .single())
        .isEqualTo(4);
  }

  @Test
  void concurrentSourcesCommitBothMeasurementsToOneProjectionAndRollbackTogether() {
    var actor = actor();
    UUID task = task(actor);
    Source first = source(actor, task);
    Source second = source(actor, task);
    CompletableFuture.allOf(
            CompletableFuture.runAsync(() -> checkpoint(first, 1, 1000, 100, 0, 0, true)),
            CompletableFuture.runAsync(() -> checkpoint(second, 1, 2000, 200, 0, 0, true)))
        .join();
    assertThat(tree(tasks.get(actor, task).usage()).path("browserSeconds").decimalValue())
        .isEqualByComparingTo("3");
    var before = tree(tasks.get(actor, task).usage());
    transaction.executeWithoutResult(
        status -> {
          Source pending = source(actor, task);
          checkpoint(pending, 1, 4000, 100, 0, 0, true);
          status.setRollbackOnly();
        });
    assertThat(tree(tasks.get(actor, task).usage())).isEqualTo(before);
  }

  private AuthenticatedActor actor() {
    var account =
        transaction.execute(
            status ->
                identities.resolve(
                    "https://issuer.example",
                    UUID.randomUUID().toString(),
                    "Task usage",
                    "usage@example.test"));
    Objects.requireNonNull(account);
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

  private UUID task(AuthenticatedActor actor) {
    return tasks
        .create(
            actor,
            new TaskContracts.Create(
                "Measure task", null, List.of(), "TEXT", false, 1800, "PREPARE"),
            new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID()),
            null)
        .resource()
        .id();
  }

  private record Source(UUID worker, UUID boot, UUID session, Instant started) {}

  private Source source(AuthenticatedActor actor, UUID task) {
    Source source =
        new Source(
            UUID.randomUUID(),
            UUID.randomUUID(),
            UUID.randomUUID(),
            Instant.now().minusSeconds(20).truncatedTo(ChronoUnit.MILLIS));
    jdbc.sql(
            "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                + " VALUES(:id,:boot,1,'fixture')")
        .param("id", source.worker())
        .param("boot", source.boot())
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_id,worker_boot_id,purpose,state,
              requested_at,ready_at,closed_at,binding_released_at,idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:task,:worker,:boot,'TASK','CLOSED',:started,:started,now(),now(),now(),now())
            """)
        .param("id", source.session())
        .param("user", actor.userId())
        .param("task", task)
        .param("worker", source.worker())
        .param("boot", source.boot())
        .param("started", Timestamp.from(source.started()))
        .update();
    return source;
  }

  private void checkpoint(
      Source source,
      int sequence,
      long browser,
      long execution,
      long human,
      long login,
      boolean complete) {
    Map<String, Object> value = new HashMap<>();
    value.put("sourceId", source.boot() + ":" + source.session());
    value.put("sourceSequence", sequence);
    value.put("sourceStartedAt", source.started().toString());
    value.put("browserMs", browser);
    value.put("executionMs", execution);
    value.put("humanMs", human);
    value.put("loginMs", login);
    value.put("browserComplete", complete);
    checkpoints.record(source.worker(), source.boot(), source.session(), tree(value));
  }

  private JsonNode tree(Object value) {
    return json.read(json.write(value));
  }

  private static PageQuery page() {
    return PageQuery.from(new LinkedMultiValueMap<>());
  }
}
