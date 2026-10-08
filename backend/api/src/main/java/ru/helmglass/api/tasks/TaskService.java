package ru.helmglass.api.tasks;

import java.net.URI;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
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
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.browsers.WorkerClient;
import ru.helmglass.api.events.EventService;
import tools.jackson.databind.JsonNode;

@Service
public class TaskService {
  public static final Set<String> TERMINAL =
      Set.of("SUCCEEDED", "PARTIAL", "NOT_ACHIEVED", "FAILED", "STOPPED");
  public static final String SELECT =
      """
SELECT t.*,
  coalesce(t.result->>'summary',(SELECT h.title FROM task_history h WHERE h.task_id=t.id ORDER BY h.sequence DESC LIMIT 1)) task_summary,
  (SELECT jsonb_build_object('id',r.id,'type',r.type,'prompt',r.prompt,'version',r.version,
    'options',r.options,'operationId',r.operation_id) FROM task_requests r
    WHERE r.task_id=t.id AND r.status='PENDING')::text request_json,
  (SELECT jsonb_build_object('id',b.id,'status',b.status,'nodeId',b.node_id,
    'controlOwner',b.control_owner,'controlEpoch',b.control_epoch,'privateMode',b.private_mode,
    'currentUrl',CASE WHEN b.private_mode THEN NULL ELSE b.current_url END,
    'canView',b.status='LIVE','canControl',b.status='LIVE','version',b.version)
    FROM browser_sessions b WHERE b.id=t.browser_session_id)::text browser_json,
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
  private final WorkerClient worker;

  public TaskService(
      JdbcClient jdbc,
      JsonSupport json,
      EventService events,
      Identity identity,
      WorkerClient worker) {
    this.jdbc = jdbc;
    this.json = json;
    this.events = events;
    this.identity = identity;
    this.worker = worker;
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
    var items =
        jdbc.sql(
                SELECT
                    + " WHERE "
                    + filter.where()
                    + " ORDER BY "
                    + query.taskOrder()
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
    for (String table : List.of("mcp_chats", "mcp_task_chats", "task_history")) {
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
INSERT INTO tasks(id,owner_id,title,goal,start_url,site,output_format,require_confirmation,
  preferred_connection_ids,source,status,accepted_at,accepted_sequence)
VALUES (:id,:owner,:title,:goal,:url,:site,:format,:confirm,CAST(:connections AS jsonb),
  :source,:status,CASE WHEN :prepare THEN now() ELSE NULL END,:sequence)
""")
        .param("id", id)
        .param("owner", owner)
        .param("title", title)
        .param("goal", goal)
        .param("url", url)
        .param("site", site(url))
        .param("format", format(input.outputFormat()))
        .param("confirm", input.requireConfirmation() == null || input.requireConfirmation())
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
    return get(owner, id);
  }

  @Transactional
  public Contracts.Task command(UUID owner, UUID id, Contracts.TaskCommand command) {
    identity.requireActive(owner);
    lockOwner(owner);
    lockTask(owner, id);
    Contracts.Task task = get(owner, id);
    if (command.expectedVersion() == null || command.expectedVersion() != task.version()) {
      throw ApiException.conflict(
          "STALE_VERSION", "Задача изменилась. Проверьте актуальное поручение.");
    }
    String type = required(command.type(), "type", 60);
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
                task.requireConfirmation(),
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
      case "AMEND" -> amend(owner, task, command);
      case "COPY" -> {
        return create(
            owner,
            new Contracts.TaskInput(
                task.title(),
                task.goal(),
                task.startUrl(),
                task.outputFormat(),
                task.requireConfirmation(),
                task.preferredConnectionIds(),
                false),
            "WEB");
      }
      case "PAUSE" -> {
        if (TERMINAL.contains(task.status())
            || "DRAFT".equals(task.status())
            || "STOPPING".equals(task.status())) {
          throw unavailable();
        }
        cancelQueued(id);
        jdbc.sql("UPDATE tasks SET paused_explicitly=true WHERE id=:id").param("id", id).update();
        change(owner, id, hasDispatched(id) ? "PAUSING" : "PAUSED", null, "Запрошена пауза");
      }
      case "RESUME" -> resume(owner, task, command);
      case "STOP" -> requestStop(owner, id);
      case "END_SESSION" -> endSession(owner, task);
      case "ANSWER", "CONFIRM", "REJECT", "CHOOSE_CONNECTION" -> answer(owner, task, command);
      case "FINISH" -> finish(owner, task, command.outcome(), command.text());
      default -> throw ApiException.invalid("type", "Неизвестная команда задачи.");
    }
    return get(owner, id);
  }

  @Transactional
  public Contracts.Task selectConnection(
      UUID owner, UUID taskId, long instructionRevision, UUID connectionId) {
    identity.requireActive(owner);
    lockOwner(owner);
    lockTask(owner, taskId);
    Contracts.Task task = get(owner, taskId);
    if (task.instructionRevision() != instructionRevision) {
      throw ApiException.conflict("STALE_INSTRUCTION", "Поручение изменилось.");
    }
    if (TERMINAL.contains(task.status())
        || Set.of("DRAFT", "PAUSED", "PAUSING", "STOPPING").contains(task.status())
        || task.request() != null
        || hasDispatched(taskId)
        || hasUnknown(taskId)) {
      throw ApiException.conflict(
          "ACTION_UNRESOLVED", "Сначала завершите текущее действие или запрос участия.");
    }
    validateConnections(owner, List.of(connectionId));
    String url =
        jdbc.sql("SELECT start_url FROM connections WHERE id=:id AND status='READY'")
            .param("id", connectionId)
            .query(String.class)
            .optional()
            .orElseThrow(
                () ->
                    ApiException.conflict(
                        "LOGIN_REQUIRED", "Сначала выполните вход в выбранное подключение."));
    if (task.browser() == null || Set.of("CLOSED", "LOST").contains(task.browser().status())) {
      jdbc.sql("UPDATE tasks SET selected_connection_id=:connection WHERE id=:task")
          .param("connection", connectionId)
          .param("task", taskId)
          .update();
      return get(owner, taskId);
    }
    if (!"LIVE".equals(task.browser().status())
        || !"CHATGPT".equals(task.browser().controlOwner())
        || task.browser().privateMode()) {
      throw ApiException.conflict(
          "BROWSER_UNAVAILABLE", "Дождитесь доступного браузера под управлением ChatGPT.");
    }
    UUID current =
        jdbc.sql("SELECT connection_id FROM browser_sessions WHERE id=:id")
            .param("id", task.browser().id())
            .query((row, index) -> row.getObject("connection_id", UUID.class))
            .optional()
            .orElse(null);
    if (connectionId.equals(current)) {
      return task;
    }
    java.net.URI parsed = java.net.URI.create(url);
    var arguments =
        Map.of(
            "connectionId",
            connectionId,
            "ownerId",
            owner,
            "origins",
            List.of(parsed.getScheme() + "://" + parsed.getAuthority()),
            "url",
            url);
    UUID operation = UUID.randomUUID();
    jdbc.sql(
            """
INSERT INTO operations(id,owner_id,task_id,type,arguments,status,mutating,instruction_revision,control_epoch)
VALUES (:id,:owner,:task,'applyConnection',CAST(:arguments AS jsonb),'AWAITING_CONFIRMATION',true,:revision,:epoch)
""")
        .param("id", operation)
        .param("owner", owner)
        .param("task", taskId)
        .param("arguments", json.write(arguments))
        .param("revision", instructionRevision)
        .param("epoch", task.browser().controlEpoch())
        .update();
    request(
        owner,
        taskId,
        "CONFIRMATION",
        "Переключить аккаунт в текущем браузере? Страницы этого сайта будут закрыты; несохранённые"
            + " формы будут потеряны.",
        operation,
        null);
    return get(owner, taskId);
  }

  private void amend(UUID owner, Contracts.Task task, Contracts.TaskCommand command) {
    var input =
        new Contracts.TaskInput(
            command.title(),
            command.goal(),
            command.startUrl(),
            command.outputFormat(),
            command.requireConfirmation(),
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
  require_confirmation=:confirm,preferred_connection_ids=CAST(:connections AS jsonb),
  instruction_revision=instruction_revision+1 WHERE id=:id
""")
        .param("goal", value(input.goal()))
        .param("title", input.title() == null ? task.title() : input.title())
        .param("url", blankNull(input.startUrl()))
        .param("site", site(blankNull(input.startUrl())))
        .param("format", format(input.outputFormat()))
        .param(
            "confirm",
            input.requireConfirmation() == null
                ? task.requireConfirmation()
                : input.requireConfirmation())
        .param(
            "connections",
            json.write(
                input.preferredConnectionIds() == null
                    ? task.preferredConnectionIds()
                    : input.preferredConnectionIds()))
        .param("id", task.id())
        .update();
    String status = task.status();
    if (!Set.of("DRAFT", "PAUSED", "PAUSING", "STOPPING").contains(status)
        && !TERMINAL.contains(status)) {
      status = hasDispatched(task.id()) ? "RUNNING" : "WAITING_CHATGPT";
    }
    change(owner, task.id(), status, null, "Поручение уточнено");
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
    if (hasUnknown(task.id())) {
      throw ApiException.conflict("UNKNOWN_RESULT", "Сначала проверьте неизвестный результат.");
    }
    if ("STOPPING".equals(task.status()) || "DRAFT".equals(task.status())) {
      throw unavailable();
    }
    if (TERMINAL.contains(task.status())
        && !"STOPPED".equals(task.status())
        && !"FAILED".equals(task.status())) {
      throw unavailable();
    }
    if (("STOPPED".equals(task.status())
            || task.browser() != null && Set.of("LOST", "CLOSED").contains(task.browser().status()))
        && !Boolean.TRUE.equals(command.confirmBrowserLoss())) {
      throw ApiException.conflict(
          "BROWSER_REPLACEMENT_CONSENT",
          "Продолжение откроет новый браузер. Несохранённая страница утрачена.");
    }
    jdbc.sql("UPDATE tasks SET paused_explicitly=false,outcome=NULL,completed_at=NULL WHERE id=:id")
        .param("id", task.id())
        .update();
    if (task.request() != null && "BROWSER_LOST".equals(task.request().type())) {
      cancelRequest(task.id());
    }
    change(owner, task.id(), "WAITING_CHATGPT", null, "Разрешено продолжить исходную задачу");
    requestContinuation(task.id());
  }

  private void answer(UUID owner, Contracts.Task task, Contracts.TaskCommand command) {
    Contracts.InteractionRequest request = task.request();
    if (request == null
        || !request.id().equals(command.requestId())
        || command.requestVersion() == null
        || request.version() != command.requestVersion()) {
      throw ApiException.conflict("STALE_REQUEST", "Этот запрос участия больше не актуален.");
    }
    if ("UNKNOWN_RESULT".equals(request.type())) {
      String evidence = required(command.text(), "text", 4000);
      String verified =
          switch (command.type()) {
            case "CONFIRM" -> "SUCCEEDED";
            case "REJECT" -> "FAILED";
            default ->
                throw ApiException.invalid("type", "Укажите подтверждённый результат проверки.");
          };
      UUID session =
          jdbc.sql(
                  "SELECT session_id FROM operations WHERE id=:id AND task_id=:task AND"
                      + " status='UNKNOWN'")
              .param("id", request.operationId())
              .param("task", task.id())
              .query(UUID.class)
              .single();
      boolean closed =
          jdbc.sql("SELECT status IN ('CLOSED','LOST') FROM browser_sessions WHERE id=:id")
              .param("id", session)
              .query(Boolean.class)
              .single();
      if (!closed) {
        worker.call(
            "POST",
            "/sessions/" + session + "/commands/" + request.operationId() + "/resolve",
            Map.of("outcome", verified, "evidence", evidence));
      }
      jdbc.sql(
              """
UPDATE browser_sessions SET connection_id=CASE WHEN :succeeded THEN pending_connection_id ELSE connection_id END,
 pending_connection_id=NULL WHERE id=:id AND pending_connection_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM operations WHERE id=:operation AND type='applyConnection')
""")
          .param("succeeded", "SUCCEEDED".equals(verified))
          .param("id", session)
          .param("operation", request.operationId())
          .update();
      jdbc.sql(
              """
UPDATE operations SET status=:status,result=jsonb_build_object('verification',:evidence),
completed_at=now() WHERE id=:id AND status='UNKNOWN'
""")
          .param("status", verified)
          .param("evidence", evidence)
          .param("id", request.operationId())
          .update();
    } else if ("CONFIRMATION".equals(request.type())) {
      if (!Set.of("CONFIRM", "REJECT").contains(command.type())) {
        throw ApiException.invalid("type", "Подтвердите или отклоните конкретное действие.");
      }
      jdbc.sql(
              "UPDATE operations SET status=:status WHERE id=:id AND"
                  + " status='AWAITING_CONFIRMATION'")
          .param("status", "CONFIRM".equals(command.type()) ? "ACCEPTED" : "CANCELLED")
          .param("id", request.operationId())
          .update();
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
                  "SELECT site=:site AND deleted_at IS NULL AND (:explicit OR status='READY') FROM"
                      + " connections WHERE id=:id AND owner_id=:owner")
              .param("site", task.site())
              .param("explicit", !request.options().isEmpty())
              .param("id", command.connectionId())
              .param("owner", owner)
              .query(Boolean.class)
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
      required(command.text(), "text", 20000);
    }
    jdbc.sql(
            "UPDATE task_requests SET status='ANSWERED',answer=:answer,answered_at=now() WHERE"
                + " id=:id")
        .param("answer", command.text())
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
    change(owner, task.id(), next, null, "Ответ пользователя принят");
    if ("CHOOSE_CONNECTION".equals(command.type())) {
      if (task.browser() == null || Set.of("CLOSED", "LOST").contains(task.browser().status())) {
        jdbc.sql("UPDATE tasks SET selected_connection_id=:connection WHERE id=:id")
            .param("connection", command.connectionId())
            .param("id", task.id())
            .update();
      } else {
        selectConnection(owner, task.id(), task.instructionRevision(), command.connectionId());
      }
    }
    requestContinuation(task.id());
  }

  private void endSession(UUID owner, Contracts.Task task) {
    if (task.browser() == null || Set.of("CLOSED", "LOST").contains(task.browser().status())) {
      throw unavailable();
    }
    cancelQueued(task.id());
    jdbc.sql("UPDATE tasks SET paused_explicitly=true WHERE id=:id")
        .param("id", task.id())
        .update();
    jdbc.sql(
            """
UPDATE browser_sessions SET close_requested=true,pending_control=NULL,
 status=CASE WHEN status='QUEUED' THEN 'CLOSED' ELSE 'CLOSING' END,version=version+1,
 closed_at=CASE WHEN status='QUEUED' THEN now() ELSE closed_at END WHERE id=:id
""")
        .param("id", task.browser().id())
        .update();
    if (!TERMINAL.contains(task.status()) && !"STOPPING".equals(task.status())) {
      change(
          owner,
          task.id(),
          hasDispatched(task.id()) ? "PAUSING" : "PAUSED",
          null,
          "Сессия браузера завершается; результаты и задача сохранены");
    }
    events.emit(owner, "browser", task.browser().id(), task.browser().version() + 1);
  }

  @Transactional
  public void requestStop(UUID owner, UUID id) {
    lockTask(owner, id);
    String status =
        jdbc.sql("SELECT status FROM tasks WHERE id=:id")
            .param("id", id)
            .query(String.class)
            .single();
    if ("DRAFT".equals(status)) {
      throw unavailable();
    }
    if (TERMINAL.contains(status) || "STOPPING".equals(status)) {
      return;
    }
    cancelQueued(id);
    if (!hasUnknown(id)) {
      cancelRequest(id);
    }
    jdbc.sql(
            "UPDATE browser_sessions SET close_requested=true WHERE task_id=:id AND"
                + " status<>'CLOSED'")
        .param("id", id)
        .update();
    jdbc.sql(
            "UPDATE browser_sessions SET status='CLOSED',closed_at=now(),control_owner='NONE' WHERE"
                + " task_id=:id AND status='QUEUED'")
        .param("id", id)
        .update();
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
    jdbc.sql(
            "UPDATE browser_sessions SET close_requested=true WHERE task_id=:id AND"
                + " status<>'CLOSED'")
        .param("id", task.id())
        .update();
    change(owner, task.id(), outcome, null, "Результат задачи сохранён");
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
            INSERT INTO task_requests(id,task_id,owner_id,type,prompt,operation_id,options)
            VALUES (:id,:task,:owner,:type,:prompt,:operation,CAST(:options AS jsonb))
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
    change(owner, task, suspended ? status : "WAITING_USER", type, prompt);
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
    if (!hasUnknown(id)) {
      jdbc.sql(
              """
UPDATE mcp_chats SET continuation_status='PENDING',continuation_revision=t.instruction_revision,
  continuation_id=:continuation,continuation_reason=NULL,
  continuation_requested_at=clock_timestamp(),updated_at=now() FROM tasks t
WHERE mcp_chats.task_id=t.id AND t.id=:id AND NOT t.paused_explicitly
  AND t.status='WAITING_CHATGPT'
""")
          .param("id", id)
          .param("continuation", UUID.randomUUID())
          .update();
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
    List<String> commands = new ArrayList<>(List.of("COPY", "AMEND"));
    if ("DRAFT".equals(status)) {
      commands.add("PREPARE");
    } else if ("PAUSED".equals(status)) {
      commands.addAll(List.of("RESUME", "STOP", "TAKE_CONTROL", "BEGIN_LOGIN"));
    } else if (Set.of("STOPPED", "FAILED").contains(status)) {
      commands.add("RESUME");
    } else if (!TERMINAL.contains(status) && !"STOPPING".equals(status)) {
      commands.addAll(List.of("PAUSE", "STOP", "TAKE_CONTROL", "BEGIN_LOGIN"));
    }
    String request = row.getString("request_json");
    String browser = row.getString("browser_json");
    Contracts.InteractionRequest interaction =
        request == null
            ? null
            : json.convert(json.read(request), Contracts.InteractionRequest.class);
    Contracts.Browser browserState =
        browser == null ? null : json.convert(json.read(browser), Contracts.Browser.class);
    if (interaction != null) {
      switch (interaction.type()) {
        case "CONFIRMATION", "UNKNOWN_RESULT" -> commands.addAll(List.of("CONFIRM", "REJECT"));
        case "ACCOUNT_CHOICE" -> commands.add("CHOOSE_CONNECTION");
        case "BROWSER_LOST" -> commands.add("RESUME");
        default -> commands.add("ANSWER");
      }
    }
    if (browserState == null
        || !"LIVE".equals(browserState.status())
        || "TRANSFERRING".equals(browserState.controlOwner())) {
      commands.removeAll(List.of("TAKE_CONTROL", "BEGIN_LOGIN"));
    } else if ("USER".equals(browserState.controlOwner())) {
      commands.add(browserState.privateMode() ? "FINISH_LOGIN" : "RETURN_CONTROL");
    }
    if (browserState != null
        && !Set.of("CLOSED", "LOST", "CLOSING").contains(browserState.status())) {
      commands.add("END_SESSION");
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
        row.getBoolean("require_confirmation"),
        json.uuidList(row.getString("preferred_connection_ids")),
        row.getString("source"),
        status,
        row.getString("outcome"),
        row.getString("wait_reason"),
        row.getString("task_summary"),
        interaction,
        browserState,
        result,
        usageMap(usage, artifactTotals),
        List.copyOf(commands),
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
