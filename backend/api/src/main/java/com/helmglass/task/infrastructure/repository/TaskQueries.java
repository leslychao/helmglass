package com.helmglass.task.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository;
import com.helmglass.identity.domain.QuotaCeiling;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.api.TaskContracts.Capability;
import com.helmglass.task.api.TaskContracts.EventPage;
import com.helmglass.task.api.TaskContracts.EventPageMeta;
import com.helmglass.task.api.TaskContracts.TaskView;
import com.helmglass.task.domain.TaskAggregate;
import com.helmglass.task.domain.TaskState;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class TaskQueries {
  private static final Set<String> EVENT_TYPES = Set.of("AGENT", "BROWSER", "SYSTEM");
  private static final Set<String> EVENT_PARAMETERS =
      Set.of("page", "pageSize", "q", "sort", "direction", "snapshot", "type");
  private static final int EVENT_PAGE_SIZE = 10;
  private static final int MAX_EVENT_OFFSET = 100_000;
  private static final int EVENT_SNAPSHOT_SECONDS = 300;
  private final JdbcClient jdbc;
  private final ChangeRepository changes;
  private final ContinuationRepository continuations;
  private final JsonSupport json;

  public TaskQueries(
      JdbcClient jdbc,
      ChangeRepository changes,
      ContinuationRepository continuations,
      JsonSupport json) {
    this.jdbc = jdbc;
    this.changes = changes;
    this.continuations = continuations;
    this.json = json;
  }

  public long nextDisplayNumber() {
    return jdbc.sql("SELECT nextval('task_display_number')").query(Long.class).single();
  }

  public UUID site(UUID userId, String startUrl) {
    if (startUrl == null || startUrl.isBlank()) {
      return null;
    }
    URI uri = URI.create(startUrl);
    if (!List.of("https", "http").contains(uri.getScheme())
        || uri.getHost() == null
        || uri.getUserInfo() != null) {
      throw new DomainException(422, "INVALID_START_URL", "A public HTTP(S) address is required");
    }
    String host = uri.getHost().toLowerCase(Locale.ROOT);
    UUID id =
        jdbc.sql(
                """
                INSERT INTO sites(id,normalized_host,display_name) VALUES(:id,:host,:host)
                ON CONFLICT(normalized_host) DO UPDATE SET normalized_host=excluded.normalized_host RETURNING id
                """)
            .param("id", UUID.randomUUID())
            .param("host", host)
            .query(UUID.class)
            .single();
    jdbc.sql(
            """
            INSERT INTO user_sites(user_id,site_id,scope) VALUES(:user,:site,'tasks')
            ON CONFLICT(user_id,site_id,scope) DO UPDATE SET last_selected_at=now()
            """)
        .param("user", userId)
        .param("site", id)
        .update();
    return id;
  }

  public void setConnections(UUID userId, UUID taskId, List<UUID> ids) {
    if (ids.size() != ids.stream().distinct().count()) {
      throw new DomainException(
          422, "DUPLICATE_CONNECTION", "Connection selection contains duplicates");
    }
    jdbc.sql("DELETE FROM task_connections WHERE task_id=:task").param("task", taskId).update();
    for (int index = 0; index < ids.size(); index++) {
      int inserted =
          jdbc.sql(
                  """
                  INSERT INTO task_connections(task_id,connection_id,user_id,site_id,preference_rank)
                  SELECT :task,id,user_id,site_id,:rank FROM connections
                  WHERE id=:connection AND user_id=:user AND status NOT IN ('DELETING','DELETED')
                  """)
              .param("task", taskId)
              .param("connection", ids.get(index))
              .param("user", userId)
              .param("rank", index)
              .update();
      if (inserted != 1) {
        throw DomainException.notFound();
      }
    }
  }

  public void checkQueueAdmission(UUID userId) {
    record Limits(Integer personal, String mode, Integer configured, long waiting) {}
    Limits limits =
        jdbc.sql(
                """
                SELECT p.queued_limit personal,l.queued_mode mode,l.queued_custom configured,
                (SELECT count(*) FROM tasks t WHERE t.user_id=p.user_id
                AND t.state IN ('QUEUED','WAITING_AGENT','WAITING_USER')) waiting
                FROM user_policies p JOIN admin_user_limits l ON l.user_id=p.user_id WHERE p.user_id=:user
                """)
            .param("user", userId)
            .query(Limits.class)
            .single();
    Integer limit =
        QuotaCeiling.queued(limits.mode(), limits.configured(), limits.personal()).effective();
    if (limit != null && limits.waiting() >= limit) {
      throw DomainException.conflict(
          "QUEUED_LIMIT_REACHED", "Prepared task limit has been reached");
    }
  }

  public List<UUID> connections(UUID taskId) {
    return jdbc.sql(
            """
            SELECT connection_id FROM task_connections WHERE task_id=:task ORDER BY preference_rank
            """)
        .param("task", taskId)
        .query(UUID.class)
        .list();
  }

  public TaskView view(TaskAggregate task) {
    List<Map<String, Object>> sessions =
        jdbc.sql(
                """
                SELECT s.id,s.version,s.state,s.privacy,s.page_epoch AS "pageEpoch",
                s.privacy_epoch AS "privacyEpoch",
                CASE WHEN s.privacy='NORMAL' THEN s.idle_deadline_at END AS "idleDeadlineAt",
                s.budget_deadline_at AS "budgetDeadlineAt",s.close_reason AS "closeReason",
                l.epoch AS "controlEpoch",l.owner_kind AS "controlOwner"
                FROM browser_sessions s LEFT JOIN browser_control_leases l ON l.session_id=s.id
                WHERE s.task_id=:task AND s.binding_released_at IS NULL
                """)
            .param("task", task.getId())
            .query()
            .listOfRows();
    Map<String, Object> session = sessions.isEmpty() ? null : sessions.getFirst();
    boolean active = !task.getState().terminal() && task.getState() != TaskState.DRAFT;
    Map<String, Boolean> allowed =
        Map.of(
            "pause",
            active,
            "stop",
            active,
            "resume",
            (task.getState() == TaskState.PAUSED || task.getState() == TaskState.INTERRUPTED)
                && !task.isMutationBarrier(),
            "edit",
            task.getState() == TaskState.DRAFT,
            "openBrowser",
            active && session == null && !task.isMutationBarrier(),
            "reconcile",
            task.isMutationBarrier());
    Map<String, Capability> capabilities = new HashMap<>();
    allowed.forEach(
        (name, value) ->
            capabilities.put(
                name,
                new Capability(
                    value, true, value ? null : "Action unavailable in the current task state")));
    return new TaskView(
        task.getId(),
        task.getDisplayNumber(),
        task.getVersion(),
        task.getInstructionRevision(),
        task.getGoal(),
        task.getTitle(),
        task.getStartUrl(),
        task.getOutputFormat(),
        task.isConfirmImportantActions(),
        task.getBrowserTimeLimitSeconds(),
        task.getState().name(),
        task.getOutcome(),
        task.getOrigin(),
        task.getWaitReason(),
        task.getFailureCode(),
        task.isMutationBarrier(),
        task.getCreatedAt(),
        task.getUpdatedAt(),
        connections(task.getId()),
        session,
        capabilities,
        task.getId() + ":" + task.getInstructionRevision(),
        lastSession(task.getId()),
        activeRequest(task.getId()),
        commandView(task.getId(), true),
        commandView(task.getId(), false),
        usage(task.getId()),
        continuations.snapshot(task.getId()),
        unresolvedHumanOperation(task.getId()));
  }

  private UUID unresolvedHumanOperation(UUID taskId) {
    return jdbc.sql(
            """
            SELECT o.id FROM operations o JOIN browser_sessions s ON s.id=o.target_id
            WHERE s.task_id=:task AND o.human_checkpoint='UNKNOWN' ORDER BY o.created_at DESC LIMIT 1
            """)
        .param("task", taskId)
        .query(UUID.class)
        .optional()
        .orElse(null);
  }

  private Map<String, Object> usage(UUID taskId) {
    return jdbc.sql("SELECT totals::text FROM task_usage_totals WHERE task_id=:task")
        .param("task", taskId)
        .query(String.class)
        .optional()
        .map(json::map)
        .orElseGet(() -> Map.of("completeness", "UNKNOWN"));
  }

  private UUID lastSession(UUID taskId) {
    return jdbc.sql(
            "SELECT id FROM browser_sessions WHERE task_id=:id ORDER BY requested_at DESC,id LIMIT"
                + " 1")
        .param("id", taskId)
        .query(UUID.class)
        .optional()
        .orElse(null);
  }

  private Map<String, Object> activeRequest(UUID taskId) {
    var rows =
        jdbc.sql(
                """
                SELECT id,kind,connection_id AS "connectionId",intent_hash AS "intentHash",prompt,version,status,expires_at AS "expiresAt",
                context::text AS context
                FROM user_action_requests WHERE task_id=:id AND status='OPEN' AND expires_at>now()
                ORDER BY created_at LIMIT 1
                """)
            .param("id", taskId)
            .query()
            .listOfRows();
    if (rows.isEmpty()) {
      return null;
    }
    var result = rows.getFirst();
    var context = json.read((String) result.remove("context"));
    result.put("purpose", context.path("purpose").asString("GENERAL"));
    result.put("choices", context.has("choices") ? context.get("choices") : List.of());
    result.put("hasMoreChoices", context.path("hasMore").asBoolean(false));
    return result;
  }

  private Map<String, Object> commandView(UUID taskId, boolean outstanding) {
    String predicate =
        outstanding ? " AND state IN ('ACCEPTED','WAITING_RESOURCE','DISPATCHED','STARTED')" : "";
    var rows =
        jdbc.sql(
                "SELECT id,kind,state,version,instruction_revision AS \"instructionRevision\" FROM"
                    + " task_commands WHERE task_id=:id"
                    + predicate
                    + " ORDER BY command_sequence DESC LIMIT 1")
            .param("id", taskId)
            .query()
            .listOfRows();
    return rows.isEmpty() ? null : rows.getFirst();
  }

  public void deleteDraft(UUID taskId) {
    jdbc.sql("DELETE FROM task_usage_totals WHERE task_id=:id").param("id", taskId).update();
    jdbc.sql("DELETE FROM task_connections WHERE task_id=:id").param("id", taskId).update();
    jdbc.sql("DELETE FROM task_execution_events WHERE task_id=:id").param("id", taskId).update();
    jdbc.sql("DELETE FROM task_event_counters WHERE task_id=:id").param("id", taskId).update();
  }

  public PageResult<Map<String, Object>> list(UUID userId, PageQuery query) {
    String snapshot = changes.snapshot(userId, "tasks", query);
    StringBuilder where =
        new StringBuilder(
            " WHERE user_id=:user AND (lower(title) ILIKE :q OR display_number::text ILIKE :q)");
    Map<String, Object> params = new HashMap<>();
    params.put("user", userId);
    params.put("q", query.escapedQuery());
    for (String field : List.of("state", "outcome", "source", "siteId")) {
      List<String> values = query.filters().get(field);
      if (values == null) {
        values = query.filters().get(field + "[]");
      }
      if (values != null && !values.isEmpty()) {
        if (values.size() > 50) {
          throw new DomainException(400, "INVALID_FILTER", "Too many filter values");
        }
        String column =
            switch (field) {
              case "source" -> "origin";
              case "siteId" -> "start_site_id::text";
              default -> field;
            };
        where.append(" AND ").append(column).append(" IN (:").append(field).append(')');
        params.put(field, values);
      }
    }
    String from = query.filters().getFirst("createdFrom");
    String to = query.filters().getFirst("createdTo");
    if (from != null) {
      where.append(" AND created_at>=:from");
      params.put("from", Timestamp.from(Instant.parse(from)));
    }
    if (to != null) {
      where.append(" AND created_at<:to");
      params.put("to", Timestamp.from(Instant.parse(to)));
    }
    long total =
        jdbc.sql("SELECT count(*) FROM tasks" + where).params(params).query(Long.class).single();
    Map<String, String> sortFields =
        Map.of(
            "updatedAt",
            "updated_at",
            "createdAt",
            "created_at",
            "title",
            "title",
            "site",
            "site",
            "state",
            "state",
            "activeSeconds",
            "active_seconds",
            "humanSeconds",
            "human_seconds",
            "mediaSeconds",
            "media_seconds",
            "mediaBytes",
            "media_bytes",
            "summary",
            "summary");
    String order = "updated_at DESC,id DESC";
    if (query.sort() != null) {
      String column = sortFields.get(query.sort());
      if (column == null) {
        throw new DomainException(400, "INVALID_SORT", "Unsupported task sort field");
      }
      order = column + " " + query.direction() + " NULLS LAST,id " + query.direction();
    }
    List<Map<String, Object>> rows =
        jdbc.sql(
                """
                WITH task_view AS (
                  SELECT t.*,site.normalized_host AS site,u.totals::text AS usage_snapshot,
                  (u.totals->>'activeSeconds')::numeric AS active_seconds,
                  (u.totals->>'humanSeconds')::numeric AS human_seconds,
                  (u.totals->>'mediaSeconds')::numeric AS media_seconds,
                  (u.totals->>'mediaBytes')::numeric AS media_bytes,
                  r.summary FROM tasks t LEFT JOIN sites site ON site.id=t.start_site_id
                  LEFT JOIN task_usage_totals u ON u.task_id=t.id
                  LEFT JOIN LATERAL (SELECT left(conclusion,500) AS summary FROM task_results WHERE task_id=t.id ORDER BY revision DESC LIMIT 1) r ON true
                )
                SELECT id,display_number AS "displayNumber",version,instruction_revision AS "instructionRevision",
                goal,title,start_url AS "startUrl",output_format AS "outputFormat",state,outcome,origin,site,
                wait_reason AS "waitReason",failure_code AS "failureCode",created_at AS "createdAt",
                updated_at AS "updatedAt",confirm_important_actions AS "confirmImportantActions",
                browser_time_limit_seconds AS "browserTimeLimitSeconds",coalesce(wait_reason,failure_code) AS reason,
                state AS "currentStep",summary,usage_snapshot
                FROM task_view
                """
                    + where
                    + " ORDER BY "
                    + order
                    + " LIMIT :limit OFFSET :offset")
            .params(params)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query()
            .listOfRows();
    for (Map<String, Object> row : rows) {
      Object snapshotValue = row.remove("usage_snapshot");
      row.put(
          "usage",
          snapshotValue instanceof String encoded
              ? json.map(encoded)
              : Map.of("completeness", "UNKNOWN"));
    }
    return new PageResult<>(
        rows, total, query.page(), query.pageSize(), query.sortDescriptor(), snapshot);
  }

  public Map<String, Long> summary(UUID userId) {
    return jdbc.sql(
            """
            SELECT count(*) AS total,count(*) FILTER(WHERE state IN ('QUEUED','STARTING','RUNNING','PAUSING','STOPPING')) AS active,
            count(*) FILTER(WHERE state IN ('WAITING_USER','INTERRUPTED')) AS "waitingUser",
            count(*) FILTER(WHERE state='COMPLETED' AND outcome='SUCCESS') AS "successCount",
            count(*) FILTER(WHERE state IN ('COMPLETED','FAILED','CANCELLED')) AS "successDenominator",
            (SELECT count(*) FROM connections c WHERE c.user_id=:user AND c.status<>'DELETED') AS "totalConnections",
            (SELECT count(*) FROM browser_profiles p JOIN connections c ON c.id=p.connection_id
            WHERE c.user_id=:user AND c.status NOT IN ('DELETING','DELETED') AND p.current_version_id IS NOT NULL) AS "savedConnections"
            FROM tasks WHERE user_id=:user
            """)
        .param("user", userId)
        .query(
            (row, index) ->
                Map.of(
                    "total",
                    row.getLong("total"),
                    "active",
                    row.getLong("active"),
                    "waitingUser",
                    row.getLong("waitingUser"),
                    "successCount",
                    row.getLong("successCount"),
                    "successDenominator",
                    row.getLong("successDenominator"),
                    "totalConnections",
                    row.getLong("totalConnections"),
                    "savedConnections",
                    row.getLong("savedConnections")))
        .single();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void event(TaskAggregate task, String type, String code, String summary) {
    if (!EVENT_TYPES.contains(type)) {
      throw new IllegalArgumentException("Unsupported task event type");
    }
    jdbc.sql("INSERT INTO task_event_counters(task_id) VALUES(:task) ON CONFLICT DO NOTHING")
        .param("task", task.getId())
        .update();
    long sequence =
        jdbc.sql(
                """
                UPDATE task_event_counters SET next_sequence=next_sequence+1,event_count=event_count+1
                WHERE task_id=:task RETURNING next_sequence-1
                """)
            .param("task", task.getId())
            .query(Long.class)
            .single();
    jdbc.sql(
            """
            INSERT INTO task_execution_events(task_id,sequence,event_id,type,code,summary)
            VALUES(:task,:sequence,:id,:type,:code,:summary)
            """)
        .param("task", task.getId())
        .param("sequence", sequence)
        .param("id", UUID.randomUUID())
        .param("type", type)
        .param("code", code)
        .param("summary", summary)
        .update();
    changes.changed(task.getUserId(), "events", task.getId(), sequence);
  }

  public void enqueueStops(UUID userId, UUID operationId) {
    jdbc.sql(
            """
            INSERT INTO operation_items(operation_id,item_key,target_id,phase)
            SELECT :operation,id::text,id,'STOP_TASK' FROM tasks WHERE user_id=:user
            AND state NOT IN ('DRAFT','COMPLETED','FAILED','CANCELLED') ON CONFLICT DO NOTHING
            """)
        .param("operation", operationId)
        .param("user", userId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_sessions SET state='STOPPING',version=version+1
            WHERE user_id=:user AND task_id IS NULL AND binding_released_at IS NULL
            """)
        .param("user", userId)
        .update();
  }

  public record StopTarget(UUID operationId, UUID taskId, UUID userId) {}

  public List<StopTarget> pendingStops() {
    return jdbc.sql(
            """
            SELECT i.operation_id,i.target_id task_id,t.user_id FROM operation_items i
            JOIN tasks t ON t.id=i.target_id WHERE i.phase='STOP_TASK' AND i.state='PENDING'
            ORDER BY t.user_id,t.id LIMIT 100
            """)
        .query(StopTarget.class)
        .list();
  }

  public void stopRequested(StopTarget target) {
    jdbc.sql(
            """
            UPDATE operation_items SET state='RUNNING',version=version+1,updated_at=now()
            WHERE operation_id=:operation AND target_id=:task AND phase='STOP_TASK'
            """)
        .param("operation", target.operationId())
        .param("task", target.taskId())
        .update();
  }

  public boolean outstanding(UUID taskId) {
    return jdbc.sql(
                """
                SELECT count(*) FROM task_commands WHERE task_id=:task
                AND state IN ('ACCEPTED','WAITING_RESOURCE','DISPATCHED','STARTED')
                """)
            .param("task", taskId)
            .query(Long.class)
            .single()
        > 0;
  }

  public boolean resources(UUID taskId) {
    return jdbc.sql(
                """
                SELECT count(*) FROM browser_sessions s WHERE s.task_id=:task
                AND (s.binding_released_at IS NULL OR EXISTS(
                  SELECT 1 FROM browser_allocations a WHERE a.session_id=s.id AND a.state<>'RELEASED'))
                """)
            .param("task", taskId)
            .query(Long.class)
            .single()
        > 0;
  }

  public record StoppedTask(UUID userId, UUID taskId) {}

  public List<StoppedTask> uncompletedStops() {
    return jdbc.sql(
            """
            SELECT t.user_id,t.id task_id FROM tasks t
            WHERE (t.state='STOPPING' OR (t.state='CANCELLED' AND EXISTS(
              SELECT 1 FROM operations o WHERE o.user_id=t.user_id AND o.target_type='task'
              AND o.target_id=t.id AND o.kind='tasks.stop:'||t.id::text
              AND o.state IN ('PENDING','RUNNING'))))
            AND NOT EXISTS(SELECT 1 FROM browser_sessions s WHERE s.task_id=t.id
              AND (s.binding_released_at IS NULL OR EXISTS(
                SELECT 1 FROM browser_allocations a WHERE a.session_id=s.id AND a.state<>'RELEASED')))
            ORDER BY t.user_id,t.id LIMIT 100
            """)
        .query(StoppedTask.class)
        .list();
  }

  public List<UUID> cancelUnstarted(UUID taskId, String code) {
    return jdbc.sql(
            """
            UPDATE task_commands SET state='CANCELLED',failure_code=:code,finished_at=now(),version=version+1
            WHERE task_id=:task AND state IN ('ACCEPTED','WAITING_RESOURCE','DISPATCHED')
            RETURNING id
            """)
        .param("task", taskId)
        .param("code", code)
        .query(UUID.class)
        .list();
  }

  public boolean cancelActionRequests(UUID taskId) {
    return jdbc.sql(
                """
                UPDATE user_action_requests SET status='CANCELLED',resolved_at=now(),version=version+1
                WHERE task_id=:task AND status='OPEN'
                """)
            .param("task", taskId)
            .update()
        > 0;
  }

  public UUID startedCommand(UUID taskId) {
    return jdbc.sql("SELECT id FROM task_commands WHERE task_id=:task AND state='STARTED'")
        .param("task", taskId)
        .query(UUID.class)
        .optional()
        .orElse(null);
  }

  public void clarification(
      TaskAggregate task, UUID id, String text, UUID afterCommand, String disposition) {
    jdbc.sql(
            """
            INSERT INTO task_clarifications(id,task_id,user_id,revision,text,after_command_id,disposition)
            VALUES(:id,:task,:user,:revision,:text,:after,:disposition)
            """)
        .param("id", id)
        .param("task", task.getId())
        .param("user", task.getUserId())
        .param("revision", task.getInstructionRevision())
        .param("text", text)
        .param("after", afterCommand)
        .param("disposition", disposition)
        .update();
  }

  public List<Map<String, Object>> clarifications(UUID taskId, long afterRevision, int limit) {
    return jdbc.sql(
            """
            SELECT id,revision,text,after_command_id AS "afterCommandId",disposition,accepted_at AS "acceptedAt"
            FROM task_clarifications WHERE task_id=:task AND revision>:revision ORDER BY revision LIMIT :limit
            """)
        .param("task", taskId)
        .param("revision", afterRevision)
        .param("limit", limit)
        .query()
        .listOfRows();
  }

  public EventPage events(UUID userId, UUID taskId, PageQuery query) {
    var types = eventTypes(query);
    String direction = query.direction() == null ? "desc" : query.direction();
    try {
      // Both queries share the owner's repeatable-read transaction and bounded SQL budget.
      jdbc.sql("SELECT set_config('statement_timeout','2s',true)").query(String.class).single();
      var counter =
          jdbc.sql(
                  """
                  SELECT c.next_sequence-1 AS sequence,c.snapshot_key FROM task_event_counters c
                  JOIN tasks t ON t.id=c.task_id WHERE c.task_id=:task AND t.user_id=:user
                  """)
              .param("task", taskId)
              .param("user", userId)
              .query(
                  (row, number) ->
                      new EventCounter(row.getLong("sequence"), row.getString("snapshot_key")))
              .optional()
              .orElseThrow(TaskQueries::expiredEventSnapshot);
      String fingerprint =
          json.digest(
              Map.of(
                  "user",
                  userId,
                  "task",
                  taskId,
                  "q",
                  query.query(),
                  "types",
                  types,
                  "sort",
                  "sequence",
                  "direction",
                  direction,
                  "pageSize",
                  EVENT_PAGE_SIZE));
      var snapshot = eventSnapshot(query.snapshot(), counter, fingerprint);
      return eventPage(taskId, query, types, direction, snapshot);
    } catch (QueryTimeoutException error) {
      throw new DomainException(
          503, "EVENT_HISTORY_QUERY_TIMEOUT", "History query exceeded its time limit");
    }
  }

  private EventPage eventPage(
      UUID taskId, PageQuery query, Set<String> types, String direction, EventSnapshot snapshot) {
    String where =
        " WHERE task_id=:task AND sequence<=:sequence AND type IN (:types) AND summary ILIKE :q";
    long total =
        jdbc.sql("SELECT count(*) FROM task_execution_events" + where)
            .param("task", taskId)
            .param("sequence", snapshot.sequence())
            .param("types", types)
            .param("q", query.escapedQuery())
            .query(Long.class)
            .single();
    var rows =
        jdbc.sql(
                """
                SELECT event_id id,sequence,type,code,summary,occurred_at AS "occurredAt"
                FROM task_execution_events
                """
                    + where
                    + " ORDER BY sequence "
                    + direction
                    + " LIMIT :limit OFFSET :offset")
            .param("task", taskId)
            .param("sequence", snapshot.sequence())
            .param("types", types)
            .param("q", query.escapedQuery())
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query()
            .listOfRows();
    return new EventPage(
        rows,
        total,
        query.page(),
        EVENT_PAGE_SIZE,
        Map.of("field", "sequence", "direction", direction),
        snapshot.token(),
        new EventPageMeta(snapshot.sequence()));
  }

  private static Set<String> eventTypes(PageQuery query) {
    if (query.pageSize() != EVENT_PAGE_SIZE
        || query.offset() > MAX_EVENT_OFFSET
        || query.sort() != null && !query.sort().equals("sequence")) {
      throw new DomainException(
          422,
          "INVALID_EVENT_PAGINATION",
          "History requires ten rows, sequence ordering and an offset at most 100000");
    }
    for (var entry : query.filters().entrySet()) {
      if (!EVENT_PARAMETERS.contains(entry.getKey())
          || !entry.getKey().equals("type") && entry.getValue().size() != 1) {
        throw new DomainException(
            422, "INVALID_EVENT_FILTER", "Unsupported history query parameter");
      }
    }
    List<String> requested = query.filters().get("type");
    Set<String> types = new TreeSet<>(requested == null ? EVENT_TYPES : requested);
    if (types.isEmpty()
        || requested != null && requested.size() > EVENT_TYPES.size()
        || !EVENT_TYPES.containsAll(types)) {
      throw new DomainException(422, "INVALID_EVENT_FILTER", "Unsupported history event type");
    }
    if (query.page() != 1 && query.snapshot() == null) {
      throw new DomainException(
          422, "EVENT_SNAPSHOT_REQUIRED", "Open the first history page before paging");
    }
    return types;
  }

  private static EventSnapshot eventSnapshot(
      String token, EventCounter counter, String fingerprint) {
    if (token == null) {
      String payload =
          "1:"
              + counter.sequence()
              + ":"
              + Instant.now().plusSeconds(EVENT_SNAPSHOT_SECONDS).getEpochSecond()
              + ":"
              + fingerprint;
      String encoded =
          Base64.getUrlEncoder()
              .withoutPadding()
              .encodeToString(payload.getBytes(StandardCharsets.UTF_8));
      return new EventSnapshot(
          counter.sequence(), encoded + "." + eventSignature(encoded, counter.key()));
    }
    try {
      if (token.length() > 512) {
        throw expiredEventSnapshot();
      }
      String[] parts = token.split("\\.", -1);
      if (parts.length != 2
          || !MessageDigest.isEqual(
              parts[1].getBytes(StandardCharsets.US_ASCII),
              eventSignature(parts[0], counter.key()).getBytes(StandardCharsets.US_ASCII))) {
        throw expiredEventSnapshot();
      }
      String[] payload =
          new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8)
              .split(":", -1);
      if (payload.length != 4
          || !payload[0].equals("1")
          || !payload[3].equals(fingerprint)
          || Instant.now().getEpochSecond() >= Long.parseLong(payload[2])) {
        throw expiredEventSnapshot();
      }
      long sequence = Long.parseLong(payload[1]);
      if (sequence < 0 || sequence > counter.sequence()) {
        throw expiredEventSnapshot();
      }
      return new EventSnapshot(sequence, token);
    } catch (IllegalArgumentException error) {
      throw expiredEventSnapshot();
    }
  }

  private static String eventSignature(String payload, String key) {
    try {
      Mac hmac = Mac.getInstance("HmacSHA256");
      hmac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      return Base64.getUrlEncoder()
          .withoutPadding()
          .encodeToString(hmac.doFinal(payload.getBytes(StandardCharsets.US_ASCII)));
    } catch (GeneralSecurityException error) {
      throw new IllegalStateException("History snapshot signing is unavailable", error);
    }
  }

  private static DomainException expiredEventSnapshot() {
    return DomainException.conflict("LIST_SNAPSHOT_EXPIRED", "Refresh the current history");
  }

  private record EventCounter(long sequence, String key) {}

  private record EventSnapshot(long sequence, String token) {}

  public void verifyFinalResult(UUID taskId, UUID resultId, long revision) {
    int updated =
        jdbc.sql(
                """
                UPDATE task_results SET final=true WHERE task_id=:task AND id=:result AND revision=:revision
                """)
            .param("task", taskId)
            .param("result", resultId)
            .param("revision", revision)
            .update();
    if (updated != 1) {
      throw DomainException.conflict("RESULT_REVISION_CONFLICT", "Result revision is unavailable");
    }
  }

  public boolean resolved(UUID taskId, UUID resolutionId) {
    return resolutionId != null
        && jdbc.sql(
                    """
                    SELECT count(*) FROM operations WHERE id=:id AND target_id=:task AND kind='RECONCILE_EFFECT'
                    AND state='SUCCEEDED' AND reconciliation_outcome IN ('APPLIED','NOT_APPLIED')
                    """)
                .param("id", resolutionId)
                .param("task", taskId)
                .query(Long.class)
                .single()
            == 1;
  }
}
