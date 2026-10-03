package com.helmglass.usage.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.PageQuery;
import com.helmglass.usage.api.UsageContracts.Measurement;
import com.helmglass.usage.api.UsageContracts.UnknownInterval;
import com.helmglass.usage.application.UsagePeriod;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class UsageRepository {
  private static final String METRICS =
      """
      , observations AS (
        SELECT s.task_id,v.metric,NULL::bigint AS value,false AS complete
        FROM browser_sessions s JOIN cohort t ON t.id=s.task_id
        LEFT JOIN session_usage_checkpoints c ON c.session_id=s.id
        CROSS JOIN (VALUES ('browser_seconds'),('execution_seconds'),
          ('human_control_seconds'),('human_login_seconds')) v(metric)
        WHERE c.browser_complete IS DISTINCT FROM true OR NOT EXISTS
          (SELECT 1 FROM usage_measurements m WHERE m.session_id=s.id AND m.metric=v.metric)
        UNION ALL
        SELECT m.task_id,m.metric,m.value,m.completeness='COMPLETE'
        FROM usage_measurements m JOIN cohort t ON t.id=m.task_id
        WHERE m.metric IN ('browser_seconds','execution_seconds','human_control_seconds',
          'human_login_seconds','media_bytes','media_seconds',
          'audio_analyzed_seconds','active_agent_seconds')
        UNION ALL
        SELECT t.id,'command_count',count(c.id),true FROM cohort t
        LEFT JOIN task_commands c ON c.task_id=t.id GROUP BY t.id
      ), per_task AS (
        SELECT t.id,t.day,t.state,t.outcome,t.start_site_id,m.metric,
          sum(o.value) AS known_value,count(o.value) AS measured_count,
          count(*) AS expected_count,
          count(*) FILTER(WHERE o.value IS NULL OR o.complete IS DISTINCT FROM true)
            AS incomplete_count
        FROM cohort t CROSS JOIN (VALUES ('browser_seconds'),('execution_seconds'),
          ('human_control_seconds'),('human_login_seconds'),('media_seconds'),('media_bytes'),
          ('audio_analyzed_seconds'),('active_agent_seconds'),('command_count')) m(metric)
        LEFT JOIN observations o ON o.task_id=t.id AND o.metric=m.metric
        GROUP BY t.id,t.day,t.state,t.outcome,t.start_site_id,m.metric
      )
      """;

  private static final String TOTALS =
      """
      count(*) AS task_count,
      count(*) FILTER(WHERE state IN ('COMPLETED','FAILED','CANCELLED')) AS terminal_count,
      count(*) FILTER(WHERE state='COMPLETED' AND outcome='SUCCESS') AS successful_count,
      metric,sum(known_value) AS known_value,sum(measured_count)::bigint AS measured_count,
      sum(expected_count)::bigint AS expected_count,
      sum(incomplete_count)::bigint AS incomplete_count
      """;

  private final JdbcClient jdbc;

  public UsageRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public void lockProjection(UUID userId, UUID taskId) {
    jdbc.sql(
            """
            INSERT INTO task_usage_totals(task_id)
            SELECT id FROM tasks WHERE id=:task AND user_id=:user ON CONFLICT DO NOTHING
            """)
        .param("task", taskId)
        .param("user", userId)
        .update();
    jdbc.sql(
            """
            SELECT u.task_id FROM task_usage_totals u JOIN tasks t ON t.id=u.task_id
            WHERE u.task_id=:task AND t.user_id=:user FOR UPDATE OF u
            """)
        .param("task", taskId)
        .param("user", userId)
        .query(UUID.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void saveProjection(UUID taskId, String totals, String coverage) {
    jdbc.sql(
            """
            UPDATE task_usage_totals SET totals=CAST(:totals AS jsonb),coverage=:coverage,
              version=version+1,calculated_at=now(),
              source_watermark=(SELECT count(*) FROM usage_measurements WHERE task_id=:task),
              unknown_intervals=coalesce((SELECT jsonb_agg(jsonb_build_object(
                'sessionId',s.id,'from',c.source_started_at+c.browser_ms*interval '1 millisecond',
                'to',s.closed_at) ORDER BY s.requested_at,s.id)
                FROM browser_sessions s LEFT JOIN session_usage_checkpoints c ON c.session_id=s.id
                WHERE s.task_id=:task AND c.browser_complete IS DISTINCT FROM true),'[]'::jsonb)
            WHERE task_id=:task
            """)
        .param("task", taskId)
        .param("totals", totals)
        .param("coverage", coverage)
        .update();
  }

  public record ProjectionTarget(UUID userId, UUID taskId) {}

  public List<ProjectionTarget> missingProjections() {
    return jdbc.sql(
            """
            SELECT t.user_id,t.id AS task_id FROM tasks t
            LEFT JOIN task_usage_totals u ON u.task_id=t.id
            WHERE u.task_id IS NULL OR NOT jsonb_exists(u.totals,'metrics')
            ORDER BY t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED
            """)
        .query(ProjectionTarget.class)
        .list();
  }

  public record BrowserBudget(long limitSeconds, BigDecimal knownMs, long incompleteCount) {}

  public BrowserBudget browserBudget(UUID taskId) {
    return jdbc.sql(
            """
            SELECT t.browser_time_limit_seconds AS limit_seconds,coalesce(sum(c.browser_ms),0) AS known_ms,
              count(*) FILTER (WHERE (s.ready_at IS NOT NULL OR c.session_id IS NOT NULL
                OR s.state IN ('ACTIVE','LOST','STOPPING') OR s.startup_state='UNKNOWN')
                AND (c.browser_complete IS DISTINCT FROM true OR c.worker_boot_id IS DISTINCT FROM s.worker_boot_id))
                AS incomplete_count
            FROM tasks t LEFT JOIN browser_sessions s ON s.task_id=t.id
            LEFT JOIN session_usage_checkpoints c ON c.session_id=s.id
            WHERE t.id=:task GROUP BY t.id,t.browser_time_limit_seconds
            """)
        .param("task", taskId)
        .query(BrowserBudget.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public record Checkpoint(
      UUID sessionId,
      UUID workerBootId,
      long sourceSequence,
      long browserMs,
      long executionMs,
      long humanMs,
      long loginMs,
      boolean browserComplete,
      Instant sourceStartedAt) {}

  public Checkpoint checkpoint(UUID id) {
    return jdbc.sql("SELECT * FROM session_usage_checkpoints WHERE session_id=:id FOR UPDATE")
        .param("id", id)
        .query(Checkpoint.class)
        .optional()
        .orElse(null);
  }

  public record Source(UUID userId, UUID taskId, Instant requestedAt, Instant readyAt) {}

  public Source source(UUID workerId, UUID bootId, UUID sessionId) {
    return jdbc.sql(
            """
            SELECT user_id,task_id,requested_at,ready_at FROM browser_sessions
            WHERE id=:id AND worker_id=:worker AND worker_boot_id=:boot FOR UPDATE
            """)
        .param("id", sessionId)
        .param("worker", workerId)
        .param("boot", bootId)
        .query(Source.class)
        .optional()
        .orElseThrow(
            () ->
                new DomainException(
                    403, "USAGE_BINDING_MISMATCH", "Usage source does not match assignment"));
  }

  public void saveCheckpoint(Checkpoint value, Checkpoint previous, Source source) {
    jdbc.sql(
            """
            INSERT INTO session_usage_checkpoints(session_id,worker_boot_id,source_sequence,browser_ms,
            execution_ms,human_ms,login_ms,browser_complete,source_started_at)
            VALUES(:session,:boot,:sequence,:browser,:execution,:human,:login,:complete,:started)
            ON CONFLICT(session_id) DO UPDATE SET
            source_sequence=:sequence,browser_ms=:browser,execution_ms=:execution,human_ms=:human,
            login_ms=:login,browser_complete=:complete,source_started_at=:started,observed_at=now()
            """)
        .param("session", value.sessionId())
        .param("boot", value.workerBootId())
        .param("sequence", value.sourceSequence())
        .param("browser", value.browserMs())
        .param("execution", value.executionMs())
        .param("human", value.humanMs())
        .param("login", value.loginMs())
        .param("complete", value.browserComplete())
        .param("started", Timestamp.from(value.sourceStartedAt()))
        .update();
    // A new anchored cumulative receipt can also cover counters from a legacy unanchored receipt.
    Checkpoint baseline = previous != null && previous.sourceStartedAt() != null ? previous : null;
    long previousBrowserMs = baseline == null ? 0 : baseline.browserMs();
    jdbc.sql(
            """
            INSERT INTO usage_measurements(id,user_id,task_id,session_id,metric,value,unit,
              interval_start,interval_end,completeness,source_id,source_sequence)
            SELECT gen_random_uuid(),:user,:task,:session,v.metric,v.value,'ms',:from,:to,
              'COMPLETE',:session,:sequence
            FROM (VALUES ('browser_seconds',CAST(:browser AS bigint)),
              ('execution_seconds',CAST(:execution AS bigint)),
              ('human_control_seconds',CAST(:human AS bigint)),
              ('human_login_seconds',CAST(:login AS bigint))) v(metric,value)
            """)
        .param("user", source.userId())
        .param("task", source.taskId())
        .param("session", value.sessionId())
        .param("sequence", value.sourceSequence())
        .param("from", Timestamp.from(value.sourceStartedAt().plusMillis(previousBrowserMs)))
        .param("to", Timestamp.from(value.sourceStartedAt().plusMillis(value.browserMs())))
        .param("browser", value.browserMs() - previousBrowserMs)
        .param("execution", value.executionMs() - (baseline == null ? 0 : baseline.executionMs()))
        .param("human", value.humanMs() - (baseline == null ? 0 : baseline.humanMs()))
        .param("login", value.loginMs() - (baseline == null ? 0 : baseline.loginMs()))
        .update();
    jdbc.sql(
            """
            UPDATE browser_sessions
            SET state='STOPPING',close_reason='TASK_BUDGET_EXHAUSTED',version=version+1
            WHERE id=:session AND state='ACTIVE' AND task_id IS NOT NULL AND
            (SELECT coalesce(sum(c.browser_ms),0) FROM session_usage_checkpoints c
            JOIN browser_sessions s ON s.id=c.session_id WHERE s.task_id=browser_sessions.task_id)
            >=(SELECT browser_time_limit_seconds::bigint*1000 FROM tasks
              WHERE id=browser_sessions.task_id)
            """)
        .param("session", value.sessionId())
        .update();
  }

  public record Aggregate(
      String groupKind,
      LocalDate day,
      String state,
      String outcome,
      UUID siteId,
      String host,
      long taskCount,
      long terminalCount,
      long successfulCount,
      String metric,
      BigDecimal knownValue,
      long measuredCount,
      long expectedCount,
      long incompleteCount) {}

  public List<Aggregate> summary(UUID userId, UsagePeriod period) {
    Map<String, Object> parameters = parameters(userId, period);
    return jdbc.sql(
            cohort(period)
                + METRICS
                + """
                SELECT CASE WHEN grouping(day)=0 THEN 'DAY'
                  WHEN grouping(state)=0 THEN 'STATE' ELSE 'TOTAL' END AS group_kind,
                  day,state,outcome,NULL::uuid AS site_id,NULL::text AS host,
                """
                + TOTALS
                + """
                FROM per_task GROUP BY GROUPING SETS ((metric),(day,metric),(state,outcome,metric))
                HAVING grouping(state)=1 OR metric='command_count'
                ORDER BY group_kind,day,state,outcome,metric
                """)
        .params(parameters)
        .query(Aggregate.class)
        .list();
  }

  public long siteCount(UUID userId, UsagePeriod period) {
    return jdbc.sql(
            cohort(period)
                + """
                SELECT count(*) FROM (SELECT start_site_id FROM cohort GROUP BY start_site_id) groups
                """)
        .params(parameters(userId, period))
        .query(Long.class)
        .single();
  }

  public List<Aggregate> sites(UUID userId, UsagePeriod period, PageQuery query) {
    Map<String, Object> parameters = parameters(userId, period);
    parameters.put("limit", query.pageSize());
    parameters.put("offset", query.offset());
    return jdbc.sql(
            cohort(period)
                + METRICS
                + """
                , grouped AS (
                  SELECT start_site_id AS id,
                """
                + TOTALS
                + """
                  FROM per_task GROUP BY start_site_id,metric
                ), selected AS (
                  SELECT g.id,s.normalized_host AS host,max(task_count) AS task_count,
                    max(known_value) FILTER(WHERE metric='execution_seconds' AND incomplete_count=0)
                      AS execution_seconds,
                    max(known_value) FILTER(WHERE metric='browser_seconds' AND incomplete_count=0)
                      AS browser_seconds,
                    max(known_value) FILTER(WHERE metric='media_seconds' AND incomplete_count=0)
                      AS media_seconds,
                    max(known_value) FILTER(WHERE metric='media_bytes' AND incomplete_count=0)
                      AS media_bytes
                  FROM grouped g LEFT JOIN sites s ON s.id=g.id GROUP BY g.id,s.normalized_host
                  ORDER BY
                """
                + siteOrder(query, "")
                + "\n"
                + """
                  LIMIT :limit OFFSET :offset
                ) SELECT 'SITE' AS group_kind,NULL::date AS day,NULL::text AS state,
                  NULL::text AS outcome,g.id AS site_id,
                  s.host,g.task_count,g.terminal_count,g.successful_count,g.metric,g.known_value,
                  g.measured_count,g.expected_count,g.incomplete_count
                FROM selected s JOIN grouped g ON g.id IS NOT DISTINCT FROM s.id
                ORDER BY
                """
                + siteOrder(query, "s.")
                + ",g.metric")
        .params(parameters)
        .query(Aggregate.class)
        .list();
  }

  private static String siteOrder(PageQuery query, String prefix) {
    if (query.sort() == null) {
      return prefix
          + "task_count DESC,"
          + prefix
          + "host ASC NULLS LAST,"
          + prefix
          + "id ASC NULLS LAST";
    }
    String column =
        Map.of(
                "host",
                "host",
                "taskCount",
                "task_count",
                "executionSeconds",
                "execution_seconds",
                "browserSeconds",
                "browser_seconds",
                "mediaSeconds",
                "media_seconds",
                "mediaBytes",
                "media_bytes")
            .get(query.sort());
    if (column == null) {
      throw new DomainException(400, "INVALID_SORT", "Unsupported usage sort field");
    }
    return prefix
        + column
        + " "
        + query.direction()
        + " NULLS LAST,"
        + prefix
        + "id "
        + query.direction()
        + " NULLS LAST";
  }

  private static String cohort(UsagePeriod period) {
    StringBuilder sql =
        new StringBuilder(
            """
            WITH cohort AS (
              SELECT id,state,outcome,start_site_id,(created_at AT TIME ZONE :timezone)::date AS day
              FROM tasks WHERE user_id=:user AND created_at>=:from AND created_at<:to AND state<>'DRAFT'
            """);
    if (!period.states().isEmpty()) {
      sql.append(" AND state IN (:states)");
    }
    if (!period.sites().isEmpty() || period.unknownSite()) {
      sql.append(" AND (");
      if (!period.sites().isEmpty()) {
        sql.append("start_site_id IN (:sites)");
      }
      if (period.unknownSite()) {
        sql.append(period.sites().isEmpty() ? "" : " OR ").append("start_site_id IS NULL");
      }
      sql.append(')');
    }
    return sql.append(')').toString();
  }

  private static Map<String, Object> parameters(UUID userId, UsagePeriod period) {
    Map<String, Object> parameters = new HashMap<>();
    parameters.put("user", userId);
    parameters.put("from", Timestamp.from(period.from()));
    parameters.put("to", Timestamp.from(period.to()));
    parameters.put("timezone", period.timezone());
    parameters.put("states", period.states());
    parameters.put("sites", period.sites());
    return parameters;
  }

  public void requireTask(UUID userId, UUID taskId) {
    if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=:task AND user_id=:user)")
        .param("task", taskId)
        .param("user", userId)
        .query(Boolean.class)
        .single()) {
      throw DomainException.notFound();
    }
  }

  public void requireUser(UUID userId) {
    if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM application_users WHERE id=:user)")
        .param("user", userId)
        .query(Boolean.class)
        .single()) {
      throw DomainException.notFound();
    }
  }

  public record CalendarMetric(
      LocalDate day,
      Instant from,
      Instant to,
      String metric,
      BigDecimal knownValue,
      boolean complete) {}

  public List<CalendarMetric> calendar(UUID userId, UsagePeriod period, Instant asOf) {
    return jdbc.sql(
            """
              WITH bounds AS (
                SELECT CAST(:from AS timestamptz) AS first,least(CAST(:to AS timestamptz),:asOf) AS last
              ), calendar_dates AS (
                SELECT (b.first AT TIME ZONE :timezone)::date + n AS day,b.first,b.last
                FROM bounds b CROSS JOIN LATERAL generate_series(0,
                  (b.last AT TIME ZONE :timezone)::date-(b.first AT TIME ZONE :timezone)::date) n
              ), days AS (
                SELECT day,greatest(day::timestamp AT TIME ZONE :timezone,first) AS start_at,
                  least((day+1)::timestamp AT TIME ZONE :timezone,last) AS end_at
                FROM calendar_dates
            WHERE greatest(day::timestamp AT TIME ZONE :timezone,first)
              <least((day+1)::timestamp AT TIME ZONE :timezone,last)
              ), session_gaps AS (
                SELECT CASE WHEN c.source_started_at IS NOT NULL AND EXISTS
                    (SELECT 1 FROM usage_measurements m WHERE m.session_id=s.id AND m.metric='browser_seconds')
                  THEN c.source_started_at + c.browser_ms * interval '1 millisecond'
                  ELSE coalesce(s.ready_at,s.requested_at) END AS start_at,
                  coalesce(s.closed_at,:asOf) AS end_at
                FROM browser_sessions s LEFT JOIN session_usage_checkpoints c ON c.session_id=s.id
                WHERE s.user_id=:user AND s.requested_at<least(CAST(:to AS timestamptz),:asOf)
                  AND coalesce(s.closed_at,:asOf)>:from
                  AND (s.ready_at IS NOT NULL OR c.session_id IS NOT NULL
                    OR s.state IN ('ACTIVE','LOST','STOPPING') OR s.startup_state='UNKNOWN')
                  AND (c.browser_complete IS DISTINCT FROM true OR NOT EXISTS
                    (SELECT 1 FROM usage_measurements m WHERE m.session_id=s.id AND m.metric='browser_seconds'))
              ), clipped AS (
                SELECT d.day,m.value,m.completeness,
                  extract(epoch FROM (m.interval_end-m.interval_start))*1000 AS duration,
                  extract(epoch FROM (least(m.interval_end,d.end_at)-greatest(m.interval_start,d.start_at)))*1000 AS overlap
                FROM days d JOIN usage_measurements m ON m.user_id=:user AND m.metric='browser_seconds'
                  AND m.interval_start<d.end_at AND m.interval_end>=d.start_at
                  AND (m.interval_end>d.start_at OR m.interval_start=m.interval_end)
              ), browser_days AS (
                SELECT day,sum(CASE WHEN value IS NULL THEN NULL
                  WHEN duration=overlap THEN value
                  ELSE greatest(0,value-(duration-overlap)) END) AS known,
                  bool_and(completeness='COMPLETE' AND value IS NOT NULL
                    AND (duration=overlap OR value=duration OR value=0)) AS complete
                FROM clipped GROUP BY day
              ), gaps AS (
                SELECT d.day,count(*) AS missing FROM days d JOIN session_gaps g
                  ON g.start_at<d.end_at AND g.end_at>d.start_at GROUP BY d.day
              ), command_days AS (
                SELECT (accepted_at AT TIME ZONE :timezone)::date AS day,count(*) AS commands
                FROM task_commands WHERE user_id=:user AND accepted_at>=:from
                  AND accepted_at<least(CAST(:to AS timestamptz),:asOf)
            GROUP BY 1
              )
              SELECT d.day,d.start_at AS "from",d.end_at AS "to",v.metric,
                CASE WHEN u.state IN ('PURGING','DELETED') THEN NULL ELSE v.known END AS known_value,
                u.state NOT IN ('PURGING','DELETED') AND v.complete AS complete
              FROM days d JOIN application_users u ON u.id=:user
              LEFT JOIN browser_days b ON b.day=d.day LEFT JOIN gaps g ON g.day=d.day
              LEFT JOIN command_days c ON c.day=d.day
              CROSS JOIN LATERAL (VALUES
                ('browser_seconds',CASE WHEN b.day IS NOT NULL THEN b.known
                  WHEN g.missing IS NOT NULL THEN NULL ELSE 0 END,
                  coalesce(b.complete,true) AND g.missing IS NULL),
                ('command_count',coalesce(c.commands,0),true)) v(metric,known,complete)
              ORDER BY d.day,v.metric
            """)
        .params(parameters(userId, period))
        .param("asOf", Timestamp.from(asOf))
        .query(CalendarMetric.class)
        .list();
  }

  public List<Aggregate> taskTotals(UUID userId, UUID taskId) {
    return jdbc.sql(
            """
            WITH cohort AS (SELECT id,state,outcome,start_site_id,(created_at AT TIME ZONE 'UTC')::date AS day
              FROM tasks WHERE id=:task AND user_id=:user)
            """
                + METRICS
                + """
                SELECT 'TOTAL' AS group_kind,NULL::date AS day,NULL::text AS state,
                  NULL::text AS outcome,NULL::uuid AS site_id,NULL::text AS host,
                """
                + TOTALS
                + " FROM per_task GROUP BY metric")
        .param("task", taskId)
        .param("user", userId)
        .query(Aggregate.class)
        .list();
  }

  public long measurementCount(UUID userId, UUID taskId) {
    return jdbc.sql("SELECT count(*) FROM usage_measurements WHERE user_id=:user AND task_id=:task")
        .param("user", userId)
        .param("task", taskId)
        .query(Long.class)
        .single();
  }

  public List<Measurement> measurements(UUID userId, UUID taskId, PageQuery query) {
    return jdbc.sql(
            """
            SELECT id,session_id,attempt_id,metric,value,unit,completeness,interval_start,interval_end,recorded_at
            FROM usage_measurements WHERE task_id=:task AND user_id=:user ORDER BY
            """
                + query.sqlOrder(
                    Map.of("intervalStart", "interval_start", "metric", "metric"),
                    "interval_start,id")
                + " LIMIT :limit OFFSET :offset")
        .param("task", taskId)
        .param("user", userId)
        .param("limit", query.pageSize())
        .param("offset", query.offset())
        .query(Measurement.class)
        .list();
  }

  public long unknownIntervalCount(UUID userId, UUID taskId) {
    return jdbc.sql(
            """
            SELECT count(*) FROM browser_sessions s LEFT JOIN session_usage_checkpoints c ON c.session_id=s.id
            WHERE s.user_id=:user AND s.task_id=:task AND c.browser_complete IS DISTINCT FROM true
            """)
        .param("user", userId)
        .param("task", taskId)
        .query(Long.class)
        .single();
  }

  public List<UnknownInterval> unknownIntervals(
      UUID userId, UUID taskId, Instant asOf, PageQuery query) {
    return jdbc.sql(
            """
            SELECT s.id AS session_id,
              c.source_started_at + c.browser_ms * interval '1 millisecond' AS "from",
              coalesce(s.closed_at,:asOf) AS "to",
              CASE WHEN s.state IN ('CLOSED','LOST') THEN 'UNCONFIRMED_TAIL'
                ELSE 'MEASUREMENT_PENDING' END AS reason
            FROM browser_sessions s LEFT JOIN session_usage_checkpoints c ON c.session_id=s.id
            WHERE s.user_id=:user AND s.task_id=:task AND c.browser_complete IS DISTINCT FROM true
            ORDER BY s.requested_at,s.id LIMIT :limit OFFSET :offset
            """)
        .param("user", userId)
        .param("task", taskId)
        .param("asOf", Timestamp.from(asOf))
        .param("limit", query.pageSize())
        .param("offset", query.offset())
        .query(UnknownInterval.class)
        .list();
  }
}
