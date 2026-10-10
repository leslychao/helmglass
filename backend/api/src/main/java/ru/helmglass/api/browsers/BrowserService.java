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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
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
  private static final int WAIT_IDLE_SECONDS = 300;
  private static final int MANUAL_IDLE_SECONDS = 900;
  private static final String IDLE_PROTECTED = """
      ((b.pending_control IS NOT NULL AND b.control_deadline_at>clock_timestamp())
       OR EXISTS(SELECT 1 FROM operations o WHERE o.session_id=b.id AND o.status='DISPATCHED'
         AND o.deadline_at+interval '10 seconds'>clock_timestamp()))
      """;
  private final JdbcClient jdbc;
  private final TaskService tasks;
  private final EventService events;
  private final Identity identity;
  private final WorkerClient worker;
  private final JsonSupport json;
  private final ViewerAccess viewers;
  private final TransactionTemplate transactions;
  private final ExecutorService controlDelivery = Executors.newVirtualThreadPerTaskExecutor();
  private final Semaphore controlSlots = new Semaphore(4);

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
                    Database.instant(row, "idle_close_at"), row.getInt("idle_timeout_seconds"),
                    Database.instant(row, "idle_warning_at"), row.getString("cleanup_state"),
                    row.getString("cleanup_error"), row.getString("close_reason")))
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
          Contracts.Browser previous = get(owner, session);
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
          queueInternalControl(owner, session, "ADOPT", previous, connectionId,
              "LOGIN".equals(tasks.get(owner, taskId).waitReason()));
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

      jdbc.sql("""
              UPDATE browser_sessions SET private_mode=true,
                control_owner=CASE WHEN pending_control IS NULL THEN 'NONE' ELSE 'TRANSFERRING' END,
                pending_control=CASE WHEN pending_control IS NULL THEN NULL
                  ELSE jsonb_set(pending_control,'{keepPrivate}','true') END,
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
    if (!"LIVE".equals(browser.status())
        || reference(id).closeRequested()) {
      throw ApiException.conflict("BROWSER_UNAVAILABLE", "Браузер уже закрывается или недоступен.");
    }
    refreshIdle(owner, id, true);
    return get(owner, id);
  }

  @Transactional
  public void refreshIdle(UUID owner, UUID id, boolean activity) {
    tasks.lockOwner(owner);
    var state = jdbc.sql("SELECT b.idle_close_at,b.control_owner," + IDLE_PROTECTED + " AS protected"
            + " FROM browser_sessions b WHERE b.id=:id AND b.owner_id=:owner"
            + " AND b.status='LIVE' AND NOT b.close_requested")
        .param("id", id).param("owner", owner)
        .query((row, index) -> new IdleState(Database.instant(row, "idle_close_at"),
            row.getBoolean("protected"), "USER".equals(row.getString("control_owner")))).optional();
    if (state.isEmpty()) {
      return;
    }
    IdleState current = state.get();
    if (current.protectedNow()) {
      if (current.deadline() == null) {
        return;
      }
      setIdleDeadline(owner, id, null, current.manual());
    } else if (activity || current.deadline() == null) {
      setIdleDeadline(owner, id, Instant.now().plusSeconds(
          current.manual() ? MANUAL_IDLE_SECONDS : WAIT_IDLE_SECONDS), current.manual());
    } else if (!current.deadline().isAfter(Instant.now())) {
      UUID task = reference(id).taskId();
      if (task != null) {
        tasks.closeBrowser(owner, task, "IDLE_TIMEOUT");
      } else {
        requestClose(owner, id);
        jdbc.sql("UPDATE browser_sessions SET close_reason='IDLE_TIMEOUT' WHERE id=:id")
            .param("id", id).update();
      }
    }
  }

  private void setIdleDeadline(UUID owner, UUID id, Instant deadline, boolean manual) {
    jdbc.sql("UPDATE browser_sessions SET idle_close_at=:deadline,idle_warning_at=:warning,"
            + "idle_timeout_seconds=:seconds,version=version+1 WHERE id=:id")
        .param("deadline", deadline == null ? null : java.sql.Timestamp.from(deadline))
        .param("warning", deadline == null ? null : java.sql.Timestamp.from(
            deadline.minusSeconds(manual ? 300 : 60)))
        .param("seconds", manual ? MANUAL_IDLE_SECONDS : WAIT_IDLE_SECONDS)
        .param("id", id).update();
    events.emit(owner, "browser", id, 0);
  }

  @Scheduled(fixedDelay = 2000)
  public void expireIdleBrowsers() {
    var candidates = jdbc.sql("""
            SELECT b.id,b.owner_id FROM browser_sessions b
            WHERE b.status='LIVE' AND NOT b.close_requested
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

  private record IdleState(Instant deadline, boolean protectedNow, boolean manual) {}

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
  control_deadline_at=clock_timestamp()+(:seconds*interval '1 second'),
  control_next_check_at=clock_timestamp(),
  login_completed=CASE WHEN :newLogin THEN false ELSE login_completed END,
  pending_connection_id=CASE WHEN :saving THEN :connection ELSE pending_connection_id END WHERE id=:id
""")
        .param("epoch", epoch)
        .param("intent", json.write(new ControlIntent(input, keepPrivate, browser.controlOwner(), browser.privateMode(), reference.controllerId(), browser.connectionId())))
        .param("seconds", Boolean.TRUE.equals(input.saveConnection()) ? 360 : 30)
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
    var pending = jdbc.sql("""
            SELECT id,owner_id FROM browser_sessions WHERE pending_control IS NOT NULL
              AND status='LIVE' AND NOT close_requested
              AND control_next_check_at<=clock_timestamp()
            ORDER BY control_next_check_at,id LIMIT 20
            """).query((row, index) -> new PendingControl(row.getObject("id", UUID.class),
                row.getObject("owner_id", UUID.class))).list();
    for (PendingControl candidate : pending) {
      if (!controlSlots.tryAcquire()) break;
      ControlWork work = transactions.execute(transaction -> {
        tasks.lockOwner(candidate.owner());
        return jdbc.sql("""
                UPDATE browser_sessions SET control_next_check_at=clock_timestamp()+interval '6 minutes'
                WHERE id=:id AND pending_control IS NOT NULL AND NOT close_requested
                  AND control_next_check_at<=clock_timestamp()
                RETURNING pending_control::text,control_epoch,control_deadline_at
                """).param("id", candidate.id()).query((row, index) -> new ControlWork(
                    json.convert(json.read(row.getString("pending_control")), ControlIntent.class),
                    row.getLong("control_epoch"), Database.instant(row, "control_deadline_at")))
            .optional().orElse(null);
      });
      if (work == null) { controlSlots.release(); continue; }
      controlDelivery.execute(() -> {
      try {
        applyControl(candidate.owner(), candidate.id(), work);
      } catch (RuntimeException exception) {
        if (exception instanceof WorkerClient.WorkerException rejected
            && Set.of(400, 403, 413, 422).contains(rejected.status())
            && restoreRejectedControl(candidate.owner(), candidate.id(), work)) {
          return;
        }
        // A lost acknowledgement cannot restore authority safely. Closing wins over a late reply.
        transactions.executeWithoutResult(transaction -> {
          tasks.lockOwner(candidate.owner());
          if (get(candidate.owner(), candidate.id()).controlEpoch() != work.epoch()) return;
          if (Boolean.TRUE.equals(work.intent().input().saveConnection())) {
            recordProfileFailure(candidate.owner(), work.intent().input().connectionId(),
                new WorkerClient.WorkerException("PROFILE_SAVE_FAILED", 0));
          }
          closeForFailure(candidate.owner(), candidate.id(), "CONTROL_UNCONFIRMED");
        });
      } finally { controlSlots.release(); }
      });
    }
  }

  @jakarta.annotation.PreDestroy
  void stopControlDelivery() { controlDelivery.shutdownNow(); }

  @Scheduled(fixedDelay = 2000)
  public void expireControlIntents() {
    var expired = jdbc.sql("""
            SELECT id,owner_id FROM browser_sessions WHERE pending_control IS NOT NULL
              AND NOT close_requested AND control_deadline_at<=clock_timestamp()
            ORDER BY control_deadline_at,id LIMIT 20
            """).query((row, index) -> new PendingControl(row.getObject("id", UUID.class),
                row.getObject("owner_id", UUID.class))).list();
    for (PendingControl candidate : expired) {
      transactions.executeWithoutResult(transaction -> {
        tasks.lockOwner(candidate.owner());
        closeForFailure(candidate.owner(), candidate.id(), "CONTROL_DEADLINE_EXCEEDED");
      });
    }
  }

  public void closeForFailure(UUID owner, UUID session, String reason) {
    SessionReference reference = reference(session);
    if (reference.closeRequested()) return;
    if (reference.taskId() != null && !"STOPPING".equals(tasks.get(owner, reference.taskId()).status())) {
      tasks.closeBrowser(owner, reference.taskId());
      tasks.history(owner, reference.taskId(), "BROWSER_FAILURE", "Браузер закрывается", reason);
    } else {
      jdbc.sql("UPDATE browser_sessions SET close_requested=true,pending_control=NULL,"
              + "version=version+1 WHERE id=:id").param("id", session).update();
    }
    events.emit(owner, "browser", session, 0);
  }

  private record ControlWork(ControlIntent intent, long epoch, Instant deadline) {}

  private boolean restoreRejectedControl(UUID owner, UUID id, ControlWork work) {
    ControlIntent intent = work.intent();
    if (intent.previousOwner() == null || intent.previousPrivate() == null
        || reference(id).closeRequested() || !work.deadline().isAfter(Instant.now())) return false;
    long epoch = work.epoch() + 1;
    Map<String, Object> policy = new HashMap<>();
    policy.put("controlEpoch", epoch);
    policy.put("owner", intent.previousOwner());
    policy.put("privateMode", intent.previousPrivate());
    policy.put("deadlineAt", work.deadline().toString());
    if (intent.previousController() != null) policy.put("controllerId", intent.previousController());
    try {
      worker.call("POST", "/sessions/" + id + "/control", policy, remaining(work.deadline()));
    } catch (WorkerClient.WorkerException exception) {
      return false;
    }
    transactions.executeWithoutResult(transaction -> {
      tasks.lockOwner(owner);
      jdbc.sql("""
              UPDATE browser_sessions SET control_owner=:control,private_mode=:private,
                controller_id=:controller,control_epoch=:epoch,pending_control=NULL,
                control_deadline_at=NULL,pending_connection_id=NULL,version=version+1
              WHERE id=:id AND control_epoch=:previous AND NOT close_requested
              """).param("id", id).param("previous", work.epoch()).param("epoch", epoch)
          .param("control", intent.previousOwner()).param("private", intent.previousPrivate())
          .param("controller", intent.previousController()).update();
      if (Boolean.TRUE.equals(intent.input().saveConnection())) {
        recordProfileFailure(owner, intent.input().connectionId(),
            new WorkerClient.WorkerException("PROFILE_SAVE_FAILED", 422));
      }
      refreshIdle(owner, id, true);
      events.emit(owner, "browser", id, 0);
    });
    return true;
  }

  private void applyControl(UUID owner, UUID id, ControlWork work) {
    ControlIntent intent = work.intent();
    Contracts.ControlInput input = intent.input();
    Contracts.Browser browser = get(owner, id);
    SessionReference reference = reference(id);
    boolean take = Set.of("TAKE", "BEGIN_LOGIN").contains(input.type());
    boolean sessionSave = "SAVE_SESSION".equals(input.type());
    long epoch = work.epoch();
    boolean incompleteLogin = intent.keepPrivate();
    boolean privateMode = "BEGIN_LOGIN".equals(input.type()) || sessionSave || incompleteLogin;
    boolean internal = Set.of("ADOPT", "LOGIN").contains(input.type());
    String control = take || sessionSave ? "USER"
        : internal && intent.keepPrivate() || reference.taskId() == null ? "NONE" : "CHATGPT";
    if ("ADOPT".equals(input.type())) {
      worker.call("POST", "/sessions/" + id + "/bind",
          Map.of("ownerId", owner, "taskId", reference.taskId()), remaining(work.deadline()));
    }
    if ("LOGIN".equals(input.type()) && intent.previousConnection() != null
        && !intent.previousConnection().equals(input.connectionId()) && Boolean.FALSE.equals(intent.previousPrivate())) {
      if (!exportProfile(owner, id, intent.previousConnection(), id + ":switch:" + epoch, remaining(work.deadline()))) {
        throw new WorkerClient.WorkerException("PROFILE_SAVE_FAILED", 0);
      }
    }
    Map<String, Object> payload = new HashMap<>();
    payload.put("controlEpoch", epoch);
    payload.put("deadlineAt", work.deadline().toString());
    payload.put("owner", control);
    payload.put("privateMode", privateMode);
    if (take || sessionSave) {
      payload.put("controllerId", input.viewerId());
    }
    if (("FINISH_LOGIN".equals(input.type()) || sessionSave)
        && Boolean.TRUE.equals(input.saveConnection())) {
      saveProfile(owner, id, input.connectionId(), input.accountLabel(), input.accountSubject(), epoch, work.deadline());
    }
    worker.call("POST", "/sessions/" + id + "/control", payload, remaining(work.deadline()));
    if ("LOGIN".equals(input.type()) && input.connectionId() != null
        && !input.connectionId().equals(intent.previousConnection())) {
      String startUrl = jdbc.sql("SELECT start_url FROM connections WHERE id=:id")
          .param("id", input.connectionId()).query(String.class).single();
      worker.call("POST", "/sessions/" + id + "/login-context",
          Map.of("ownerId", owner, "connectionId", input.connectionId(), "startUrl", startUrl), remaining(work.deadline()));
    }
    transactions.executeWithoutResult(transaction -> {
    tasks.lockOwner(owner);
    if (reference(id).closeRequested() || get(owner, id).controlEpoch() != epoch) return;
    jdbc.sql(
            """
            UPDATE browser_sessions SET control_owner=:control,private_mode=:private,
              controller_id=:controller,pending_control=NULL,control_deadline_at=NULL,
              login_confirmed=CASE WHEN :saved THEN false ELSE login_confirmed END,
              version=version+1 WHERE id=:id
            """)
        .param("control", control)
        .param("private", privateMode)
        .param("controller", take || sessionSave ? input.viewerId() : null)
        .param("saved", Boolean.TRUE.equals(input.saveConnection()))
        .param("id", id)
        .update();
    if (internal) {
      jdbc.sql("UPDATE browser_sessions SET connection_id=coalesce(pending_connection_id,connection_id),"
              + "pending_connection_id=NULL WHERE id=:id").param("id", id).update();
      if ("ADOPT".equals(input.type())) tasks.browserReady(owner, reference.taskId());
      refreshIdle(owner, id, true);
      events.emit(owner, "browser", id, 0);
      return;
    }
    if (sessionSave) {
      refreshIdle(owner, id, true);
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
    Contracts.Task task =
        reference.taskId() == null ? null : tasks.get(owner, reference.taskId());
    // Browser control does not reopen a result; only an explicit task RESUME may do that.
    if (task != null && !TaskService.TERMINAL.contains(task.status())
        && !"STOPPING".equals(task.status())) {
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
    });
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
      UUID owner, UUID session, UUID connection, String label, String subject, long controlEpoch,
      Instant deadline) {
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
            "operationId", session + ":" + controlEpoch, "deadlineAt", deadline.toString()), remaining(deadline));
    transactions.executeWithoutResult(transaction -> {
    tasks.lockOwner(owner);
    if (reference(session).closeRequested() || get(owner, session).controlEpoch() != controlEpoch) return;
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
    });
  }

  private static Duration remaining(Instant deadline) {
    Duration duration = Duration.between(Instant.now(), deadline);
    if (duration.isNegative() || duration.isZero()) {
      throw new WorkerClient.WorkerException("OPERATION_DEADLINE_EXCEEDED", 408);
    }
    return duration;
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

  public void reconcile(UUID id, JsonNode result) {
    SessionReference initial = reference(id);
    Contracts.Browser before = get(initial.ownerId(), id);
    if ("CLOSED".equals(before.status())) return;
    if ("LIVE".equals(result.path("status").asString()) && !"LIVE".equals(before.status())
        && !initial.closeRequested() && !"TRANSFERRING".equals(before.controlOwner())) {
      Map<String, Object> desired = new HashMap<>();
      desired.put("owner", before.controlOwner());
      desired.put("privateMode", before.privateMode());
      desired.put("controlEpoch", before.controlEpoch());
      desired.put("deadlineAt", Instant.now().plusSeconds(30).toString());
      if (initial.controllerId() != null) desired.put("controllerId", initial.controllerId());
      worker.call("POST", "/sessions/" + id + "/control", desired, Duration.ofSeconds(30));
    }
    transactions.executeWithoutResult(transaction -> reconcileState(id, result));
  }

  private void reconcileState(UUID id, JsonNode result) {
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
    if (Set.of("CLOSED", "LOST").contains(status) && !result.path("runtimeStoppedAt").isString()) {
      status = "UNREACHABLE";
    }
    if ("LOST".equals(status) && result.path("runtimeStoppedAt").isString()) status = "CLOSED";
    if (reference.closeRequested() && Set.of("LIVE", "STARTING").contains(status)) {
      status = "CLOSING";
    }
    Contracts.Browser previousBrowser = get(reference.ownerId(), id);
    String previous = previousBrowser.status();
    if ("CLOSED".equals(previous)) return;
    String reportedUrl = result.path("currentUrl").asString(null);
    boolean urlChanged =
        !previousBrowser.privateMode()
            && reportedUrl != null
            && !reportedUrl.equals(previousBrowser.currentUrl());
    jdbc.sql(
            "UPDATE browser_sessions SET"
                + " status=:status,last_seen_at=now(),current_url=coalesce(:url,current_url),"
                + "cleanup_state=CASE WHEN :status='CLOSED' AND cleanup_state='NONE' THEN :cleanup ELSE cleanup_state END,"
                + "version=version+CASE WHEN status IS DISTINCT FROM :status OR current_url IS DISTINCT FROM coalesce(:url,current_url) THEN 1 ELSE 0 END"
                + " WHERE id=:id")
        .param("status", status)
        .param("cleanup", result.path("cleanupState").asString("NONE"))
        .param("url", result.path("currentUrl").asString(null))
        .param("id", id)
        .update();
    if ("LIVE".equals(status) && !"LIVE".equals(previous)) {
      Contracts.Browser policy = get(reference.ownerId(), id);
      if ("TRANSFERRING".equals(policy.controlOwner())) {
        return;
      }
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
    boolean switching = connection != null && !connection.equals(previous.connectionId());
    if (switching) requireAvailableConnection(connection, session);
    if (switching || !browser.privateMode() || !"USER".equals(browser.controlOwner())) {
      if ("LIVE".equals(browser.status())) {
        queueInternalControl(owner, session, "LOGIN", browser, connection, true);
      } else {
        jdbc.sql("UPDATE browser_sessions SET private_mode=true,control_owner='NONE',"
                + "controller_id=NULL,login_completed=false,version=version+1 WHERE id=:id")
            .param("id", session).update();
      }
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

  /** Attempt one final save; a storage failure must not prevent the requested closure. */
  public boolean prepareClose(UUID session) {
    UUID owner = reference(session).ownerId();
    SessionReference reference = reference(session);
    if (!reference.closeRequested()) {
      return false;
    }
    int claimed = jdbc.sql("""
            UPDATE browser_sessions b SET close_profile_attempted=true
            WHERE b.id=:id AND NOT b.close_profile_attempted AND NOT b.private_mode
              AND EXISTS(SELECT 1 FROM connections c WHERE c.id=b.connection_id
                AND c.status='READY' AND c.deleted_at IS NULL)
            """).param("id", session).update();
    if (claimed == 0) {
      return true;
    }
    Contracts.Browser browser = get(owner, session);
    try {
      if (!"NONE".equals(browser.controlOwner())) {
        long epoch = browser.controlEpoch() + 1;
        worker.call("POST", "/sessions/" + session + "/control",
            Map.of("controlEpoch", epoch, "owner", "NONE", "privateMode", false),
            Duration.ofSeconds(5));
        jdbc.sql("""
                UPDATE browser_sessions SET control_epoch=:epoch,control_owner='NONE',
                  controller_id=NULL,version=version+1 WHERE id=:id
                """).param("epoch", epoch).param("id", session).update();
        jdbc.sql("""
                UPDATE usage_intervals SET ended_at=now()
                WHERE session_id=:id AND kind='MANUAL' AND ended_at IS NULL
                """).param("id", session).update();
      }
      refreshProfile(owner, session, session + ":close", Duration.ofSeconds(20));
    } catch (WorkerClient.WorkerException exception) {
      recordProfileFailure(owner, reference.connectionId(), exception);
    }
    events.emit(owner, "browser", session, 0);
    return true;
  }

  public boolean refreshProfile(UUID owner, UUID session, String operationId) {
    return refreshProfile(owner, session, operationId, Duration.ofSeconds(310));
  }

  private boolean refreshProfile(UUID owner, UUID session, String operationId, Duration timeout) {
    var connection = jdbc.sql("""
            SELECT c.id FROM connections c JOIN browser_sessions b ON b.connection_id=c.id
            WHERE b.id=:session AND b.owner_id=:owner AND b.status IN ('LIVE','CLOSING')
              AND NOT b.private_mode AND c.status='READY' AND c.deleted_at IS NULL
            """).param("session", session).param("owner", owner).query(UUID.class).optional();
    if (connection.isEmpty()) {
      return true;
    }
    return exportProfile(owner, session, connection.get(), operationId, timeout);
  }

  private boolean exportProfile(UUID owner, UUID session, UUID connection, String operationId, Duration timeout) {
    try {
      JsonNode result = worker.call("POST", "/sessions/" + session + "/profile/export",
          Map.of("connectionId", connection, "ownerId", owner,
              "origins", connectionOrigins(owner, connection), "operationId", operationId,
              "deadlineAt", Instant.now().plus(timeout).toString()), timeout);
      if (!result.path("saved").asBoolean(false)
          || !connection.toString().equals(result.path("profileRef").asString())
          || result.path("revision").asLong(0) < 1 || !result.path("savedAt").isString()) {
        throw new WorkerClient.WorkerException("PROFILE_SAVE_FAILED", 502);
      }
      recordProfileSave(owner, connection, result);
      return true;
    } catch (WorkerClient.WorkerException exception) {
      recordProfileFailure(owner, connection, exception);
      return false;
    }
  }

  private void recordProfileFailure(UUID owner, UUID connection, WorkerClient.WorkerException error) {
    String failure = error.code().startsWith("PROFILE_") ? error.code() : "PROFILE_SAVE_FAILED";
    int changed = jdbc.sql("""
            UPDATE connections SET profile_save_error=:failure,version=version+1
            WHERE id=:id AND profile_save_error IS DISTINCT FROM :failure
            """).param("failure", failure).param("id", connection).update();
    if (changed != 0) {
      events.emit(owner, "connection", connection, 0);
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
              AND (CAST(:error AS text) IS NOT NULL OR profile_save_error IS NULL
                OR profile_revision<:revision OR cookie_checked_at IS NULL
                OR CAST(:checked AS timestamptz)>cookie_checked_at)
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

  private record ControlIntent(Contracts.ControlInput input, boolean keepPrivate,
      String previousOwner, Boolean previousPrivate, String previousController, UUID previousConnection) {}

  private void queueInternalControl(UUID owner, UUID session, String type, Contracts.Browser previous,
      UUID connection, boolean privateMode) {
    Contracts.ControlInput input = new Contracts.ControlInput(type, null, true, false, connection, null, null);
    ControlIntent intent = new ControlIntent(input, privateMode, previous.controlOwner(),
        previous.privateMode(), reference(session).controllerId(), previous.connectionId());
    jdbc.sql("""
            UPDATE browser_sessions SET control_owner='TRANSFERRING',private_mode=true,
              control_epoch=control_epoch+1,pending_control=CAST(:intent AS jsonb),
              pending_connection_id=:connection,control_deadline_at=clock_timestamp()+interval '6 minutes',
              control_next_check_at=clock_timestamp(),version=version+1 WHERE id=:id
            """).param("id", session).param("intent", json.write(intent))
        .param("connection", connection).update();
    events.emit(owner, "browser", session, 0);
  }
}
