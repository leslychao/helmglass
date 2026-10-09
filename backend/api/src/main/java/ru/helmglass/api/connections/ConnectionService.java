package ru.helmglass.api.connections;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.browsers.BrowserPages;
import ru.helmglass.api.browsers.BrowserService;
import ru.helmglass.api.browsers.WorkerClient;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.tasks.TaskService;

@Service
public class ConnectionService {
  private static final String SELECT =
      """
      SELECT c.*,b.id browser_id,b.status browser_status,b.node_id,b.control_owner,b.control_epoch,
        b.private_mode,b.current_url,b.version browser_version,b.task_id,b.login_confirmed,
        b.started_at browser_started_at,b.closed_at browser_closed_at,b.idle_close_at,b.close_reason,
        (SELECT count(*) FROM tasks t WHERE t.owner_id=c.owner_id
          AND (t.selected_connection_id=c.id OR t.preferred_connection_ids @> jsonb_build_array(c.id))) task_count
        FROM connections c
      """;
  private static final String ACTIVE_BROWSER =
      " LEFT JOIN browser_sessions b ON b.connection_id=c.id AND b.status NOT IN ('CLOSED','LOST')";
  private final JdbcClient jdbc;
  private final BrowserService browsers;
  private final BrowserPages browserPages;
  private final TaskService tasks;
  private final EventService events;
  private final Identity identity;
  private final WorkerClient worker;
  private final JsonSupport json;
  private final TransactionTemplate transactions;

  public ConnectionService(
      JdbcClient jdbc,
      BrowserService browsers,
      BrowserPages browserPages,
      TaskService tasks,
      EventService events,
      Identity identity,
      WorkerClient worker,
      JsonSupport json,
      PlatformTransactionManager transactionManager) {
    this.jdbc = jdbc;
    this.browsers = browsers;
    this.browserPages = browserPages;
    this.tasks = tasks;
    this.events = events;
    this.identity = identity;
    this.worker = worker;
    this.json = json;
    this.transactions = new TransactionTemplate(transactionManager);
  }

