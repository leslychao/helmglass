package com.helmglass.usage.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.domain.TaskState;
import com.helmglass.usage.api.UsageContracts.Calendar;
import com.helmglass.usage.api.UsageContracts.CalendarDay;
import com.helmglass.usage.api.UsageContracts.Daily;
import com.helmglass.usage.api.UsageContracts.Measurement;
import com.helmglass.usage.api.UsageContracts.Metric;
import com.helmglass.usage.api.UsageContracts.Site;
import com.helmglass.usage.api.UsageContracts.StateCount;
import com.helmglass.usage.api.UsageContracts.StateGroup;
import com.helmglass.usage.api.UsageContracts.Summary;
import com.helmglass.usage.api.UsageContracts.TaskUsage;
import com.helmglass.usage.infrastructure.repository.UsageRepository;
import com.helmglass.usage.infrastructure.repository.UsageRepository.Aggregate;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.LinkedMultiValueMap;

@Service
@Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
public class UsageService {
  private final UsageRepository usage;
  private final ChangeRepository changes;

  public UsageService(UsageRepository usage, ChangeRepository changes) {
    this.usage = usage;
    this.changes = changes;
  }

  /** Allocation callers have already authorized and serialized the task's browser binding. */
  public int remainingBrowserSeconds(UUID taskId) {
    var budget = usage.browserBudget(taskId);
    if (budget.incompleteCount() > 0) {
      throw DomainException.conflict("USAGE_INCOMPLETE", "Previous browser usage is not confirmed");
    }
    BigDecimal remainingMs =
        BigDecimal.valueOf(budget.limitSeconds()).movePointRight(3).subtract(budget.knownMs());
    if (remainingMs.compareTo(BigDecimal.valueOf(1000)) < 0) {
      throw DomainException.conflict(
          "BROWSER_BUDGET_EXHAUSTED", "The task's cumulative browser budget is exhausted");
    }
    return remainingMs.movePointLeft(3).intValue();
  }

  public TaskUsage task(AuthenticatedActor actor, UUID taskId, PageQuery query) {
    actor.requireScope("tasks:read");
    usage.requireTask(actor.userId(), taskId);
    Instant asOf = Instant.now();
    var parameters = new LinkedMultiValueMap<>(query.filters());
    parameters.set("taskId", taskId.toString());
    parameters.set("view", "task-measurements");
    String snapshot = changes.snapshot(actor.userId(), "usage", PageQuery.from(parameters));
    PageResult<Measurement> measurements =
        new PageResult<>(
            usage.measurements(actor.userId(), taskId, query),
            usage.measurementCount(actor.userId(), taskId),
            query.page(),
            query.pageSize(),
            query.sortDescriptor(),
            snapshot);
    return new TaskUsage(
        taskId,
        asOf,
        metrics(usage.taskTotals(actor.userId(), taskId)),
        measurements,
        new PageResult<>(
            usage.unknownIntervals(actor.userId(), taskId, asOf, query),
            usage.unknownIntervalCount(actor.userId(), taskId),
            query.page(),
            query.pageSize(),
            null,
            snapshot));
  }

  public Calendar calendar(AuthenticatedActor actor, UUID userId, UsagePeriod period) {
    actor.requireAdmin();
    usage.requireUser(userId);
    Instant asOf = Instant.now();
    var rows = usage.calendar(userId, period, asOf);
    Map<LocalDate, CalendarDay> days = new LinkedHashMap<>();
    for (var row : rows) {
      var day =
          days.computeIfAbsent(
              row.day(),
              ignored -> new CalendarDay(row.day(), row.from(), row.to(), new LinkedHashMap<>()));
      BigDecimal known = row.knownValue();
      if (known != null && row.metric().equals("browser_seconds")) {
        known = known.movePointLeft(3);
      }
      day.metrics()
          .put(
              row.metric(),
              new Metric(
                  row.complete() ? known : null,
                  known,
                  row.complete() ? "COMPLETE" : known == null ? "UNKNOWN" : "PARTIAL",
                  known == null ? 0 : 1,
                  1));
    }
    Map<String, Metric> totals = new LinkedHashMap<>();
    for (String name : List.of("browser_seconds", "command_count")) {
      BigDecimal known = null;
      long measured = 0;
      boolean complete = !days.isEmpty();
      for (var day : days.values()) {
        Metric metric = day.metrics().get(name);
        if (metric.knownValue() != null) {
          known = known == null ? metric.knownValue() : known.add(metric.knownValue());
          measured++;
        }
        complete &= metric.completeness().equals("COMPLETE");
      }
      totals.put(
          name,
          new Metric(
              complete ? known : null,
              known,
              complete ? "COMPLETE" : known == null ? "UNKNOWN" : "PARTIAL",
              measured,
              days.size()));
    }
    return new Calendar(
        "USER_CALENDAR",
        "INTERVAL",
        userId,
        period.from(),
        period.to(),
        period.timezone(),
        asOf,
        totals,
        List.copyOf(days.values()));
  }

  public Summary summary(AuthenticatedActor actor, Instant from, Instant to, String timezone) {
    return summary(actor, new UsagePeriod(from, to, timezone, List.of(), List.of(), false));
  }

