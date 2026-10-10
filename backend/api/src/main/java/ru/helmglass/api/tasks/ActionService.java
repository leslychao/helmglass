package ru.helmglass.api.tasks;

import jakarta.annotation.PreDestroy;
import java.sql.Types;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.artifacts.ArtifactService;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.browsers.BrowserService;
import ru.helmglass.api.browsers.WorkerClient;
import ru.helmglass.api.events.EventService;
import tools.jackson.databind.JsonNode;

@Service
public class ActionService {
  private static final Logger log = LoggerFactory.getLogger(ActionService.class);
  private static final int MAXIMUM_DISPATCHES = 8;
  private static final Set<String> READ_ONLY =
      Set.of("observe", "screenshot", "listMedia", "captureAudio", "waitFor");
  private static final Set<String> ACTIONS =
      Set.of(
          "navigate",
          "click",
          "fill",
          "press",
          "selectOption",
          "check",
          "scroll",
          "goBack",
          "reload",
          "newTab",
          "selectTab",
          "closeTab",
          "observe",
          "screenshot",
          "listMedia",
          "captureAudio",
          "waitFor");
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final TaskService tasks;
  private final TaskStepService steps;
  private final BrowserService browsers;
  private final WorkerClient worker;
  private final ArtifactService artifacts;
  private final Identity identity;
  private final EventService events;
  private final TransactionTemplate transactions;
  private final Map<UUID, Completion> completions = new ConcurrentHashMap<>();
  private final Semaphore waitingCalls = new Semaphore(64);
  private final Semaphore dispatchSlots = new Semaphore(MAXIMUM_DISPATCHES);
  private final ExecutorService dispatcher = Executors.newFixedThreadPool(MAXIMUM_DISPATCHES,
      Thread.ofPlatform().name("browser-command-", 0).factory());

  public ActionService(
      JdbcClient jdbc,
      JsonSupport json,
      TaskService tasks,
      TaskStepService steps,
      BrowserService browsers,
      WorkerClient worker,
      ArtifactService artifacts,
      Identity identity,
      EventService events,
      org.springframework.transaction.PlatformTransactionManager manager) {
    this.jdbc = jdbc;
    this.json = json;
    this.tasks = tasks;
    this.steps = steps;
    this.browsers = browsers;
    this.worker = worker;
    this.artifacts = artifacts;
    this.identity = identity;
    this.events = events;
    transactions = new TransactionTemplate(manager);
  }

  @Transactional
  public Contracts.Operation submit(UUID owner, UUID taskId, Contracts.BrowserAction action) {
    return submit(owner, taskId, action, List.of());
  }

