package ru.helmglass.api.browsers;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.artifacts.ArtifactService;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.tasks.TaskService;
import tools.jackson.databind.JsonNode;

@Service
public class AdmissionService {
  private static final Logger log = LoggerFactory.getLogger(AdmissionService.class);
  private final JdbcClient jdbc;
  private final WorkerClient worker;
  private final BrowserService browsers;
  private final TaskService tasks;
  private final TransactionTemplate transactions;
  private final ArtifactService artifacts;
  private final EventService events;

  public AdmissionService(
      JdbcClient jdbc,
      WorkerClient worker,
      BrowserService browsers,
      TaskService tasks,
      ArtifactService artifacts,
      EventService events,
      org.springframework.transaction.PlatformTransactionManager manager) {
    this.jdbc = jdbc;
    this.worker = worker;
    this.browsers = browsers;
    this.tasks = tasks;
    this.artifacts = artifacts;
    this.events = events;
    this.transactions = new TransactionTemplate(manager);
  }

  @org.springframework.transaction.annotation.Transactional
  public void drain(boolean drain) {
    jdbc.sql("UPDATE scheduler_state SET drain=:drain WHERE id=1").param("drain", drain).update();
  }

  public Object drainState() {
    return jdbc.sql(
            """
SELECT drain,(SELECT count(*) FROM browser_sessions WHERE status NOT IN ('CLOSED','QUEUED')) occupied,
  (SELECT count(*) FROM browser_nodes WHERE NOT reachable) unreachable_nodes FROM scheduler_state WHERE id=1
""")
        .query(
            (row, index) ->
                Map.of(
                    "drain",
                    row.getBoolean("drain"),
                    "occupied",
                    row.getLong("occupied"),
                    "unreachableNodes",
                    row.getLong("unreachable_nodes"),
                    "ready",
                    row.getBoolean("drain")
                        && row.getLong("occupied") == 0
                        && row.getLong("unreachable_nodes") == 0))
        .single();
  }

  @Scheduled(fixedDelay = 3000)
  public void reconcile() {
    try {
      JsonNode health = worker.call("GET", "/health", null);
      UUID node = UUID.fromString(health.path("nodeId").asString());
      recordHealth(node, health);
      var sessions =
          jdbc.sql(
                  "SELECT id,(close_requested AND NOT EXISTS(SELECT 1 FROM operations o JOIN tasks"
                      + " t ON t.id=o.task_id WHERE o.session_id=browser_sessions.id AND"
                      + " o.status='DISPATCHED' AND t.status='PAUSING')) close_requested"
                      + " FROM browser_sessions WHERE node_id=:node AND status<>'CLOSED'"
                      + " ORDER BY last_seen_at NULLS FIRST LIMIT 20")
              .param("node", node)
              .query(
                  (row, index) ->
                      new Pending(
                          row.getObject("id", UUID.class), row.getBoolean("close_requested")))
              .list();
      for (Pending session : sessions) {
        try {
          JsonNode result = worker.call("GET", "/sessions/" + session.id(), null);
          browsers.reconcile(session.id(), result);
          String state = result.path("status").asString("UNKNOWN");
          if (!Set.of("LIVE", "CLOSING", "LOST").contains(state)) {
            continue;
          }
          boolean archived = artifacts.importSessionBatch(session.id());
          if ((session.close() || "LOST".equals(state)) && archived) {
            browsers.reconcile(
                session.id(), worker.call("DELETE", "/sessions/" + session.id(), null));
          }
        } catch (WorkerClient.WorkerException exception) {
          if (exception.status() == 404) {
            browsers.reconcile(
                session.id(),
                tools.jackson.databind.node.JsonNodeFactory.instance
                    .objectNode()
                    .put("status", "LOST"));
          }
        } catch (ApiException exception) {
          log.warn("Session reconciliation failed for {}: {}", session.id(), exception.code());
        }
      }
    } catch (RuntimeException exception) {
      transactions.executeWithoutResult(
          transaction -> {
            var changed =
                jdbc.sql(
                        "UPDATE browser_nodes SET reachable=false,version=version+1 WHERE reachable"
                            + " AND last_seen_at<now()-interval '10 seconds' RETURNING id")
                    .query(UUID.class)
                    .list();
            for (UUID node : changed) {
              events.emitAdministrators("node", node, 0);
            }
          });
      log.debug("Worker reconciliation unavailable: {}", exception.getClass().getSimpleName());
    }
  }

  private void recordHealth(UUID node, JsonNode health) {
    transactions.executeWithoutResult(
        transaction -> {
          var changed =
              jdbc.sql(
                      """
                      INSERT INTO browser_nodes(id,name,capacity,reachable,last_seen_at)
                      VALUES (:id,:name,:capacity,true,now()) ON CONFLICT(id) DO UPDATE
                      SET name=EXCLUDED.name,capacity=EXCLUDED.capacity,reachable=true,
                        last_seen_at=now(),version=browser_nodes.version+1
                      WHERE NOT browser_nodes.reachable
                        OR browser_nodes.name IS DISTINCT FROM EXCLUDED.name
                        OR browser_nodes.capacity IS DISTINCT FROM EXCLUDED.capacity
                      RETURNING version
                      """)
                  .param("id", node)
                  .param("name", health.path("name").asString("Браузерный узел"))
                  .param("capacity", health.path("capacity").asInt(1))
                  .query(Long.class)
                  .optional();
          if (changed.isPresent()) {
            events.emitAdministrators("node", node, changed.get());
          } else {
            jdbc.sql("UPDATE browser_nodes SET last_seen_at=now() WHERE id=:id")
                .param("id", node)
                .update();
          }
        });
  }

