package ru.helmglass.api.accounts;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.tasks.TaskService;

@Service
public class NodeService {
  private final JdbcClient jdbc;
  private final AccountService accounts;
  private final EventService events;

  public NodeService(JdbcClient jdbc, AccountService accounts, EventService events) {
    this.jdbc = jdbc;
    this.accounts = accounts;
    this.events = events;
  }

  public List<Node> list() {
    return jdbc.sql(
            "SELECT n.*,(SELECT count(*) FROM browser_sessions b WHERE b.node_id=n.id AND b.status"
                + " NOT IN ('CLOSED','QUEUED')) occupied FROM browser_nodes n ORDER BY"
                + " n.name")
        .query(
            (row, index) -> {
              UUID id = row.getObject("id", UUID.class);
              boolean reachable = row.getBoolean("reachable");
              var sessions =
                  jdbc.sql(
                          "SELECT b.id,b.task_id,b.owner_id,a.name,a.email,b.status,t.status"
                              + " task_status FROM browser_sessions b JOIN accounts a ON"
                              + " a.id=b.owner_id LEFT JOIN tasks t ON t.id=b.task_id WHERE"
                              + " b.node_id=:node AND b.status NOT IN ('CLOSED','QUEUED') ORDER BY"
                              + " b.created_at")
                      .param("node", id)
                      .query(
                          (browser, number) ->
                              new AdminBrowser(
                                  browser.getObject("id", UUID.class),
                                  browser.getObject("task_id", UUID.class),
                                  browser.getObject("owner_id", UUID.class),
                                  browser.getString("name"),
                                  browser.getString("status"),
                                  browser.getString("email"),
                                  browser.getString("task_status")))
                      .list();
              return new Node(
                  id,
                  row.getString("name"),
                  row.getLong("version"),
                  !reachable ? "OFFLINE" : row.getBoolean("accepts_new") ? "ONLINE" : "DRAINING",
                  reachable ? row.getLong("occupied") : null,
                  row.getInt("capacity"),
                  sessions);
            })
        .list();
  }

  public Contracts.Page<Node> page(ListQuery query) {
    var clauses = new ArrayList<String>();
    var parameters = new HashMap<String, Object>();
    if (query.search() != null && !query.search().isBlank()) {
      clauses.add("(n.name ILIKE :search OR n.id::text ILIKE :search)");
      parameters.put("search", "%" + query.search() + "%");
    }
    ListQuery.addList(clauses, parameters, "n.status", "status", query.status());
    String from =
        """
        FROM (SELECT n.*,CASE WHEN NOT reachable THEN 'OFFLINE'
          WHEN accepts_new THEN 'ONLINE' ELSE 'DRAINING' END status,
          CASE WHEN reachable THEN (SELECT count(*) FROM browser_sessions b
            WHERE b.node_id=n.id AND b.status NOT IN ('CLOSED','QUEUED')) END occupied
          FROM browser_nodes n) n
        """;
    String where = clauses.isEmpty() ? "" : " WHERE " + String.join(" AND ", clauses);
    long total =
        jdbc.sql("SELECT count(*) " + from + where).params(parameters).query(Long.class).single();
    String order =
        switch (query.sort() == null ? "" : query.sort()) {
          case "status" -> "n.status";
          case "occupied" -> "n.occupied";
          default -> "n.name";
        };
    var items =
        jdbc.sql(
                "SELECT n.* "
                    + from
                    + where
                    + " ORDER BY "
                    + order
                    + (query.ascending() ? " ASC" : " DESC")
                    + " NULLS LAST,n.id LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(
                (row, index) ->
                    new Node(
                        row.getObject("id", UUID.class),
                        row.getString("name"),
                        row.getLong("version"),
                        row.getString("status"),
                        row.getObject("occupied", Long.class),
                        row.getInt("capacity"),
                        List.of()))
            .list();
    return new Contracts.Page<>(items, total, query.page(), query.pageSize());
  }

