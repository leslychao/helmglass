package ru.helmglass.api.browsers;

import java.net.URI;
import java.sql.Types;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.tasks.TaskService;
import tools.jackson.databind.JsonNode;

@Service
public class BrowserService {
  private static final Logger log = LoggerFactory.getLogger(BrowserService.class);
  private static final Duration IDLE_TIMEOUT = Duration.ofMinutes(15);
  private static final String IDLE_PROTECTED = """
      (b.pending_control IS NOT NULL OR b.control_owner='TRANSFERRING'
       OR EXISTS(SELECT 1 FROM operations o WHERE o.session_id=b.id AND o.status='DISPATCHED')
       OR (b.control_owner='USER' AND EXISTS(
         SELECT 1 FROM browser_page_visits v WHERE v.session_id=b.id
           AND v.viewer_id::text=b.controller_id AND v.control_epoch=b.control_epoch
           AND NOT v.leaving AND v.expires_at>clock_timestamp())))
      """;
  private final JdbcClient jdbc;
  private final TaskService tasks;
  private final EventService events;
  private final Identity identity;
  private final WorkerClient worker;
  private final JsonSupport json;
  private final ViewerAccess viewers;
  private final TransactionTemplate transactions;

  public BrowserService(
      JdbcClient jdbc,
      TaskService tasks,
      EventService events,
      Identity identity,
      WorkerClient worker,
      JsonSupport json,
      ViewerAccess viewers,
      org.springframework.transaction.PlatformTransactionManager manager) {
    this.jdbc = jdbc;
    this.tasks = tasks;
    this.events = events;
    this.identity = identity;
    this.worker = worker;
    this.json = json;
    this.viewers = viewers;
    this.transactions = new TransactionTemplate(manager);
  }

  public Contracts.Browser get(UUID owner, UUID id) {
    return jdbc.sql("""
            SELECT b.*,c.profile_save_error FROM browser_sessions b
            LEFT JOIN connections c ON c.id=coalesce(b.pending_connection_id,b.connection_id)
            WHERE b.id=:id AND b.owner_id=:owner
            """)
        .param("id", id)
        .param("owner", owner)
        .query(
            (row, index) ->
                new Contracts.Browser(
                    row.getObject("id", UUID.class),
                    row.getString("status"),
                    row.getObject("node_id", UUID.class),
                    row.getString("control_owner"),
                    row.getLong("control_epoch"),
                    row.getBoolean("private_mode"),
                    row.getBoolean("private_mode") ? null : row.getString("current_url"),
                    "LIVE".equals(row.getString("status")),
                    "LIVE".equals(row.getString("status")),
                    row.getLong("version"), row.getString("profile_save_error"),
                    row.getObject("task_id", UUID.class),
                    row.getObject("connection_id", UUID.class), row.getBoolean("login_confirmed"),
                    Database.instant(row, "started_at"), Database.instant(row, "closed_at"),
                    Database.instant(row, "idle_close_at"), row.getString("close_reason")))
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  @Transactional
  public UUID ensure(UUID owner, UUID taskId, UUID connectionId, String startUrl) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    if (taskId != null) {
      tasks.lockTask(owner, taskId);
      var current =
          jdbc.sql(
                  "SELECT id FROM browser_sessions WHERE task_id=:task AND status NOT IN"
                      + " ('CLOSED','LOST')")
              .param("task", taskId)
              .query(UUID.class)
              .optional();
      if (current.isPresent()) {
        return current.get();
      }
    } else if (connectionId != null) {
      var current =
          jdbc.sql(
                  "SELECT id FROM browser_sessions WHERE connection_id=:connection AND status NOT"
                      + " IN ('CLOSED','LOST')")
              .param("connection", connectionId)
              .query(UUID.class)
              .optional();
      if (current.isPresent()) {
        if (reference(current.get()).taskId() != null) {
          throw ApiException.conflict(
              "CONNECTION_BUSY", "Подключение занято задачей. Откройте её браузер.");
        }
        return current.get();
      }
    }
    if (connectionId != null) {
      tasks.validateConnections(owner, List.of(connectionId));
      if (taskId != null) {
        var idle = jdbc.sql("""
                SELECT b.id FROM browser_sessions b JOIN connections c ON c.id=b.connection_id
                WHERE b.owner_id=:owner AND b.connection_id=:connection AND b.task_id IS NULL
                  AND b.status='LIVE' AND b.control_owner='NONE' AND NOT b.private_mode
                  AND b.pending_control IS NULL AND NOT b.close_requested AND c.status='READY'
                FOR UPDATE OF b
                """)
            .param("owner", owner).param("connection", connectionId).query(UUID.class).optional();
        if (idle.isPresent()) {
          UUID session = idle.get();
          long epoch = get(owner, session).controlEpoch() + 1;
          worker.call("POST", "/sessions/" + session + "/bind",
              Map.of("ownerId", owner, "taskId", taskId));
          worker.call("POST", "/sessions/" + session + "/control",
              Map.of("controlEpoch", epoch, "owner", "CHATGPT", "privateMode", false));
          jdbc.sql("""
                  UPDATE browser_sessions SET task_id=:task,control_owner='CHATGPT',
                    control_epoch=:epoch,version=version+1 WHERE id=:id
                  """)
              .param("task", taskId).param("epoch", epoch).param("id", session).update();
          jdbc.sql("UPDATE tasks SET browser_session_id=:session WHERE id=:task")
              .param("session", session).param("task", taskId).update();
          jdbc.sql("UPDATE usage_intervals SET ended_at=now() WHERE session_id=:id AND ended_at IS NULL")
              .param("id", session).update();
          startUsage(reference(session), session, "BROWSER");
          boolean reopening = "PAUSED".equals(tasks.get(owner, taskId).status());
          tasks.change(owner, taskId, reopening ? "PAUSED" : "WAITING_CHATGPT",
              reopening ? "BROWSER_OPEN_REQUESTED" : null, "Подключён открытый браузер");
          events.emit(owner, "browser", session, 0);
          return session;
        }
      }
      boolean busy =
          jdbc.sql(
                  "SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE (connection_id=:id OR"
                      + " pending_connection_id=:id) AND status NOT IN ('CLOSED','LOST'))")
              .param("id", connectionId)
              .query(Boolean.class)
              .single();
      if (busy) {
        if (taskId != null) {
          tasks.change(
              owner, taskId, "QUEUED", "CONNECTION_BUSY", "Подключение занято другой работой");
        }
        return null;
      }
    }
    UUID id = UUID.randomUUID();
    long sequence = events.emit(owner, "browser", id, 1);
    jdbc.sql(
            """
INSERT INTO browser_sessions(id,owner_id,task_id,connection_id,current_url,allocation_sequence,control_owner,control_epoch)
VALUES (:id,:owner,:task,:connection,:url,:sequence,:control,1)
""")
        .param("id", id)
        .param("owner", owner)
        .param("task", taskId)
        .param("connection", connectionId)
        .param("url", startUrl)
        .param("sequence", sequence)
        .param("control", taskId == null ? "NONE" : "CHATGPT")
        .update();
    if (taskId != null) {
      jdbc.sql("UPDATE tasks SET browser_session_id=:browser WHERE id=:task")
          .param("browser", id)
          .param("task", taskId)
          .update();
      boolean paused = "PAUSED".equals(tasks.get(owner, taskId).status());
      tasks.change(owner, taskId, paused ? "PAUSED" : "QUEUED",
          paused ? "BROWSER_OPEN_REQUESTED" : "BROWSER_CAPACITY", "Ожидание свободного браузера");
    }
    return id;
  }

