package ru.helmglass.api.tasks;

import java.net.URI;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.connections.ConnectionSite;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.mcp.ChatBindings;
import tools.jackson.databind.JsonNode;

@Service
public class TaskService {
  public static final Set<String> TERMINAL =
      Set.of("SUCCEEDED", "PARTIAL", "NOT_ACHIEVED", "FAILED", "STOPPED");
  public static final String SELECT =
"""
SELECT t.*,
  CASE WHEN t.accepted_at IS NOT NULL THEN
    greatest(0,extract(epoch FROM coalesce(t.completed_at,statement_timestamp())-t.accepted_at))
    END elapsed_seconds,
  (SELECT count(*) FROM task_steps s WHERE s.task_id=t.id) step_count,
  EXISTS(SELECT 1 FROM operations o WHERE o.task_id=t.id AND o.status='UNKNOWN') unknown_action,
  EXISTS(SELECT 1 FROM operations o WHERE o.task_id=t.id AND o.status='DISPATCHED') dispatched_action,
  EXISTS(SELECT 1 FROM mcp_task_chats c WHERE c.task_id=t.id) chat_bound,
  (SELECT jsonb_build_object('status',c.continuation_status,'reason',c.continuation_reason)
    FROM mcp_chats c JOIN mcp_task_chats binding
      ON binding.owner_id=c.owner_id AND binding.chat_id=c.chat_id
    WHERE binding.task_id=t.id AND c.task_id=t.id)::text continuation_json,
  coalesce((SELECT coalesce(s.result,s.title) FROM task_steps s WHERE s.task_id=t.id
    AND s.status IN ('RUNNING','WAITING','UNKNOWN') LIMIT 1),t.result->>'summary',
    (SELECT coalesce(s.result,s.title) FROM task_steps s WHERE s.task_id=t.id
    ORDER BY s.updated_at DESC,s.sequence DESC LIMIT 1)) task_summary,
  (SELECT jsonb_build_object('id',r.id,'type',r.type,'prompt',r.prompt,'version',r.version,
    'instructionRevision',r.instruction_revision,
    'options',r.options,'operationId',r.operation_id) FROM task_requests r
    WHERE r.task_id=t.id AND r.status='PENDING')::text request_json,
  (SELECT jsonb_build_object('requestId',r.id,'requestVersion',r.version,
    'instructionRevision',r.instruction_revision,'type',r.type,'prompt',r.prompt,
    'operationId',r.operation_id,'command',r.answer_command,'text',r.answer,
    'connectionId',r.answer_connection_id,'answeredAt',r.answered_at)
    FROM task_requests r WHERE r.task_id=t.id AND r.status='ANSWERED'
      AND r.instruction_revision=t.instruction_revision AND r.answer_command IS NOT NULL
    ORDER BY r.answered_at DESC,r.id DESC LIMIT 1)::text response_json,
  (SELECT jsonb_build_object('id',b.id,'status',b.status,'nodeId',b.node_id,
    'controlOwner',b.control_owner,'controlEpoch',b.control_epoch,'privateMode',b.private_mode,
    'currentUrl',CASE WHEN b.private_mode THEN NULL ELSE b.current_url END,
    'canView',b.status='LIVE','canControl',b.status='LIVE','version',b.version,
    'profileSaveError',c.profile_save_error,'taskId',b.task_id,'connectionId',b.connection_id,
    'loginConfirmed',b.login_confirmed,'startedAt',b.started_at,'closedAt',b.closed_at,
    'idleCloseAt',b.idle_close_at,'idleTimeoutSeconds',b.idle_timeout_seconds,
    'idleWarningAt',b.idle_warning_at,'cleanupState',b.cleanup_state,
    'cleanupError',b.cleanup_error,'closeReason',b.close_reason)
    FROM browser_sessions b
    LEFT JOIN connections c ON c.id=coalesce(b.pending_connection_id,b.connection_id)
    WHERE b.id=t.browser_session_id)::text browser_json,
  (SELECT jsonb_build_object(
    'browserSeconds',coalesce(sum(extract(epoch FROM coalesce(u.ended_at,now())-u.started_at)) FILTER(WHERE u.kind='BROWSER'),0),
    'executionSeconds',coalesce(sum(extract(epoch FROM coalesce(u.ended_at,now())-u.started_at)) FILTER(WHERE u.kind='EXECUTION'),0),
    'manualSeconds',coalesce(sum(extract(epoch FROM coalesce(u.ended_at,now())-u.started_at)) FILTER(WHERE u.kind='MANUAL'),0),
    'incomplete',coalesce(bool_or(u.incomplete),false)) FROM usage_intervals u WHERE u.task_id=t.id)::text usage_json,
  (SELECT jsonb_build_object('count',count(*),
    'mediaBytes',coalesce(sum(a.size_bytes) FILTER(WHERE a.status='READY'),0),
    'mediaSeconds',coalesce(sum(a.duration_seconds) FILTER(WHERE a.status='READY' AND a.mime_type LIKE 'audio/%'),0),
    'durationKnown',NOT coalesce(bool_or(a.status='READY' AND a.mime_type LIKE 'audio/%' AND a.duration_seconds IS NULL),false))
    FROM artifacts a WHERE a.task_id=t.id)::text artifact_totals_json
FROM tasks t
""";
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final EventService events;
  private final Identity identity;
  private final ChatBindings chats;

  public TaskService(
      JdbcClient jdbc,
      JsonSupport json,
      EventService events,
      Identity identity,
      ChatBindings chats) {
    this.jdbc = jdbc;
    this.json = json;
    this.events = events;
    this.identity = identity;
    this.chats = chats;
  }

