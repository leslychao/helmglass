package ru.helmglass.api.usage;

import java.math.BigDecimal;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;

@Service
public class UsageService {
  private final JdbcClient jdbc;

  public UsageService(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public Report report(
      UUID owner, Instant from, Instant to, boolean administration, String timezone) {
    return report(owner, from, to, administration, timezone, 1, 1, 10);
  }

  public Report report(
      UUID owner,
      Instant from,
      Instant to,
      boolean administration,
      String timezone,
      int daysPage,
      int sitesPage,
      int pageSize) {
    if (daysPage < 1
        || sitesPage < 1
        || daysPage > 1000000
        || sitesPage > 1000000
        || !java.util.Set.of(10, 20, 50).contains(pageSize)) {
      throw ApiException.invalid("page", "Недопустимая страница или размер страницы статистики.");
    }
    ZoneId zone = zone(timezone);
    Instant start = from == null ? Instant.EPOCH : from;
    Instant end = to == null ? Instant.now().plusSeconds(1) : to;
    String cohort =
        "owner_id=:owner AND status<>'DRAFT' AND created_at>=:start AND created_at<:end";
    Map<String, Object> parameters =
        Map.of(
            "owner",
            owner,
            "start",
            java.sql.Timestamp.from(start),
            "end",
            java.sql.Timestamp.from(end),
            "timezone",
            zone.getId());
    AdminUsage totals = totals(owner, start, end, administration);
    List<Day> days =
        jdbc.sql(
                """
SELECT (t.created_at AT TIME ZONE :timezone)::date AS usage_date,count(*) tasks,
  coalesce(sum((SELECT sum(extract(epoch FROM coalesce(u.ended_at,now())-u.started_at)) FROM usage_intervals u WHERE u.task_id=t.id AND u.kind='BROWSER')),0) seconds
FROM tasks t WHERE
"""
                    + cohort
                    + " GROUP BY usage_date ORDER BY usage_date LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", pageSize)
            .param("offset", (long) (daysPage - 1) * pageSize)
            .query(
                (row, index) ->
                    new Day(
                        row.getObject("usage_date", LocalDate.class).toString(),
                        row.getLong("tasks"),
                        row.getBigDecimal("seconds")))
            .list();
    List<Site> sites =
        jdbc.sql(
                """
SELECT t.site,count(*) tasks,
  coalesce(sum((SELECT sum(extract(epoch FROM coalesce(u.ended_at,now())-u.started_at)) FROM usage_intervals u WHERE u.task_id=t.id AND u.kind='BROWSER')),0) browser,
  sum((SELECT sum(a.duration_seconds) FROM artifacts a WHERE a.task_id=t.id AND a.status='READY')) media_seconds,
  coalesce(sum((SELECT sum(a.size_bytes) FROM artifacts a WHERE a.task_id=t.id AND a.status='READY')),0) media_bytes
FROM tasks t WHERE
"""
                    + cohort
                    + " GROUP BY t.site ORDER BY t.site NULLS LAST LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", pageSize)
            .param("offset", (long) (sitesPage - 1) * pageSize)
            .query(
                (row, index) ->
                    new Site(
                        row.getString("site"),
                        row.getLong("tasks"),
                        row.getBigDecimal("browser"),
                        row.getBigDecimal("media_seconds"),
                        row.getLong("media_bytes")))
            .list();
    long dayCount =
        jdbc.sql(
                "SELECT count(DISTINCT (created_at AT TIME ZONE :timezone)::date) FROM tasks WHERE "
                    + cohort)
            .params(parameters)
            .query(Long.class)
            .single();
    long siteCount =
        jdbc.sql(
                "SELECT count(*) FROM (SELECT site FROM tasks WHERE "
                    + cohort
                    + " GROUP BY site) sites")
            .params(parameters)
            .query(Long.class)
            .single();
    List<State> statuses =
        jdbc.sql(
                "SELECT status,count(*) total FROM tasks WHERE "
                    + cohort
                    + " GROUP BY status ORDER BY status")
            .params(parameters)
            .query((row, index) -> new State(row.getString("status"), row.getLong("total")))
            .list();
    return new Report(
        totals.totalTasks(),
        totals.successfulTasks(),
        totals.completedTasks(),
        totals.successRate(),
        totals.usage(),
        new Contracts.Page<>(days, dayCount, daysPage, pageSize),
        new Contracts.Page<>(sites, siteCount, sitesPage, pageSize),
        statuses);
  }

  public AdminUsage administration(UUID owner, Instant from, Instant to) {
    return totals(owner, from, to, true);
  }

  private AdminUsage totals(UUID owner, Instant start, Instant end, boolean administration) {
    String cohort =
        "owner_id=:owner AND status<>'DRAFT' AND created_at>=:start AND created_at<:end";
    Map<String, Object> parameters =
        Map.of(
            "owner",
            owner,
            "start",
            java.sql.Timestamp.from(start),
            "end",
            java.sql.Timestamp.from(end));
    Counts counts =
        jdbc.sql(
                "SELECT count(*) total,count(*) FILTER(WHERE status='SUCCEEDED')"
                    + " successful,count(*) FILTER(WHERE status IN"
                    + " ('SUCCEEDED','PARTIAL','NOT_ACHIEVED','FAILED','STOPPED') AND NOT"
                    + " EXISTS(SELECT 1 FROM operations o WHERE o.task_id=tasks.id AND"
                    + " o.status='UNKNOWN')) completed FROM tasks WHERE "
                    + cohort)
            .params(parameters)
            .query(
                (row, index) ->
                    new Counts(
                        row.getLong("total"), row.getLong("successful"), row.getLong("completed")))
            .single();
    String intervalFilter =
        administration
            ? "u.owner_id=:owner AND u.started_at<:end AND coalesce(u.ended_at,now())>=:start"
            : "u.task_id IN (SELECT id FROM tasks WHERE " + cohort + ")";
    String intervalDuration =
        administration
            ? "greatest(0,extract(epoch FROM"
                + " least(coalesce(u.ended_at,now()),:end)-greatest(u.started_at,:start)))"
            : "extract(epoch FROM coalesce(u.ended_at,now())-u.started_at)";
    Times times =
        jdbc.sql(
                "SELECT coalesce(sum("
                    + intervalDuration
                    + ") FILTER(WHERE kind='BROWSER'),0) browser,coalesce(sum("
                    + intervalDuration
                    + ") FILTER(WHERE kind='EXECUTION'),0) execution,coalesce(sum("
                    + intervalDuration
                    + ") FILTER(WHERE kind='MANUAL'),0) manual,coalesce(bool_or(incomplete),false)"
                    + " incomplete FROM usage_intervals u WHERE "
                    + intervalFilter)
            .params(parameters)
            .query(
                (row, index) ->
                    new Times(
                        row.getBigDecimal("browser"),
                        row.getBigDecimal("execution"),
                        row.getBigDecimal("manual"),
                        row.getBoolean("incomplete")))
            .single();
    String mediaFilter =
        administration
            ? "owner_id=:owner AND created_at>=:start AND created_at<:end"
            : "task_id IN (SELECT id FROM tasks WHERE " + cohort + ")";
    Media media =
        jdbc.sql(
                "SELECT coalesce(sum(size_bytes),0) bytes,sum(duration_seconds) seconds,count(*)"
                    + " FILTER(WHERE mime_type LIKE 'audio/%' AND duration_seconds IS NULL)>0"
                    + " incomplete FROM artifacts WHERE status='READY' AND "
                    + mediaFilter)
            .params(parameters)
            .query(
                (row, index) ->
                    new Media(
                        row.getLong("bytes"),
                        row.getBigDecimal("seconds"),
                        row.getBoolean("incomplete")))
            .single();
    Usage usage =
        new Usage(
            times.browser(),
            times.execution(),
            times.manual(),
            media.seconds(),
            media.bytes(),
            times.incomplete() || media.incomplete());
    Double successRate =
        counts.completed() == 0 ? null : (double) counts.successful() / counts.completed();
    return new AdminUsage(
        counts.total(), counts.successful(), counts.completed(), successRate, usage);
  }

  public record AdminUsage(
      long totalTasks,
      long successfulTasks,
      long completedTasks,
      Double successRate,
      Usage usage) {}

  public static ZoneId zone(String timezone) {
    try {
      return timezone == null || timezone.isBlank() ? ZoneId.of("UTC") : ZoneId.of(timezone);
    } catch (DateTimeException exception) {
      throw ApiException.invalid("timezone", "Укажите корректный часовой пояс IANA.");
    }
  }

  public record Usage(
      BigDecimal browserSeconds,
      BigDecimal executionSeconds,
      BigDecimal manualSeconds,
      BigDecimal mediaSeconds,
      Long mediaBytes,
      boolean incomplete) {}

  public record Report(
      long totalTasks,
      long successfulTasks,
      long completedTasks,
      Double successRate,
      Usage usage,
      Contracts.Page<Day> days,
      Contracts.Page<Site> sites,
      List<State> statuses) {}

  public record Day(String date, long tasks, BigDecimal browserSeconds) {}

  public record Site(
      String site,
      long tasks,
      BigDecimal browserSeconds,
      BigDecimal mediaSeconds,
      long mediaBytes) {}

  public record State(String status, long tasks) {}

  private record Counts(long total, long successful, long completed) {}

  private record Times(
      BigDecimal browser, BigDecimal execution, BigDecimal manual, boolean incomplete) {}

  private record Media(long bytes, BigDecimal seconds, boolean incomplete) {}
}