  @Transactional
  public Contracts.Task openTaskBrowser(UUID owner, UUID id, Long expectedVersion) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    tasks.lockTask(owner, id);
    Contracts.Task task = tasks.get(owner, id);
    if (expectedVersion == null || expectedVersion != task.version()) {
      throw ApiException.conflict("STALE_VERSION", "Задача изменилась.");
    }
    if (!task.allowedCommands().contains("OPEN_BROWSER") || tasks.hasDispatched(id)
        || tasks.hasUnknown(id)) {
      throw ApiException.conflict("ACTION_UNAVAILABLE", "Новый браузер сейчас открыть нельзя.");
    }
    UUID connection = task.browser().connectionId();
    UUID session = ensure(owner, id, connection, task.startUrl());
    if (session == null) {
      throw ApiException.conflict("CONNECTION_BUSY", "Подключение занято другой работой.");
    }
    tasks.resumeWithBrowser(owner, id);
    Contracts.Browser opened = get(owner, session);
    if ("LOGIN".equals(task.waitReason())
        || (task.request() != null && "LOGIN".equals(task.request().type()))) {
      long epoch = opened.controlEpoch() + 1;
      if ("LIVE".equals(opened.status())) {
        worker.call("POST", "/sessions/" + session + "/control",
            Map.of("controlEpoch", epoch, "owner", "NONE", "privateMode", true));
      }
      jdbc.sql("""
              UPDATE browser_sessions SET private_mode=true,control_owner='NONE',
                control_epoch=:epoch,version=version+1 WHERE id=:id
              """).param("id", session).param("epoch", epoch).update();
    }
    if ("LIVE".equals(opened.status())) {
      tasks.browserReady(owner, id);
    }
    return tasks.get(owner, id);
  }

  @Transactional
  public Contracts.Browser keepOpen(UUID owner, UUID id) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    Contracts.Browser browser = get(owner, id);
    if (browser.taskId() == null || !"LIVE".equals(browser.status())
        || reference(id).closeRequested()) {
      throw ApiException.conflict("BROWSER_UNAVAILABLE", "Браузер уже закрывается или недоступен.");
    }
    refreshIdle(owner, id, true);
    return get(owner, id);
  }

  /** Model calls are activity; widget reads and viewers never call this method. */
  @Transactional
  public void modelActivity(UUID owner, UUID task) {
    tasks.lockOwner(owner);
    Contracts.Task current = tasks.get(owner, task);
    if (current.browser() != null) {
      refreshIdle(owner, current.browser().id(), true);
    }
  }

  @Transactional
  public void refreshIdle(UUID owner, UUID id, boolean activity) {
    tasks.lockOwner(owner);
    var state = jdbc.sql("SELECT b.idle_close_at," + IDLE_PROTECTED + " AS protected"
            + " FROM browser_sessions b WHERE b.id=:id AND b.owner_id=:owner"
            + " AND b.task_id IS NOT NULL AND b.status='LIVE' AND NOT b.close_requested")
        .param("id", id).param("owner", owner)
        .query((row, index) -> new IdleState(Database.instant(row, "idle_close_at"),
            row.getBoolean("protected"))).optional();
    if (state.isEmpty()) {
      return;
    }
    IdleState current = state.get();
    if (current.protectedNow()) {
      if (current.deadline() == null) {
        return;
      }
      setIdleDeadline(owner, id, null);
    } else if (activity || current.deadline() == null) {
      setIdleDeadline(owner, id, Instant.now().plus(IDLE_TIMEOUT));
    } else if (!current.deadline().isAfter(Instant.now())) {
      tasks.closeBrowser(owner, reference(id).taskId(), "IDLE_TIMEOUT");
    }
  }

  private void setIdleDeadline(UUID owner, UUID id, Instant deadline) {
    jdbc.sql("UPDATE browser_sessions SET idle_close_at=:deadline,version=version+1 WHERE id=:id")
        .param("deadline", deadline == null ? null : java.sql.Timestamp.from(deadline))
        .param("id", id).update();
    events.emit(owner, "browser", id, 0);
  }

  @Scheduled(fixedDelay = 2000)
  public void expireIdleBrowsers() {
    var candidates = jdbc.sql("""
            SELECT b.id,b.owner_id FROM browser_sessions b
            WHERE b.task_id IS NOT NULL AND b.status='LIVE' AND NOT b.close_requested
              AND ((b.idle_close_at IS NULL AND NOT %1$s)
                OR (b.idle_close_at IS NOT NULL AND %1$s)
                OR b.idle_close_at<=clock_timestamp())
            ORDER BY b.idle_close_at NULLS FIRST,b.id LIMIT 20
            """.formatted(IDLE_PROTECTED))
        .query((row, index) -> new PendingControl(row.getObject("id", UUID.class),
            row.getObject("owner_id", UUID.class))).list();
    for (PendingControl candidate : candidates) {
      try {
        transactions.executeWithoutResult(transaction ->
            refreshIdle(candidate.owner(), candidate.id(), false));
      } catch (ApiException | WorkerClient.WorkerException exception) {
        log.warn("Browser idle reconciliation will retry for {}: {}",
            candidate.id(), exception.getClass().getSimpleName());
      }
    }
  }

  private record IdleState(Instant deadline, boolean protectedNow) {}

  @Transactional
  public Contracts.Ticket ticket(
      ru.helmglass.api.auth.Actor actor, UUID id, Contracts.TicketInput input) {
    UUID owner = actor.id();
    tasks.lockOwner(owner);
    identity.requireGrant(actor);
    viewers.beforeTicket(actor);
    if (actor.sessionId() == null || actor.sessionId().isBlank()) {
      throw Identity.denied("Сессия доступа отсутствует.");
    }
    Contracts.Browser browser = get(owner, id);
    if (!"LIVE".equals(browser.status())) {
      throw ApiException.conflict("BROWSER_UNAVAILABLE", "Живой браузер сейчас недоступен.");
    }
    UUID.fromString(input.viewerId());
    if (!Set.of("VIEWER", "CONTROLLER").contains(input.role())) {
      throw ApiException.invalid("role", "Неизвестная роль просмотра.");
    }
    String controller =
        jdbc.sql("SELECT controller_id FROM browser_sessions WHERE id=:id")
            .param("id", id)
            .query((row, index) -> row.getString("controller_id"))
            .optional()
            .orElse(null);
    if (("CONTROLLER".equals(input.role()) || browser.privateMode())
        && (!"USER".equals(browser.controlOwner()) || !input.viewerId().equals(controller))) {
      throw Identity.denied("Этот просмотр не управляет защищённой сессией.");
    }
    String token = UUID.randomUUID().toString() + UUID.randomUUID();
    Instant expiry = Instant.now().plusSeconds(60);
    worker.call(
        "POST",
        "/sessions/" + id + "/ticket",
        Map.of(
            "ticket",
            token,
            "role",
            input.role(),
            "viewerId",
            input.viewerId(),
            "expiresAt",
            expiry.toString(),
            "access",
            Map.of("channel", actor.channel(), "grantId", actor.sessionId())));
    String path = "browser/sessions/" + id + "/view?ticket=" + token;
    String url =
        "/browser/novnc/helm.html?autoconnect=1&resize=scale&path="
            + java.net.URLEncoder.encode(path, java.nio.charset.StandardCharsets.UTF_8);
    return new Contracts.Ticket(url, token, input.role(), expiry);
  }

  @Transactional
  public Contracts.Browser control(UUID owner, UUID id, Contracts.ControlInput input) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    Contracts.Browser browser = get(owner, id);
    UUID.fromString(TaskService.required(input.viewerId(), "viewerId", 36));
    SessionReference reference = reference(id);
    if (!"LIVE".equals(browser.status()) || reference.closeRequested()) {
      throw ApiException.conflict("BROWSER_UNAVAILABLE", "Браузер недоступен.");
    }
    if ("TRANSFERRING".equals(browser.controlOwner())) {
      throw ApiException.conflict("CONTROL_PENDING", "Передача управления ещё не подтверждена.");
    }
    boolean sessionSave = "SAVE_SESSION".equals(input.type());
    boolean confirmLogin = "CONFIRM_LOGIN".equals(input.type());
    boolean finishLogin = "FINISH_LOGIN".equals(input.type());
    if (input.controlEpoch() != null && input.controlEpoch() != browser.controlEpoch()) {
      throw ApiException.conflict("CONTROL_CHANGED", "Управление изменилось. Обновите просмотр.");
    }
    if (sessionSave && !Boolean.TRUE.equals(input.saveConnection())) {
      throw ApiException.invalid("saveConnection", "Сохранение должно включать запись сессии.");
    }
    if (sessionSave || confirmLogin) {
      if (input.controlEpoch() == null || input.controlEpoch() != browser.controlEpoch()) {
        throw ApiException.conflict("CONTROL_CHANGED", "Управление изменилось. Обновите просмотр.");
      }
    }
    if (sessionSave || confirmLogin || finishLogin) {
      if (!"USER".equals(browser.controlOwner()) || !browser.privateMode()
          || !input.viewerId().equals(reference.controllerId())) {
        throw Identity.denied("Подтвердить и сохранить вход можно в управляющем защищённом просмотре.");
      }
    }
    if (reference.taskId() != null
        && (tasks.hasDispatched(reference.taskId()) || tasks.hasUnknown(reference.taskId()))) {
      throw ApiException.conflict(
          "ACTION_UNRESOLVED", "Сначала дождитесь или проверьте результат текущего действия.");
    }
    if (confirmLogin) {
      jdbc.sql("UPDATE browser_sessions SET login_confirmed=true,login_completed=true,"
              + "version=version+1 WHERE id=:id")
          .param("id", id).update();
      events.emit(owner, "browser", id, browser.version() + 1);
      return get(owner, id);
    }
    if (sessionSave && !browser.loginConfirmed()) {
      throw ApiException.conflict("LOGIN_NOT_CONFIRMED", "Сначала подтвердите завершение входа.");
    }
    boolean take = Set.of("TAKE", "BEGIN_LOGIN").contains(input.type());
    boolean returning = Set.of("RETURN", "FINISH_LOGIN").contains(input.type());
    if (!take && !returning && !sessionSave) {
      throw ApiException.invalid("type", "Неизвестная команда управления.");
    }
    if (returning && !input.viewerId().equals(reference.controllerId())) {
      throw Identity.denied("Управление находится в другом просмотре.");
    }
    if (Boolean.TRUE.equals(input.saveConnection())) {
      if (!("FINISH_LOGIN".equals(input.type()) || sessionSave) || input.connectionId() == null) {
        throw ApiException.invalid("connectionId", "Выберите подключение для сохранения входа.");
      }
      tasks.validateConnections(owner, List.of(input.connectionId()));
      requireAvailableConnection(input.connectionId(), id);
      if (input.accountLabel() != null) {
        TaskService.required(input.accountLabel(), "accountLabel", 300);
      }
      if (input.accountSubject() != null) {
        TaskService.required(input.accountSubject(), "accountSubject", 500);
      }
      String previous =
          jdbc.sql("SELECT account_subject FROM connections WHERE id=:id")
              .param("id", input.connectionId())
              .query((row, index) -> row.getString("account_subject"))
              .optional()
              .orElse(null);
      if (previous != null && input.accountSubject() != null
          && !previous.equals(input.accountSubject().trim())) {
        throw ApiException.conflict(
            "ACCOUNT_MISMATCH", "Создайте отдельное подключение для другого аккаунта.");
      }
      jdbc.sql("UPDATE connections SET profile_save_error=NULL WHERE id=:id")
          .param("id", input.connectionId()).update();
    }
    if (reference.taskId() != null) {
      tasks.suspendBrowserWork(reference.taskId());
    }
    if ("TAKE".equals(input.type()) && browser.privateMode()) {
      input =
          new Contracts.ControlInput(
              "BEGIN_LOGIN",
              input.viewerId(),
              input.resume(),
              input.saveConnection(),
              input.connectionId(),
              input.accountLabel(),
              input.accountSubject());
    }
    long epoch = browser.controlEpoch() + 1;
    boolean keepPrivate = "RETURN".equals(input.type()) && browser.privateMode()
        && !jdbc.sql("SELECT login_completed FROM browser_sessions WHERE id=:id")
            .param("id", id).query(Boolean.class).single();
    jdbc.sql(
            """
UPDATE browser_sessions SET control_owner='TRANSFERRING',control_epoch=:epoch,
  private_mode=true,pending_control=CAST(:intent AS jsonb),version=version+1,
  login_completed=CASE WHEN :newLogin THEN false ELSE login_completed END,
  pending_connection_id=CASE WHEN :saving THEN :connection ELSE pending_connection_id END WHERE id=:id
""")
        .param("epoch", epoch)
        .param("intent", json.write(new ControlIntent(input, keepPrivate)))
        .param("newLogin", "BEGIN_LOGIN".equals(input.type()) && !browser.privateMode())
        .param("saving", Boolean.TRUE.equals(input.saveConnection()))
        .param("connection", input.connectionId())
        .param("id", id)
        .update();
    events.emit(owner, "browser", id, browser.version() + 1);
    return get(owner, id);
  }

  @Scheduled(fixedDelay = 500)
  public void deliverControlIntents() {
    var pending =
        jdbc.sql(
                "SELECT id,owner_id FROM browser_sessions WHERE pending_control IS NOT NULL AND"
                    + " status='LIVE' AND NOT close_requested ORDER BY created_at LIMIT 20")
            .query(
                (row, index) ->
                    new PendingControl(
                        row.getObject("id", UUID.class), row.getObject("owner_id", UUID.class)))
            .list();
    for (PendingControl intent : pending) {
      try {
        transactions.executeWithoutResult(
            transaction -> {
              tasks.lockOwner(intent.owner());
              var input =
                  jdbc.sql(
                          "SELECT pending_control::text FROM browser_sessions WHERE id=:id AND"
                              + " pending_control IS NOT NULL AND status='LIVE'"
                              + " AND NOT close_requested FOR UPDATE")
                      .param("id", intent.id())
                      .query(String.class)
                      .optional();
              if (input.isPresent()) {
                applyControl(
                    intent.owner(),
                    intent.id(),
                    json.convert(json.read(input.get()), ControlIntent.class));
              }
            });
      } catch (WorkerClient.WorkerException exception) {
        // The committed intent and fail-closed policy remain until the worker acknowledges it.
        String failure = exception.code().startsWith("PROFILE_")
            ? exception.code() : "PROFILE_SAVE_FAILED";
        jdbc.sql("""
                UPDATE connections SET profile_save_error=:failure,version=version+1
                WHERE id=(SELECT pending_connection_id FROM browser_sessions WHERE id=:id)
                  AND profile_save_error IS DISTINCT FROM :failure
                """).param("failure", failure).param("id", intent.id()).update();
        events.emit(intent.owner(), "browser", intent.id(), 0);
        if (Set.of(400, 403, 413, 422).contains(exception.status())
            || Set.of("PROFILE_SNAPSHOT_CHANGED", "PROFILE_REVISION_CHANGED",
                "PROFILE_UNSUPPORTED_VALUE").contains(exception.code())) {
          try {
            transactions.executeWithoutResult(transaction -> {
              tasks.lockOwner(intent.owner());
              Contracts.Browser browser = get(intent.owner(), intent.id());
              SessionReference reference = reference(intent.id());
              if (reference.closeRequested() || !"LIVE".equals(browser.status())) {
                return;
              }
              if (reference.controllerId() != null) {
                long epoch = browser.controlEpoch() + 1;
                worker.call("POST", "/sessions/" + intent.id() + "/control",
                    Map.of("controlEpoch", epoch, "owner", "USER",
                        "privateMode", true, "controllerId", reference.controllerId()));
                jdbc.sql("""
                        UPDATE browser_sessions SET pending_control=NULL,pending_connection_id=NULL,
                          control_epoch=:epoch,control_owner='USER',private_mode=true,
                          version=version+1 WHERE id=:id
                        """).param("epoch", epoch).param("id", intent.id()).update();
                events.emit(intent.owner(), "browser", intent.id(), 0);
              }
            });
          } catch (WorkerClient.WorkerException recoveryFailure) {
            // Keep the durable intent and protected state until the worker is reachable.
          }
        }
      }
    }
  }

  private void applyControl(UUID owner, UUID id, ControlIntent intent) {
    Contracts.ControlInput input = intent.input();
    Contracts.Browser browser = get(owner, id);
    SessionReference reference = reference(id);
    boolean take = Set.of("TAKE", "BEGIN_LOGIN").contains(input.type());
    boolean sessionSave = "SAVE_SESSION".equals(input.type());
    long epoch = browser.controlEpoch();
    boolean incompleteLogin = intent.keepPrivate();
    boolean privateMode = "BEGIN_LOGIN".equals(input.type()) || sessionSave || incompleteLogin;
    String control = take || sessionSave ? "USER" : reference.taskId() == null ? "NONE" : "CHATGPT";
    Map<String, Object> payload = new HashMap<>();
    payload.put("controlEpoch", epoch);
    payload.put("owner", control);
    payload.put("privateMode", privateMode);
    if (take || sessionSave) {
      payload.put("controllerId", input.viewerId());
    }
    if (("FINISH_LOGIN".equals(input.type()) || sessionSave)
        && Boolean.TRUE.equals(input.saveConnection())) {
      saveProfile(owner, id, input.connectionId(), input.accountLabel(), input.accountSubject(), epoch);
    }
    worker.call("POST", "/sessions/" + id + "/control", payload);
    jdbc.sql(
            """
            UPDATE browser_sessions SET control_owner=:control,private_mode=:private,
              controller_id=:controller,pending_control=NULL,
              login_confirmed=CASE WHEN :saved THEN false ELSE login_confirmed END,
              version=version+1 WHERE id=:id
            """)
        .param("control", control)
        .param("private", privateMode)
        .param("controller", take || sessionSave ? input.viewerId() : null)
        .param("saved", Boolean.TRUE.equals(input.saveConnection()))
        .param("id", id)
        .update();
    if (sessionSave) {
      events.emit(owner, "browser", id, browser.version() + 1);
      return;
    }
    jdbc.sql(
            "UPDATE usage_intervals SET ended_at=now() WHERE session_id=:id AND kind='MANUAL' AND"
                + " ended_at IS NULL")
        .param("id", id)
        .update();
    if (take) {
      startUsage(reference, id, "MANUAL");
    }
    if (reference.taskId() != null) {
      Contracts.Task task = tasks.get(owner, reference.taskId());
      if (take) {
        tasks.change(
            owner,
            task.id(),
            "WAITING_USER",
            privateMode ? "LOGIN" : "MANUAL_CONTROL",
            privateMode ? "Защищённый вход пользователя" : "Ручное управление");
      } else {
        boolean paused =
            jdbc.sql("SELECT paused_explicitly FROM tasks WHERE id=:id")
                .param("id", task.id())
                .query(Boolean.class)
                .single();
        boolean resume = Boolean.TRUE.equals(input.resume());
        if (!resume || paused) {
          jdbc.sql("UPDATE tasks SET paused_explicitly=true WHERE id=:id")
              .param("id", task.id())
              .update();
        }
        String pendingReason = incompleteLogin ? "LOGIN" : null;
        if (task.request() != null) {
          boolean completedLogin = "FINISH_LOGIN".equals(input.type())
              || jdbc.sql("SELECT login_completed FROM browser_sessions WHERE id=:id")
                  .param("id", id).query(Boolean.class).single();
          if ("MANUAL_CONTROL".equals(task.request().type())
              || ("LOGIN".equals(task.request().type()) && completedLogin)) {
            tasks.cancelRequest(task.id());
          } else {
            pendingReason = task.request().type();
          }
        }
        String state = "WAITING_CHATGPT";
        if (paused || !resume) {
          state = "PAUSED";
        } else if (pendingReason != null) {
          state = "WAITING_USER";
        }
        tasks.change(
            owner,
            task.id(),
            state,
            pendingReason,
            "Управление возвращено");
        tasks.requestContinuation(task.id());
      }
    }
    events.emit(owner, "browser", id, browser.version() + 2);
    refreshIdle(owner, id, true);
  }

  private record PendingControl(UUID id, UUID owner) {}

  private void requireAvailableConnection(UUID connection, UUID session) {
    boolean occupied =
        jdbc.sql(
                """
SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE (connection_id=:connection OR pending_connection_id=:connection)
 AND id<>:session AND status NOT IN ('CLOSED','LOST'))
""")
            .param("connection", connection)
            .param("session", session)
            .query(Boolean.class)
            .single();
    if (occupied) {
      throw ApiException.conflict("CONNECTION_BUSY", "Подключение занято другим браузером.");
    }
  }

  private void saveProfile(
      UUID owner, UUID session, UUID connection, String label, String subject, long controlEpoch) {
    if (connection == null) {
      throw ApiException.invalid("connectionId", "Выберите подключение для сохранения входа.");
    }
    tasks.validateConnections(owner, List.of(connection));
    requireAvailableConnection(connection, session);
    String identityLabel = label == null ? null : TaskService.required(label, "accountLabel", 300);
    String identitySubject = subject == null
        ? null : TaskService.required(subject, "accountSubject", 500);
    var previous =
        jdbc.sql("SELECT account_subject FROM connections WHERE id=:id")
            .param("id", connection)
            .query((row, index) -> row.getString("account_subject"))
            .optional()
            .orElse(null);
    if (previous != null && identitySubject != null && !previous.equals(identitySubject)) {
      throw ApiException.conflict(
          "ACCOUNT_MISMATCH", "Вход принадлежит другому аккаунту. Создайте отдельное подключение.");
    }
    JsonNode saved = worker.call(
        "POST",
        "/sessions/" + session + "/profile/export",
        Map.of("connectionId", connection, "ownerId", owner,
            "origins", connectionOrigins(owner, connection), "includeLoginOrigins", true,
            "operationId", session + ":" + controlEpoch), Duration.ofSeconds(310));
    recordProfileSave(owner, connection, saved);
    jdbc.sql("UPDATE connections SET authorized_origins=CAST(:origins AS jsonb) WHERE id=:id")
        .param("origins", json.write(saved.path("origins"))).param("id", connection).update();
    jdbc.sql(
            "UPDATE connections SET"
                + " status='READY',account_label=COALESCE(:label,account_label),"
                + "account_subject=COALESCE(:subject,account_subject),version=version+1,"
                + "updated_at=now(),last_used_at=now()"
                + " WHERE id=:id")
        .param("label", identityLabel)
        .param("subject", identitySubject)
        .param("id", connection)
        .update();
    jdbc.sql(
            "UPDATE browser_sessions SET connection_id=:connection,pending_connection_id=NULL WHERE"
                + " id=:session AND owner_id=:owner")
        .param("connection", connection)
        .param("session", session)
        .param("owner", owner)
        .update();
    jdbc.sql(
            "UPDATE tasks SET selected_connection_id=:connection WHERE browser_session_id=:session"
                + " AND owner_id=:owner")
        .param("connection", connection)
        .param("session", session)
        .param("owner", owner)
        .update();
    events.emit(owner, "connection", connection, 0);
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void recordSuccessfulUse(UUID owner, UUID session) {
    var changed =
        jdbc.sql(
                """
UPDATE connections SET last_used_at=now(),version=version+1
WHERE owner_id=:owner AND deleted_at IS NULL AND status='READY'
  AND id=(SELECT connection_id FROM browser_sessions WHERE id=:session AND owner_id=:owner)
RETURNING id,version
""")
            .param("owner", owner)
            .param("session", session)
            .query(
                (row, index) -> Map.entry(row.getObject("id", UUID.class), row.getLong("version")))
            .optional();
    changed.ifPresent(
        connection -> events.emit(owner, "connection", connection.getKey(), connection.getValue()));
  }

  @Transactional
  public void requestClose(UUID owner, UUID id) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    Contracts.Browser browser = get(owner, id);
    if (browser.taskId() != null) {
      tasks.closeBrowser(owner, browser.taskId());
      return;
    }
    jdbc.sql("""
            UPDATE browser_sessions SET close_requested=true,version=version+1,
              pending_control=NULL,pending_connection_id=NULL,
              closed_at=CASE WHEN status='QUEUED' THEN now() ELSE closed_at END,
              control_owner=CASE WHEN status='QUEUED' THEN 'NONE' ELSE control_owner END,
              status=CASE WHEN status='QUEUED' THEN 'CLOSED' ELSE status END WHERE id=:id
            """)
        .param("id", id)
        .update();
    events.emit(owner, "browser", id, 0);
  }

  @Transactional
  public void reconcile(UUID id, JsonNode result) {
    SessionReference reference = reference(id);
    tasks.lockOwner(reference.ownerId());
    if (reference.taskId() != null) {
      tasks.lockTask(reference.ownerId(), reference.taskId());
    }
    String state = result.path("status").asString("UNKNOWN");
    if (reference.connectionId() != null && !result.path("profileRevision").isNumber()
        && reference.connectionId().toString().equals(result.path("profileConnectionId").asString())
        && result.path("profileSaveError").isString()) {
      int changed = jdbc.sql("""
              UPDATE connections SET profile_save_error=:error,version=version+1
              WHERE id=:id AND profile_save_error IS DISTINCT FROM :error
              """).param("error", result.path("profileSaveError").asString())
          .param("id", reference.connectionId()).update();
      if (changed != 0) {
        events.emit(reference.ownerId(), "connection", reference.connectionId(), 0);
      }
    }
    if (reference.connectionId() != null
        && reference.connectionId().toString().equals(result.path("profileConnectionId").asString())
        && result.path("profileRevision").isNumber()) {
      recordProfileSave(reference.ownerId(), reference.connectionId(),
          result.path("profileRevision").asLong(), result.path("profileSavedAt").asString(null),
          result.path("profileSaveError").asString(null), cookieCheck(result));
    }
    String status =
        switch (state) {
          case "LIVE", "STARTING", "CLOSING", "CLOSED", "LOST" -> state;
          default -> "UNREACHABLE";
        };
    if (reference.closeRequested() && Set.of("LIVE", "STARTING").contains(status)) {
      status = "CLOSING";
    }
    Contracts.Browser previousBrowser = get(reference.ownerId(), id);
    String previous = previousBrowser.status();
    String reportedUrl = result.path("currentUrl").asString(null);
    boolean urlChanged =
        !previousBrowser.privateMode()
            && reportedUrl != null
            && !reportedUrl.equals(previousBrowser.currentUrl());
    jdbc.sql(
            "UPDATE browser_sessions SET"
                + " status=:status,last_seen_at=now(),current_url=coalesce(:url,current_url),version=version+1"
                + " WHERE id=:id")
        .param("status", status)
        .param("url", result.path("currentUrl").asString(null))
        .param("id", id)
        .update();
    if ("LIVE".equals(status) && !"LIVE".equals(previous)) {
      Contracts.Browser policy = get(reference.ownerId(), id);
      if ("TRANSFERRING".equals(policy.controlOwner())) {
        return;
      }
      Map<String, Object> desired = new HashMap<>();
      desired.put("owner", policy.controlOwner());
      desired.put("privateMode", policy.privateMode());
      desired.put("controlEpoch", policy.controlEpoch());
      if (reference.controllerId() != null) {
        desired.put("controllerId", reference.controllerId());
      }
      worker.call("POST", "/sessions/" + id + "/control", desired);
      jdbc.sql("UPDATE browser_sessions SET started_at=coalesce(started_at,now()) WHERE id=:id")
          .param("id", id)
          .update();
      startUsage(reference, id, "BROWSER");
      if ("USER".equals(policy.controlOwner())) {
        startUsage(reference, id, "MANUAL");
      }
      if (reference.taskId() != null) {
        Contracts.Task task = tasks.get(reference.ownerId(), reference.taskId());
        if (Set.of("QUEUED", "STARTING").contains(task.status())
            || "BROWSER_OPEN_REQUESTED".equals(task.waitReason())) {
          tasks.browserReady(reference.ownerId(), task.id());
        }
      }
      refreshIdle(reference.ownerId(), id, false);
    }
    if (Set.of("CLOSED", "LOST").contains(status)) {
      jdbc.sql(
              "UPDATE browser_sessions SET"
                  + " closed_at=coalesce(closed_at,now()),control_owner='NONE',private_mode=false,controller_id=NULL,idle_close_at=NULL,pending_control=NULL"
                  + " WHERE id=:id")
          .param("id", id)
          .update();
      jdbc.sql(
              "UPDATE usage_intervals SET ended_at=now(),incomplete=incomplete OR :lost WHERE"
                  + " session_id=:id AND ended_at IS NULL")
          .param("lost", "LOST".equals(status))
          .param("id", id)
          .update();
      if (reference.taskId() != null) {
        Contracts.Task task = tasks.get(reference.ownerId(), reference.taskId());
        if ("STOPPING".equals(task.status())) {
          tasks.settleStop(reference.ownerId(), task.id());
        } else if ("CLOSED".equals(status)
            && !"CLOSED".equals(previous)
            && reference.closeRequested()
            && "PAUSED".equals(task.status())) {
          tasks.history(
              reference.ownerId(),
              task.id(),
              "BROWSER_CLOSED",
              "Сессия браузера закрыта",
              "Задача, история и сохранённые результаты доступны.");
        } else if (!reference.closeRequested()
            && !TaskService.TERMINAL.contains(task.status())
            && !Set.of("CLOSED", "LOST").contains(previous)
            && !tasks.hasUnknown(task.id())) {
          tasks.request(
              reference.ownerId(),
              task.id(),
              "BROWSER_LOST",
              "Браузер утрачен. Для продолжения потребуется отдельное согласие на новый браузер.",
              null,
              null);
        }
      }
    }
    if (!previous.equals(status) || urlChanged) {
      events.emit(reference.ownerId(), "browser", id, 0);
      if (reference.taskId() != null) {
        events.emit(reference.ownerId(), "task", reference.taskId(), 0);
      }
      events.emit(reference.ownerId(), "usage", reference.taskId(), 0);
      events.emitAdministrators("node", get(reference.ownerId(), id).nodeId(), 0);
      events.emitAdministrators("admin-user", reference.ownerId(), 0);
    }
  }

  /** Enter private login without interpreting a saved profile as current authentication. */
  @Transactional
  public Contracts.Task requireLogin(UUID owner, UUID taskId, long expectedVersion) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    tasks.lockTask(owner, taskId);
    Contracts.Task task = tasks.get(owner, taskId);
    if (task.version() != expectedVersion) {
      throw ApiException.conflict("STALE_VERSION", "Задача изменилась.");
    }
    if (tasks.hasDispatched(taskId) || tasks.hasUnknown(taskId)
        || Set.of("DRAFT", "STOPPING", "STOPPED", "SUCCEEDED", "PARTIAL", "NOT_ACHIEVED", "FAILED")
            .contains(task.status())
        || (task.request() != null && !"LOGIN".equals(task.request().type()))) {
      throw ApiException.conflict("ACTION_UNRESOLVED", "Сначала завершите текущее действие.");
    }
    UUID connection = jdbc.sql("SELECT selected_connection_id FROM tasks WHERE id=:id")
        .param("id", taskId).query((row, index) -> row.getObject(1, UUID.class))
        .optional().orElse(null);
    UUID session = ensure(owner, taskId, connection, task.startUrl());
    if (session == null) {
      return tasks.get(owner, taskId);
    }
    tasks.cancelQueued(taskId);
    if (connection != null) {
      jdbc.sql("UPDATE connections SET status='LOGIN_REQUIRED',version=version+1 WHERE id=:id")
          .param("id", connection).update();
      events.emit(owner, "connection", connection, 0);
    }
    Contracts.Browser browser = get(owner, session);
    SessionReference previous = reference(session);
    if (connection != null && !connection.equals(previous.connectionId())) {
      requireAvailableConnection(connection, session);
      refreshProfile(owner, session);
    }
    boolean switchingConnection = connection != null && !connection.equals(previous.connectionId());
    if (switchingConnection || !browser.privateMode() || !"USER".equals(browser.controlOwner())) {
      long epoch = browser.controlEpoch() + 1;
      // No controller exists until the owner opens the protected login view.
      if ("LIVE".equals(browser.status())) {
        worker.call("POST", "/sessions/" + session + "/control",
            Map.of("controlEpoch", epoch, "owner", "NONE", "privateMode", true));
      }
      jdbc.sql("""
              UPDATE browser_sessions SET private_mode=true,control_owner='NONE',
                controller_id=NULL,control_epoch=:epoch,login_completed=false,version=version+1 WHERE id=:id
              """)
          .param("epoch", epoch).param("id", session).update();
      events.emit(owner, "browser", session, 0);
    }
    if (connection != null && !connection.equals(previous.connectionId())) {
      String startUrl = jdbc.sql("SELECT start_url FROM connections WHERE id=:id")
          .param("id", connection).query(String.class).single();
      if (!"LIVE".equals(browser.status())) {
        throw ApiException.conflict("BROWSER_UNAVAILABLE", "Дождитесь запуска браузера.");
      }
      worker.call("POST", "/sessions/" + session + "/login-context",
          Map.of("ownerId", owner, "connectionId", connection, "startUrl", startUrl));
      jdbc.sql("UPDATE browser_sessions SET connection_id=:connection WHERE id=:id")
          .param("connection", connection).param("id", session).update();
    }
    if (task.request() == null) {
      tasks.request(owner, taskId, "LOGIN", "Войдите на сайт в защищённом браузере задачи.", null, null);
    }
    return tasks.get(owner, taskId);
  }

  public List<String> connectionOrigins(UUID owner, UUID connection) {
    tasks.validateConnections(owner, List.of(connection));
    return jdbc.sql("SELECT start_url,authorized_origins::text FROM connections WHERE id=:id")
        .param("id", connection).query((row, index) -> {
          List<String> origins = new ArrayList<>();
          for (JsonNode origin : json.read(row.getString(2))) {
            origins.add(origin.asString());
          }
          if (origins.isEmpty()) {
            URI url = URI.create(row.getString(1));
            origins.add(url.getScheme() + "://" + url.getAuthority());
          }
          return List.copyOf(origins);
        }).single();
  }

  /** A checkpoint failure never turns a completed external action into a retry. */
  @Transactional
  public void refreshProfile(UUID owner, UUID session) {
    tasks.lockOwner(owner);
    var connection = jdbc.sql("""
            SELECT c.id FROM connections c JOIN browser_sessions b ON b.connection_id=c.id
            WHERE b.id=:session AND b.owner_id=:owner AND b.status='LIVE'
              AND NOT b.private_mode AND c.status='READY' AND c.deleted_at IS NULL
            """).param("session", session).param("owner", owner).query(UUID.class).optional();
    if (connection.isEmpty()) {
      return;
    }
    try {
      JsonNode result = worker.call("POST", "/sessions/" + session + "/profile/export",
          Map.of("connectionId", connection.get(), "ownerId", owner,
              "origins", connectionOrigins(owner, connection.get())), Duration.ofSeconds(310));
      recordProfileSave(owner, connection.get(), result);
    } catch (WorkerClient.WorkerException exception) {
      String failure = exception.code().startsWith("PROFILE_")
          ? exception.code() : "PROFILE_SAVE_FAILED";
      int changed = jdbc.sql("""
              UPDATE connections SET profile_save_error=:failure,version=version+1
              WHERE id=:id AND profile_save_error IS DISTINCT FROM :failure
              """).param("id", connection.get()).param("failure", failure).update();
      if (changed != 0) {
        events.emit(owner, "connection", connection.get(), 0);
      }
    }
  }

  private void recordProfileSave(UUID owner, UUID connection, JsonNode result) {
    recordProfileSave(owner, connection, result.path("revision").asLong(),
        result.path("savedAt").asString(), null, cookieCheck(result));
  }

  private Contracts.CookieCheck cookieCheck(JsonNode result) {
    JsonNode value = result.path("cookieCheck");
    return value.isMissingNode() || value.isNull() ? null
        : json.convert(value, Contracts.CookieCheck.class);
  }

  private void recordProfileSave(UUID owner, UUID connection, long revision, String savedAt,
      String error, Contracts.CookieCheck check) {
    int changed = jdbc.sql("""
            UPDATE connections SET profile_revision=:revision,
              profile_saved_at=CAST(:saved AS timestamptz),profile_save_error=:error,
              cookie_usable_count=:count,cookie_checked_at=CAST(:checked AS timestamptz),
              version=version+1
            WHERE id=:id AND profile_revision<=:revision
              AND (profile_revision<:revision OR cookie_checked_at IS NULL
                OR CAST(:checked AS timestamptz)>=cookie_checked_at)
              AND (profile_revision<>:revision OR profile_save_error IS DISTINCT FROM :error
                OR cookie_checked_at IS DISTINCT FROM CAST(:checked AS timestamptz)
                OR cookie_usable_count IS DISTINCT FROM :count)
            """).param("revision", revision).param("saved", savedAt).param("error", error)
        .param("count", check == null ? null : check.usableCount(), Types.INTEGER)
        .param("checked", check == null ? null : check.checkedAt().toString())
        .param("id", connection).update();
    if (changed != 0) {
      events.emit(owner, "connection", connection, 0);
    }
  }

  public SessionReference reference(UUID id) {
    return jdbc.sql(
            "SELECT owner_id,task_id,connection_id,controller_id,close_requested FROM"
                + " browser_sessions WHERE id=:id")
        .param("id", id)
        .query(
            (row, index) ->
                new SessionReference(
                    row.getObject("owner_id", UUID.class),
                    row.getObject("task_id", UUID.class),
                    row.getObject("connection_id", UUID.class),
                    row.getString("controller_id"),
                    row.getBoolean("close_requested")))
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  private void startUsage(SessionReference reference, UUID session, String kind) {
    jdbc.sql(
            "INSERT INTO usage_intervals(id,owner_id,task_id,session_id,kind) VALUES"
                + " (:id,:owner,:task,:session,:kind) ON CONFLICT DO NOTHING")
        .param("id", UUID.randomUUID())
        .param("owner", reference.ownerId())
        .param("task", reference.taskId())
        .param("session", session)
        .param("kind", kind)
        .update();
  }

  public record SessionReference(
      UUID ownerId, UUID taskId, UUID connectionId, String controllerId, boolean closeRequested) {}

  private record ControlIntent(Contracts.ControlInput input, boolean keepPrivate) {}
}
