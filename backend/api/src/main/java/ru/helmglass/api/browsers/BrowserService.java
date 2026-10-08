package ru.helmglass.api.browsers;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.tasks.TaskService;
import tools.jackson.databind.JsonNode;

@Service
public class BrowserService {
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
    return jdbc.sql("SELECT * FROM browser_sessions WHERE id=:id AND owner_id=:owner")
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
                    row.getLong("version")))
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
      tasks.change(owner, taskId, "QUEUED", "BROWSER_CAPACITY", "Ожидание свободного браузера");
    }
    return id;
  }

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
    UUID.fromString(input.viewerId());
    SessionReference reference = reference(id);
    if (!"LIVE".equals(browser.status())) {
      throw ApiException.conflict("BROWSER_UNAVAILABLE", "Браузер недоступен.");
    }
    if ("TRANSFERRING".equals(browser.controlOwner())) {
      throw ApiException.conflict("CONTROL_PENDING", "Передача управления ещё не подтверждена.");
    }
    if (reference.taskId() != null
        && (tasks.hasDispatched(reference.taskId()) || tasks.hasUnknown(reference.taskId()))) {
      throw ApiException.conflict(
          "ACTION_UNRESOLVED", "Сначала дождитесь или проверьте результат текущего действия.");
    }
    boolean take = Set.of("TAKE", "BEGIN_LOGIN").contains(input.type());
    boolean returning = Set.of("RETURN", "FINISH_LOGIN").contains(input.type());
    if (!take && !returning) {
      throw ApiException.invalid("type", "Неизвестная команда управления.");
    }
    if (returning && !input.viewerId().equals(reference.controllerId())) {
      throw Identity.denied("Управление находится в другом просмотре.");
    }
    if (Boolean.TRUE.equals(input.saveConnection())) {
      if (!"FINISH_LOGIN".equals(input.type()) || input.connectionId() == null) {
        throw ApiException.invalid("connectionId", "Выберите подключение для сохранения входа.");
      }
      tasks.validateConnections(owner, List.of(input.connectionId()));
      requireAvailableConnection(input.connectionId(), id);
      TaskService.required(input.accountLabel(), "accountLabel", 300);
      TaskService.required(input.accountSubject(), "accountSubject", 500);
      String previous =
          jdbc.sql("SELECT account_subject FROM connections WHERE id=:id")
              .param("id", input.connectionId())
              .query((row, index) -> row.getString("account_subject"))
              .optional()
              .orElse(null);
      if (previous != null && !previous.equals(input.accountSubject().trim())) {
        throw ApiException.conflict(
            "ACCOUNT_MISMATCH", "Создайте отдельное подключение для другого аккаунта.");
      }
    }
    if (reference.taskId() != null) {
      tasks.cancelQueued(reference.taskId());
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
    jdbc.sql(
            """
UPDATE browser_sessions SET control_owner='TRANSFERRING',control_epoch=:epoch,
  private_mode=true,pending_control=CAST(:intent AS jsonb),version=version+1,
  pending_connection_id=CASE WHEN :saving THEN :connection ELSE pending_connection_id END WHERE id=:id
""")
        .param("epoch", epoch)
        .param("intent", json.write(input))
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
                    + " status='LIVE' ORDER BY created_at LIMIT 20")
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
                              + " pending_control IS NOT NULL FOR UPDATE")
                      .param("id", intent.id())
                      .query(String.class)
                      .optional();
              if (input.isPresent()) {
                applyControl(
                    intent.owner(),
                    intent.id(),
                    json.convert(json.read(input.get()), Contracts.ControlInput.class));
              }
            });
      } catch (WorkerClient.WorkerException exception) {
        // The committed intent and fail-closed policy remain until the worker acknowledges it.
      }
    }
  }

  private void applyControl(UUID owner, UUID id, Contracts.ControlInput input) {
    Contracts.Browser browser = get(owner, id);
    SessionReference reference = reference(id);
    boolean take = Set.of("TAKE", "BEGIN_LOGIN").contains(input.type());
    long epoch = browser.controlEpoch();
    boolean privateMode = "BEGIN_LOGIN".equals(input.type());
    String control = take ? "USER" : reference.taskId() == null ? "NONE" : "CHATGPT";
    Map<String, Object> payload = new HashMap<>();
    payload.put("controlEpoch", epoch);
    payload.put("owner", control);
    payload.put("privateMode", privateMode);
    if (take) {
      payload.put("controllerId", input.viewerId());
    }
    if ("FINISH_LOGIN".equals(input.type()) && Boolean.TRUE.equals(input.saveConnection())) {
      saveProfile(owner, id, input.connectionId(), input.accountLabel(), input.accountSubject());
    }
    worker.call("POST", "/sessions/" + id + "/control", payload);
    jdbc.sql(
            """
            UPDATE browser_sessions SET control_owner=:control,private_mode=:private,
              controller_id=:controller,pending_control=NULL,version=version+1 WHERE id=:id
            """)
        .param("control", control)
        .param("private", privateMode)
        .param("controller", take ? input.viewerId() : null)
        .param("id", id)
        .update();
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
        if (task.request() != null
            && Set.of("LOGIN", "MANUAL_CONTROL").contains(task.request().type())) {
          tasks.cancelRequest(task.id());
        }
        String state =
            paused || !resume
                ? "PAUSED"
                : task.request() != null
                        && !Set.of("LOGIN", "MANUAL_CONTROL").contains(task.request().type())
                    ? "WAITING_USER"
                    : "WAITING_CHATGPT";
        tasks.change(
            owner,
            task.id(),
            state,
            "WAITING_USER".equals(state) ? task.waitReason() : null,
            "Управление возвращено");
        tasks.requestContinuation(task.id());
      }
    }
    events.emit(owner, "browser", id, browser.version() + 2);
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

  public void saveProfile(UUID owner, UUID session, UUID connection, String label, String subject) {
    if (connection == null) {
      throw ApiException.invalid("connectionId", "Выберите подключение для сохранения входа.");
    }
    tasks.validateConnections(owner, List.of(connection));
    requireAvailableConnection(connection, session);
    String identityLabel = TaskService.required(label, "accountLabel", 300);
    String identitySubject = TaskService.required(subject, "accountSubject", 500);
    var previous =
        jdbc.sql("SELECT account_subject FROM connections WHERE id=:id")
            .param("id", connection)
            .query((row, index) -> row.getString("account_subject"))
            .optional()
            .orElse(null);
    if (previous != null && !previous.equals(identitySubject)) {
      throw ApiException.conflict(
          "ACCOUNT_MISMATCH", "Вход принадлежит другому аккаунту. Создайте отдельное подключение.");
    }
    String origin =
        jdbc.sql("SELECT start_url FROM connections WHERE id=:id")
            .param("id", connection)
            .query(String.class)
            .single();
    java.net.URI uri = java.net.URI.create(origin);
    String authorizedOrigin = uri.getScheme() + "://" + uri.getAuthority();
    worker.call(
        "POST",
        "/sessions/" + session + "/profile/export",
        Map.of("connectionId", connection, "ownerId", owner, "origins", List.of(authorizedOrigin)));
    jdbc.sql(
            "UPDATE connections SET"
                + " status='READY',account_label=:label,account_subject=:subject,version=version+1,updated_at=now(),last_used_at=now()"
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
    get(owner, id);
    jdbc.sql("UPDATE browser_sessions SET close_requested=true WHERE id=:id")
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
        if (Set.of("QUEUED", "STARTING").contains(task.status())) {
          tasks.change(reference.ownerId(), task.id(), "WAITING_CHATGPT", null, "Браузер готов");
        }
      }
    }
    if (Set.of("CLOSED", "LOST").contains(status)) {
      jdbc.sql(
              "UPDATE browser_sessions SET"
                  + " closed_at=coalesce(closed_at,now()),control_owner='NONE',private_mode=false,controller_id=NULL"
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
        if ("STOPPING".equals(task.status())
            && "CLOSED".equals(status)
            && !jdbc.sql(
                    "SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE task_id=:task AND"
                        + " status<>'CLOSED')")
                .param("task", task.id())
                .query(Boolean.class)
                .single()) {
          tasks.change(
              reference.ownerId(),
              task.id(),
              "STOPPED",
              null,
              "Браузер закрыт, задача остановлена");
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
}
