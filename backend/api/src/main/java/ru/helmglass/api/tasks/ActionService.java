package ru.helmglass.api.tasks;

import jakarta.annotation.PreDestroy;
import java.sql.Types;
import java.time.Duration;
import java.time.Instant;
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
import ru.helmglass.api.connections.ConnectionSite;
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
  private final ConnectionSite connectionSites;
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
  private final Semaphore receiptSlots = new Semaphore(4);
  private final ExecutorService receiptRecovery = Executors.newVirtualThreadPerTaskExecutor();
  private final ExecutorService dispatcher =
      Executors.newFixedThreadPool(
          MAXIMUM_DISPATCHES, Thread.ofPlatform().name("browser-command-", 0).factory());

  public ActionService(
      JdbcClient jdbc,
      JsonSupport json,
      TaskService tasks,
      ConnectionSite connectionSites,
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
    this.connectionSites = connectionSites;
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
    return submit(owner, taskId, action, List.of(), false);
  }

  @Transactional
  public Contracts.Operation submit(
      UUID owner,
      UUID taskId,
      Contracts.BrowserAction action,
      List<UUID> sequence,
      boolean explicitWait) {
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
    validateObservationArguments(action.type(), action.arguments());
    String confirmation =
        action.confirmationPrompt() == null
            ? null
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
                      + " instruction_snapshot->'step'=CAST(:definition AS jsonb),false)) AND"
                      + " (:observe IS NULL OR"
                      + " coalesce((instruction_snapshot->>'observeAfter')::boolean,true)=:observe)"
                      + " AND coalesce(instruction_snapshot->'sequence','[]'::jsonb)="
                      + " CAST(:sequence AS jsonb) AND type=:type AND"
                      + " coalesce((instruction_snapshot->>'explicitWait')::boolean,false)=:explicitWait"
                      + " AND arguments=CAST(:arguments AS jsonb) AND"
                      + " instruction_revision=:revision AND requested_control_epoch IS NOT"
                      + " DISTINCT FROM CAST(:epoch AS bigint) AND"
                      + " instruction_snapshot->>'confirmationPrompt' IS NOT DISTINCT FROM"
                      + " CAST(:confirmation AS text) FROM operations WHERE id=:id")
              .param("task", taskId)
              .param("step", action.stepId())
              .param("definition", action.step() == null ? null : json.write(action.step()))
              .param("observe", action.observeAfter(), Types.BOOLEAN)
              .param("sequence", json.write(sequence))
              .param("explicitWait", explicitWait)
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
    UUID stepId =
        action.step() == null
            ? action.stepId()
            : steps.startForAction(owner, taskId, action.instructionRevision(), action.step());
    steps.requireRunning(owner, taskId, stepId);
    boolean mutating = !READ_ONLY.contains(action.type());
    if ("captureAudio".equals(action.type())) {
      validateAudioContext(action.arguments().path("sourceContext"));
    }
    Map<String, Object> instruction = new HashMap<>();
    instruction.put("revision", task.instructionRevision());
    if (task.browser() != null
        && (!"CLOSED".equals(task.browser().status()) || action.arguments().has("observationId"))) {
      instruction.put("browserId", task.browser().id());
    }
    instruction.put("title", task.title());
    instruction.put("goal", task.goal());
    instruction.put("sequence", sequence);
    instruction.put("explicitWait", explicitWait);
    instruction.put(
        "observeAfter",
        action.observeAfter() == null
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
    if (task.browser() != null) {
      browsers.refreshIdle(owner, task.browser().id(), true);
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

  public Contracts.Task respond(
      Actor actor,
      String chat,
      TaskService.ElicitationClaim claim,
      String command,
      String text,
      UUID connection) {
    tasks.validateResponse(actor, chat, claim);
    if ("UNKNOWN_RESULT".equals(claim.request().type())) {
      String evidence = TaskService.required(text, "text", 4000);
      if (!Set.of("CONFIRM", "REJECT").contains(command)) {
        throw ApiException.invalid("type", "Укажите подтверждённый результат проверки.");
      }
      Dispatch operation = savedDispatch(claim.request().operationId());
      if (!Set.of("CLOSED", "LOST")
          .contains(browsers.get(actor.id(), operation.session()).status())) {
        worker.call(
            "POST",
            "/sessions/" + operation.session() + "/commands/" + operation.id() + "/resolve",
            Map.of(
                "outcome",
                "CONFIRM".equals(command) ? "SUCCEEDED" : "FAILED",
                "evidence",
                evidence));
      }
    }
    return transactions.execute(
        transaction -> {
          Contracts.Task task = tasks.respond(actor, chat, claim, command, text, connection);
          if ("UNKNOWN_RESULT".equals(claim.request().type())) {
            complete(
                savedDispatch(claim.request().operationId()),
                "CONFIRM".equals(command) ? "SUCCEEDED" : "FAILED",
                json.tree(Map.of("verification", text)),
                null,
                "Результат подтверждён пользователем.");
            return tasks.get(actor.id(), task.id());
          }
          if ("CHOOSE_CONNECTION".equals(command)) {
            return selectConnection(
                actor.id(), task.id(), task.instructionRevision(), connection, null);
          }
          return task;
        });
  }

  @Transactional
  public Contracts.Task prepareBrowser(UUID owner, UUID taskId) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    tasks.lockTask(owner, taskId);
    Contracts.Task task = tasks.get(owner, taskId);
    if (task.request() == null
        && !TaskService.TERMINAL.contains(task.status())
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
    if (connection == null) {
      var matches = connectionSites.choices(owner, task.site(), task.preferredConnectionIds());
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
      } else if (!task.preferredConnectionIds().isEmpty()
          && connectionSites.hasPreferred(owner, task.site(), task.preferredConnectionIds())) {
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
      UUID owner,
      UUID taskId,
      long instructionRevision,
      UUID connectionId,
      String confirmationPrompt) {
    Contracts.Task task =
        tasks.selectConnection(
            owner, taskId, instructionRevision, connectionId, confirmationPrompt);
    if ("PAUSED".equals(task.status())) {
      return task;
    }
    if (task.browser() != null) {
      browsers.refreshIdle(owner, task.browser().id(), true);
    }
    boolean ready =
        jdbc.sql("SELECT status='READY' FROM connections WHERE id=:id AND owner_id=:owner")
            .param("id", connectionId)
            .param("owner", owner)
            .query(Boolean.class)
            .single();
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
      boolean belongs =
          jdbc.sql(
                  "SELECT EXISTS(SELECT 1 FROM task_steps"
                      + " WHERE id=:step AND task_id=:task AND owner_id=:owner)")
              .param("step", step)
              .param("task", task)
              .param("owner", owner)
              .query(Boolean.class)
              .single();
      if (!belongs) {
        throw ApiException.notFound();
      }
      filter += " AND step_id=:step";
      parameters.put("step", step);
    }
    long total =
        jdbc.sql("SELECT count(*) FROM operations WHERE " + filter)
            .params(parameters)
            .query(Long.class)
            .single();
    var items =
        jdbc.sql(
                "SELECT id,task_id,step_id,type,status,created_at FROM operations WHERE "
                    + filter
                    + " ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET :offset")
            .params(parameters)
            .param("offset", (long) (page - 1) * 10)
            .query(
                (row, index) ->
                    new Contracts.OperationSummary(
                        row.getObject("id", UUID.class),
                        row.getObject("task_id", UUID.class),
                        row.getObject("step_id", UUID.class),
                        row.getString("type"),
                        row.getString("status"),
                        Database.instant(row, "created_at")))
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
            .optional()
            .orElseThrow(ApiException::notFound);
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
  public Contracts.Operation awaitResult(
      UUID owner, Contracts.Operation submitted, long deadlineNanos) {
    if (!Set.of("ACCEPTED", "DISPATCHED").contains(submitted.status())
        || System.nanoTime() >= deadlineNanos
        || !waitingCalls.tryAcquire()) {
      return submitted;
    }
    Completion completion =
        completions.compute(
            submitted.id(),
            (id, current) ->
                current == null
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
      completions.computeIfPresent(
          submitted.id(),
          (id, current) ->
              current.waiters() == 1
                  ? null
                  : new Completion(current.signal(), current.waiters() - 1));
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
      dispatcher.execute(
          () -> {
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
    receiptRecovery.shutdownNow();
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

  private static void validateObservationArguments(String type, JsonNode arguments) {
    if (!Set.of("observe", "waitFor").contains(type)) {
      return;
    }
    boolean target = arguments.has("observationId") && arguments.has("ref");
    if ("observe".equals(type)) {
      boolean valid =
          arguments.isEmpty()
              || arguments.size() == 1
                  && arguments.path("cursor").isString()
                  && !arguments.path("cursor").asString().isEmpty()
                  && arguments.path("cursor").asString().length() <= 100
              || arguments.size() == 2 && target;
      if (!valid) {
        throw ApiException.invalid("arguments", "Укажите страницу, observationId/ref или cursor.");
      }
    } else {
      boolean text = arguments.has("text");
      boolean state = arguments.has("state");
      if (!target
          || text && state
          || arguments.size() != (text || state ? 3 : 2)
          || text
              && (!arguments.path("text").isString()
                  || arguments.path("text").asString().isEmpty()
                  || arguments.path("text").asString().length() > 1000)
          || state
              && !Set.of("visible", "hidden", "attached", "detached")
                  .contains(arguments.path("state").asString(""))) {
        throw ApiException.invalid(
            "arguments", "waitFor требует observationId/ref и state либо text.");
      }
    }
    if (target
        && (!arguments.path("observationId").isString()
            || !arguments
                .path("observationId")
                .asString()
                .matches(
                    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
            || !arguments.path("ref").isString()
            || arguments.path("ref").asString().length() > 40
            || !arguments.path("ref").asString().matches("(f[0-9]+)?e[0-9]+"))) {
      throw ApiException.invalid("arguments", "Некорректные observationId/ref.");
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
    request.put("explicitWait", dispatch.explicitWait());
    Instant deadline =
        jdbc.sql("SELECT deadline_at FROM operations WHERE id=:id")
            .param("id", dispatch.id())
            .query((row, index) -> Database.instant(row, "deadline_at"))
            .single();
    request.put("deadlineAt", deadline.toString());
    if (!dispatch.sequence().isMissingNode() && !dispatch.sequence().isEmpty()) {
      request.put("sequence", Map.of("operationIds", dispatch.sequence()));
    }
    try {
      if ("applyConnection".equals(dispatch.type())
          && !browsers.refreshProfile(
              dispatch.owner(), dispatch.session(), dispatch.id() + ":before-switch")) {
        complete(
            dispatch,
            "FAILED",
            null,
            "PROFILE_SAVE_FAILED",
            "Не удалось сохранить текущее подключение. Смена аккаунта не выполнялась.");
        return;
      }
      if (browsers.reference(dispatch.session()).closeRequested()
          || !deadline.isAfter(Instant.now())) {
        complete(dispatch, "FAILED", null, "CANCELLED_BEFORE_DISPATCH", "Действие не отправлено.");
        return;
      }
      JsonNode response =
          worker.call(
              "POST",
              "/sessions/" + dispatch.session() + "/commands",
              request,
              Duration.between(Instant.now(), deadline));
      acceptResponse(dispatch, response);
    } catch (WorkerClient.WorkerException exception) {
      boolean rejected = Set.of(400, 401, 403, 404, 413, 422).contains(exception.status());
      complete(
          dispatch,
          rejected || !dispatch.mutating() ? "FAILED" : "UNKNOWN",
          null,
          exception.code(),
          rejected
              ? "Команда отклонена до исполнения."
              : "Ответ браузера потерян. Требуется проверить результат.");
      if (!rejected && !dispatch.mutating()) {
        transactions.executeWithoutResult(
            transaction -> {
              tasks.lockOwner(dispatch.owner());
              browsers.closeForFailure(dispatch.owner(), dispatch.session(), "READ_UNCONFIRMED");
            });
      }
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
                      instruction.path("sequence"),
                      instruction.path("explicitWait").asBoolean(false));
                })
            .single();
    if (command.revision() != task.instructionRevision()
        || tasks.hasUnknown(task.id()) && command.mutating()) {
      jdbc.sql("UPDATE operations SET status='CANCELLED',completed_at=now() WHERE id=:id")
          .param("id", command.id())
          .update();
      return null;
    }
    String boundSession =
        jdbc.sql("SELECT instruction_snapshot->>'browserId' FROM operations WHERE id=:id")
            .param("id", command.id())
            .query((row, index) -> row.getString(1))
            .optional()
            .orElse(null);
    if (boundSession != null && !sessionId.toString().equals(boundSession)
        || boundSession == null && command.arguments().has("observationId")) {
      jdbc.sql(
              "UPDATE operations SET"
                  + " status='CANCELLED',completed_at=now(),error_code='STALE_BROWSER' WHERE"
                  + " id=:id")
          .param("id", command.id())
          .update();
      tasks.requestContinuation(task.id());
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
      jdbc.sql("UPDATE browser_sessions SET pending_connection_id=:connection WHERE id=:id")
          .param("connection", connection)
          .param("id", task.browser().id())
          .update();
    }
    jdbc.sql(
            "UPDATE operations SET status='DISPATCHED',session_id=:session,control_epoch=:epoch,"
                + " dispatched_at=clock_timestamp(),next_check_at=clock_timestamp()+interval '5"
                + " seconds', deadline_at=clock_timestamp()+CASE WHEN type IN"
                + " ('captureAudio','applyConnection') THEN interval '6 minutes' ELSE interval '90"
                + " seconds' END WHERE id=:id")
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
                "SELECT o.* FROM operations o JOIN browser_sessions b ON b.id=o.session_id"
                    + " WHERE o.status IN ('DISPATCHED','UNKNOWN') AND NOT o.receipt_archived"
                    + " AND b.status<>'CLOSED' AND o.next_check_at<=clock_timestamp()"
                    + " ORDER BY o.next_check_at,o.id LIMIT 20")
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
                      instruction.path("sequence"),
                      instruction.path("explicitWait").asBoolean(false));
                })
            .list();
    for (Dispatch operation : operations) {
      if (!receiptSlots.tryAcquire()) {
        break;
      }
      try {
        int claimed =
            jdbc.sql(
                    "UPDATE operations SET next_check_at=clock_timestamp()+interval '45 seconds'"
                        + " WHERE id=:id AND next_check_at<=clock_timestamp()")
                .param("id", operation.id())
                .update();
        if (claimed == 0) {
          receiptSlots.release();
          continue;
        }
        receiptRecovery.execute(
            () -> {
              try {
                JsonNode receipt =
                    worker.call(
                        "GET",
                        "/sessions/" + operation.session() + "/commands/" + operation.id(),
                        null);
                acceptResponse(operation, receipt);
              } catch (RuntimeException exception) {
                if ("DISPATCHED".equals(operation(operation.owner(), operation.id()).status())) {
                  complete(
                      operation,
                      operation.mutating() ? "UNKNOWN" : "FAILED",
                      null,
                      "WORKER_UNREACHABLE",
                      "Результат отправленного действия пока неизвестен.");
                  if (!operation.mutating()) {
                    transactions.executeWithoutResult(
                        transaction -> {
                          tasks.lockOwner(operation.owner());
                          browsers.closeForFailure(
                              operation.owner(), operation.session(), "READ_UNCONFIRMED");
                        });
                  }
                }
              } finally {
                try {
                  jdbc.sql(
                          "UPDATE operations SET next_check_at=clock_timestamp()+interval '15"
                              + " seconds' WHERE id=:id")
                      .param("id", operation.id())
                      .update();
                } finally {
                  receiptSlots.release();
                }
              }
            });
      } catch (RuntimeException exception) {
        receiptSlots.release();
        throw exception;
      }
    }
  }

  private void acceptResponse(Dispatch operation, JsonNode response) {
    String status = response.path("status").asString("UNKNOWN");
    if ("RUNNING".equals(status)) {
      return;
    }
    JsonNode result = response.get("result");
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
      errorCode = operation.mutating() ? "UNKNOWN_RESULT" : "READ_UNCONFIRMED";
      errorMessage =
          operation.mutating() ? "Результат действия неизвестен." : "Чтение не завершено.";
      if (!operation.mutating()) {
        status = "FAILED";
      }
    }
    complete(
        operation,
        Set.of("SUCCEEDED", "FAILED").contains(status) ? status : "UNKNOWN",
        result,
        errorCode,
        errorMessage);
    if ("SUCCEEDED".equals(status)) {
      try {
        artifacts.importResults(
            operation.owner(), operation.task(), operation.session(), operation.id(), result);
      } catch (RuntimeException exception) {
        log.warn(
            "Confirmed operation {} awaits artifact delivery: {}",
            operation.id(),
            exception.getClass().getSimpleName());
      }
    }
  }

  /** Physical shutdown is independent of delivering the remaining receipts and files. */
  public void executionStopped(UUID session) {
    var ids =
        jdbc.sql("SELECT id FROM operations WHERE session_id=:session AND status='DISPATCHED'")
            .param("session", session)
            .query(UUID.class)
            .list();
    for (UUID id : ids) {
      Dispatch operation = savedDispatch(id);
      complete(
          operation,
          operation.mutating() ? "UNKNOWN" : "FAILED",
          null,
          "EXECUTION_STOPPED",
          "Исполнение остановлено; результат уточняется по сохранённой квитанции.");
    }
    var browser = browsers.reference(session);
    if (browser.taskId() != null) {
      transactions.executeWithoutResult(
          transaction -> {
            tasks.lockOwner(browser.ownerId());
            tasks.settleStop(browser.ownerId(), browser.taskId());
          });
    }
  }

  /** Recover final receipts before the node removes the original session volume. */
  public boolean archiveReceipts(UUID session) {
    var ids =
        jdbc.sql(
                "SELECT id FROM operations WHERE session_id=:session AND status IN"
                    + " ('DISPATCHED','UNKNOWN') AND NOT receipt_archived ORDER BY next_check_at,id"
                    + " LIMIT 20")
            .param("session", session)
            .query(UUID.class)
            .list();
    for (UUID id : ids) {
      Dispatch operation = savedDispatch(id);
      try {
        acceptResponse(
            operation, worker.call("GET", "/sessions/" + session + "/commands/" + id, null));
      } catch (WorkerClient.WorkerException exception) {
        if (exception.status() != 404) throw exception;
        // A missing receipt cannot prove that an already dispatched external change failed.
        complete(
            operation,
            operation.mutating() ? "UNKNOWN" : "FAILED",
            null,
            "RECEIPT_UNAVAILABLE",
            "Браузер остановлен; квитанция действия отсутствует.");
      }
      jdbc.sql("UPDATE operations SET receipt_archived=true WHERE id=:id").param("id", id).update();
    }
    return ids.size() < 20;
  }

  @Scheduled(fixedDelay = 1000)
  public void expireOperations() {
    var expired =
        jdbc.sql(
                """
                SELECT o.id,o.cancel_requested_at FROM operations o
                JOIN tasks t ON t.id=o.task_id JOIN browser_sessions b ON b.id=o.session_id
                WHERE o.status IN ('DISPATCHED','UNKNOWN') AND b.status<>'CLOSED'
                  AND o.deadline_at IS NOT NULL AND NOT o.deadline_handled
                  AND (o.deadline_at<=clock_timestamp() OR t.status='STOPPING')
                  AND (o.cancel_requested_at IS NULL
                    OR o.cancel_requested_at<=clock_timestamp()-interval '10 seconds')
                ORDER BY o.next_check_at,o.id LIMIT 20
                """)
            .query(
                (row, index) ->
                    new ExpiredOperation(
                        row.getObject("id", UUID.class),
                        Database.instant(row, "cancel_requested_at")))
            .list();
    for (ExpiredOperation candidate : expired) {
      Dispatch operation = savedDispatch(candidate.id());
      jdbc.sql(
              "UPDATE operations SET next_check_at=clock_timestamp()+interval '1"
                  + " second',cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp())"
                  + " WHERE id=:id")
          .param("id", candidate.id())
          .update();
      if (candidate.cancelAt() == null) {
        try {
          JsonNode result =
              worker.call(
                  "POST",
                  "/sessions/" + operation.session() + "/commands/" + operation.id() + "/cancel",
                  Map.of(),
                  Duration.ofSeconds(2));
          acceptResponse(operation, result);
        } catch (WorkerClient.WorkerException exception) {
          log.debug("Cancellation acknowledgement unavailable for {}", candidate.id());
        }
      } else if (!candidate.cancelAt().plusSeconds(10).isAfter(Instant.now())) {
        complete(
            operation,
            operation.mutating() ? "UNKNOWN" : "FAILED",
            null,
            "OPERATION_DEADLINE_EXCEEDED",
            "Срок операции истёк. Браузер закрывается.");
        transactions.executeWithoutResult(
            transaction -> {
              tasks.lockOwner(operation.owner());
              browsers.closeForFailure(
                  operation.owner(), operation.session(), "OPERATION_DEADLINE_EXCEEDED");
              jdbc.sql("UPDATE operations SET deadline_handled=true WHERE id=:id")
                  .param("id", candidate.id())
                  .update();
            });
      }
    }
  }

  private Dispatch savedDispatch(UUID id) {
    return jdbc.sql("SELECT * FROM operations WHERE id=:id")
        .param("id", id)
        .query(
            (row, index) -> {
              JsonNode instruction = json.read(row.getString("instruction_snapshot"));
              return new Dispatch(
                  id,
                  row.getObject("owner_id", UUID.class),
                  row.getObject("task_id", UUID.class),
                  row.getObject("session_id", UUID.class),
                  row.getString("type"),
                  json.read(row.getString("arguments")),
                  row.getLong("instruction_revision"),
                  row.getLong("control_epoch"),
                  row.getBoolean("mutating"),
                  instruction.path("observeAfter").asBoolean(true),
                  instruction.path("sequence"),
                  instruction.path("explicitWait").asBoolean(false));
            })
        .single();
  }

  private record ExpiredOperation(UUID id, Instant cancelAt) {}

  private void complete(
      Dispatch operation, String status, JsonNode result, String error, String message) {
    transactions.executeWithoutResult(
        transaction -> {
          tasks.lockOwner(operation.owner());
          tasks.lockTask(operation.owner(), operation.task());
          String previous = operation(operation.owner(), operation.id()).status();
          // Repeated recovery observations are not new task or browser activity.
          if (previous.equals(status)) {
            return;
          }
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
          TransactionSynchronizationManager.registerSynchronization(
              new TransactionSynchronization() {
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
      JsonNode sequence,
      boolean explicitWait) {}
}