  public Contracts.Page<AdminBrowser> browsers(UUID node, ListQuery query) {
    if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM browser_nodes WHERE id=:id)")
        .param("id", node)
        .query(Boolean.class)
        .single()) {
      throw ApiException.notFound();
    }
    String from =
        " FROM browser_sessions b JOIN accounts a ON a.id=b.owner_id"
            + " LEFT JOIN tasks t ON t.id=b.task_id WHERE b.node_id=:node"
            + " AND b.status NOT IN ('CLOSED','QUEUED')";
    long total = jdbc.sql("SELECT count(*)" + from).param("node", node).query(Long.class).single();
    String order =
        switch (query.sort() == null ? "" : query.sort()) {
          case "ownerName" -> "a.name";
          case "status" -> "coalesce(t.status,b.status)";
          default -> "b.id";
        };
    var items =
        jdbc.sql(
                "SELECT b.id,b.task_id,b.owner_id,a.name,a.email,b.status,t.status task_status"
                    + from
                    + " ORDER BY "
                    + order
                    + (query.ascending() ? " ASC" : " DESC")
                    + " NULLS LAST,b.id LIMIT :limit OFFSET :offset")
            .param("node", node)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(
                (row, index) ->
                    new AdminBrowser(
                        row.getObject("id", UUID.class),
                        row.getObject("task_id", UUID.class),
                        row.getObject("owner_id", UUID.class),
                        row.getString("name"),
                        row.getString("status"),
                        row.getString("email"),
                        row.getString("task_status")))
            .list();
    return new Contracts.Page<>(items, total, query.page(), query.pageSize());
  }

  @Transactional
  public Node command(Actor actor, UUID id, Contracts.NodeCommand input) {
    String reason = TaskService.required(input.reason(), "reason", 1000);
    String type = TaskService.required(input.type(), "type", 50);
    if (!List.of("DRAIN", "ENABLE").contains(type)) {
      throw ApiException.invalid("type", "Неизвестная команда узла.");
    }
    boolean enabled = "ENABLE".equals(type);
    var previous =
        jdbc.sql("SELECT version,reachable,accepts_new FROM browser_nodes WHERE id=:id FOR UPDATE")
            .param("id", id)
            .query(
                (row, index) ->
                    new NodeState(
                        row.getLong("version"),
                        row.getBoolean("reachable"),
                        row.getBoolean("accepts_new")))
            .optional()
            .orElseThrow(ApiException::notFound);
    if (!previous.reachable()) {
      throw ApiException.conflict("NODE_OFFLINE", "Нет подтверждения доступности узла.");
    }
    if (input.expectedVersion() != null && input.expectedVersion() != previous.version()) {
      throw ApiException.conflict("STALE_VERSION", "Состояние узла изменилось. Обновите данные.");
    }
    int changed =
        jdbc.sql("UPDATE browser_nodes SET accepts_new=:enabled,version=version+1 WHERE id=:id")
            .param("enabled", enabled)
            .param("id", id)
            .update();
    if (changed == 0) {
      throw ApiException.notFound();
    }
    accounts.writeAudit(
        actor.id(),
        id,
        null,
        type,
        reason,
        Map.of("acceptsNew", previous.acceptsNew()),
        Map.of("acceptsNew", enabled),
        "SUCCEEDED");
    events.emitAdministrators("node", id, 0);
    return (list().stream()
        .filter(node -> node.id().equals(id))
        .findFirst()
        .orElseThrow(ApiException::notFound));
  }

  private record NodeState(long version, boolean reachable, boolean acceptsNew) {}

  public record AdminBrowser(
      UUID id,
      UUID taskId,
      UUID ownerId,
      String ownerName,
      String status,
      String ownerEmail,
      String taskStatus) {}

  public record Node(
      UUID id,
      String name,
      long version,
      String status,
      Long occupied,
      int capacity,
      List<AdminBrowser> browsers) {}
}