  @Scheduled(fixedDelay = 500)
  public void allocate() {
    Allocation allocation = transactions.execute(status -> claim());
    if (allocation == null) {
      return;
    }
    Map<String, Object> payload = new HashMap<>();
    payload.put("sessionId", allocation.id());
    payload.put("ownerId", allocation.owner());
    if (allocation.task() != null) {
      payload.put("taskId", allocation.task());
    }
    payload.put("startUrl", allocation.url());
    if (allocation.connection() != null) {
      payload.put("connectionId", allocation.connection());
    }
    try {
      browsers.reconcile(allocation.id(), worker.call("POST", "/sessions", payload));
    } catch (WorkerClient.WorkerException exception) {
      jdbc.sql("UPDATE browser_sessions SET status='UNREACHABLE' WHERE id=:id")
          .param("id", allocation.id())
          .update();
    }
  }

  private Allocation claim() {
    var scheduler =
        jdbc.sql(
                "SELECT last_owner_id,drain FROM scheduler_state WHERE id=1 FOR UPDATE SKIP LOCKED")
            .query(
                (row, index) ->
                    new Scheduler(
                        row.getObject("last_owner_id", UUID.class), row.getBoolean("drain")))
            .optional();
    if (scheduler.isEmpty() || scheduler.get().drain()) {
      return null;
    }
    var node =
        jdbc.sql(
                """
SELECT n.id FROM browser_nodes n WHERE n.reachable AND n.accepts_new
  AND n.last_seen_at>now()-interval '15 seconds'
  AND (SELECT count(*) FROM browser_sessions b WHERE b.node_id=n.id AND b.status NOT IN ('CLOSED','QUEUED'))<n.capacity
ORDER BY n.id LIMIT 1 FOR UPDATE SKIP LOCKED
""")
            .query(UUID.class)
            .optional();
    if (node.isEmpty()) {
      return null;
    }
    var candidate =
        jdbc.sql(
                """
SELECT b.*,CASE WHEN EXISTS(SELECT 1 FROM connections c WHERE c.id=b.connection_id AND c.status='READY')
 THEN b.connection_id END profile_connection_id FROM browser_sessions b JOIN accounts a ON a.id=b.owner_id
        WHERE b.status='QUEUED' AND NOT b.close_requested AND a.status='ACTIVE'
          AND (b.task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=b.task_id
            AND (t.status IN ('QUEUED','STARTING','WAITING_CHATGPT','RUNNING')
              OR (t.status='WAITING_USER' AND t.wait_reason='LOGIN'))))
  AND (a.browser_limit_mode='UNLIMITED' OR (SELECT count(*) FROM browser_sessions busy
  WHERE busy.owner_id=a.id AND busy.status NOT IN ('QUEUED','CLOSED'))
  < CASE WHEN a.browser_limit_mode='CUSTOM' THEN a.browser_limit ELSE 2 END)
ORDER BY CASE WHEN CAST(:last AS uuid) IS NULL OR b.owner_id>CAST(:last AS uuid) THEN 0 ELSE 1 END,
  b.owner_id,b.created_at,b.id LIMIT 1 FOR UPDATE OF b,a SKIP LOCKED
""")
            .param("last", scheduler.get().lastOwner())
            .query(
                (row, index) ->
                    new Allocation(
                        row.getObject("id", UUID.class),
                        row.getObject("owner_id", UUID.class),
                        row.getObject("task_id", UUID.class),
                        row.getObject("profile_connection_id", UUID.class),
                        row.getString("current_url")))
            .optional();
    if (candidate.isEmpty()) {
      return null;
    }
    Allocation allocation = candidate.get();
    jdbc.sql("UPDATE browser_sessions SET status='STARTING',node_id=:node WHERE id=:id")
        .param("node", node.get())
        .param("id", allocation.id())
        .update();
    jdbc.sql("UPDATE scheduler_state SET last_owner_id=:owner WHERE id=1")
        .param("owner", allocation.owner())
        .update();
    if (allocation.task() != null
        && !"WAITING_USER".equals(tasks.get(allocation.owner(), allocation.task()).status())) {
      tasks.change(allocation.owner(), allocation.task(), "STARTING", null, "Запускается браузер");
    }
    events.emitAdministrators("node", node.get(), 0);
    return allocation;
  }

  private record Allocation(UUID id, UUID owner, UUID task, UUID connection, String url) {}

  private record Pending(UUID id, boolean close) {}

  private record Scheduler(UUID lastOwner, boolean drain) {}
}
