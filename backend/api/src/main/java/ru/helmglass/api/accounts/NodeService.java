package ru.helmglass.api.accounts;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
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
                          "SELECT b.id,b.task_id,b.owner_id,a.name,b.status FROM browser_sessions b"
                              + " JOIN accounts a ON a.id=b.owner_id WHERE b.node_id=:node AND"
                              + " b.status NOT IN ('CLOSED','QUEUED') ORDER BY b.created_at")
                      .param("node", id)
                      .query(
                          (browser, number) ->
                              new AdminBrowser(
                                  browser.getObject("id", UUID.class),
                                  browser.getObject("task_id", UUID.class),
                                  browser.getObject("owner_id", UUID.class),
                                  browser.getString("name"),
                                  browser.getString("status")))
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

  @Transactional
  public Node command(Actor actor, UUID id, Contracts.NodeCommand input) {
    String reason = TaskService.required(input.reason(), "reason", 1000);
    String type = TaskService.required(input.type(), "type", 50);
    if (!List.of("DRAIN", "ENABLE").contains(type)) {
      throw ApiException.invalid("type", "Неизвестная команда узла.");
    }
    boolean enabled = "ENABLE".equals(type);
    int changed =
        jdbc.sql("UPDATE browser_nodes SET accepts_new=:enabled,version=version+1 WHERE id=:id")
            .param("enabled", enabled)
            .param("id", id)
            .update();
    if (changed == 0) {
      throw ApiException.notFound();
    }
    accounts.writeAudit(
        actor.id(), id, null, type, reason, Map.of(), Map.of("acceptsNew", enabled), "SUCCEEDED");
    events.emitAdministrators("node", id, 0);
    return (list().stream()
        .filter(node -> node.id().equals(id))
        .findFirst()
        .orElseThrow(ApiException::notFound));
  }

  public record AdminBrowser(UUID id, UUID taskId, UUID ownerId, String ownerName, String status) {}

  public record Node(
      UUID id,
      String name,
      long version,
      String status,
      Long occupied,
      int capacity,
      List<AdminBrowser> browsers) {}
}