  public Contracts.Connection get(UUID owner, UUID id) {
    String detail = SELECT + " LEFT JOIN LATERAL (SELECT s.* FROM browser_sessions s"
        + " WHERE s.connection_id=c.id ORDER BY s.created_at DESC,s.id DESC LIMIT 1) b ON true";
    return jdbc.sql(detail + " WHERE c.id=:id AND c.owner_id=:owner AND c.deleted_at IS NULL")
        .param("id", id)
        .param("owner", owner)
        .query(this::map)
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  public Contracts.Page<Contracts.Connection> list(UUID owner, ListQuery query) {
    List<String> clauses = new ArrayList<>(List.of("c.owner_id=:owner", "c.deleted_at IS NULL"));
    Map<String, Object> parameters = new HashMap<>();
    parameters.put("owner", owner);
    if (query.search() != null && !query.search().isBlank()) {
      clauses.add("(c.name ILIKE :search OR c.site ILIKE :search)");
      parameters.put("search", "%" + query.search() + "%");
    }
    ListQuery.addList(clauses, parameters, "c.status", "status", query.status());
    ListQuery.addList(clauses, parameters, "c.site", "site", query.site());
    String where = String.join(" AND ", clauses);
    long total =
        jdbc.sql("SELECT count(*) FROM connections c WHERE " + where)
            .params(parameters)
            .query(Long.class)
            .single();
    String order = switch (query.sort() == null ? "" : query.sort()) {
      case "name" -> "c.name";
      case "site" -> "c.site";
      case "status" -> "c.status";
      case "lastUsedAt" -> "c.last_used_at";
      default -> "c.updated_at";
    };
    var items =
        jdbc.sql(
                SELECT + ACTIVE_BROWSER
                    + " WHERE "
                    + where
                    + " ORDER BY "
                    + order
                    + (query.ascending() ? " ASC" : " DESC")
                    + " NULLS LAST,c.id LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(this::map)
            .list();
    return new Contracts.Page<>(items, total, query.page(), query.pageSize());
  }

  public Contracts.Page<String> sites(UUID owner, ListQuery query) {
    String where = "owner_id=:owner AND deleted_at IS NULL";
    Map<String, Object> parameters = new HashMap<>(Map.of("owner", owner));
    if (query.search() != null && !query.search().isBlank()) {
      where += " AND site ILIKE :search";
      parameters.put("search", "%" + query.search() + "%");
    }
    long total =
        jdbc.sql("SELECT count(DISTINCT site) FROM connections WHERE " + where)
            .params(parameters)
            .query(Long.class)
            .single();
    var items =
        jdbc.sql(
                "SELECT site FROM connections WHERE "
                    + where
                    + " GROUP BY site ORDER BY max(updated_at) DESC,site LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(String.class)
            .list();
    return new Contracts.Page<>(items, total, query.page(), query.pageSize());
  }

  @Transactional
  public Contracts.Connection create(UUID owner, Contracts.ConnectionInput input) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    String name = TaskService.required(input.name(), "name", 200);
    String url =
        input.startUrl() == null || input.startUrl().isBlank()
            ? "https://" + TaskService.required(input.site(), "site", 253) + "/"
            : input.startUrl();
    String site = TaskService.site(url);
    UUID id = UUID.randomUUID();
    jdbc.sql(
            "INSERT INTO connections(id,owner_id,name,site,start_url) VALUES"
                + " (:id,:owner,:name,:site,:url)")
        .param("id", id)
        .param("owner", owner)
        .param("name", name)
        .param("site", site)
        .param("url", url)
        .update();
    events.emit(owner, "connection", id, 1);
    return get(owner, id);
  }

  @Transactional
  public Contracts.Connection rename(UUID owner, UUID id, Contracts.RenameInput input) {
    tasks.lockOwner(owner);
    Contracts.Connection connection = get(owner, id);
    if (input.expectedVersion() == null || input.expectedVersion() != connection.version()) {
      throw ApiException.conflict("STALE_VERSION", "Подключение изменилось.");
    }
    jdbc.sql("UPDATE connections SET name=:name,version=version+1,updated_at=now() WHERE id=:id")
        .param("name", TaskService.required(input.name(), "name", 200))
        .param("id", id)
        .update();
    events.emit(owner, "connection", id, connection.version() + 1);
    return get(owner, id);
  }

  @Transactional
  public void delete(UUID owner, UUID id) {
    tasks.lockOwner(owner);
    get(owner, id);
    jdbc.sql(
            "UPDATE connections SET"
                + " deleted_at=now(),status='DELETING',version=version+1,updated_at=now() WHERE"
                + " id=:id")
        .param("id", id)
        .update();
    closeStandaloneBrowser(owner, id);
    var affected =
        jdbc.sql(
                """
SELECT DISTINCT t.id FROM tasks t LEFT JOIN browser_sessions b ON b.id=t.browser_session_id
WHERE t.owner_id=:owner AND (t.selected_connection_id=:id OR b.connection_id=:id
  OR t.preferred_connection_ids @> CAST(:ids AS jsonb))
  AND t.status NOT IN ('DRAFT','SUCCEEDED','PARTIAL','NOT_ACHIEVED','FAILED','STOPPED','STOPPING')
""")
            .param("owner", owner)
            .param("id", id)
            .param("ids", "[\"" + id + "\"]")
            .query(UUID.class)
            .list();
    for (UUID task : affected) {
      tasks.cancelQueued(task);
      if (!tasks.hasDispatched(task)) {
        tasks.request(
            owner,
            task,
            "ACCOUNT_CHOICE",
            "Подключение удалено. Выберите другой доступ или войдите заново.",
            null,
            null);
      }
    }
    events.emit(owner, "connection", id, 0);
  }

  private void closeStandaloneBrowser(UUID owner, UUID connection) {
    jdbc.sql("""
            SELECT id FROM browser_sessions
            WHERE owner_id=:owner AND connection_id=:connection AND task_id IS NULL
              AND status NOT IN ('CLOSED','LOST')
              AND (NOT close_requested OR status='QUEUED')
            """)
        .param("owner", owner)
        .param("connection", connection)
        .query(UUID.class)
        .optional()
        .ifPresent(session -> browsers.requestClose(owner, session));
  }

  private record DeletedConnection(UUID id, UUID owner) {}

  @Scheduled(fixedDelay = 10000)
  public void removeDeletedProfiles() {
    var deleted =
        jdbc.sql("""
                SELECT c.id,c.owner_id FROM connections c
                WHERE c.status='DELETING' OR (c.status='DELETED' AND EXISTS (
                  SELECT 1 FROM browser_sessions b WHERE b.connection_id=c.id
                    AND b.task_id IS NULL AND b.status NOT IN ('CLOSED','LOST')
                    AND (NOT b.close_requested OR b.status='QUEUED')))
                ORDER BY c.deleted_at,c.id LIMIT 20
                """)
            .query((row, index) -> new DeletedConnection(
                row.getObject("id", UUID.class), row.getObject("owner_id", UUID.class)))
            .list();
    for (DeletedConnection connection : deleted) {
      UUID id = connection.id();
      try {
        boolean closed = Boolean.TRUE.equals(transactions.execute(transaction -> {
          tasks.lockOwner(connection.owner());
          closeStandaloneBrowser(connection.owner(), id);
          return jdbc.sql("""
                  SELECT NOT EXISTS (SELECT 1 FROM browser_sessions
                    WHERE connection_id=:id AND task_id IS NULL AND status<>'CLOSED')
                  """).param("id", id).query(Boolean.class).single();
        }));
        if (!closed) {
          continue;
        }
        worker.call("DELETE", "/profiles/" + id, null);
        jdbc.sql(
                "UPDATE connections SET status='DELETED',account_subject=NULL,account_label=NULL"
                    + " WHERE id=:id")
            .param("id", id)
            .update();
      } catch (WorkerClient.WorkerException exception) {
        if (exception.status() == 404) {
          jdbc.sql(
                  "UPDATE connections SET status='DELETED',account_subject=NULL,account_label=NULL"
                      + " WHERE id=:id")
              .param("id", id)
              .update();
        }
      }
    }
  }

  @Transactional
  public Contracts.Connection login(UUID owner, UUID id, Contracts.LoginInput input) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    Contracts.Connection connection = get(owner, id);
    String action = input.action() == null ? "START" : input.action();
    switch (action) {
      case "START" -> {
        UUID viewer = UUID.fromString(input.viewerId());
        UUID session = browsers.ensure(owner, null, id, connection.startUrl());
        Contracts.Browser browser = browsers.get(owner, session);
        if ("LIVE".equals(browser.status())) {
          browsers.control(
              owner,
              session,
              new Contracts.ControlInput(
                  "BEGIN_LOGIN", input.viewerId(), false, false, id, null, null,
                  browser.controlEpoch()));
        } else {
          jdbc.sql(
                  "UPDATE browser_sessions SET"
                      + " control_owner='USER',controller_id=:viewer,private_mode=true,"
                      + " control_epoch=greatest(control_epoch,1)"
                      + " WHERE id=:id")
              .param("viewer", input.viewerId())
              .param("id", session)
              .update();
        }
        if (input.pageVisitId() != null) {
          browserPages.open(owner, session, input.pageVisitId(), viewer);
        }
      }
      case "SAVE" -> {
        if (connection.browser() == null) {
          throw ApiException.conflict("BROWSER_REQUIRED", "Сначала войдите в браузере.");
        }
        browsers.control(
            owner,
            connection.browser().id(),
            new Contracts.ControlInput(
                "FINISH_LOGIN",
                input.viewerId(),
                false,
                true,
                id,
                input.accountLabel(),
                input.accountSubject()));
      }
      case "CLOSE" -> {
        if (connection.browser() != null) {
          browsers.requestClose(owner, connection.browser().id());
        }
      }
      default -> throw ApiException.invalid("action", "Неизвестное действие входа.");
    }
    events.emit(owner, "connection", id, connection.version());
    return get(owner, id);
  }

  @Transactional
  public UUID connectionForLogin(UUID owner, UUID browserId) {
    identity.requireActive(owner);
    tasks.lockOwner(owner);
    browsers.get(owner, browserId);
    BrowserService.SessionReference reference = browsers.reference(browserId);
    if (reference.connectionId() != null) {
      get(owner, reference.connectionId());
      return reference.connectionId();
    }
    if (reference.taskId() == null) {
      throw ApiException.conflict("CONNECTION_REQUIRED", "Браузер не связан с подключением.");
    }
    Contracts.Task task = tasks.get(owner, reference.taskId());
    UUID selected = jdbc.sql("SELECT selected_connection_id FROM tasks WHERE id=:id")
        .param("id", task.id()).query((row, index) -> row.getObject(1, UUID.class))
        .optional().orElse(null);
    UUID connection = selected == null
        ? create(owner, new Contracts.ConnectionInput(task.site(), task.site(), task.startUrl())).id()
        : get(owner, selected).id();
    jdbc.sql("""
            UPDATE browser_sessions SET connection_id=:connection WHERE id=:browser
            AND NOT EXISTS(SELECT 1 FROM browser_sessions other WHERE other.id<>:browser
              AND (other.connection_id=:connection OR other.pending_connection_id=:connection)
              AND other.status NOT IN ('CLOSED','LOST'))
            """).param("connection", connection).param("browser", browserId).update();
    if (!connection.equals(browsers.reference(browserId).connectionId())) {
      throw ApiException.conflict("CONNECTION_BUSY", "Подключение занято другим браузером.");
    }
    jdbc.sql("UPDATE tasks SET selected_connection_id=:connection WHERE id=:id")
        .param("connection", connection).param("id", task.id()).update();
    return connection;
  }

  public Object credentials(
      UUID owner, UUID browserId, String action, String viewerId, Map<String, Object> values) {
    // Commit the canonical destination before a worker call whose reply may be lost.
    UUID connection = transactions.execute(transaction -> {
      identity.requireActive(owner);
      tasks.lockOwner(owner);
      Contracts.Browser browser = browsers.get(owner, browserId);
      BrowserService.SessionReference reference = browsers.reference(browserId);
      if (!"LIVE".equals(browser.status()) || !browser.privateMode()
          || !"USER".equals(browser.controlOwner())
          || viewerId == null || !viewerId.equals(reference.controllerId())) {
        throw Identity.denied("Сначала откройте защищённый вход в этом просмотре.");
      }
      return reference.connectionId();
    });
    Map<String, Object> payload = new HashMap<>(values);
    payload.put("action", action);
    payload.put("ownerId", owner);
    payload.put("viewerId", viewerId);
    if (connection != null) {
      get(owner, connection);
      payload.put("connectionId", connection);
    }
    try {
      return worker.call("POST", "/sessions/" + browserId + "/credentials", payload);
    } catch (WorkerClient.WorkerException exception) {
      if (exception.status() == 400 || exception.status() == 413) {
        throw ApiException.invalid("credentials", "Проверьте поля сохранённого входа.");
      }
      if (exception.status() == 403) {
        throw Identity.denied("Подстановка разрешена только в защищённом входе нужного сайта.");
      }
      if (exception.status() == 409) {
        throw ApiException.conflict("CREDENTIAL_STATE_CHANGED", "Состояние сохранённого входа изменилось.");
      }
      throw exception;
    }
  }

  @Transactional
  public Contracts.Browser finishTaskLogin(
      UUID owner, UUID browserId, Contracts.ControlInput input) {
    tasks.lockOwner(owner);
    UUID connection = connectionForLogin(owner, browserId);
    Contracts.Connection current = get(owner, connection);
    String label = input.accountLabel() == null ? current.accountLabel() : input.accountLabel();
    String subject = input.accountSubject() == null ? current.accountSubject() : input.accountSubject();
    return browsers.control(owner, browserId, new Contracts.ControlInput(
        "FINISH_LOGIN", input.viewerId(), true, true, connection, label, subject));
  }

  @Transactional
  public Contracts.Browser sessionLogin(UUID owner, UUID browserId, Contracts.ControlInput input) {
    if ("CONFIRM_LOGIN".equals(input.type())) {
      return browsers.control(owner, browserId, input);
    }
    boolean finish = "FINISH_LOGIN".equals(input.type());
    if (!"SAVE_SESSION".equals(input.type()) && !finish) {
      throw ApiException.invalid("type", "Неизвестное действие сессии.");
    }
    if (finish && input.controlEpoch() == null) {
      throw ApiException.conflict("CONTROL_CHANGED", "Управление изменилось. Обновите просмотр.");
    }
    tasks.lockOwner(owner);
    UUID connection = connectionForLogin(owner, browserId);
    Contracts.Connection current = get(owner, connection);
    String label = input.accountLabel() == null ? current.accountLabel() : input.accountLabel();
    String subject = input.accountSubject() == null ? current.accountSubject() : input.accountSubject();
    return browsers.control(owner, browserId, new Contracts.ControlInput(
        input.type(), input.viewerId(), finish, true, connection, label, subject,
        input.controlEpoch()));
  }

  private Contracts.Connection map(ResultSet row, int index) throws SQLException {
    UUID browserId = row.getObject("browser_id", UUID.class);
    Contracts.Browser browser =
        browserId == null
            ? null
            : new Contracts.Browser(
                browserId,
                row.getString("browser_status"),
                row.getObject("node_id", UUID.class),
                row.getString("control_owner"),
                row.getLong("control_epoch"),
                row.getBoolean("private_mode"),
                row.getBoolean("private_mode") ? null : row.getString("current_url"),
                "LIVE".equals(row.getString("browser_status")),
                "LIVE".equals(row.getString("browser_status")),
                row.getLong("browser_version"), row.getString("profile_save_error"),
                row.getObject("task_id", UUID.class), row.getObject("id", UUID.class),
                row.getBoolean("login_confirmed"), Database.instant(row, "browser_started_at"),
                Database.instant(row, "browser_closed_at"), Database.instant(row, "idle_close_at"),
                row.getString("close_reason"));
    return new Contracts.Connection(
        row.getObject("id", UUID.class),
        row.getLong("version"),
        row.getString("name"),
        row.getString("site"),
        row.getString("start_url"),
        row.getString("status"),
        row.getString("account_subject"),
        row.getString("account_label"),
        Database.instant(row, "last_used_at"),
        browser,
        Database.instant(row, "created_at"),
        Database.instant(row, "updated_at"),
        row.getLong("profile_revision"),
        Database.instant(row, "profile_saved_at"),
        row.getString("profile_save_error"),
        savedOrigins(row.getString("authorized_origins")),
        row.getObject("cookie_usable_count", Integer.class) == null ? null
            : new Contracts.CookieCheck(row.getInt("cookie_usable_count"),
                Database.instant(row, "cookie_checked_at")),
        row.getLong("task_count"));
  }

  private List<String> savedOrigins(String value) {
    List<String> origins = new ArrayList<>();
    for (var origin : json.read(value)) {
      origins.add(origin.asString());
    }
    return List.copyOf(origins);
  }
}
