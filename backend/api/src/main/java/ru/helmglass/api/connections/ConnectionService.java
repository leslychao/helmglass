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
import org.springframework.transaction.annotation.Transactional;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.browsers.BrowserService;
import ru.helmglass.api.browsers.WorkerClient;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.tasks.TaskService;

@Service
public class ConnectionService {
  private static final String SELECT =
      """
      SELECT c.*,b.id browser_id,b.status browser_status,b.node_id,b.control_owner,b.control_epoch,
        b.private_mode,b.current_url,b.version browser_version FROM connections c
      LEFT JOIN browser_sessions b ON b.connection_id=c.id AND b.status NOT IN ('CLOSED','LOST')
      """;
  private final JdbcClient jdbc;
  private final BrowserService browsers;
  private final TaskService tasks;
  private final EventService events;
  private final Identity identity;
  private final WorkerClient worker;

  public ConnectionService(
      JdbcClient jdbc,
      BrowserService browsers,
      TaskService tasks,
      EventService events,
      Identity identity,
      WorkerClient worker) {
    this.jdbc = jdbc;
    this.browsers = browsers;
    this.tasks = tasks;
    this.events = events;
    this.identity = identity;
    this.worker = worker;
  }

  public Contracts.Connection get(UUID owner, UUID id) {
    return jdbc.sql(SELECT + " WHERE c.id=:id AND c.owner_id=:owner AND c.deleted_at IS NULL")
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
    String order =
        "name".equals(query.sort())
            ? "c.name"
            : "site".equals(query.sort()) ? "c.site" : "c.updated_at";
    var items =
        jdbc.sql(
                SELECT
                    + " WHERE "
                    + where
                    + " ORDER BY "
                    + order
                    + (query.ascending() ? " ASC" : " DESC")
                    + ",c.id LIMIT :limit OFFSET :offset")
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
                "SELECT DISTINCT site FROM connections WHERE "
                    + where
                    + " ORDER BY site LIMIT :limit OFFSET :offset")
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

  @Scheduled(fixedDelay = 10000)
  public void removeDeletedProfiles() {
    var ids =
        jdbc.sql("SELECT id FROM connections WHERE status='DELETING' ORDER BY deleted_at LIMIT 20")
            .query(UUID.class)
            .list();
    for (UUID id : ids) {
      try {
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
        UUID.fromString(input.viewerId());
        UUID session = browsers.ensure(owner, null, id, connection.startUrl());
        Contracts.Browser browser = browsers.get(owner, session);
        if ("LIVE".equals(browser.status())) {
          browsers.control(
              owner,
              session,
              new Contracts.ControlInput(
                  "BEGIN_LOGIN", input.viewerId(), false, false, id, null, null));
        } else {
          jdbc.sql(
                  "UPDATE browser_sessions SET"
                      + " control_owner='USER',controller_id=:viewer,private_mode=true,control_epoch=greatest(control_epoch,1)"
                      + " WHERE id=:id")
              .param("viewer", input.viewerId())
              .param("id", session)
              .update();
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
                row.getLong("browser_version"));
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
        Database.instant(row, "updated_at"));
  }
}