  public Contracts.Task get(UUID owner, UUID id) {
    return jdbc.sql(SELECT + " WHERE t.id=:id AND t.owner_id=:owner")
        .param("id", id)
        .param("owner", owner)
        .query(this::map)
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  public Contracts.Page<Contracts.Task> list(UUID owner, ListQuery query) {
    var filter = query.tasks(new ListQuery.UUIDOwner(owner), true);
    long total =
        jdbc.sql("SELECT count(*) FROM tasks t WHERE " + filter.where())
            .params(filter.parameters())
            .query(Long.class)
            .single();
    String order =
        switch (query.sort() == null ? "" : query.sort()) {
          case "title" -> "coalesce(nullif(title,''),nullif(goal,''),'Черновик без названия')";
          case "status" -> "status";
          case "site" -> "site";
          case "source" -> "source";
          case "createdAt" -> "created_at";
          case "summary" -> "task_summary";
          case "elapsedSeconds" -> "elapsed_seconds";
          case "executionSeconds" -> "(usage_json::jsonb->>'executionSeconds')::numeric";
          case "manualSeconds" -> "(usage_json::jsonb->>'manualSeconds')::numeric";
          case "mediaBytes" -> "(artifact_totals_json::jsonb->>'mediaBytes')::bigint";
          case "mediaSeconds" ->
              "CASE WHEN (artifact_totals_json::jsonb->>'durationKnown')::boolean"
                  + " THEN (artifact_totals_json::jsonb->>'mediaSeconds')::numeric END";
          default -> "updated_at";
        };
    var items =
        jdbc.sql(
                "SELECT listed.* FROM ("
                    + SELECT
                    + " WHERE "
                    + filter.where()
                    + ") listed ORDER BY "
                    + order
                    + (query.ascending() ? " ASC" : " DESC")
                    + " NULLS LAST,id"
                    + " LIMIT :limit OFFSET :offset")
            .params(filter.parameters())
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(this::map)
            .list();
    return new Contracts.Page<>(items, total, query.page(), query.pageSize());
  }

  public Map<String, Object> summary(UUID owner, ListQuery query) {
    var filter = query.tasks(new ListQuery.UUIDOwner(owner), false);
    return jdbc.sql(
            """
            SELECT count(*) total,
              count(*) FILTER(WHERE status IN ('STARTING','RUNNING','PAUSING','STOPPING')) active,
              count(*) FILTER(WHERE status='SUCCEEDED') succeeded,
              count(*) FILTER(WHERE status='WAITING_USER') AS "waitingForYou"
            FROM tasks t WHERE
            """
                + filter.where())
        .params(filter.parameters())
        .query()
        .singleRow();
  }

  @Transactional
  public Map<String, Boolean> deleteDraft(UUID owner, UUID id) {
    lockTask(owner, id);
    if (!"DRAFT".equals(get(owner, id).status())) {
      throw ApiException.conflict("NOT_A_DRAFT", "Удалить можно только черновик.");
    }
    for (String table : List.of("mcp_chats", "mcp_task_chats", "task_history", "task_steps")) {
      jdbc.sql("DELETE FROM " + table + " WHERE task_id=:id AND owner_id=:owner")
          .param("id", id)
          .param("owner", owner)
          .update();
    }
    jdbc.sql("DELETE FROM tasks WHERE id=:id AND owner_id=:owner")
        .param("id", id)
        .param("owner", owner)
        .update();
    events.emit(owner, "task", id, 0);
    return Map.of("deleted", true);
  }

  @Transactional
  public Contracts.Task create(UUID owner, Contracts.TaskInput input, String source) {
    identity.requireActive(owner);
    lockOwner(owner);
    boolean prepare = Boolean.TRUE.equals(input.prepare());
    validate(input, prepare);
    validateConnections(owner, input.preferredConnectionIds());
    if (prepare) {
      checkWaitingAdmission(owner);
    }
    UUID id = UUID.randomUUID();
    String goal = value(input.goal());
    String title =
        input.title() == null || input.title().isBlank()
            ? (goal.isBlank() ? "Новая задача" : goal.substring(0, Math.min(100, goal.length())))
            : input.title().trim();
    String url = blankNull(input.startUrl());
    long sequence = events.emit(owner, "task", id, 1);
    jdbc.sql(
"""
INSERT INTO tasks(id,owner_id,title,goal,start_url,site,output_format,
  preferred_connection_ids,source,status,accepted_at,accepted_sequence)
VALUES (:id,:owner,:title,:goal,:url,:site,:format,CAST(:connections AS jsonb),
  :source,:status,CASE WHEN :prepare THEN now() ELSE NULL END,:sequence)
""")
        .param("id", id)
        .param("owner", owner)
        .param("title", title)
        .param("goal", goal)
        .param("url", url)
        .param("site", site(url))
        .param("format", format(input.outputFormat()))
        .param(
            "connections",
            json.write(
                input.preferredConnectionIds() == null
                    ? List.of()
                    : input.preferredConnectionIds()))
        .param("source", source)
        .param("status", prepare ? "WAITING_CHATGPT" : "DRAFT")
        .param("prepare", prepare)
        .param("sequence", prepare ? sequence : null)
        .update();
    history(
        owner,
        id,
        "CREATED",
        prepare ? "Задача подготовлена для ChatGPT" : "Черновик сохранён",
        null);
    if (prepare) {
      events.emitAdministrators("admin-user", owner, 1);
    }
    return get(owner, id);
  }

  @Transactional
  public Contracts.Task command(Actor actor, UUID id, Contracts.TaskCommand command) {
    UUID owner = actor.id();
    identity.requireActive(owner);
    lockOwner(owner);
    lockTask(owner, id);
    Contracts.Task task = get(owner, id);
    String type = required(command.type(), "type", 60);
    if (Set.of("ANSWER", "CONFIRM", "REJECT", "CHOOSE_CONNECTION").contains(type)) {
      throw ApiException.conflict(
          "HOST_RESPONSE_REQUIRED",
          "Ответ принимается только через запрос пользователя в исходном чате GPT.");
    }
    if (command.expectedVersion() == null || command.expectedVersion() != task.version()) {
      throw ApiException.conflict(
          "STALE_VERSION", "Задача изменилась. Проверьте актуальное поручение.");
    }
    switch (type) {
      case "PREPARE" -> {
        if (!"DRAFT".equals(task.status())) {
          throw unavailable();
        }
        validate(
            new Contracts.TaskInput(
                task.title(),
                task.goal(),
                task.startUrl(),
                task.outputFormat(),
                task.preferredConnectionIds(),
                true),
            true);
        checkWaitingAdmission(owner);
        long accepted = events.emit(owner, "task", id, task.version() + 1);
        jdbc.sql("UPDATE tasks SET accepted_at=now(),accepted_sequence=:sequence WHERE id=:id")
            .param("sequence", accepted)
            .param("id", id)
            .update();
        change(owner, id, "WAITING_CHATGPT", null, "Задача подготовлена для ChatGPT");
      }
      case "AMEND" -> {
        if ("WEB".equals(actor.channel()) && !"DRAFT".equals(task.status())) {
          throw ApiException.conflict(
              "ORIGINAL_CHAT_REQUIRED", "Уточните задачу в исходном чате GPT.");
        }
        amend(owner, task, command);
      }
      case "RESUME" -> resume(owner, task, command);
      case "STOP" -> requestStop(owner, id);
      case "CLOSE_BROWSER" -> {
        if (!"WEB".equals(actor.channel())) {
          throw Identity.denied("Закрытие браузера доступно в кабинете.");
        }
        closeBrowser(owner, id);
      }
      case "FINISH" -> finish(owner, task, command.outcome(), command.text());
      default -> throw ApiException.invalid("type", "Неизвестная команда задачи.");
    }
    return get(owner, id);
  }

  @Transactional
  public void closeBrowser(UUID owner, UUID id) {
    closeBrowser(owner, id, "USER");
  }

  @Transactional
  public void closeBrowser(UUID owner, UUID id, String reason) {
    identity.requireActive(owner);
    lockOwner(owner);
    lockTask(owner, id);
    Contracts.Task task = get(owner, id);
    if (task.browser() == null
        || "DRAFT".equals(task.status())
        || "STOPPING".equals(task.status())) {
      throw unavailable();
    }
    if (Set.of("CLOSED", "LOST").contains(task.browser().status())) {
      return;
    }
    boolean alreadyClosing =
        jdbc.sql("SELECT close_requested FROM browser_sessions WHERE id=:id")
            .param("id", task.browser().id())
            .query(Boolean.class)
            .single();
    if (alreadyClosing) {
      return;
    }
    if (!TERMINAL.contains(task.status())) {
      boolean recovering = "IDLE_TIMEOUT".equals(reason)
          && task.request() != null && "UNKNOWN_RESULT".equals(task.request().type())
          && !task.browser().privateMode()
          && !"USER".equals(task.browser().controlOwner())
          && !jdbc.sql("SELECT paused_explicitly FROM tasks WHERE id=:id")
              .param("id", id).query(Boolean.class).single();
      if (!recovering) {
        jdbc.sql(
              """
              UPDATE tasks SET browser_resume_allowed=NOT paused_explicitly,
                paused_explicitly=true WHERE id=:id
              """)
          .param("id", id)
          .update();
      }
      suspendBrowserWork(id);
      String next = hasDispatched(id) ? "PAUSING" : "PAUSED";
      if (recovering) {
        next = waitingStatus(task.request().type());
      }
      change(
          owner,
          id,
          next,
          task.waitReason(),
          "IDLE_TIMEOUT".equals(reason)
              ? "Браузер закрывается после простоя. Задача сохранена."
              : "Закрытие браузера запрошено. Задача остаётся на паузе.");
      if (recovering) {
        requestContinuation(id);
      }
    }
    closeTaskBrowsers(id);
    jdbc.sql("UPDATE browser_sessions SET close_reason=:reason,idle_close_at=NULL WHERE id=:id")
        .param("reason", reason)
        .param("id", task.browser().id())
        .update();
    events.emit(owner, "browser", task.browser().id(), 0);
  }

  /** Preserve an existing question or unknown effect when execution is physically lost. */
  @Transactional
  public void browserLost(UUID owner, UUID id) {
    lockOwner(owner);
    lockTask(owner, id);
    Contracts.Task task = get(owner, id);
    if (TERMINAL.contains(task.status()) || "STOPPING".equals(task.status())) {
      return;
    }
    if (task.request() == null && !hasUnknown(id)) {
      request(
          owner,
          id,
          "BROWSER_LOST",
          "Браузер утрачен. Для продолжения потребуется согласие на новый браузер.",
          null,
          null);
      return;
    }
    boolean paused = jdbc.sql("SELECT paused_explicitly FROM tasks WHERE id=:id")
        .param("id", id).query(Boolean.class).single();
    if (!paused && task.request() != null && "UNKNOWN_RESULT".equals(task.request().type())
        && (task.browser() == null
            || !task.browser().privateMode() && !"USER".equals(task.browser().controlOwner()))) {
      change(owner, id, waitingStatus(task.request().type()), "UNKNOWN_RESULT",
          "Браузер будет восстановлен для проверки результата ChatGPT.");
      requestContinuation(id);
      return;
    }
    jdbc.sql(
            """
            UPDATE tasks SET browser_resume_allowed=NOT paused_explicitly,paused_explicitly=true
            WHERE id=:id
            """)
        .param("id", id)
        .update();
    change(
        owner,
        id,
        "PAUSED",
        task.waitReason(),
        "Браузер утрачен. Сохранённый запрос и неизвестный результат остаются актуальными.");
  }

  /** Reopening the browser only removes the hold introduced by its closure. */
  @Transactional
  public void resumeWithBrowser(UUID owner, UUID id) {
    lockOwner(owner);
    lockTask(owner, id);
    jdbc.sql(
            """
            UPDATE tasks SET paused_explicitly=paused_explicitly AND NOT browser_resume_allowed,
              browser_resume_allowed=false WHERE id=:id
            """)
        .param("id", id)
        .update();
  }

  @Transactional
  public void browserReady(UUID owner, UUID id) {
    lockOwner(owner);
    lockTask(owner, id);
    Contracts.Task task = get(owner, id);
    if (TERMINAL.contains(task.status()) || "STOPPING".equals(task.status())) {
      return;
    }
    boolean paused =
        jdbc.sql("SELECT paused_explicitly FROM tasks WHERE id=:id")
            .param("id", id)
            .query(Boolean.class)
            .single();
    String reason = task.request() == null ? null : task.request().type();
    if (task.browser() != null && task.browser().privateMode()) {
      reason = "LOGIN";
    }
    String state = "WAITING_CHATGPT";
    if (paused) {
      state = "PAUSED";
    } else if (reason != null) {
      state = waitingStatus(reason);
    }
    change(
        owner,
        id,
        state,
        reason,
        paused ? "Браузер открыт. Сохранена прежняя пауза." : "Браузер готов");
    if ("BROWSER_OPEN_REQUESTED".equals(task.waitReason())) {
      requestContinuation(id);
    }
  }

  @Transactional
  public Contracts.Task selectConnection(
      UUID owner,
      UUID taskId,
      long instructionRevision,
      UUID connectionId,
      String confirmationPrompt) {
    identity.requireActive(owner);
    lockOwner(owner);
    lockTask(owner, taskId);
    Contracts.Task task = get(owner, taskId);
    String confirmation =
        confirmationPrompt == null
            ? null
            : required(confirmationPrompt, "confirmationPrompt", 4000);
    if (task.instructionRevision() != instructionRevision) {
      throw ApiException.conflict("STALE_INSTRUCTION", "Поручение изменилось.");
    }
    if (TERMINAL.contains(task.status())
        || Set.of("DRAFT", "PAUSING", "STOPPING").contains(task.status())
        || task.request() != null
        || hasDispatched(taskId)
        || hasUnknown(taskId)) {
      throw ApiException.conflict(
          "ACTION_UNRESOLVED", "Сначала завершите текущее действие или запрос участия.");
    }
    validateConnections(owner, List.of(connectionId));
    String url =
        jdbc.sql(
                "SELECT start_url FROM connections WHERE id=:id AND owner_id=:owner AND deleted_at"
                    + " IS NULL")
            .param("id", connectionId)
            .param("owner", owner)
            .query(String.class)
            .optional()
            .orElseThrow(ApiException::notFound);
    if (!ConnectionSite.matches(site(url), task.site())) {
      throw ApiException.invalid("connectionId", "Подключение не относится к сайту задачи.");
    }
    boolean loginRequired =
        !jdbc.sql("SELECT status='READY' FROM connections WHERE id=:id")
            .param("id", connectionId)
            .query(Boolean.class)
            .single();
    boolean existingBrowser =
        task.browser() != null && !Set.of("CLOSED", "LOST").contains(task.browser().status());
    if ((!existingBrowser || loginRequired) && confirmation == null) {
      jdbc.sql("UPDATE tasks SET selected_connection_id=:connection WHERE id=:task")
          .param("connection", connectionId)
          .param("task", taskId)
          .update();
      return get(owner, taskId);
    }
    if (existingBrowser
        && (!"LIVE".equals(task.browser().status())
            || !"CHATGPT".equals(task.browser().controlOwner())
            || task.browser().privateMode())) {
      throw ApiException.conflict(
          "BROWSER_UNAVAILABLE", "Дождитесь доступного браузера под управлением ChatGPT.");
    }
    UUID current =
        !existingBrowser
            ? null
            : jdbc.sql("SELECT connection_id FROM browser_sessions WHERE id=:id")
                .param("id", task.browser().id())
                .query((row, index) -> row.getObject("connection_id", UUID.class))
                .optional()
                .orElse(null);
    if (connectionId.equals(current)) {
      return task;
    }
    URI parsed = URI.create(url);
    JsonNode savedOrigins =
        json.read(
            jdbc.sql("SELECT authorized_origins::text FROM connections WHERE id=:id")
                .param("id", connectionId)
                .query(String.class)
                .single());
    List<String> origins = new ArrayList<>();
    savedOrigins.forEach(origin -> origins.add(origin.asString()));
    if (origins.isEmpty()) {
      origins.add(parsed.getScheme() + "://" + parsed.getAuthority());
    }
    // A related destination may not have been visited when the account was saved.
    // Confirm that origin for this switch without copying storage between origins.
    URI destination = URI.create(task.startUrl());
    String destinationOrigin = destination.getScheme() + "://" + destination.getAuthority();
    if (!origins.contains(destinationOrigin)) {
      if (origins.size() >= 50) {
        throw ApiException.conflict(
            "PROFILE_ORIGIN_LIMIT", "Область подключения превышает 50 сайтов.");
      }
      origins.add(destinationOrigin);
    }
    var arguments =
        Map.of(
            "connectionId",
            connectionId,
            "ownerId",
            owner,
            "origins",
            origins,
            "url",
            task.startUrl());
    UUID operation = UUID.randomUUID();
    Map<String, Object> instruction = new HashMap<>();
    instruction.put("revision", instructionRevision);
    instruction.put("title", task.title());
    instruction.put("goal", task.goal());
    if (existingBrowser) {
      instruction.put("browserId", task.browser().id());
    }
    if (confirmation != null) {
      instruction.put("confirmationPrompt", confirmation);
    }
    jdbc.sql(
"""
INSERT INTO operations(id,owner_id,task_id,type,arguments,status,mutating,instruction_revision,control_epoch,instruction_snapshot)
VALUES (:id,:owner,:task,'applyConnection',CAST(:arguments AS jsonb),:status,true,:revision,:epoch,CAST(:instruction AS jsonb))
""")
        .param("id", operation)
        .param("owner", owner)
        .param("task", taskId)
        .param("arguments", json.write(arguments))
        .param("status", confirmation == null ? "ACCEPTED" : "AWAITING_CONFIRMATION")
        .param("revision", instructionRevision)
        .param("epoch", existingBrowser ? task.browser().controlEpoch() : null)
        .param("instruction", json.write(instruction))
        .update();
    if (confirmation != null) {
      request(owner, taskId, "CONFIRMATION", confirmation, operation, null);
    } else if (existingBrowser
        && jdbc.sql(
                """
                SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE id<>:session
                  AND (connection_id=:connection OR pending_connection_id=:connection)
                  AND status NOT IN ('CLOSED','LOST'))
                """)
            .param("session", task.browser().id())
            .param("connection", connectionId)
            .query(Boolean.class)
            .single()) {
      change(
          owner,
          taskId,
          "WAITING_CHATGPT",
          "CONNECTION_BUSY",
          "Выбранное подключение занято другим браузером.");
    }
    return get(owner, taskId);
  }

  private void amend(UUID owner, Contracts.Task task, Contracts.TaskCommand command) {
    var input =
        new Contracts.TaskInput(
            command.title(),
            command.goal(),
            command.startUrl(),
            command.outputFormat(),
            command.preferredConnectionIds(),
            false);
    validate(input, !"DRAFT".equals(task.status()));
    validateConnections(owner, input.preferredConnectionIds());
    cancelQueued(task.id());
    cancelRequest(task.id());
    cancelContinuation(task.id());
    jdbc.sql(
"""
UPDATE tasks SET goal=:goal,title=:title,start_url=:url,site=:site,output_format=:format,
  preferred_connection_ids=CAST(:connections AS jsonb),
  instruction_revision=instruction_revision+1 WHERE id=:id
""")
        .param("goal", value(input.goal()))
        .param("title", input.title() == null ? task.title() : input.title())
        .param("url", blankNull(input.startUrl()))
        .param("site", site(blankNull(input.startUrl())))
        .param("format", format(input.outputFormat()))
        .param(
            "connections",
            json.write(
                input.preferredConnectionIds() == null
                    ? task.preferredConnectionIds()
                    : input.preferredConnectionIds()))
        .param("id", task.id())
        .update();
    String status = task.status();
    String waitReason = null;
    if (!Set.of("DRAFT", "PAUSED", "PAUSING", "STOPPING").contains(status)
        && !TERMINAL.contains(status)) {
      if (task.browser() != null && "USER".equals(task.browser().controlOwner())) {
        status = "WAITING_USER";
        waitReason = task.browser().privateMode() ? "LOGIN" : "MANUAL_CONTROL";
      } else {
        status = hasDispatched(task.id()) ? "RUNNING" : "WAITING_CHATGPT";
      }
    }
    change(owner, task.id(), status, waitReason, "Поручение уточнено");
    if (hasUnknown(task.id())) {
      UUID operation =
          jdbc.sql(
                  "SELECT id FROM operations WHERE task_id=:task AND status='UNKNOWN' ORDER BY"
                      + " created_at LIMIT 1")
              .param("task", task.id())
              .query(UUID.class)
              .single();
      request(
          owner,
          task.id(),
          "UNKNOWN_RESULT",
          "Проверьте результат ранее отправленного действия.",
          operation,
          null);
    }
    requestContinuation(task.id());
  }

  private void resume(UUID owner, Contracts.Task task, Contracts.TaskCommand command) {
    if (Set.of("STOPPED", "STOPPING", "PAUSING", "DRAFT").contains(task.status())) {
      throw unavailable();
    }
    boolean unknown = hasUnknown(task.id());
    boolean verifyingUnknown =
        unknown
            && Set.of("WAITING_USER", "WAITING_CHATGPT").contains(task.status())
            && "UNKNOWN_RESULT".equals(task.waitReason())
            && task.request() != null
            && "UNKNOWN_RESULT".equals(task.request().type());
    if (unknown && !"PAUSED".equals(task.status()) && !verifyingUnknown) {
      throw ApiException.conflict("UNKNOWN_RESULT", "Сначала проверьте неизвестный результат.");
    }
    if (!TERMINAL.contains(task.status())
        && !"PAUSED".equals(task.status())
        && !verifyingUnknown
        && !(task.request() != null && "BROWSER_LOST".equals(task.request().type()))) {
      throw unavailable();
    }
    if (hasDispatched(task.id())
        || task.browser() != null && "CLOSING".equals(task.browser().status())) {
      throw ApiException.conflict(
          "BROWSER_CLOSING", "Дождитесь завершения действия и закрытия браузера.");
    }
    chats.activate(owner, task.id());
    if (task.browser() != null
        && Set.of("LOST", "CLOSED").contains(task.browser().status())
        && !unknown
        && !Boolean.TRUE.equals(command.confirmBrowserLoss())) {
      throw ApiException.conflict(
          "BROWSER_REPLACEMENT_CONSENT",
          "Продолжение откроет новый браузер. Несохранённая страница утрачена.");
    }
    jdbc.sql(
            """
            UPDATE tasks SET paused_explicitly=false,browser_resume_allowed=false,outcome=NULL,completed_at=NULL,
              instruction_revision=instruction_revision+CASE WHEN status IN
                ('SUCCEEDED','PARTIAL','NOT_ACHIEVED','FAILED') THEN 1 ELSE 0 END WHERE id=:id
            """)
        .param("id", task.id())
        .update();
    if (task.request() != null && "BROWSER_LOST".equals(task.request().type())) {
      cancelRequest(task.id());
    }
    boolean waitingUser = task.request() != null && !"BROWSER_LOST".equals(task.request().type());
    change(
        owner,
        task.id(),
        waitingUser ? waitingStatus(task.request().type()) : "WAITING_CHATGPT",
        waitingUser ? task.request().type() : null,
        "Разрешено продолжить исходную задачу");
    requestContinuation(task.id());
  }

  @Transactional
  public ElicitationClaim claimResponse(
      Actor actor,
      UUID taskId,
      String chat,
      UUID requestId,
      long requestVersion,
      String operationKey,
      Contracts.OperationVerification verification) {
    identity.requireGrant(actor);
    UUID owner = actor.id();
    lockOwner(owner);
    lockTask(owner, taskId);
    chats.requireCurrent(owner, taskId, chat);
    required(operationKey, "operationKey", 128);
    if (operationKey.length() < 8) {
      throw ApiException.invalid("operationKey", "Ключ операции слишком короткий.");
    }
    var previous =
        jdbc.sql(
                """
                SELECT status,version,elicitation_operation_key,elicitation_deadline,
                  verification::text
                FROM task_requests WHERE id=:request AND task_id=:task AND owner_id=:owner
                """)
            .param("request", requestId)
            .param("task", taskId)
            .param("owner", owner)
            .query(
                (row, index) ->
                    new ResponseAttempt(
                        row.getString("status"),
                        row.getLong("version"),
                        row.getString("elicitation_operation_key"),
                        Database.instant(row, "elicitation_deadline"),
                        row.getString("verification")))
            .optional()
            .orElseThrow(ApiException::notFound);
    if (previous.version() != requestVersion) {
      throw ApiException.conflict("STALE_REQUEST", "Этот запрос участия больше не актуален.");
    }
    if (verification != null
        && previous.verification() != null
        && !json.tree(verification).equals(json.read(previous.verification()))) {
      throw ApiException.conflict(
          "IDEMPOTENCY_CONFLICT", "Для этой операции уже сохранён другой результат проверки.");
    }
    if (jdbc.sql(
            "SELECT EXISTS(SELECT 1 FROM task_requests WHERE owner_id=:owner"
                + " AND elicitation_operation_key=:key AND id<>:id)")
        .param("owner", owner)
        .param("key", operationKey)
        .param("id", requestId)
        .query(Boolean.class)
        .single()) {
      throw ApiException.conflict("IDEMPOTENCY_CONFLICT", "Ключ уже использован другим запросом.");
    }
    if (operationKey.equals(previous.operationKey()) && "ANSWERED".equals(previous.status())) {
      return null;
    }
    Contracts.Task task = get(owner, taskId);
    Contracts.InteractionRequest request = task.request();
    if (request == null
        || !request.id().equals(requestId)
        || request.version() != requestVersion
        || request.instructionRevision() != task.instructionRevision()) {
      throw ApiException.conflict("STALE_REQUEST", "Этот запрос участия больше не актуален.");
    }
    if (verification != null && !"UNKNOWN_RESULT".equals(request.type())) {
      throw ApiException.conflict(
          "HOST_RESPONSE_REQUIRED", "Ответ на этот запрос должен дать пользователь в чате GPT.");
    }
    if (!Set.of("QUESTION", "CONFIRMATION", "ACCOUNT_CHOICE", "UNKNOWN_RESULT")
        .contains(request.type())) {
      throw ApiException.conflict(
          "HOST_RESPONSE_UNAVAILABLE", "Этот шаг выполняется в браузере задачи.");
    }
    if ("UNKNOWN_RESULT".equals(request.type())
        && jdbc.sql(
                "SELECT EXISTS(SELECT 1 FROM idempotency_records"
                    + " WHERE owner_id=:owner AND key=:key)")
            .param("owner", owner)
            .param("key", operationKey)
            .query(Boolean.class)
            .single()) {
      throw ApiException.conflict("IDEMPOTENCY_CONFLICT", "Ключ уже использован другим запросом.");
    }
    if (previous.deadline() != null && previous.deadline().isAfter(Instant.now())) {
      throw ApiException.conflict("ELICITATION_IN_PROGRESS", "Запрос уже обрабатывается.");
    }
    if (operationKey.equals(previous.operationKey()) && !"UNKNOWN_RESULT".equals(request.type())) {
      throw ApiException.conflict(
          "ELICITATION_NOT_REPLAYED",
          "Прежний запрос закрыт. Новый показ требует нового обращения пользователя.");
    }
    UUID attempt = UUID.randomUUID();
    Instant deadline = Instant.now().plusSeconds(300);
    if (actor.expiresAt().isBefore(deadline)) {
      deadline = actor.expiresAt();
    }
    jdbc.sql(
            """
            UPDATE task_requests SET elicitation_attempt_id=:attempt,
              elicitation_operation_key=:key,elicitation_deadline=:deadline,
              verification=coalesce(verification,CAST(:verification AS jsonb)) WHERE id=:request
            """)
        .param("attempt", attempt)
        .param("key", operationKey)
        .param("deadline", java.sql.Timestamp.from(deadline))
        .param("verification", verification == null ? null : json.write(verification))
        .param("request", requestId)
        .update();
    return new ElicitationClaim(taskId, request, attempt);
  }

  @Transactional
  public Contracts.Task validateResponse(Actor actor, String chat, ElicitationClaim claim) {
    identity.requireGrant(actor);
    lockOwner(actor.id());
    lockTask(actor.id(), claim.taskId());
    chats.requireCurrent(actor.id(), claim.taskId(), chat);
    boolean claimed =
        jdbc.sql(
                """
                SELECT EXISTS(SELECT 1 FROM task_requests WHERE id=:request AND owner_id=:owner
                  AND elicitation_attempt_id=:attempt AND elicitation_deadline>now() AND status='PENDING')
                """)
            .param("request", claim.request().id())
            .param("owner", actor.id())
            .param("attempt", claim.attemptId())
            .query(Boolean.class)
            .single();
    if (!claimed) {
      throw ApiException.conflict("STALE_REQUEST", "Запрос уже закрыт или устарел.");
    }
    Contracts.Task task = get(actor.id(), claim.taskId());
    if (task.request() == null
        || !task.request().id().equals(claim.request().id())
        || task.request().version() != claim.request().version()
        || task.instructionRevision() != claim.request().instructionRevision()) {
      throw ApiException.conflict("STALE_REQUEST", "Этот запрос участия больше не актуален.");
    }
    return task;
  }

  @Transactional
  public Contracts.Task respond(
      Actor actor,
      String chat,
      ElicitationClaim claim,
      String command,
      String text,
      UUID connection) {
    Contracts.Task task = validateResponse(actor, chat, claim);
    answer(
        actor,
        task,
        new RequestAnswer(
            claim.request().id(), claim.request().version(), command, text, connection));
    jdbc.sql(
            "UPDATE task_requests SET answer_source=:source,elicitation_attempt_id=NULL,"
                + " elicitation_deadline=NULL WHERE id=:id")
        .param(
            "source",
            "UNKNOWN_RESULT".equals(claim.request().type())
                ? "MCP_VERIFICATION"
                : "MCP_ELICITATION")
        .param("id", claim.request().id())
        .update();
    chats.acceptCommand(actor.id(), claim.taskId(), chat);
    return get(actor.id(), claim.taskId());
  }

  @Transactional
  public void releaseResponse(UUID owner, ElicitationClaim claim) {
    jdbc.sql(
            "UPDATE task_requests SET elicitation_attempt_id=NULL,elicitation_deadline=NULL"
                + " WHERE id=:id AND owner_id=:owner AND elicitation_attempt_id=:attempt")
        .param("id", claim.request().id())
        .param("owner", owner)
        .param("attempt", claim.attemptId())
        .update();
  }

  public record ElicitationClaim(
      UUID taskId, Contracts.InteractionRequest request, UUID attemptId) {}

  private record ResponseAttempt(
      String status, long version, String operationKey, Instant deadline, String verification) {}

  private record RequestAnswer(
      UUID requestId, long requestVersion, String type, String text, UUID connectionId) {}

  private void answer(Actor actor, Contracts.Task task, RequestAnswer command) {
    UUID owner = actor.id();
    Contracts.InteractionRequest request = task.request();
    if (request == null
        || !request.id().equals(command.requestId())
        || request.instructionRevision() != task.instructionRevision()
        || request.version() != command.requestVersion()) {
      throw ApiException.conflict("STALE_REQUEST", "Этот запрос участия больше не актуален.");
    }
    if ("UNKNOWN_RESULT".equals(request.type())) {
      required(command.text(), "text", 4000);
      if (!Set.of("CONFIRM", "REJECT", "PROCEED").contains(command.type())) {
        throw ApiException.invalid("type", "Укажите подтверждённый результат проверки.");
      }
    } else if ("CONFIRMATION".equals(request.type())) {
      if (!Set.of("CONFIRM", "REJECT").contains(command.type())) {
        throw ApiException.invalid("type", "Подтвердите или отклоните конкретное действие.");
      }
      int accepted =
          jdbc.sql(
                  "UPDATE operations SET status=:status WHERE id=:id AND task_id=:task"
                      + " AND instruction_revision=:revision AND status='AWAITING_CONFIRMATION'")
              .param("status", "CONFIRM".equals(command.type()) ? "ACCEPTED" : "CANCELLED")
              .param("id", request.operationId())
              .param("task", task.id())
              .param("revision", task.instructionRevision())
              .update();
      if (accepted != 1) {
        throw ApiException.conflict("STALE_REQUEST", "Операция подтверждения больше не актуальна.");
      }
    } else if ("CHOOSE_CONNECTION".equals(command.type())) {
      if (command.connectionId() == null) {
        throw ApiException.invalid("connectionId", "Выберите подключение.");
      }
      if (!"ACCOUNT_CHOICE".equals(request.type())) {
        throw ApiException.conflict(
            "STALE_REQUEST", "Этот запрос не предлагает выбор подключения.");
      }
      validateConnections(owner, List.of(command.connectionId()));
      boolean candidate =
          jdbc.sql(
                  "SELECT site,deleted_at IS NULL AND (:explicit OR status='READY') available FROM"
                      + " connections WHERE id=:id AND owner_id=:owner")
              .param("explicit", !request.options().isEmpty())
              .param("id", command.connectionId())
              .param("owner", owner)
              .query(
                  (row, index) ->
                      row.getBoolean("available")
                          && ConnectionSite.matches(row.getString("site"), task.site()))
              .optional()
              .orElse(false);
      boolean offered = request.options().isEmpty();
      for (JsonNode option : request.options()) {
        if (command.connectionId().toString().equals(option.path("id").asString())) {
          offered = true;
          break;
        }
      }
      if (!candidate || !offered) {
        throw ApiException.invalid(
            "connectionId", "Подключение не относится к этому запросу выбора.");
      }
    } else {
      if (!"QUESTION".equals(request.type()) || !"ANSWER".equals(command.type())) {
        throw ApiException.invalid("type", "Ответ не соответствует ожидаемому участию.");
      }
      required(command.text(), "text", 20000);
    }
    jdbc.sql(
            "UPDATE task_requests SET status='ANSWERED',answer=:answer,"
                + " answer_command=:command,answer_connection_id=:connection,answered_at=now()"
                + " WHERE id=:id")
        .param("answer", command.text())
        .param("command", command.type())
        .param(
            "connection",
            "CHOOSE_CONNECTION".equals(command.type()) ? command.connectionId() : null)
        .param("id", request.id())
        .update();
    boolean paused =
        jdbc.sql("SELECT paused_explicitly FROM tasks WHERE id=:id")
            .param("id", task.id())
            .query(Boolean.class)
            .single();
    String next = paused ? "PAUSED" : "WAITING_CHATGPT";
    if (TERMINAL.contains(task.status()) || "STOPPING".equals(task.status())) {
      next = task.status();
    }
    String message = "Ответ пользователя принят";
    if ("UNKNOWN_RESULT".equals(request.type())) {
      message = "PROCEED".equals(command.type())
          ? "Исход остался неподтверждённым; продолжение разрешено без повтора действия"
          : "Результат проверен по состоянию сайта";
    }
    change(owner, task.id(), next, null, message);
    if ("CHOOSE_CONNECTION".equals(command.type())) {
      jdbc.sql("UPDATE tasks SET selected_connection_id=:connection WHERE id=:id")
          .param("connection", command.connectionId())
          .param("id", task.id())
          .update();
    }
  }

  @Transactional
  public void requestStop(UUID owner, UUID id) {
    lockTask(owner, id);
    String status =
        jdbc.sql("SELECT status FROM tasks WHERE id=:id")
            .param("id", id)
            .query(String.class)
            .single();
    if (Set.of("STOPPED", "STOPPING").contains(status)) {
      return;
    }
    cancelQueued(id);
    if (!hasUnknown(id)) {
      cancelRequest(id);
    }
    closeTaskBrowsers(id);
    boolean live =
        jdbc.sql(
                "SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE task_id=:id AND"
                    + " status<>'CLOSED')")
            .param("id", id)
            .query(Boolean.class)
            .single();
    change(
        owner, id, live || hasDispatched(id) ? "STOPPING" : "STOPPED", null, "Запрошена остановка");
  }

  @Transactional
  public void settleStop(UUID owner, UUID id) {
    lockTask(owner, id);
    boolean settled =
        jdbc.sql(
                """
                SELECT status='STOPPING'
                  AND NOT EXISTS(SELECT 1 FROM operations WHERE task_id=:id AND status='DISPATCHED')
                  AND NOT EXISTS(SELECT 1 FROM browser_sessions WHERE task_id=:id AND status<>'CLOSED')
                FROM tasks WHERE id=:id AND owner_id=:owner
                """)
            .param("id", id)
            .param("owner", owner)
            .query(Boolean.class)
            .single();
    if (settled) {
      change(owner, id, "STOPPED", null, "Действие завершено, браузер закрыт, задача остановлена");
    }
  }

  @Transactional
  public void finish(UUID owner, Contracts.Task task, String outcome, String summary) {
    if (TERMINAL.contains(task.status())
        || "DRAFT".equals(task.status())
        || "STOPPING".equals(task.status())
        || task.request() != null
        || task.browser() != null && task.browser().privateMode()) {
      throw unavailable();
    }
    if (!Set.of("SUCCEEDED", "PARTIAL", "NOT_ACHIEVED").contains(outcome == null ? "" : outcome)) {
      throw ApiException.invalid(
          "outcome", "Укажите полный, частичный или недостигнутый результат.");
    }
    if (hasUnknown(task.id()) || hasDispatched(task.id())) {
      throw unavailable();
    }
    required(summary, "summary", 20000);
    jdbc.sql(
            "UPDATE tasks SET"
                + " result=coalesce(result,'{}')||jsonb_build_object('summary',:summary),outcome=:outcome"
                + " WHERE id=:id")
        .param("summary", summary)
        .param("outcome", outcome)
        .param("id", task.id())
        .update();
    if ("SUCCEEDED".equals(outcome)) {
      closeTaskBrowsers(task.id());
    }
    change(owner, task.id(), outcome, null, "Результат задачи сохранён");
  }

  private void closeTaskBrowsers(UUID task) {
    // An unallocated browser has no worker to acknowledge closure.
    jdbc.sql(
            """
            UPDATE browser_sessions SET close_requested=true,pending_control=NULL,control_deadline_at=NULL,
              version=version+1,
              closed_at=CASE WHEN status='QUEUED' THEN now() ELSE closed_at END,
              control_owner=CASE WHEN status='QUEUED' THEN 'NONE' ELSE control_owner END,
              status=CASE WHEN status='QUEUED' THEN 'CLOSED' ELSE status END
            WHERE task_id=:task AND status<>'CLOSED'
            """)
        .param("task", task)
        .update();
  }

  @Transactional
  public void request(
      UUID owner, UUID task, String type, String prompt, UUID operation, JsonNode options) {
    String status =
        jdbc.sql("SELECT status FROM tasks WHERE id=:task AND owner_id=:owner FOR UPDATE")
            .param("task", task)
            .param("owner", owner)
            .query(String.class)
            .optional()
            .orElseThrow(ApiException::notFound);
    cancelRequest(task);
    jdbc.sql(
            """
            INSERT INTO task_requests(
              id,task_id,owner_id,type,prompt,operation_id,options,instruction_revision)
            SELECT :id,id,:owner,:type,:prompt,:operation,CAST(:options AS jsonb),instruction_revision
              FROM tasks WHERE id=:task
            """)
        .param("id", UUID.randomUUID())
        .param("task", task)
        .param("owner", owner)
        .param("type", type)
        .param("prompt", prompt)
        .param("operation", operation)
        .param("options", options == null ? "[]" : json.write(options))
        .update();
    boolean suspended =
        TERMINAL.contains(status) || Set.of("PAUSED", "PAUSING", "STOPPING").contains(status);
    change(owner, task, suspended ? status : waitingStatus(type), type, prompt);
    if ("UNKNOWN_RESULT".equals(type) && !suspended) {
      requestContinuation(task);
    }
  }

  public static String waitingStatus(String requestType) {
    return requestType == null || "UNKNOWN_RESULT".equals(requestType)
        ? "WAITING_CHATGPT" : "WAITING_USER";
  }

  @Transactional
  public void ask(
      UUID owner, UUID task, long instructionRevision, String prompt, JsonNode options) {
    identity.requireActive(owner);
    lockOwner(owner);
    lockTask(owner, task);
    Contracts.Task current = get(owner, task);
    if (current.instructionRevision() != instructionRevision) {
      throw ApiException.conflict("STALE_INSTRUCTION", "Поручение изменилось.");
    }
    if (TERMINAL.contains(current.status())
        || current.request() != null
        || Set.of("DRAFT", "STOPPING", "PAUSED", "PAUSING").contains(current.status())) {
      throw unavailable();
    }
    request(owner, task, "QUESTION", required(prompt, "prompt", 20000), null, options);
  }

  @Transactional
  public void change(UUID owner, UUID id, String status, String reason, String description) {
    if (TERMINAL.contains(status)
        || Set.of("DRAFT", "WAITING_USER", "PAUSED", "PAUSING", "STOPPING").contains(status)) {
      cancelContinuation(id);
    }
    long version =
        jdbc.sql(
"""
UPDATE tasks SET status=:status,wait_reason=:reason,version=version+1,updated_at=now(),
  completed_at=CASE WHEN :terminal THEN coalesce(completed_at,now()) ELSE NULL END
WHERE id=:id AND owner_id=:owner RETURNING version
""")
            .param("status", status)
            .param("reason", reason)
            .param("terminal", TERMINAL.contains(status))
            .param("id", id)
            .param("owner", owner)
            .query(Long.class)
            .single();
    long sequence = events.emit(owner, "task", id, version);
    events.emit(owner, "usage", id, version);
    events.emitAdministrators("admin-user", owner, version);
    history(owner, id, status, description, null);
    if (TERMINAL.contains(status) || "WAITING_USER".equals(status)) {
      jdbc.sql(
              """
              INSERT INTO notifications(id,owner_id,sequence,task_id,title,status)
              SELECT :notification,owner_id,:sequence,id,title,status FROM tasks WHERE id=:id
              """)
          .param("notification", UUID.randomUUID())
          .param("sequence", sequence)
          .param("id", id)
          .update();
      events.emit(owner, "notification", id, version);
    }
  }

  public void requestContinuation(UUID id) {
    jdbc.sql(
            """
            UPDATE mcp_chats SET continuation_status='PENDING',
              continuation_revision=t.instruction_revision,continuation_id=:continuation,
              continuation_reason=NULL,continuation_claimed_at=NULL,
              continuation_requested_at=clock_timestamp(),updated_at=now() FROM tasks t
            WHERE mcp_chats.task_id=t.id AND t.id=:id AND NOT t.paused_explicitly
              AND t.status='WAITING_CHATGPT'
            """)
        .param("id", id)
        .param("continuation", UUID.randomUUID())
        .update();
  }

  @Transactional
  public void recoverVerifications() {
    var candidates = jdbc.sql("""
        SELECT t.id,t.owner_id FROM tasks t
        WHERE t.status='WAITING_USER' AND t.wait_reason='UNKNOWN_RESULT'
          AND NOT t.paused_explicitly
          AND EXISTS(SELECT 1 FROM task_requests r WHERE r.task_id=t.id
            AND r.type='UNKNOWN_RESULT' AND r.status='PENDING')
          AND NOT EXISTS(SELECT 1 FROM browser_sessions b WHERE b.id=t.browser_session_id
            AND (b.private_mode OR b.control_owner='USER'))
        ORDER BY t.owner_id,t.id LIMIT 20
        """).query((row, index) -> Map.entry(
            row.getObject("owner_id", UUID.class), row.getObject("id", UUID.class))).list();
    for (var candidate : candidates) {
      UUID owner = candidate.getKey();
      UUID id = candidate.getValue();
      lockOwner(owner);
      lockTask(owner, id);
      Contracts.Task task = get(owner, id);
      boolean paused = jdbc.sql("SELECT paused_explicitly FROM tasks WHERE id=:id")
          .param("id", id).query(Boolean.class).single();
      if (!paused && "WAITING_USER".equals(task.status())
          && "UNKNOWN_RESULT".equals(task.waitReason()) && task.request() != null
          && "UNKNOWN_RESULT".equals(task.request().type())
          && (task.browser() == null
              || !task.browser().privateMode() && !"USER".equals(task.browser().controlOwner()))) {
        change(owner, id, waitingStatus(task.request().type()), "UNKNOWN_RESULT",
            "ChatGPT продолжит проверку результата без ответа пользователя.");
        requestContinuation(id);
      }
    }
  }

  private void cancelContinuation(UUID task) {
    jdbc.sql(
            """
            UPDATE mcp_chats SET continuation_status='IDLE',continuation_revision=NULL,
              continuation_id=NULL,continuation_reason=NULL,continuation_requested_at=NULL,
              updated_at=now() WHERE task_id=:task
              AND continuation_status IN ('PENDING','SENDING','MESSAGE_SENT','UNAVAILABLE')
            """)
        .param("task", task)
        .update();
  }

  public void history(UUID owner, UUID task, String type, String title, String detail) {
    jdbc.sql(
"""
INSERT INTO task_history(id,task_id,owner_id,sequence,type,title,detail)
VALUES (:id,:task,:owner,(SELECT coalesce(max(sequence),0)+1 FROM task_history WHERE task_id=:task),:type,:title,:detail)
""")
        .param("id", UUID.randomUUID())
        .param("task", task)
        .param("owner", owner)
        .param("type", type)
        .param("title", title)
        .param("detail", detail)
        .update();
    events.emit(owner, "history", task, 0);
  }

  public void lockTask(UUID owner, UUID task) {
    if (jdbc.sql("SELECT id FROM tasks WHERE id=:id AND owner_id=:owner FOR UPDATE")
        .param("id", task)
        .param("owner", owner)
        .query(UUID.class)
        .optional()
        .isEmpty()) {
      throw ApiException.notFound();
    }
  }

  public void lockOwner(UUID owner) {
    jdbc.sql("SELECT id FROM accounts WHERE id=:owner FOR UPDATE")
        .param("owner", owner)
        .query(UUID.class)
        .single();
  }

  public boolean hasUnknown(UUID task) {
    return hasOperation(task, "UNKNOWN");
  }

  public boolean hasDispatched(UUID task) {
    return hasOperation(task, "DISPATCHED");
  }

  private boolean hasOperation(UUID task, String status) {
    return jdbc.sql(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE task_id=:task AND status=:status)")
        .param("task", task)
        .param("status", status)
        .query(Boolean.class)
        .single();
  }

  public void cancelQueued(UUID task) {
    jdbc.sql(
            "UPDATE operations SET status='CANCELLED',completed_at=now() WHERE task_id=:id AND"
                + " status IN ('ACCEPTED','AWAITING_CONFIRMATION')")
        .param("id", task)
        .update();
  }

  /** An unanswered decision remains valid while the browser is paused or controlled manually. */
  public void suspendBrowserWork(UUID task) {
    jdbc.sql(
            "UPDATE operations SET status='CANCELLED',completed_at=now()"
                + " WHERE task_id=:id AND status='ACCEPTED'")
        .param("id", task)
        .update();
  }

  public void cancelRequest(UUID task) {
    jdbc.sql("UPDATE task_requests SET status='CANCELLED' WHERE task_id=:id AND status='PENDING'")
        .param("id", task)
        .update();
  }

  public void checkWaitingAdmission(UUID owner) {
    Integer limit =
        jdbc.sql("SELECT waiting_limit FROM accounts WHERE id=:owner")
            .param("owner", owner)
            .query((row, index) -> row.getObject("waiting_limit", Integer.class))
            .optional()
            .orElse(null);
    long waiting =
        jdbc.sql(
                "SELECT count(*) FROM tasks WHERE owner_id=:owner AND status IN"
                    + " ('QUEUED','WAITING_CHATGPT','WAITING_USER')")
            .param("owner", owner)
            .query(Long.class)
            .single();
    if (limit != null && waiting >= limit) {
      throw ApiException.conflict(
          "WAITING_LIMIT",
          "Достигнут лимит подготовленных ожидающих задач. Черновик можно сохранить.");
    }
  }

  public void validateConnections(UUID owner, List<UUID> ids) {
    if (ids == null || ids.isEmpty()) {
      return;
    }
    if (ids.size() > 50 || ids.stream().anyMatch(java.util.Objects::isNull)) {
      throw ApiException.invalid("preferredConnectionIds", "Некорректный выбор подключений.");
    }
    long available =
        jdbc.sql(
                "SELECT count(*) FROM connections WHERE owner_id=:owner AND id IN (:ids) AND"
                    + " deleted_at IS NULL")
            .param("owner", owner)
            .param("ids", ids)
            .query(Long.class)
            .single();
    if (available != ids.stream().distinct().count()) {
      throw ApiException.notFound();
    }
  }

  public static void validate(Contracts.TaskInput input, boolean prepared) {
    if (input.goal() != null && input.goal().length() > 20000) {
      throw ApiException.invalid("goal", "Цель слишком длинная.");
    }
    if (prepared) {
      required(input.goal(), "goal", 20000);
      required(input.startUrl(), "startUrl", 4096);
    }
    if (input.title() != null && input.title().length() > 200) {
      throw ApiException.invalid("title", "Название слишком длинное.");
    }
    if (input.startUrl() != null && !input.startUrl().isBlank()) {
      site(input.startUrl());
    }
    format(input.outputFormat());
  }

  public static String site(String url) {
    if (url == null || url.isBlank()) {
      return null;
    }
    URI uri = URI.create(url);
    if (!Set.of("http", "https").contains(uri.getScheme())
        || uri.getHost() == null
        || uri.getUserInfo() != null
        || url.length() > 4096) {
      throw ApiException.invalid("startUrl", "Нужен полный HTTP или HTTPS адрес без пароля.");
    }
    return uri.getHost().toLowerCase(java.util.Locale.ROOT);
  }

  public static String required(String value, String field, int maximum) {
    if (value == null || value.isBlank() || value.length() > maximum) {
      throw ApiException.invalid(field, "Заполните поле (до " + maximum + " символов).");
    }
    return value.trim();
  }

  private static String value(String value) {
    return value == null ? "" : value.trim();
  }

  private static String blankNull(String value) {
    return value == null || value.isBlank() ? null : value.trim();
  }

  private static String format(String value) {
    String result = value == null ? "TABLE" : value;
    if (!Set.of("TABLE", "REPORT", "TEXT").contains(result)) {
      throw ApiException.invalid("outputFormat", "Выберите формат результата.");
    }
    return result;
  }

  private static ApiException unavailable() {
    return ApiException.conflict("ACTION_UNAVAILABLE", "Действие недоступно в текущем состоянии.");
  }

  private Contracts.Task map(ResultSet row, int index) throws SQLException {
    String status = row.getString("status");
    List<String> commands = new ArrayList<>();
    if ("DRAFT".equals(status)) {
      commands.addAll(List.of("AMEND", "PREPARE", "STOP"));
    } else if ("PAUSED".equals(status)) {
      commands.addAll(List.of("RESUME", "STOP", "TAKE_CONTROL", "BEGIN_LOGIN"));
    } else if (TERMINAL.contains(status) && !"STOPPED".equals(status)) {
      commands.add("RESUME");
    } else if (!TERMINAL.contains(status) && !"STOPPING".equals(status)) {
      commands.addAll(List.of("STOP", "TAKE_CONTROL", "BEGIN_LOGIN"));
    }
    String request = row.getString("request_json");
    String response = row.getString("response_json");
    String browser = row.getString("browser_json");
    Contracts.InteractionRequest interaction =
        request == null
            ? null
            : json.convert(json.read(request), Contracts.InteractionRequest.class);
    Contracts.Browser browserState =
        browser == null ? null : json.convert(json.read(browser), Contracts.Browser.class);
    if (TERMINAL.contains(status)
        && !"STOPPED".equals(status)
        && browserState != null
        && !"CLOSED".equals(browserState.status())) {
      commands.add("STOP");
    }
    if (interaction != null
        && "BROWSER_LOST".equals(interaction.type())
        && !Set.of("STOPPED", "STOPPING").contains(status)) {
      commands.add("RESUME");
    }
    if (browserState == null
        || !"LIVE".equals(browserState.status())
        || "TRANSFERRING".equals(browserState.controlOwner())) {
      commands.removeAll(List.of("TAKE_CONTROL", "BEGIN_LOGIN"));
    } else if ("USER".equals(browserState.controlOwner())) {
      commands.add("RETURN_CONTROL");
      if (browserState.privateMode()) {
        commands.add("FINISH_LOGIN");
      }
    }
    if (browserState != null
        && !Set.of("DRAFT", "STOPPING").contains(status)
        && !Set.of("CLOSED", "LOST", "CLOSING").contains(browserState.status())) {
      commands.add("CLOSE_BROWSER");
    }
    if (!TERMINAL.contains(status)
        && !Set.of("DRAFT", "PAUSING", "STOPPING").contains(status)
        && browserState != null
        && Set.of("CLOSED", "LOST").contains(browserState.status())) {
      commands.add("OPEN_BROWSER");
    }
    if (row.getBoolean("unknown_action")) {
      if (Set.of("WAITING_USER", "WAITING_CHATGPT").contains(status)
          && "UNKNOWN_RESULT".equals(row.getString("wait_reason"))
          && interaction != null
          && "UNKNOWN_RESULT".equals(interaction.type())) {
        commands.add("RESUME");
      }
      if (TERMINAL.contains(status)) {
        commands.remove("RESUME");
      }
    }
    if (row.getBoolean("dispatched_action")) {
      commands.removeAll(
          List.of(
              "RESUME",
              "OPEN_BROWSER",
              "TAKE_CONTROL",
              "BEGIN_LOGIN",
              "RETURN_CONTROL",
              "FINISH_LOGIN"));
    }
    JsonNode usage = json.read(row.getString("usage_json"));
    JsonNode result = json.read(row.getString("result"));
    JsonNode artifactTotals = json.read(row.getString("artifact_totals_json"));
    if (result != null || artifactTotals.path("count").asLong() > 0) {
      var object =
          result != null && result.isObject()
              ? (tools.jackson.databind.node.ObjectNode) result.deepCopy()
              : tools.jackson.databind.node.JsonNodeFactory.instance.objectNode();
      object.put("artifactCount", artifactTotals.path("count").asLong());
      if (!object.has("summary")) {
        object.put("summary", "");
      }
      for (String field : List.of("limitations", "sources", "columns")) {
        if (!object.has(field)) {
          object.putArray(field);
        }
      }
      result = object;
    }
    return new Contracts.Task(
        Database.uuid(row, "id"),
        row.getLong("version"),
        row.getLong("instruction_revision"),
        row.getString("title"),
        row.getString("goal"),
        row.getString("start_url"),
        row.getString("site"),
        row.getString("output_format"),
        row.getBoolean("chat_bound"),
        row.getString("continuation_json") == null
            ? null
            : json.convert(
                json.read(row.getString("continuation_json")), Contracts.Continuation.class),
        json.uuidList(row.getString("preferred_connection_ids")),
        row.getString("source"),
        status,
        row.getString("outcome"),
        row.getString("wait_reason"),
        row.getString("task_summary"),
        interaction,
        response == null
            ? null
            : json.convert(json.read(response), Contracts.InteractionResponse.class),
        browserState,
        result,
        new Contracts.TaskTiming(
            row.getBigDecimal("elapsed_seconds"),
            row.getObject("accepted_at") != null && row.getObject("completed_at") == null),
        usageMap(usage, artifactTotals),
        List.copyOf(commands),
        row.getLong("step_count"),
        Database.instant(row, "created_at"),
        Database.instant(row, "updated_at"));
  }

  private Map<String, Object> usageMap(JsonNode usage, JsonNode artifactTotals) {
    Map<String, Object> values = new java.util.LinkedHashMap<>();
    values.put("browserSeconds", usage.path("browserSeconds").asDouble());
    values.put("executionSeconds", usage.path("executionSeconds").asDouble());
    values.put("manualSeconds", usage.path("manualSeconds").asDouble());
    boolean durationKnown = artifactTotals.path("durationKnown").asBoolean();
    values.put(
        "mediaSeconds", durationKnown ? artifactTotals.path("mediaSeconds").decimalValue() : null);
    values.put("mediaBytes", artifactTotals.path("mediaBytes").asLong());
    values.put("incomplete", usage.path("incomplete").asBoolean() || !durationKnown);
    return values;
  }
}
