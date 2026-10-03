package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.api.ResultContracts;
import com.helmglass.task.application.ResultService;
import com.helmglass.task.infrastructure.repository.ResultRepository;
import com.helmglass.usage.api.UsageContracts;
import com.helmglass.usage.api.UsageContracts.StateGroup;
import com.helmglass.usage.application.UsageCheckpointService;
import com.helmglass.usage.application.UsagePeriod;
import com.helmglass.usage.application.UsageService;
import com.helmglass.usage.infrastructure.repository.UsageRepository;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;

@SpringJUnitConfig(UsageResultIntegrationTest.Owners.class)
class UsageResultIntegrationTest {
  private static final Instant FROM = Instant.parse("2026-01-01T00:00:00Z");
  private static final Instant TO = Instant.parse("2026-01-05T00:00:00Z");
  private static final UsagePeriod PERIOD =
      new UsagePeriod(FROM, TO, "Europe/Saratov", List.of(), List.of(), false);

  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    UsageRepository.class,
    UsageService.class,
    UsageCheckpointService.class,
    ResultService.class,
    ResultRepository.class
  })
  static class Owners {}

  private final JdbcClient jdbc;
  private final IdentityRepository identities;
  private final UsageService usage;
  private final UsageCheckpointService checkpoints;
  private final ResultService results;
  private final ChangeRepository changes;
  private final JsonSupport json;
  private final TransactionTemplate transaction;

  @Autowired
  UsageResultIntegrationTest(
      JdbcClient jdbc,
      IdentityRepository identities,
      UsageService usage,
      ResultService results,
      ChangeRepository changes,
      JsonSupport json,
      PlatformTransactionManager transactions,
      UsageCheckpointService checkpoints) {
    this.jdbc = jdbc;
    this.identities = identities;
    this.usage = usage;
    this.checkpoints = checkpoints;
    this.results = results;
    this.changes = changes;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void calendarIncludesStandaloneSessionsAndUsesMeasuredTimeAcrossDaylightSavingBoundary() {
    var user = actor();
    var admin =
        new AuthenticatedActor(
            user.userId(),
            user.loginId(),
            null,
            user.clientId(),
            user.displayName(),
            user.email(),
            user.accessEpoch(),
            Set.of("platform_admin"),
            false);
    Instant from = Instant.parse("2026-03-28T23:00:00Z");
    Instant middle = Instant.parse("2026-03-29T22:00:00Z");
    Instant to = Instant.parse("2026-03-30T22:00:00Z");
    var period = new UsagePeriod(from, to, "Europe/Berlin", List.of(), List.of(), false);
    calendarSession(user, from, middle, 82_800_000, true);
    UUID oldTask = task(user, null, "COMPLETED", "SUCCESS", "2026-01-01T00:00:00Z");
    jdbc.sql(
            """
            INSERT INTO task_commands(id,task_id,user_id,command_sequence,kind,payload,payload_hash,
              accepted_task_version,instruction_revision,deadline,state,accepted_at)
            VALUES(:id,:task,:user,1,'OBSERVE','{}',repeat('a',64),1,1,:at,'SUCCEEDED',:at)
            """)
        .param("id", UUID.randomUUID())
        .param("task", oldTask)
        .param("user", user.userId())
        .param("at", Timestamp.from(from.plusSeconds(100)))
        .update();
    assertThat(usage.summary(user, period).taskCount()).isZero();
    assertThatThrownBy(() -> usage.calendar(user, user.userId(), period))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Administrator");
    var complete = usage.calendar(admin, user.userId(), period);
    assertThat(complete.scope()).isEqualTo("USER_CALENDAR");
    assertThat(complete.metrics().get("browser_seconds").value()).isEqualByComparingTo("82800");
    assertThat(complete.metrics().get("command_count").value()).isEqualByComparingTo("1");
    assertThat(complete.daily()).hasSize(2);
    assertThat(complete.daily().getFirst().date()).isEqualTo(LocalDate.of(2026, 3, 29));
    assertThat(complete.daily().getFirst().from()).isEqualTo(from);
    assertThat(complete.daily().getFirst().to()).isEqualTo(middle);
    assertThat(complete.daily().getLast().to()).isEqualTo(to);
    assertThat(complete.daily().getLast().metrics().get("browser_seconds").value())
        .isEqualByComparingTo("0");
    Instant future = Instant.now().plusSeconds(3600);
    var unelapsed =
        usage.calendar(
            admin,
            user.userId(),
            new UsagePeriod(
                future, future.plusSeconds(3600), "Europe/Berlin", List.of(), List.of(), false));
    assertThat(unelapsed.daily()).isEmpty();
    assertThat(unelapsed.metrics().get("browser_seconds").knownValue()).isNull();

    calendarSession(user, middle.plusSeconds(100), middle.plusSeconds(200), 3000, false);
    var partial = usage.calendar(admin, user.userId(), period);
    assertThat(partial.metrics().get("browser_seconds").value()).isNull();
    assertThat(partial.metrics().get("browser_seconds").knownValue()).isEqualByComparingTo("82803");
    assertThat(partial.daily().getFirst().metrics().get("browser_seconds").completeness())
        .isEqualTo("COMPLETE");
    assertThat(partial.daily().getLast().metrics().get("browser_seconds").completeness())
        .isEqualTo("PARTIAL");
    assertThat(
            usage
                .calendar(admin, actor().userId(), period)
                .metrics()
                .get("browser_seconds")
                .value())
        .isEqualByComparingTo("0");
    jdbc.sql("UPDATE application_users SET state='DELETED' WHERE id=:id")
        .param("id", user.userId())
        .update();
    assertThat(
            usage
                .calendar(admin, user.userId(), period)
                .metrics()
                .get("browser_seconds")
                .knownValue())
        .isNull();
  }

  private void calendarSession(
      AuthenticatedActor actor, Instant start, Instant close, long knownMs, boolean complete) {
    UUID session = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,worker_boot_id,purpose,state,requested_at,ready_at,
              closed_at,binding_released_at,idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:boot,'LOGIN','CLOSED',:start,:start,:close,:close,:close,:close)
            """)
        .param("id", session)
        .param("user", actor.userId())
        .param("boot", boot)
        .param("start", Timestamp.from(start))
        .param("close", Timestamp.from(close))
        .update();
    jdbc.sql(
            """
            INSERT INTO session_usage_checkpoints(session_id,worker_boot_id,source_sequence,browser_ms,
              execution_ms,human_ms,login_ms,browser_complete,source_started_at)
            VALUES(:id,:boot,1,:known,0,0,:known,:complete,:start)
            """)
        .param("id", session)
        .param("boot", boot)
        .param("known", knownMs)
        .param("complete", complete)
        .param("start", Timestamp.from(start))
        .update();
    jdbc.sql(
            """
            INSERT INTO usage_measurements(id,user_id,session_id,metric,value,unit,interval_start,
              interval_end,completeness,source_id,source_sequence)
            VALUES(:id,:user,:session,'browser_seconds',:known,'ms',:start,:end,'COMPLETE',:session,1)
            """)
        .param("id", UUID.randomUUID())
        .param("user", actor.userId())
        .param("session", session)
        .param("known", knownMs)
        .param("start", Timestamp.from(start))
        .param("end", Timestamp.from(start.plusMillis(knownMs)))
        .update();
  }

  @Test
  void reopenedBrowserUsesRemainingTaskBudgetAndRejectsUnconfirmedTail() {
    var actor = actor();
    UUID task = task(actor, null, "PAUSED", null, "2026-01-02T12:00:00Z");
    assertThat(usage.remainingBrowserSeconds(task)).isEqualTo(1800);
    UUID session = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_boot_id,purpose,state,ready_at,
              closed_at,binding_released_at,idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:task,:boot,'TASK','CLOSED',now()-interval '2 minutes',now(),now(),now(),now())
            """)
        .param("id", session)
        .param("user", actor.userId())
        .param("task", task)
        .param("boot", boot)
        .update();
    assertThatThrownBy(() -> usage.remainingBrowserSeconds(task))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("not confirmed");
    jdbc.sql(
            """
            INSERT INTO session_usage_checkpoints(session_id,worker_boot_id,source_sequence,browser_ms,
              execution_ms,human_ms,login_ms,browser_complete)
            VALUES(:id,:boot,1,100500,0,0,0,true)
            """)
        .param("id", session)
        .param("boot", boot)
        .update();
    assertThat(usage.remainingBrowserSeconds(task)).isEqualTo(1699);
    jdbc.sql("UPDATE session_usage_checkpoints SET browser_ms=1800000 WHERE session_id=:id")
        .param("id", session)
        .update();
    assertThatThrownBy(() -> usage.remainingBrowserSeconds(task))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("exhausted");
  }

  @Test
  void taskUsageEnforcesOwnershipAndReportsCompletePaginationWithoutInventingZero() {
    var actor = actor();
    UUID task = task(actor, null, "PAUSED", null, "2026-01-02T12:00:00Z");
    jdbc.sql(
            """
            INSERT INTO usage_measurements(id,user_id,task_id,metric,value,unit,interval_start,
              interval_end,completeness,source_id,source_sequence)
            SELECT gen_random_uuid(),:user,:task,'media_bytes',10,'byte',now(),now(),'COMPLETE',
              gen_random_uuid(),1 FROM generate_series(1,105)
            """)
        .param("user", actor.userId())
        .param("task", task)
        .update();
    var parameters = new LinkedMultiValueMap<String, String>();
    parameters.set("pageSize", "100");
    var first = usage.task(actor, task, PageQuery.from(parameters));
    assertThat(first.taskId()).isEqualTo(task);
    assertThat(first.measurements().total()).isEqualTo(105);
    assertThat(first.measurements().items()).hasSize(100);
    assertThat(first.metrics().get("media_bytes").value()).isEqualByComparingTo("1050");
    assertThat(first.metrics().get("browser_seconds").value()).isNull();
    parameters.set("page", "2");
    parameters.set("snapshot", first.measurements().snapshot());
    assertThat(usage.task(actor, task, PageQuery.from(parameters)).measurements().items())
        .hasSize(5);
    assertThatThrownBy(() -> usage.task(actor(), task, PageQuery.from(parameters)))
        .isInstanceOf(DomainException.class);
    UUID anotherTask = task(actor, null, "PAUSED", null, "2026-01-02T12:00:00Z");
    assertThatThrownBy(() -> usage.task(actor, anotherTask, PageQuery.from(parameters)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Refresh");
  }

  @Test
  void repeatedCheckpointIsIdempotentButChangedReceiptAndMissingCompletenessAreRejected() {
    var actor = actor();
    UUID task = task(actor, null, "RUNNING", null, "2026-01-02T12:00:00Z");
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    UUID session = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO browser_workers(id,boot_id,capacity,image_version) VALUES(:id,:boot,1,'fixture')
            """)
        .param("id", worker)
        .param("boot", boot)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_id,worker_boot_id,purpose,state,
              idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:task,:worker,:boot,'TASK','ACTIVE',now()+interval '1 hour',
              now()+interval '1 hour')
            """)
        .param("id", session)
        .param("user", actor.userId())
        .param("task", task)
        .param("worker", worker)
        .param("boot", boot)
        .update();
    Map<String, Object> checkpoint =
        new HashMap<>(
            Map.of(
                "sourceId",
                boot + ":" + session,
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
    checkpoint.put(
        "sourceStartedAt", Instant.now().minusSeconds(2).truncatedTo(ChronoUnit.MILLIS).toString());
    checkpoints.record(worker, boot, session, json.read(json.write(checkpoint)));
    var first = usage.sites(actor, PERIOD, PageQuery.from(queryParameters()));
    checkpoints.record(worker, boot, session, json.read(json.write(checkpoint)));
    var parameters = queryParameters();
    parameters.set("snapshot", first.snapshot());
    assertThat(usage.sites(actor, PERIOD, PageQuery.from(parameters)).snapshot())
        .isEqualTo(first.snapshot());
    checkpoint.put("browserMs", 2000);
    assertThatThrownBy(
            () -> checkpoints.record(worker, boot, session, json.read(json.write(checkpoint))))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("same usage sequence");
    checkpoint.put("sourceSequence", 2);
    checkpoint.remove("browserComplete");
    assertThatThrownBy(
            () -> checkpoints.record(worker, boot, session, json.read(json.write(checkpoint))))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("completeness");
    var metric = usage.summary(actor, PERIOD).metrics().get("browser_seconds");
    assertThat(metric.knownValue()).isEqualByComparingTo("1.5");
    assertThat(metric.value()).isNull();
    assertThat(
            jdbc.sql("SELECT count(*) FROM usage_measurements WHERE session_id=:id")
                .param("id", session)
                .query(Long.class)
                .single())
        .isEqualTo(4);

    checkpoint.put("browserComplete", true);
    checkpoint.put("humanMs", 900);
    assertThatThrownBy(
            () -> checkpoints.record(worker, boot, session, json.read(json.write(checkpoint))))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("deltas");
    checkpoint.put("humanMs", 0);
    checkpoints.record(worker, boot, session, json.read(json.write(checkpoint)));
    checkpoints.record(worker, boot, session, json.read(json.write(checkpoint)));
    var deltas =
        jdbc.sql(
                """
                SELECT value,interval_start,interval_end FROM usage_measurements
                WHERE session_id=:id AND metric='browser_seconds' ORDER BY source_sequence
                """)
            .param("id", session)
            .query()
            .listOfRows();
    assertThat(deltas).hasSize(2);
    assertThat(deltas.getFirst().get("value")).isEqualTo(1500L);
    assertThat(deltas.getLast().get("value")).isEqualTo(500L);
    assertThat(deltas.getLast().get("interval_start"))
        .isEqualTo(deltas.getFirst().get("interval_end"));
    assertThat(usage.summary(actor, PERIOD).metrics().get("browser_seconds").value())
        .isEqualByComparingTo("2");
    assertThat(usage.summary(actor, PERIOD).metrics().get("human_control_seconds").value())
        .isEqualByComparingTo("0");
    checkpoint.put("sourceSequence", 3);
    checkpoint.put(
        "sourceStartedAt",
        Instant.parse((String) checkpoint.get("sourceStartedAt")).plusMillis(1).toString());
    assertThatThrownBy(
            () -> checkpoints.record(worker, boot, session, json.read(json.write(checkpoint))))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("clock cannot change");
  }

  @Test
  void stateGroupsSeparateCompletedOutcomesAndCountEveryCohortTaskOnce() {
    var actor = actor();
    String createdAt = "2026-01-02T12:00:00Z";
    task(actor, null, "COMPLETED", "SUCCESS", createdAt);
    task(actor, null, "COMPLETED", "SUCCESS", createdAt);
    task(actor, null, "COMPLETED", "PARTIAL", createdAt);
    task(actor, null, "COMPLETED", "NOT_ACHIEVED", createdAt);
    task(actor, null, "COMPLETED", null, createdAt);
    task(actor, null, "FAILED", null, createdAt);
    task(actor, null, "INTERRUPTED", null, createdAt);
    task(actor, null, "CANCELLED", null, createdAt);
    for (String state :
        List.of(
            "WAITING_AGENT",
            "QUEUED",
            "STARTING",
            "RUNNING",
            "PAUSING",
            "PAUSED",
            "WAITING_USER",
            "STOPPING")) {
      task(actor, null, state, null, createdAt);
    }
    task(actor, null, "DRAFT", null, createdAt);
    task(actor, null, "COMPLETED", "SUCCESS", "2025-12-31T12:00:00Z");
    task(actor(), null, "COMPLETED", "SUCCESS", createdAt);

    var summary = usage.summary(actor, PERIOD);
    assertThat(summary.states())
        .extracting(UsageContracts.StateCount::state)
        .containsExactly(
            StateGroup.SUCCESS,
            StateGroup.ACTIVE,
            StateGroup.PARTIAL,
            StateGroup.NOT_ACHIEVED,
            StateGroup.ERROR,
            StateGroup.CANCELLED);
    assertThat(summary.states())
        .extracting(UsageContracts.StateCount::count)
        .containsExactly(2L, 8L, 1L, 2L, 2L, 1L);
    assertThat(summary.taskCount()).isEqualTo(16);
    assertThat(summary.states().stream().mapToLong(UsageContracts.StateCount::count).sum())
        .isEqualTo(summary.taskCount());
    assertThat(summary.terminalCount()).isEqualTo(7);
    assertThat(summary.successfulCount()).isEqualTo(2);
    assertThat(summary.successRate()).isEqualTo(2.0 / 7);

    var completed =
        new UsagePeriod(FROM, TO, PERIOD.timezone(), List.of("COMPLETED"), List.of(), false);
    var filtered = usage.summary(actor, completed);
    assertThat(filtered.taskCount()).isEqualTo(5);
    assertThat(filtered.states())
        .extracting(UsageContracts.StateCount::count)
        .containsExactly(2L, 0L, 1L, 2L, 0L, 0L);
    assertThat(filtered.successRate()).isEqualTo(0.4);
  }

  @Test
  void cohortCountsAndDatesUseCreationTimeAndDoNotInventMissingMeasurements() {
    var actor = actor();
    UUID site = site();
    UUID first = task(actor, site, "COMPLETED", "SUCCESS", "2026-01-01T22:00:00Z");
    task(actor, site, "FAILED", null, "2026-01-02T22:00:00Z");
    task(actor, null, "COMPLETED", "PARTIAL", "2026-01-03T12:00:00Z");
    task(actor, null, "INTERRUPTED", null, "2026-01-03T13:00:00Z");
    task(actor, null, "CANCELLED", null, "2026-01-03T14:00:00Z");
    task(actor, site, "DRAFT", null, "2026-01-02T12:00:00Z");
    task(actor, site, "COMPLETED", "SUCCESS", "2025-12-31T12:00:00Z");
    task(actor(), site, "COMPLETED", "SUCCESS", "2026-01-02T12:00:00Z");
    measurement(actor, first, "media_bytes", 1200);

    var summary = usage.summary(actor, PERIOD);
    assertThat(summary.taskCount()).isEqualTo(5);
    assertThat(summary.terminalCount()).isEqualTo(4);
    assertThat(summary.successfulCount()).isEqualTo(1);
    assertThat(summary.successRate()).isEqualTo(0.25);
    assertThat(summary.daily())
        .extracting(UsageContracts.Daily::date)
        .containsExactly(LocalDate.of(2026, 1, 2), LocalDate.of(2026, 1, 3));
    assertThat(summary.daily()).extracting(UsageContracts.Daily::taskCount).containsExactly(1L, 4L);
    assertThat(summary.states())
        .extracting(UsageContracts.StateCount::count)
        .containsExactly(1L, 0L, 1L, 0L, 2L, 1L);
    var media = summary.metrics().get("media_bytes");
    assertThat(media.value()).isNull();
    assertThat(media.knownValue()).isEqualByComparingTo("1200");
    assertThat(media.completeness()).isEqualTo("PARTIAL");
    assertThat(media.measuredCount()).isEqualTo(1);
    assertThat(media.expectedCount()).isEqualTo(5);
    assertThat(summary.metrics().get("active_agent_seconds").value()).isNull();
    assertThat(summary.metrics().get("command_count").value()).isEqualByComparingTo("0");
  }

  @Test
  void siteGroupsArePagedFilteredAndNeverDuplicateStartingSites() {
    var actor = actor();
    UUID site = site();
    task(actor, site, "COMPLETED", "SUCCESS", "2026-01-02T12:00:00Z");
    task(actor, site, "FAILED", null, "2026-01-02T12:00:00Z");
    task(actor, null, "INTERRUPTED", null, "2026-01-02T12:00:00Z");
    var parameters = queryParameters();
    parameters.set("pageSize", "1");
    parameters.set("sort", "taskCount");
    parameters.set("direction", "desc");
    var first = usage.sites(actor, PERIOD, PageQuery.from(parameters));
    assertThat(first.total()).isEqualTo(2);
    assertThat(first.items()).hasSize(1);
    assertThat(first.items().getFirst().id()).isEqualTo(site);
    assertThat(first.items().getFirst().taskCount()).isEqualTo(2);
    parameters.set("page", "2");
    parameters.set("snapshot", first.snapshot());
    var second = usage.sites(actor, PERIOD, PageQuery.from(parameters));
    assertThat(second.items().getFirst().id()).isNull();
    assertThat(second.items().getFirst().host()).isNull();
    assertThat(second.items().getFirst().successRate()).isNull();

    var unknown = new UsagePeriod(FROM, TO, "UTC", List.of(), List.of(), true);
    assertThat(usage.summary(actor, unknown).taskCount()).isEqualTo(1);
    var failed = new UsagePeriod(FROM, TO, "UTC", List.of("FAILED"), List.of(site), false);
    assertThat(usage.summary(actor, failed).taskCount()).isEqualTo(1);
    transaction.executeWithoutResult(status -> changes.changed(actor.userId(), "tasks", site, 2));
    assertThatThrownBy(() -> usage.sites(actor, PERIOD, PageQuery.from(parameters)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Refresh");
  }

  @Test
  void emptyUsageAndInvalidQueriesHaveExplicitSemantics() {
    var actor = actor();
    var empty = usage.summary(actor, PERIOD);
    assertThat(empty.taskCount()).isZero();
    assertThat(empty.successRate()).isNull();
    assertThat(empty.daily()).isEmpty();
    assertThat(empty.states())
        .extracting(UsageContracts.StateCount::state)
        .containsExactly(
            StateGroup.SUCCESS,
            StateGroup.ACTIVE,
            StateGroup.PARTIAL,
            StateGroup.NOT_ACHIEVED,
            StateGroup.ERROR,
            StateGroup.CANCELLED);
    assertThat(empty.states())
        .extracting(UsageContracts.StateCount::count)
        .containsExactly(0L, 0L, 0L, 0L, 0L, 0L);
    assertThat(empty.metrics().get("browser_seconds").completeness()).isEqualTo("UNKNOWN");
    assertThat(usage.sites(actor, PERIOD, PageQuery.from(queryParameters())).total()).isZero();
    assertThatThrownBy(() -> new UsagePeriod(FROM, TO, "not-a-zone", List.of(), List.of(), false))
        .isInstanceOf(DomainException.class);
    var parameters = queryParameters();
    parameters.set("basis", "CALENDAR");
    assertThatThrownBy(() -> UsagePeriod.from(FROM, TO, "UTC", parameters))
        .isInstanceOf(DomainException.class);
    parameters.remove("basis");
    parameters.set("sort", "task_count;drop table tasks");
    parameters.set("direction", "asc");
    assertThatThrownBy(() -> usage.sites(actor, PERIOD, PageQuery.from(parameters)))
        .isInstanceOf(DomainException.class);
  }

  @Test
  void resultsPreservePresentationAndFileMembershipAcrossRevisions() {
    var actor = actor();
    UUID task = task(actor, null, "WAITING_AGENT", null, "2026-01-02T12:00:00Z");
    assertThat(results.latest(actor, task)).isNull();
    UUID artifact = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO task_artifacts(id,user_id,task_id,purpose,bucket,object_key,mime,size,
              filename,state,checksum,ready_at)
            VALUES(:id,:user,:task,'FILE','hg-artifacts',:key,'text/plain',12,
              'report.txt','READY',repeat('a',64),now())
            """)
        .param("id", artifact)
        .param("user", actor.userId())
        .param("task", task)
        .param("key", artifact.toString())
        .update();
    var input = publish(List.of(Map.of("amount", 10), Map.of("amount", 2)), List.of(artifact));
    var first = results.publish(actor, task, input, context());
    var second = results.publish(actor, task, input, context());
    var latest = json.read(json.write(results.latest(actor, task)));
    assertThat(latest.path("revision").asLong()).isEqualTo(2);
    assertThat(latest.path("outputFormat").asString()).isEqualTo("TABLE");
    assertThat(latest.path("columns").get(0).path("label").asString()).isEqualTo("Amount");
    assertThat(latest.path("files").get(0).path("id").asString()).isEqualTo(artifact.toString());
    assertThat(latest.path("files").get(0).path("bytes").asLong()).isEqualTo(12);
    assertThat(latest.path("sections").get(0).path("text").asString()).isEqualTo("Observed data");
    assertThat(latest.path("sources").get(0).path("url").asString())
        .isEqualTo("https://example.com");
    assertThat(
            jdbc.sql("SELECT count(*) FROM task_results WHERE :artifact=ANY(artifact_ids)")
                .param("artifact", artifact)
                .query(Long.class)
                .single())
        .isEqualTo(2);
    assertThat(
            jdbc.sql("SELECT result_id FROM task_artifacts WHERE id=:id")
                .param("id", artifact)
                .query(UUID.class)
                .single())
        .isEqualTo(first.resource().id());
    assertThat(second.resource().id()).isNotEqualTo(first.resource().id());
    assertThatThrownBy(() -> results.latest(actor(), task)).isInstanceOf(DomainException.class);
  }

  @Test
  void resultRowsUseNumericServerSortStableSnapshotAndAuthorizedDetails() {
    var actor = actor();
    UUID task = task(actor, null, "WAITING_AGENT", null, "2026-01-02T12:00:00Z");
    var receipt =
        results.publish(
            actor,
            task,
            publish(List.of(Map.of("amount", 10), Map.of("amount", 2)), List.of()),
            context());
    UUID id = receipt.resource().id();
    var query = new LinkedMultiValueMap<String, String>();
    query.set("pageSize", "1");
    query.set("sort", "amount");
    query.set("direction", "asc");
    var first = results.rows(actor, id, PageQuery.from(query));
    assertThat(first.total()).isEqualTo(2);
    assertThat(json.read(json.write(first.items().getFirst())).path("data").path("amount").asInt())
        .isEqualTo(2);
    UUID rowId = (UUID) first.items().getFirst().get("id");
    assertThat(results.row(actor, id, rowId)).containsEntry("id", rowId);
    assertThatThrownBy(() -> results.row(actor(), id, rowId)).isInstanceOf(DomainException.class);
    query.set("page", "2");
    query.set("snapshot", first.snapshot());
    assertThat(results.rows(actor, id, PageQuery.from(query)).items()).hasSize(1);
    query.set("q", "10");
    assertThatThrownBy(() -> results.rows(actor, id, PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Refresh");
    query.remove("snapshot");
    query.set("page", "1");
    assertThat(results.rows(actor, id, PageQuery.from(query)).total()).isEqualTo(1);
    query.set("sort", "unknown");
    assertThatThrownBy(() -> results.rows(actor, id, PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Unknown result column");
  }

  @Test
  void invalidTypedRowsAndForeignFilesCannotPublishPartialResults() {
    var actor = actor();
    UUID task = task(actor, null, "WAITING_AGENT", null, "2026-01-02T12:00:00Z");
    assertThatThrownBy(
            () ->
                results.publish(
                    actor,
                    task,
                    publish(List.of(Map.of("amount", "not a number")), List.of()),
                    context()))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(
            () ->
                results.publish(
                    actor, task, publish(List.of(), List.of(UUID.randomUUID())), context()))
        .isInstanceOf(DomainException.class);
    assertThat(results.latest(actor, task)).isNull();
  }

  private ResultContracts.Publish publish(List<Map<String, Object>> rows, List<UUID> artifacts) {
    return new ResultContracts.Publish(
        1L,
        1L,
        null,
        "Measured result",
        List.of(),
        List.of(),
        List.of(new ResultContracts.Column("amount", "Amount", "NUMBER")),
        rows,
        Map.of(),
        artifacts,
        List.of(new ResultContracts.Section("Summary", "Observed data")),
        List.of(new ResultContracts.Source("Source", "https://example.com")));
  }

  private AuthenticatedActor actor() {
    var account =
        transaction.execute(
            status ->
                identities.resolve(
                    "https://issuer.example",
                    UUID.randomUUID().toString(),
                    "Usage test",
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

  private UUID site() {
    UUID id = UUID.randomUUID();
    jdbc.sql("INSERT INTO sites(id,normalized_host,display_name) VALUES(:id,:host,:host)")
        .param("id", id)
        .param("host", id + ".example.com")
        .update();
    return id;
  }

  private UUID task(
      AuthenticatedActor actor, UUID site, String state, String outcome, String created) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state,outcome,start_site_id,
              created_at) VALUES(:id,:user,'Usage fixture','Usage fixture','TABLE','ANGULAR',:state,
              :outcome,:site,:created)
            """)
        .param("id", id)
        .param("user", actor.userId())
        .param("state", state)
        .param("outcome", outcome)
        .param("site", site)
        .param("created", Timestamp.from(Instant.parse(created)))
        .update();
    return id;
  }

  private void measurement(AuthenticatedActor actor, UUID task, String metric, long value) {
    jdbc.sql(
            """
            INSERT INTO usage_measurements(id,user_id,task_id,metric,value,unit,interval_start,
              interval_end,completeness,source_id,source_sequence)
            VALUES(:id,:user,:task,:metric,:value,'byte',now(),now(),'COMPLETE',:source,1)
            """)
        .param("id", UUID.randomUUID())
        .param("user", actor.userId())
        .param("task", task)
        .param("metric", metric)
        .param("value", value)
        .param("source", UUID.randomUUID())
        .update();
  }

  private static LinkedMultiValueMap<String, String> queryParameters() {
    var parameters = new LinkedMultiValueMap<String, String>();
    parameters.set("from", FROM.toString());
    parameters.set("to", TO.toString());
    parameters.set("timezone", PERIOD.timezone());
    return parameters;
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