  @Transactional
  public Contracts.Operation submit(UUID owner, UUID taskId, Contracts.BrowserAction action,
      List<UUID> sequence) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    tasks.lockTask(owner, taskId);
    if (action.operationId() == null
        || action.type() == null
        || !ACTIONS.contains(action.type())
        || action.arguments() == null
        || !action.arguments().isObject()
        || json.write(action.arguments()).length() > 65536) {
      throw ApiException.invalid("action", "Некорректная команда браузера.");
    }
    if (sequence.size() > 8 || !sequence.isEmpty() && !sequence.contains(action.operationId())) {
      throw ApiException.invalid("actions", "Некорректная последовательность операций.");
    }
    if (action.arguments().has("selector") || action.arguments().has("_meta")) {
      throw ApiException.invalid("arguments", "Используйте observationId и ref из наблюдения.");
    }
    String confirmation = action.confirmationPrompt() == null ? null
        : TaskService.required(action.confirmationPrompt(), "confirmationPrompt", 4000);
    if ((action.stepId() == null) == (action.step() == null)) {
      throw ApiException.invalid("step", "Укажите stepId или описание нового бизнес-шага.");
    }
    var previous =
        jdbc.sql("SELECT id FROM operations WHERE id=:id AND owner_id=:owner")
            .param("id", action.operationId())
            .param("owner", owner)
            .query(UUID.class)
            .optional();
    if (previous.isPresent()) {
      boolean same =
          jdbc.sql(
                  "SELECT task_id=:task AND ((CAST(:definition AS jsonb) IS NULL AND"
                      + " step_id=CAST(:step AS uuid)) OR coalesce("
                      + " instruction_snapshot->'step'=CAST(:definition AS jsonb),false))"
                      + " AND (:observe IS NULL OR"
                      + " coalesce((instruction_snapshot->>'observeAfter')::boolean,true)=:observe)"
                      + " AND coalesce(instruction_snapshot->'sequence','[]'::jsonb)="
                      + " CAST(:sequence AS jsonb) AND type=:type"
                      + " AND arguments=CAST(:arguments AS jsonb) AND"
                      + " instruction_revision=:revision AND requested_control_epoch IS NOT"
                      + " DISTINCT FROM CAST(:epoch AS bigint) AND instruction_snapshot->>'confirmationPrompt'"
                      + " IS NOT DISTINCT FROM CAST(:confirmation AS text) FROM operations WHERE id=:id")
              .param("task", taskId)
              .param("step", action.stepId())
              .param("definition", action.step() == null ? null : json.write(action.step()))
              .param("observe", action.observeAfter(), Types.BOOLEAN)
              .param("sequence", json.write(sequence))
              .param("type", action.type())
              .param("arguments", json.write(action.arguments()))
              .param("revision", action.instructionRevision())
              .param("epoch", action.controlEpoch())
              .param("confirmation", confirmation)
              .param("id", action.operationId())
              .query(Boolean.class)
              .single();
      if (!same) {
        throw ApiException.conflict(
            "IDEMPOTENCY_CONFLICT", "Номер операции уже использован другой командой.");
      }
      return result(owner, action.operationId());
    }
    Contracts.Task task = tasks.get(owner, taskId);
    if (task.instructionRevision() != action.instructionRevision()) {
      throw ApiException.conflict("STALE_INSTRUCTION", "Поручение изменилось.");
    }
    if (task.browser() != null
        && !Set.of("CLOSED", "LOST").contains(task.browser().status())
        && (action.controlEpoch() == null
            || action.controlEpoch() != task.browser().controlEpoch())) {
      throw ApiException.conflict("STALE_CONTROL", "Поколение управления браузером изменилось.");
    }
    if (TaskService.TERMINAL.contains(task.status())
        || Set.of("DRAFT", "PAUSED", "PAUSING", "STOPPING").contains(task.status())) {
      throw ApiException.conflict("TASK_NOT_RUNNING", "Задача не разрешает новые действия.");
    }
    if (tasks.hasUnknown(taskId) && !READ_ONLY.contains(action.type())) {
      throw ApiException.conflict("UNKNOWN_RESULT", "Проверьте результат предыдущего действия.");
    }
    if (task.request() != null && !"UNKNOWN_RESULT".equals(task.request().type())) {
      throw ApiException.conflict(
          "USER_RESPONSE_REQUIRED", "Сначала требуется ответ пользователя.");
    }
    if (task.browser() != null
        && (!"CHATGPT".equals(task.browser().controlOwner())
                && "LIVE".equals(task.browser().status())
            || task.browser().privateMode())) {
      throw ApiException.conflict("CONTROL_NOT_OWNED", "Браузером управляет пользователь.");
    }
    UUID stepId = action.step() == null ? action.stepId()
        : steps.startForAction(owner, taskId, action.instructionRevision(), action.step());
    steps.requireRunning(owner, taskId, stepId);
    boolean mutating = !READ_ONLY.contains(action.type());
    if ("captureAudio".equals(action.type())) {
      validateAudioContext(action.arguments().path("sourceContext"));
    }
    Map<String, Object> instruction = new HashMap<>();
    instruction.put("revision", task.instructionRevision());
    instruction.put("title", task.title());
    instruction.put("goal", task.goal());
    instruction.put("sequence", sequence);
    instruction.put("observeAfter", action.observeAfter() == null
        ? !Set.of("listMedia", "captureAudio", "screenshot").contains(action.type())
        : action.observeAfter());
    if (action.step() != null) {
      instruction.put("step", action.step());
    }
    if (confirmation != null) {
      instruction.put("confirmationPrompt", confirmation);
    }
    if ("captureAudio".equals(action.type())) {
      instruction.put("sourceContext", action.arguments().path("sourceContext"));
    }
    String state = confirmation == null ? "ACCEPTED" : "AWAITING_CONFIRMATION";
    jdbc.sql(
            """
        INSERT INTO operations(id,owner_id,task_id,step_id,type,arguments,status,mutating,instruction_revision,control_epoch,requested_control_epoch,instruction_snapshot)
        VALUES (:id,:owner,:task,:step,:type,CAST(:arguments AS jsonb),:status,:mutating,:revision,:epoch,:epoch,CAST(:instruction AS jsonb))
""")
        .param("id", action.operationId())
        .param("owner", owner)
        .param("task", taskId)
        .param("step", stepId)
        .param("type", action.type())
        .param("arguments", json.write(action.arguments()))
        .param("status", state)
        .param("mutating", mutating)
        .param("revision", action.instructionRevision())
        .param("epoch", action.controlEpoch())
        .param("instruction", json.write(instruction))
        .update();
    if ("AWAITING_CONFIRMATION".equals(state)) {
      tasks.request(owner, taskId, "CONFIRMATION", confirmation, action.operationId(), null);
    } else {
      ensureBrowser(owner, task);
    }
    return operation(owner, action.operationId());
  }

  private static void validateAudioContext(JsonNode context) {
    if (!context.isObject()) {
      throw ApiException.invalid("sourceContext", "Укажите исходное задание и вопросы к записи.");
    }
    TaskService.required(context.path("assignmentId").asString(null), "assignmentId", 1000);
    TaskService.required(context.path("instruction").asString(null), "instruction", 20000);
    JsonNode questions = context.path("questions");
    if (!questions.isArray() || questions.isEmpty() || questions.size() > 100) {
      throw ApiException.invalid("questions", "Нужны вопросы к этой записи (от 1 до 100).");
    }
    for (JsonNode question : questions) {
      if (!question.isString()) {
        throw ApiException.invalid("questions", "Вопрос должен быть текстом.");
      }
      TaskService.required(question.asString(), "questions", 4000);
    }
  }

  @Transactional
  public Contracts.Task respond(Actor actor, String chat, TaskService.ElicitationClaim claim,
      String command, String text, UUID connection) {
    Contracts.Task task = tasks.respond(actor, chat, claim, command, text, connection);
    if ("CHOOSE_CONNECTION".equals(command)) {
      return selectConnection(actor.id(), task.id(), task.instructionRevision(), connection, null);
    }
    return prepareBrowser(actor.id(), task.id());
  }

  @Transactional
  public Contracts.Task prepareBrowser(UUID owner, UUID taskId) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    tasks.lockTask(owner, taskId);
    Contracts.Task task = tasks.get(owner, taskId);
    if (task.request() == null && !TaskService.TERMINAL.contains(task.status())
        && !Set.of("DRAFT", "PAUSED", "PAUSING", "STOPPING").contains(task.status())) {
      ensureBrowser(owner, task);
    }
    return tasks.get(owner, taskId);
  }

  private void ensureBrowser(UUID owner, Contracts.Task task) {
    if (task.browser() != null && !Set.of("CLOSED", "LOST").contains(task.browser().status())) {
      return;
    }
    UUID connection =
        jdbc.sql("SELECT selected_connection_id FROM tasks WHERE id=:id")
            .param("id", task.id())
            .query((row, index) -> row.getObject("selected_connection_id", UUID.class))
            .optional()
            .orElse(null);
    if (connection != null
        && !jdbc.sql(
                "SELECT EXISTS(SELECT 1 FROM connections WHERE id=:id AND owner_id=:owner AND"
                    + " deleted_at IS NULL)")
            .param("id", connection)
            .param("owner", owner)
            .query(Boolean.class)
            .single()) {
      tasks.request(
          owner,
          task.id(),
          "ACCOUNT_CHOICE",
          "Выбранное подключение недоступно. Выберите аккаунт сайта для продолжения.",
          null,
          null);
      return;
    }
    if (connection == null && !task.preferredConnectionIds().isEmpty()) {
      var matches =
          jdbc.sql(
                  "SELECT id,name FROM connections WHERE owner_id=:owner AND id IN (:ids) AND"
                      + " site=:site AND deleted_at IS NULL ORDER BY last_used_at DESC NULLS"
                      + " LAST,id")
              .param("owner", owner)
              .param("ids", task.preferredConnectionIds())
              .param("site", task.site())
              .query(
                  (row, index) ->
                      Map.of(
                          "id",
                          row.getObject("id", UUID.class).toString(),
                          "label",
                          row.getString("name")))
              .list();
      if (matches.size() > 1) {
        tasks.request(
            owner,
            task.id(),
            "ACCOUNT_CHOICE",
            "Выберите аккаунт сайта для этой задачи.",
            null,
            json.tree(matches));
        return;
      }
      if (!matches.isEmpty()) {
        connection = UUID.fromString(matches.getFirst().get("id"));
      } else if (jdbc.sql(
              "SELECT EXISTS(SELECT 1 FROM connections WHERE owner_id=:owner AND id IN (:ids) AND"
                  + " site=:site)")
          .param("owner", owner)
          .param("ids", task.preferredConnectionIds())
          .param("site", task.site())
          .query(Boolean.class)
          .single()) {
        tasks.request(
            owner,
            task.id(),
            "ACCOUNT_CHOICE",
            "Предпочтительное подключение недоступно. Выберите аккаунт сайта для продолжения.",
            null,
            null);
        return;
      }
    }
    if (connection == null && task.preferredConnectionIds().isEmpty()) {
      var matches =
          jdbc.sql(
                  "SELECT id,name FROM connections WHERE owner_id=:owner AND site=:site AND deleted_at"
                      + " IS NULL AND status='READY' ORDER BY name,id LIMIT 50")
              .param("owner", owner)
              .param("site", task.site())
              .query((row, index) -> Map.of("id", row.getObject("id", UUID.class).toString(),
                  "label", row.getString("name")))
              .list();
      if (matches.size() == 1) {
        connection = UUID.fromString(matches.getFirst().get("id"));
      } else if (matches.size() > 1) {
        tasks.request(owner, task.id(), "ACCOUNT_CHOICE", "Выберите аккаунт сайта.", null,
            json.tree(matches));
        return;
      }
    }
    if (connection != null) {
      jdbc.sql("UPDATE tasks SET selected_connection_id=:connection WHERE id=:task")
          .param("connection", connection)
          .param("task", task.id())
          .update();
    }
    UUID session = browsers.ensure(owner, task.id(), connection, task.startUrl());
    if (session != null
        && connection != null
        && !jdbc.sql("SELECT status='READY' FROM connections WHERE id=:id")
            .param("id", connection)
            .query(Boolean.class)
            .single()) {
      jdbc.sql("UPDATE browser_sessions SET control_owner='NONE',private_mode=true WHERE id=:id")
          .param("id", session)
          .update();
      tasks.request(
          owner,
          task.id(),
          "LOGIN",
          "Войдите в явно выбранный аккаунт в браузере этой задачи.",
          null,
          null);
    }
  }

  @Transactional
  public Contracts.Task selectConnection(
      UUID owner, UUID taskId, long instructionRevision, UUID connectionId, String confirmationPrompt) {
    Contracts.Task task = tasks.selectConnection(owner, taskId, instructionRevision, connectionId, confirmationPrompt);
    boolean ready = jdbc.sql("SELECT status='READY' FROM connections WHERE id=:id AND owner_id=:owner")
        .param("id", connectionId).param("owner", owner).query(Boolean.class).single();
    if (!ready && confirmationPrompt == null) {
      return browsers.requireLogin(owner, taskId, task.version());
    }
    if (!"PAUSED".equals(task.status())
        && (task.browser() == null || Set.of("CLOSED", "LOST").contains(task.browser().status()))) {
      ensureBrowser(owner, task);
    }
    return tasks.get(owner, taskId);
  }

  public Contracts.Page<Contracts.OperationSummary> list(
      UUID owner, UUID task, UUID step, int page) {
    tasks.get(owner, task);
    if (page < 1 || page > 1000000) {
      throw ApiException.invalid("page", "Недопустимая страница операций.");
    }
    String filter = "owner_id=:owner AND task_id=:task";
    Map<String, Object> parameters = new HashMap<>();
    parameters.put("owner", owner);
    parameters.put("task", task);
    if (step != null) {
      boolean belongs = jdbc.sql("SELECT EXISTS(SELECT 1 FROM task_steps"
              + " WHERE id=:step AND task_id=:task AND owner_id=:owner)")
          .param("step", step).param("task", task).param("owner", owner)
          .query(Boolean.class).single();
      if (!belongs) {
        throw ApiException.notFound();
      }
      filter += " AND step_id=:step";
      parameters.put("step", step);
    }
    long total = jdbc.sql("SELECT count(*) FROM operations WHERE " + filter)
        .params(parameters).query(Long.class).single();
    var items = jdbc.sql("SELECT id,task_id,step_id,type,status,created_at FROM operations WHERE "
            + filter + " ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET :offset")
        .params(parameters).param("offset", (long) (page - 1) * 10)
        .query((row, index) -> new Contracts.OperationSummary(row.getObject("id", UUID.class),
            row.getObject("task_id", UUID.class), row.getObject("step_id", UUID.class),
            row.getString("type"), row.getString("status"), Database.instant(row, "created_at")))
        .list();
    return new Contracts.Page<>(items, total, page, 10);
  }

  public Contracts.Operation result(UUID owner, UUID id) {
    Contracts.Operation operation = operation(owner, id);
    requireResultAccess(owner, operation.taskId());
    return operation;
  }

  public void requireResultAccess(UUID owner, UUID task) {
    boolean privateBrowser =
        jdbc.sql(
                """
                SELECT coalesce(b.private_mode,false) FROM tasks t
                LEFT JOIN browser_sessions b ON b.id=t.browser_session_id
                WHERE t.id=:task AND t.owner_id=:owner
                """)
            .param("task", task)
            .param("owner", owner)
            .query(Boolean.class)
            .optional().orElseThrow(ApiException::notFound);
    if (privateBrowser) {
      throw Identity.denied("Содержимое браузера недоступно во время защищённого входа.");
    }
  }

  private Contracts.Operation operation(UUID owner, UUID id) {
    return jdbc.sql("SELECT * FROM operations WHERE id=:id AND owner_id=:owner")
        .param("id", id)
        .param("owner", owner)
        .query(
            (row, index) ->
                new Contracts.Operation(
                    id,
                    row.getObject("task_id", UUID.class),
                    row.getObject("step_id", UUID.class),
                    row.getString("type"),
                    row.getString("status"),
                    json.read(row.getString("result")),
                    row.getString("error_code"),
                    row.getString("error_message"),
                    Database.instant(row, "created_at"),
                    Database.instant(row, "completed_at")))
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  /** Waits for a committed result without holding locks or polling the database. */
  public Contracts.Operation awaitResult(UUID owner, Contracts.Operation submitted,
      long deadlineNanos) {
    if (!Set.of("ACCEPTED", "DISPATCHED").contains(submitted.status())
        || System.nanoTime() >= deadlineNanos || !waitingCalls.tryAcquire()) {
      return submitted;
    }
    Completion completion = completions.compute(submitted.id(), (id, current) -> current == null
        ? new Completion(new CompletableFuture<>(), 1)
        : new Completion(current.signal(), current.waiters() + 1));
    try {
      // Register before reading, so completion between submit and this call is not lost.
      Contracts.Operation current = result(owner, submitted.id());
      long remaining = deadlineNanos - System.nanoTime();
      if (!Set.of("ACCEPTED", "DISPATCHED").contains(current.status()) || remaining <= 0) {
        return current;
      }
      try {
        completion.signal().get(remaining, TimeUnit.NANOSECONDS);
      } catch (TimeoutException exception) {
        // A different API instance may have committed it; the durable receipt is authoritative.
      } catch (InterruptedException exception) {
        Thread.currentThread().interrupt();
      } catch (ExecutionException exception) {
        throw new IllegalStateException("Operation completion notification failed", exception);
      }
      return result(owner, submitted.id());
    } finally {
      completions.computeIfPresent(submitted.id(), (id, current) -> current.waiters() == 1
          ? null : new Completion(current.signal(), current.waiters() - 1));
      waitingCalls.release();
    }
  }

  @Scheduled(fixedDelay = 300)
  public void dispatch() {
    if (!dispatchSlots.tryAcquire()) {
      return;
    }
    boolean scheduled = false;
    try {
      dispatcher.execute(() -> {
        try {
          Dispatch dispatch = transactions.execute(status -> claim());
          if (dispatch != null) {
            send(dispatch);
          }
        } catch (RuntimeException exception) {
          log.warn("Action dispatch failed: {}", exception.getClass().getSimpleName());
        } finally {
          dispatchSlots.release();
        }
      });
      scheduled = true;
    } finally {
      if (!scheduled) {
        dispatchSlots.release();
      }
    }
  }

  @PreDestroy
  void stopDispatcher() {
    dispatcher.shutdown();
    try {
      if (!dispatcher.awaitTermination(45, TimeUnit.SECONDS)) {
        dispatcher.shutdownNow();
      }
    } catch (InterruptedException exception) {
      dispatcher.shutdownNow();
      Thread.currentThread().interrupt();
    }
  }

  private void send(Dispatch dispatch) {
    Map<String, Object> request = new HashMap<>();
    request.put("operationId", dispatch.id());
    request.put("type", dispatch.type());
    request.put("arguments", dispatch.arguments());
    request.put("instructionRevision", dispatch.revision());
    request.put("controlEpoch", dispatch.epoch());
    request.put("observeAfter", dispatch.observeAfter());
    if (!dispatch.sequence().isMissingNode() && !dispatch.sequence().isEmpty()) {
      request.put("sequence", Map.of("operationIds", dispatch.sequence()));
    }
    try {
      JsonNode response =
          worker.call("POST", "/sessions/" + dispatch.session() + "/commands", request);
      acceptResponse(dispatch, response);
    } catch (WorkerClient.WorkerException exception) {
      complete(
          dispatch,
          "UNKNOWN",
          null,
          exception.code(),
          "Ответ браузера потерян. Требуется проверить результат.");
    } catch (RuntimeException exception) {
      complete(
          dispatch,
          "UNKNOWN",
          null,
          "RESULT_PROCESSING_FAILED",
          "Не удалось подтвердить результат действия.");
      log.warn("Action result processing failed: {}", exception.getClass().getSimpleName());
    }
  }

  private Dispatch claim() {
    var pending =
        jdbc.sql(
                """
SELECT o.id,o.owner_id,o.task_id FROM operations o JOIN tasks t ON t.id=o.task_id
JOIN accounts a ON a.id=o.owner_id WHERE o.status='ACCEPTED' AND a.status='ACTIVE'
  AND t.status NOT IN ('PAUSED','PAUSING','STOPPING','STOPPED','FAILED','SUCCEEDED','PARTIAL','NOT_ACHIEVED','DRAFT')
  AND NOT EXISTS(SELECT 1 FROM operations active WHERE active.task_id=o.task_id AND active.status='DISPATCHED')
  AND (t.browser_session_id IS NULL OR EXISTS(SELECT 1 FROM browser_sessions b
    WHERE b.id=t.browser_session_id AND b.status IN ('LIVE','CLOSED','LOST')))
  AND NOT EXISTS(SELECT 1 FROM browser_sessions leased
    WHERE leased.status NOT IN ('CLOSED','LOST') AND leased.id IS DISTINCT FROM t.browser_session_id
    AND ((o.type='applyConnection' AND (leased.connection_id::text=o.arguments->>'connectionId'
      OR leased.pending_connection_id::text=o.arguments->>'connectionId'))
      OR (o.type<>'applyConnection' AND (leased.connection_id=t.selected_connection_id
      OR leased.pending_connection_id=t.selected_connection_id))))
  AND NOT EXISTS(SELECT 1 FROM task_requests r WHERE r.task_id=t.id AND r.status='PENDING'
    AND r.type<>'UNKNOWN_RESULT')
ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED
""")
            .query(
                (row, index) ->
                    new Pending(
                        row.getObject("id", UUID.class),
                        row.getObject("owner_id", UUID.class),
                        row.getObject("task_id", UUID.class)))
            .optional();
    if (pending.isEmpty()) {
      return null;
    }
    Pending candidate = pending.get();
    // The queue claims the account lock first, preserving the owner/task lock order.
    tasks.lockTask(candidate.owner(), candidate.task());
    if (tasks.hasDispatched(candidate.task())
        || !jdbc.sql("SELECT status='ACCEPTED' FROM operations WHERE id=:id FOR UPDATE")
        .param("id", candidate.id())
        .query(Boolean.class)
        .single()) {
      return null;
    }
    Contracts.Task task = tasks.get(candidate.owner(), candidate.task());
    if (TaskService.TERMINAL.contains(task.status())
        || Set.of("DRAFT", "PAUSED", "PAUSING", "STOPPING").contains(task.status())
        || task.request() != null && !"UNKNOWN_RESULT".equals(task.request().type())) {
      return null;
    }
    ensureBrowser(candidate.owner(), task);
    task = tasks.get(candidate.owner(), candidate.task());
    if (task.browser() == null
        || !"LIVE".equals(task.browser().status())
        || !"CHATGPT".equals(task.browser().controlOwner())
        || task.browser().privateMode()) {
      return null;
    }
    UUID sessionId = task.browser().id();
    long epoch = task.browser().controlEpoch();
    Dispatch command =
        jdbc.sql(
                "SELECT id,type,arguments,instruction_revision,mutating,instruction_snapshot"
                    + " FROM operations WHERE"
                    + " id=:id")
            .param("id", candidate.id())
            .query(
                (row, index) -> {
                  JsonNode instruction = json.read(row.getString("instruction_snapshot"));
                  return new Dispatch(
                      candidate.id(),
                      candidate.owner(),
                      candidate.task(),
                      sessionId,
                      row.getString("type"),
                      json.read(row.getString("arguments")),
                      row.getLong("instruction_revision"),
                      epoch,
                      row.getBoolean("mutating"),
                      instruction.path("observeAfter").asBoolean(true),
                      instruction.path("sequence"));
                })
            .single();
    if (command.revision() != task.instructionRevision()
        || tasks.hasUnknown(task.id()) && command.mutating()) {
      jdbc.sql("UPDATE operations SET status='CANCELLED',completed_at=now() WHERE id=:id")
          .param("id", command.id())
          .update();
      return null;
    }
    Long boundEpoch =
        jdbc.sql("SELECT control_epoch FROM operations WHERE id=:id")
            .param("id", command.id())
            .query((row, index) -> row.getObject("control_epoch", Long.class))
            .optional()
            .orElse(null);
    if (boundEpoch != null && boundEpoch != epoch) {
      jdbc.sql(
              "UPDATE operations SET"
                  + " status='CANCELLED',completed_at=now(),error_code='STALE_CONTROL' WHERE"
                  + " id=:id")
          .param("id", command.id())
          .update();
      return null;
    }
    if ("applyConnection".equals(command.type())) {
      UUID connection = UUID.fromString(command.arguments().path("connectionId").asString());
      boolean busy =
          jdbc.sql(
                  "SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE id<>:session AND"
                      + " (connection_id=:connection OR pending_connection_id=:connection) AND"
                      + " status NOT IN ('CLOSED','LOST'))")
              .param("session", task.browser().id())
              .param("connection", connection)
              .query(Boolean.class)
              .single();
      if (busy) {
        tasks.change(
            candidate.owner(),
            task.id(),
            "QUEUED",
            "CONNECTION_BUSY",
            "Выбранное подключение занято другой работой");
        return null;
      }
      if (!browsers.refreshProfile(candidate.owner(), sessionId, command.id() + ":before-switch")) {
        complete(command, "FAILED", null, "PROFILE_SAVE_FAILED",
            "Не удалось сохранить текущее подключение. Смена аккаунта не выполнялась.");
        return null;
      }
      jdbc.sql("UPDATE browser_sessions SET pending_connection_id=:connection WHERE id=:id")
          .param("connection", connection)
          .param("id", task.browser().id())
          .update();
    }
    jdbc.sql(
            "UPDATE operations SET"
                + " status='DISPATCHED',session_id=:session,control_epoch=:epoch,"
                + " dispatched_at=clock_timestamp()"
                + " WHERE id=:id")
        .param("session", task.browser().id())
        .param("epoch", epoch)
        .param("id", command.id())
        .update();
    jdbc.sql(
            "INSERT INTO usage_intervals(id,owner_id,task_id,session_id,kind) VALUES"
                + " (:id,:owner,:task,:session,'EXECUTION') ON CONFLICT DO NOTHING")
        .param("id", UUID.randomUUID())
        .param("owner", candidate.owner())
        .param("task", candidate.task())
        .param("session", task.browser().id())
        .update();
    if (!tasks.hasUnknown(task.id())) {
      tasks.change(
          candidate.owner(),
          task.id(),
          "RUNNING",
          null,
          "Выполняется команда ChatGPT: " + command.type());
    }
    browsers.refreshIdle(candidate.owner(), task.browser().id(), false);
    return command;
  }

  @Scheduled(fixedDelay = 5000)
  public void recoverReceipts() {
    var operations =
        jdbc.sql(
                "SELECT * FROM operations WHERE status IN ('DISPATCHED','UNKNOWN') AND"
                    + " dispatched_at<now()-interval '45 seconds' ORDER BY dispatched_at LIMIT 20")
            .query(
                (row, index) -> {
                  JsonNode instruction = json.read(row.getString("instruction_snapshot"));
                  return new Dispatch(
                      row.getObject("id", UUID.class),
                      row.getObject("owner_id", UUID.class),
                      row.getObject("task_id", UUID.class),
                      row.getObject("session_id", UUID.class),
                      row.getString("type"),
                      json.read(row.getString("arguments")),
                      row.getLong("instruction_revision"),
                      row.getLong("control_epoch"),
                      row.getBoolean("mutating"),
                      instruction.path("observeAfter").asBoolean(true),
                      instruction.path("sequence"));
                })
            .list();
    for (Dispatch operation : operations) {
      try {
        JsonNode receipt =
            worker.call(
                "GET", "/sessions/" + operation.session() + "/commands/" + operation.id(), null);
        acceptResponse(operation, receipt);
      } catch (RuntimeException exception) {
        if ("DISPATCHED".equals(operation(operation.owner(), operation.id()).status())) {
          complete(
              operation,
              "UNKNOWN",
              null,
              "WORKER_UNREACHABLE",
              "Результат отправленного действия пока неизвестен.");
        }
      }
    }
  }

  private void acceptResponse(Dispatch operation, JsonNode response) {
    String status = response.path("status").asString("UNKNOWN");
    if ("RUNNING".equals(status)) {
      return;
    }
    JsonNode result = response.get("result");
    if ("SUCCEEDED".equals(status)) {
      artifacts.importResults(
          operation.owner(), operation.task(), operation.session(), operation.id(), result);
    }
    String errorCode = null;
    String errorMessage = null;
    if ("FAILED".equals(status)) {
      if ("OBSERVATION_LIMIT_EXCEEDED".equals(response.path("code").asString())) {
        errorCode = "OBSERVATION_LIMIT_EXCEEDED";
        errorMessage = "Страница превышает безопасные ограничения наблюдения.";
      } else {
        errorCode = "BROWSER_ACTION_FAILED";
        errorMessage = "Браузер сообщил об отказе действия.";
      }
    } else if ("UNKNOWN".equals(status)) {
      errorCode = "UNKNOWN_RESULT";
      errorMessage = "Результат действия неизвестен.";
    }
    complete(
        operation,
        Set.of("SUCCEEDED", "FAILED").contains(status) ? status : "UNKNOWN",
        result,
        errorCode,
        errorMessage);
  }

  private void complete(
      Dispatch operation, String status, JsonNode result, String error, String message) {
    transactions.executeWithoutResult(
        transaction -> {
          tasks.lockOwner(operation.owner());
          tasks.lockTask(operation.owner(), operation.task());
          String previous = operation(operation.owner(), operation.id()).status();
          if (!Set.of("DISPATCHED", "UNKNOWN").contains(previous)
              && !("ACCEPTED".equals(previous) && "FAILED".equals(status))) {
            return;
          }
          jdbc.sql(
                  "UPDATE operations SET status=:status,result=CAST(:result AS"
                      + " jsonb),error_code=:error,error_message=:message,completed_at=now() WHERE"
                      + " id=:id")
              .param("status", status)
              .param("result", json.write(result))
              .param("error", error)
              .param("message", message)
              .param("id", operation.id())
              .update();
          if ("applyConnection".equals(operation.type()) && !"UNKNOWN".equals(status)) {
            jdbc.sql(
                    "UPDATE browser_sessions SET connection_id=CASE WHEN :success THEN"
                        + " pending_connection_id ELSE connection_id END,pending_connection_id=NULL"
                        + " WHERE id=:id")
                .param("success", "SUCCEEDED".equals(status))
                .param("id", operation.session())
                .update();
            if ("SUCCEEDED".equals(status)) {
              jdbc.sql("UPDATE tasks SET selected_connection_id=:connection WHERE id=:id")
                  .param(
                      "connection",
                      UUID.fromString(operation.arguments().path("connectionId").asString()))
                  .param("id", operation.task())
                  .update();
            }
          }
          if ("SUCCEEDED".equals(status)) {
            browsers.recordSuccessfulUse(operation.owner(), operation.session());
          }
          jdbc.sql(
                  "UPDATE usage_intervals SET ended_at=now(),incomplete=incomplete OR :unknown"
                      + " WHERE session_id=:session AND kind='EXECUTION' AND ended_at IS NULL")
              .param("unknown", "UNKNOWN".equals(status))
              .param("session", operation.session())
              .update();
          Contracts.Task task = tasks.get(operation.owner(), operation.task());
          if ("UNKNOWN".equals(status)) {
            steps.operationUnknown(operation.owner(), operation.task(), operation.id());
          }
          tasks.history(
              operation.owner(), operation.task(), "ACTION_" + status, operation.type(), message);
          if ("UNKNOWN".equals(status)
              && (TaskService.TERMINAL.contains(task.status())
                  || "STOPPING".equals(task.status()))) {
            tasks.request(
                operation.owner(),
                task.id(),
                "UNKNOWN_RESULT",
                "Проверьте результат последнего действия. Остановка браузера не доказывает"
                    + " отсутствие эффекта.",
                operation.id(),
                null);
          }
          if (!TaskService.TERMINAL.contains(task.status()) && !"STOPPING".equals(task.status())) {
            if ("UNKNOWN".equals(status)) {
              tasks.request(
                  operation.owner(),
                  operation.task(),
                  "UNKNOWN_RESULT",
                  "Проверьте, выполнил ли сайт последнее действие. Оно не будет отправлено"
                      + " повторно.",
                  operation.id(),
                  null);
              boolean paused =
                  jdbc.sql("SELECT paused_explicitly FROM tasks WHERE id=:id")
                      .param("id", task.id())
                      .query(Boolean.class)
                      .single();
              if (paused) {
                tasks.change(
                    operation.owner(),
                    task.id(),
                    "PAUSED",
                    "UNKNOWN_RESULT",
                    "Задача приостановлена; неизвестный результат требует проверки");
              }
            } else {
              if (task.request() != null
                  && "UNKNOWN_RESULT".equals(task.request().type())
                  && operation.id().equals(task.request().operationId())) {
                tasks.cancelRequest(task.id());
              }
              boolean paused =
                  jdbc.sql("SELECT paused_explicitly FROM tasks WHERE id=:id")
                      .param("id", task.id())
                      .query(Boolean.class)
                      .single();
              if (!tasks.hasUnknown(task.id())) {
                tasks.change(
                    operation.owner(),
                    task.id(),
                    paused ? "PAUSED" : "WAITING_CHATGPT",
                    null,
                    "SUCCEEDED".equals(status)
                        ? "Команда выполнена"
                        : "Действие завершилось отказом");
              }
            }
          }
          tasks.settleStop(operation.owner(), operation.task());
          browsers.refreshIdle(operation.owner(), operation.session(), true);
          events.emit(operation.owner(), "operation", operation.id(), 1);
          TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
              Completion completion = completions.get(operation.id());
              if (completion != null) {
                completion.signal().complete(null);
              }
            }
          });
        });
  }

  @Transactional
  public void saveResult(
      UUID owner, UUID taskId, long instructionRevision, JsonNode result, List<JsonNode> rows) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    tasks.lockTask(owner, taskId);
    Contracts.Task task = tasks.get(owner, taskId);
    if (task.instructionRevision() != instructionRevision) {
      throw ApiException.conflict("STALE_INSTRUCTION", "Поручение изменилось.");
    }
    if ("DRAFT".equals(task.status())) {
      throw ApiException.conflict("ACTION_UNAVAILABLE", "Сначала подготовьте задачу.");
    }
    if (result == null
        || !result.isObject()
        || json.write(result).length() > 256000
        || rows != null && rows.size() > 100) {
      throw ApiException.invalid(
          "result", "Передавайте результат ограниченными порциями до 100 строк.");
    }
    validateResult(task, result, rows);
    jdbc.sql(
            "UPDATE tasks SET result=coalesce(result,'{}')||CAST(:result AS"
                + " jsonb),version=version+1,updated_at=now() WHERE id=:id")
        .param("result", json.write(result))
        .param("id", taskId)
        .update();
    if (rows != null) {
      for (JsonNode row : rows) {
        String content = json.write(row);
        if (!row.isObject() || content.length() > 65536) {
          throw ApiException.invalid("rows", "Строка результата слишком велика.");
        }
        jdbc.sql(
                "INSERT INTO result_rows(task_id,owner_id,cells) VALUES (:task,:owner,CAST(:cells"
                    + " AS jsonb))")
            .param("task", taskId)
            .param("owner", owner)
            .param("cells", content)
            .update();
      }
    }
    events.emit(owner, "task", taskId, 0);
  }

  private void validateResult(Contracts.Task task, JsonNode result, List<JsonNode> rows) {
    requireFields(result, Set.of("summary", "limitations", "sources", "columns"), "result");
    if (result.has("summary")) {
      text(result.get("summary"), "summary", 20000, true);
    }
    if (result.has("limitations")) {
      array(result.get("limitations"), "limitations", 100);
      for (JsonNode item : result.get("limitations")) {
        text(item, "limitations", 4000, false);
      }
    }
    if (result.has("sources")) {
      array(result.get("sources"), "sources", 100);
      for (JsonNode source : result.get("sources")) {
        requireFields(source, Set.of("title", "url"), "sources");
        text(source.path("title"), "sources.title", 500, false);
        String url = text(source.path("url"), "sources.url", 4096, false);
        TaskService.site(url);
      }
    }
    JsonNode columns = result.get("columns");
    if (columns == null && task.result() != null) {
      columns = task.result().path("columns");
    }
    Map<String, String> types = new HashMap<>();
    if (columns != null) {
      array(columns, "columns", 100);
      for (JsonNode column : columns) {
        requireFields(column, Set.of("key", "label", "type"), "columns");
        String key = text(column.path("key"), "columns.key", 64, false);
        String type = text(column.path("type"), "columns.type", 20, false);
        text(column.path("label"), "columns.label", 200, false);
        if (!key.matches("[A-Za-z_][A-Za-z0-9_]{0,63}")
            || types.putIfAbsent(key, type) != null
            || !Set.of("string", "number", "boolean", "date", "url").contains(type)) {
          throw ApiException.invalid(
              "columns", "Нужны уникальные ключи и поддерживаемые типы столбцов.");
        }
      }
      if (result.has("columns")
          && task.result() != null
          && !columns.equals(task.result().path("columns"))
          && jdbc.sql("SELECT EXISTS(SELECT 1 FROM result_rows WHERE task_id=:id)")
              .param("id", task.id())
              .query(Boolean.class)
              .single()) {
        throw ApiException.conflict(
            "RESULT_SCHEMA_CHANGED", "После добавления строк структуру столбцов менять нельзя.");
      }
    }
    if (rows == null) {
      return;
    }
    for (JsonNode row : rows) {
      if (!row.isObject() || json.write(row).length() > 65536) {
        throw ApiException.invalid("rows", "Некорректная или слишком большая строка результата.");
      }
      for (var entry : row.properties()) {
        String type = types.get(entry.getKey());
        JsonNode value = entry.getValue();
        if (type == null) {
          throw ApiException.invalid("rows", "Ячейка не соответствует объявленным столбцам.");
        }
        if (value.isNull()) {
          continue;
        }
        switch (type) {
          case "number" -> {
            if (!value.isNumber()) {
              throw ApiException.invalid("rows", "Числовой столбец принимает только числа.");
            }
          }
          case "boolean" -> {
            if (!value.isBoolean()) {
              throw ApiException.invalid("rows", "Логический столбец принимает true или false.");
            }
          }
          case "url" -> TaskService.site(text(value, "rows", 4096, false));
          case "date" -> {
            String date = text(value, "rows", 10, false);
            try {
              java.time.LocalDate.parse(date);
            } catch (java.time.DateTimeException exception) {
              throw ApiException.invalid("rows", "Дата должна иметь формат YYYY-MM-DD.");
            }
          }
          default -> text(value, "rows", 20000, true);
        }
      }
    }
  }

  private static void requireFields(JsonNode node, Set<String> allowed, String field) {
    if (!node.isObject()) {
      throw ApiException.invalid(field, "Ожидается объект установленного формата.");
    }
    for (var entry : node.properties()) {
      if (!allowed.contains(entry.getKey())) {
        throw ApiException.invalid(field, "Неизвестное поле результата.");
      }
    }
  }

  private static void array(JsonNode node, String field, int maximum) {
    if (!node.isArray() || node.size() > maximum) {
      throw ApiException.invalid(field, "Превышен размер списка или неверный формат.");
    }
  }

  private static String text(JsonNode node, String field, int maximum, boolean allowEmpty) {
    if (!node.isString()
        || node.asString().length() > maximum
        || !allowEmpty && node.asString().isBlank()) {
      throw ApiException.invalid(field, "Неверный формат или размер текста.");
    }
    return node.asString();
  }

  private record Pending(UUID id, UUID owner, UUID task) {}

  private record Completion(CompletableFuture<Void> signal, int waiters) {}

  private record Dispatch(
      UUID id,
      UUID owner,
      UUID task,
      UUID session,
      String type,
      JsonNode arguments,
      long revision,
      long epoch,
      boolean mutating,
      boolean observeAfter,
      JsonNode sequence) {}
}