  public Summary summary(AuthenticatedActor actor, UsagePeriod period) {
    actor.requireScope("tasks:read");
    Instant asOf = Instant.now();
    List<Aggregate> values = usage.summary(actor.userId(), period);
    List<Aggregate> totals = new ArrayList<>();
    Map<LocalDate, List<Aggregate>> days = new LinkedHashMap<>();
    Map<StateGroup, Long> states = new EnumMap<>(StateGroup.class);
    for (StateGroup group : StateGroup.values()) {
      states.put(group, 0L);
    }
    for (Aggregate value : values) {
      switch (value.groupKind()) {
        case "TOTAL" -> totals.add(value);
        case "DAY" -> days.computeIfAbsent(value.day(), ignored -> new ArrayList<>()).add(value);
        case "STATE" -> states.merge(stateGroup(value), value.taskCount(), Long::sum);
        default -> throw new IllegalStateException("Unknown usage grouping");
      }
    }
    long taskCount = totals.isEmpty() ? 0 : totals.getFirst().taskCount();
    long terminalCount = totals.isEmpty() ? 0 : totals.getFirst().terminalCount();
    long successfulCount = totals.isEmpty() ? 0 : totals.getFirst().successfulCount();
    List<Daily> daily =
        days.entrySet().stream()
            .map(
                entry ->
                    new Daily(
                        entry.getKey(),
                        entry.getValue().getFirst().taskCount(),
                        metrics(entry.getValue())))
            .toList();
    List<StateCount> counts =
        states.entrySet().stream()
            .map(entry -> new StateCount(entry.getKey(), entry.getValue()))
            .toList();
    return new Summary(
        "TASK_COHORT",
        "TASK_CREATED",
        period.from(),
        period.to(),
        period.timezone(),
        asOf,
        taskCount,
        terminalCount,
        successfulCount,
        successRate(successfulCount, terminalCount),
        metrics(totals),
        daily,
        counts);
  }

  public PageResult<Site> sites(AuthenticatedActor actor, UsagePeriod period, PageQuery query) {
    actor.requireScope("tasks:read");
    String snapshot = changes.snapshot(actor.userId(), "usage", query);
    long total = usage.siteCount(actor.userId(), period);
    Map<UUID, List<Aggregate>> groups = new LinkedHashMap<>();
    for (Aggregate value : usage.sites(actor.userId(), period, query)) {
      groups.computeIfAbsent(value.siteId(), ignored -> new ArrayList<>()).add(value);
    }
    List<Site> items =
        groups.values().stream()
            .map(
                values -> {
                  Aggregate group = values.getFirst();
                  return new Site(
                      group.siteId(),
                      group.host(),
                      group.taskCount(),
                      group.terminalCount(),
                      group.successfulCount(),
                      successRate(group.successfulCount(), group.terminalCount()),
                      metrics(values));
                })
            .toList();
    return new PageResult<>(
        items, total, query.page(), query.pageSize(), query.sortDescriptor(), snapshot);
  }

  private static Double successRate(long successful, long terminal) {
    return terminal == 0 ? null : (double) successful / terminal;
  }

  private static StateGroup stateGroup(Aggregate value) {
    return switch (TaskState.valueOf(value.state())) {
      case COMPLETED ->
          switch (value.outcome()) {
            case "SUCCESS" -> StateGroup.SUCCESS;
            case "PARTIAL" -> StateGroup.PARTIAL;
            // Legacy completed tasks without an outcome must not imply success.
            case null, default -> StateGroup.NOT_ACHIEVED;
          };
      case FAILED, INTERRUPTED -> StateGroup.ERROR;
      case CANCELLED -> StateGroup.CANCELLED;
      case WAITING_AGENT, QUEUED, STARTING, RUNNING, PAUSING, PAUSED, WAITING_USER, STOPPING ->
          StateGroup.ACTIVE;
      case DRAFT -> throw new IllegalStateException("Draft tasks are outside the usage cohort");
    };
  }

  static Map<String, Metric> metrics(List<Aggregate> values) {
    Map<String, Metric> result = new LinkedHashMap<>();
    for (String name :
        List.of(
            "browser_seconds",
            "execution_seconds",
            "human_login_seconds",
            "human_control_seconds",
            "media_seconds",
            "media_bytes",
            "audio_analyzed_seconds",
            "active_agent_seconds",
            "command_count")) {
      result.put(name, new Metric(null, null, "UNKNOWN", 0, 0));
    }
    for (Aggregate value : values) {
      BigDecimal known = value.knownValue();
      if (known != null && value.metric().endsWith("_seconds")) {
        known = known.movePointLeft(3);
      }
      boolean complete = value.incompleteCount() == 0 && value.measuredCount() > 0;
      String completeness = known == null ? "UNKNOWN" : "PARTIAL";
      if (complete) {
        completeness = "COMPLETE";
      }
      result.put(
          value.metric(),
          new Metric(
              complete ? known : null,
              known,
              completeness,
              value.measuredCount(),
              value.expectedCount()));
    }
    return result;
  }
}
