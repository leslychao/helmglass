package ru.helmglass.api.browsers;

import java.util.HashMap;
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
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.artifacts.ArtifactService;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.tasks.ActionService;
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
  private final ActionService actions;
  private final ExecutorService reconciler = Executors.newVirtualThreadPerTaskExecutor();
  private final Semaphore reconciliationSlots = new Semaphore(4);
  private final Semaphore archiveSlot = new Semaphore(1);
  private final EventService events;
  private final JsonSupport json;
  private static final UUID PLATFORM_ID = new UUID(0, 0);

  public AdmissionService(
      JdbcClient jdbc,
      WorkerClient worker,
      BrowserService browsers,
      TaskService tasks,
      ArtifactService artifacts,
      ActionService actions,
      EventService events,
      JsonSupport json,
      org.springframework.transaction.PlatformTransactionManager manager) {
    this.jdbc = jdbc;
    this.worker = worker;
    this.browsers = browsers;
    this.tasks = tasks;
    this.artifacts = artifacts;
    this.actions = actions;
    this.events = events;
    this.json = json;
    this.transactions = new TransactionTemplate(manager);
  }

  @org.springframework.transaction.annotation.Transactional
  public void drain(boolean drain) {
    jdbc.sql("UPDATE scheduler_state SET drain=:drain WHERE id=1").param("drain", drain).update();
    events.emitAdministrators("admission", PLATFORM_ID, 0);
  }

  public AdmissionState administrationState() {
    return jdbc.sql("SELECT admin_paused,drain,admin_version FROM scheduler_state WHERE id=1")
        .query(
            (row, index) ->
                new AdmissionState(
                    row.getBoolean("admin_paused"),
                    row.getBoolean("drain"),
                    row.getLong("admin_version")))
        .single();
  }

  @org.springframework.transaction.annotation.Transactional
  public AdmissionState administrationCommand(Actor actor, AdmissionCommand input) {
    if (!actor.administrator()) {
      throw Identity.denied("Нет административных прав.");
    }
    String reason = TaskService.required(input.reason(), "reason", 1000);
    String type = TaskService.required(input.type(), "type", 50);
    if (!Set.of("PAUSE", "RESUME").contains(type)) {
      throw ApiException.invalid("type", "Неизвестная команда запуска браузеров.");
    }
    if (input.expectedVersion() == null) {
      throw ApiException.invalid("expectedVersion", "Укажите версию состояния запуска.");
    }
    jdbc.sql("SELECT id FROM scheduler_state WHERE id=1 FOR UPDATE").query(Integer.class).single();
    AdmissionState previous = administrationState();
    if (previous.version() != input.expectedVersion()) {
      throw ApiException.conflict(
          "VERSION_CONFLICT", "Состояние запуска изменилось. Обновите данные.");
    }
    boolean paused = "PAUSE".equals(type);
    jdbc.sql(
            "UPDATE scheduler_state SET admin_paused=:paused,admin_version=admin_version+1 WHERE"
                + " id=1")
        .param("paused", paused)
        .update();
    AdmissionState current = administrationState();
    jdbc.sql(
            """
            INSERT INTO administrative_audit
              (id,actor_id,target_id,action,reason,before_value,after_value,status)
            VALUES (:id,:actor,:target,:action,:reason,CAST(:before AS jsonb),CAST(:after AS jsonb),'SUCCEEDED')
            """)
        .param("id", UUID.randomUUID())
        .param("actor", actor.id())
        .param("target", PLATFORM_ID)
        .param("action", paused ? "PAUSE_ADMISSION" : "RESUME_ADMISSION")
        .param("reason", reason)
        .param("before", json.write(Map.of("paused", previous.paused())))
        .param("after", json.write(Map.of("paused", current.paused())))
        .update();
    events.emitAdministrators("admission", PLATFORM_ID, current.version());
    events.emitAdministrators("admin-audit", PLATFORM_ID, 0);
    return current;
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
                  """
                  SELECT id FROM browser_sessions WHERE node_id=:node AND status<>'CLOSED'
                    AND next_check_at<=clock_timestamp() ORDER BY next_check_at,id LIMIT 20
                  """)
              .param("node", node)
              .query(UUID.class)
              .list();
      for (UUID session : sessions) {
        if (!reconciliationSlots.tryAcquire()) {
          break;
        }
        try {
          int claimed =
              jdbc.sql(
                      """
                      UPDATE browser_sessions SET next_check_at=clock_timestamp()+interval '45 seconds'
                      WHERE id=:id AND next_check_at<=clock_timestamp()
                      """)
                  .param("id", session)
                  .update();
          if (claimed == 0) {
            reconciliationSlots.release();
            continue;
          }
          reconciler.execute(
              () -> {
                try {
                  reconcileSession(session);
                } catch (RuntimeException exception) {
                  log.warn(
                      "Session reconciliation failed for {}: {}",
                      session,
                      exception.getClass().getSimpleName());
                } finally {
                  try {
                    jdbc.sql(
                            "UPDATE browser_sessions SET next_check_at=clock_timestamp()+interval"
                                + " '3 seconds' WHERE id=:id")
                        .param("id", session)
                        .update();
                  } finally {
                    reconciliationSlots.release();
                  }
                }
              });
        } catch (RuntimeException exception) {
          reconciliationSlots.release();
          throw exception;
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

  private void reconcileSession(UUID session) {
    boolean close =
        jdbc.sql(
                """
                SELECT close_requested AND NOT EXISTS(SELECT 1 FROM operations o JOIN tasks t ON t.id=o.task_id
                  WHERE o.session_id=b.id AND o.status='DISPATCHED' AND t.status='PAUSING'
                    AND o.deadline_at+interval '10 seconds'>clock_timestamp())
                FROM browser_sessions b WHERE b.id=:id
                """)
            .param("id", session)
            .query(Boolean.class)
            .single();
    if (close) {
      if (!browsers.prepareClose(session)) {
        return;
      }
      JsonNode stopped = worker.call("DELETE", "/sessions/" + session, null);
      browsers.reconcile(session, stopped);
      if (stopped.path("runtimeStoppedAt").isString()) {
        actions.executionStopped(session);
      }
      return;
    }
    JsonNode result = worker.call("GET", "/sessions/" + session, null);
    browsers.reconcile(session, result);
    if (result.path("runtimeStoppedAt").isString()) {
      actions.executionStopped(session);
    } else if ("LOST".equals(result.path("status").asString())) {
      JsonNode stopped = worker.call("DELETE", "/sessions/" + session, null);
      browsers.reconcile(session, stopped);
      if (stopped.path("runtimeStoppedAt").isString()) {
        actions.executionStopped(session);
      }
    }
  }

  @Scheduled(fixedDelay = 1000)
  public void archiveSessions() {
    if (!archiveSlot.tryAcquire()) {
      return;
    }
    try {
      var candidate =
          jdbc.sql(
                  """
                  UPDATE browser_sessions SET next_check_at=clock_timestamp()+interval '7 minutes'
                  WHERE id=(SELECT id FROM browser_sessions WHERE status='CLOSED'
                    AND cleanup_state IN ('PENDING','RUNNING') AND next_check_at<=clock_timestamp()
                    ORDER BY next_check_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
                  RETURNING id
                  """)
              .query(UUID.class)
              .optional();
      if (candidate.isEmpty()) {
        archiveSlot.release();
        return;
      }
      UUID session = candidate.get();
      reconciler.execute(
          () -> {
            String failureCode = "RESULT_REGISTRATION_FAILED";
            try {
              boolean receipts = actions.archiveReceipts(session);
              boolean files = artifacts.importSessionBatch(session);
              if (receipts && files) {
                failureCode = "CLEANUP_FAILED";
                JsonNode cleaned = worker.call("DELETE", "/sessions/" + session + "/cleanup", null);
                if (!"COMPLETE".equals(cleaned.path("cleanupState").asString())) {
                  throw new IllegalStateException("Cleanup was not confirmed");
                }
                cleanupState(session, "COMPLETE", null, false);
              } else {
                cleanupState(session, "PENDING", null, false);
              }
            } catch (RuntimeException exception) {
              log.warn(
                  "{} for session {}: {}",
                  failureCode,
                  session,
                  exception.getClass().getSimpleName());
              cleanupState(session, "PENDING", failureCode, true);
            } finally {
              archiveSlot.release();
            }
          });
    } catch (RuntimeException exception) {
      archiveSlot.release();
      throw exception;
    }
  }

  private void cleanupState(UUID session, String state, String error, boolean failed) {
    transactions.executeWithoutResult(
        transaction -> {
          var reference = browsers.reference(session);
          tasks.lockOwner(reference.ownerId());
          jdbc.sql(
                  """
                  UPDATE browser_sessions SET cleanup_attempts=cleanup_attempts+CASE WHEN :failed THEN 1 ELSE 0 END,
                    cleanup_state=CASE WHEN :failed AND cleanup_attempts>=2 THEN 'FAILED' ELSE :state END,
                    cleanup_error=:error,next_check_at=clock_timestamp()+
                      (CASE WHEN :failed THEN CASE cleanup_attempts WHEN 0 THEN 1 WHEN 1 THEN 3 ELSE 10 END ELSE 1 END)*interval '1 second',
                    version=version+1 WHERE id=:id
                  """)
              .param("id", session)
              .param("failed", failed)
              .param("state", state)
              .param("error", error)
              .update();
          events.emit(reference.ownerId(), "browser", session, 0);
          events.emitAdministrators("node", session, 0);
        });
  }

  @org.springframework.transaction.annotation.Transactional
  public Contracts.Browser retryCleanup(Actor actor, UUID session) {
    if (!actor.administrator()) {
      throw Identity.denied("Нет административных прав.");
    }
    var reference = browsers.reference(session);
    tasks.lockOwner(reference.ownerId());
    int changed =
        jdbc.sql(
                """
                UPDATE browser_sessions SET cleanup_state='PENDING',cleanup_error=NULL,cleanup_attempts=0,
                  next_check_at=clock_timestamp(),version=version+1 WHERE id=:id AND cleanup_state='FAILED'
                """)
            .param("id", session)
            .update();
    if (changed != 1) {
      throw ApiException.conflict("CLEANUP_NOT_FAILED", "Повтор очистки сейчас не требуется.");
    }
    events.emit(reference.ownerId(), "browser", session, 0);
    jdbc.sql(
            """
            INSERT INTO administrative_audit
              (id,actor_id,target_id,action,reason,before_value,after_value,status)
            VALUES (:id,:actor,:target,'RETRY_BROWSER_CLEANUP','Повтор проверки результатов и очистки',
              '{"cleanupState":"FAILED"}','{"cleanupState":"PENDING"}','SUCCEEDED')
            """)
        .param("id", UUID.randomUUID())
        .param("actor", actor.id())
        .param("target", session)
        .update();
    events.emitAdministrators("admin-audit", session, 0);
    return browsers.get(reference.ownerId(), session);
  }

  @jakarta.annotation.PreDestroy
  void stopReconciler() {
    reconciler.shutdownNow();
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
    payload.put(
        "deadlineAt",
        jdbc.sql("SELECT start_deadline_at FROM browser_sessions WHERE id=:id")
            .param("id", allocation.id())
            .query((row, index) -> ru.helmglass.api.Database.instant(row, "start_deadline_at"))
            .single()
            .toString());
    if (allocation.connection() != null) {
      payload.put("connectionId", allocation.connection());
      payload.put("restoreProfile", allocation.restoreProfile());
    }
    try {
      browsers.reconcile(allocation.id(), worker.call("POST", "/sessions", payload));
    } catch (WorkerClient.WorkerException exception) {
      jdbc.sql(
              "UPDATE browser_sessions SET status='UNREACHABLE'"
                  + " WHERE id=:id AND status='STARTING' AND NOT close_requested")
          .param("id", allocation.id())
          .update();
    }
  }

  @Scheduled(fixedDelay = 3000)
  public void explainQueue() {
    var changes =
        jdbc.sql(
                """
                WITH waiting AS (
                  SELECT t.id,t.owner_id,t.wait_reason,CASE
                    WHEN s.admin_paused AND s.drain THEN 'ADMIN_PAUSED_DEPLOYMENT_DRAIN'
                    WHEN s.admin_paused THEN 'ADMIN_PAUSED'
                    WHEN s.drain THEN 'DEPLOYMENT_DRAIN'
                    WHEN a.browser_limit_mode<>'UNLIMITED' AND
                      (SELECT count(*) FROM browser_sessions used WHERE used.owner_id=a.id
                        AND used.status NOT IN ('CLOSED','QUEUED')) >=
                      CASE WHEN a.browser_limit_mode='CUSTOM' THEN a.browser_limit ELSE 2 END THEN 'USER_BROWSER_LIMIT'
                    WHEN NOT EXISTS(SELECT 1 FROM browser_nodes n WHERE n.reachable AND n.accepts_new
                      AND n.last_seen_at>clock_timestamp()-interval '15 seconds') THEN 'NODE_UNAVAILABLE'
                    ELSE 'BROWSER_CAPACITY' END reason
                  FROM tasks t JOIN browser_sessions b ON b.id=t.browser_session_id
                  JOIN accounts a ON a.id=t.owner_id CROSS JOIN scheduler_state s
                  WHERE t.status='QUEUED' AND b.status='QUEUED' AND NOT b.close_requested)
                SELECT id,owner_id,reason FROM waiting WHERE wait_reason IS DISTINCT FROM reason LIMIT 50
                """)
            .query(
                (row, index) ->
                    new QueueReason(
                        row.getObject("id", UUID.class),
                        row.getObject("owner_id", UUID.class),
                        row.getString("reason")))
            .list();
    for (QueueReason change : changes) {
      transactions.executeWithoutResult(
          transaction -> {
            tasks.lockOwner(change.owner());
            if ("QUEUED".equals(tasks.get(change.owner(), change.id()).status())) {
              tasks.change(
                  change.owner(),
                  change.id(),
                  "QUEUED",
                  change.reason(),
                  "Ожидание назначения браузера");
            }
          });
    }
  }

  private record QueueReason(UUID id, UUID owner, String reason) {}

  private Allocation claim() {
    var scheduler =
        jdbc.sql(
                "SELECT last_owner_id,(drain OR admin_paused) AS drain FROM scheduler_state"
                    + " WHERE id=1 FOR UPDATE SKIP LOCKED")
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
SELECT b.*,EXISTS(SELECT 1 FROM connections c WHERE c.id=b.connection_id AND c.status='READY')
 restore_profile FROM browser_sessions b JOIN accounts a ON a.id=b.owner_id
        WHERE b.status='QUEUED' AND NOT b.close_requested AND a.status='ACTIVE'
          AND (b.task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=b.task_id
            AND (t.status IN ('QUEUED','STARTING','WAITING_CHATGPT','RUNNING')
              OR (t.status='WAITING_USER' AND t.wait_reason='LOGIN')
              OR (t.status='PAUSED' AND t.wait_reason='BROWSER_OPEN_REQUESTED'))))
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
                        row.getObject("connection_id", UUID.class),
                        row.getBoolean("restore_profile"),
                        row.getString("current_url")))
            .optional();
    if (candidate.isEmpty()) {
      return null;
    }
    Allocation allocation = candidate.get();
    jdbc.sql(
            "UPDATE browser_sessions SET"
                + " status='STARTING',start_deadline_at=clock_timestamp()+interval '6"
                + " minutes',node_id=:node WHERE id=:id")
        .param("node", node.get())
        .param("id", allocation.id())
        .update();
    jdbc.sql("UPDATE scheduler_state SET last_owner_id=:owner WHERE id=1")
        .param("owner", allocation.owner())
        .update();
    if (allocation.task() != null
        && !Set.of("WAITING_USER", "PAUSED")
            .contains(tasks.get(allocation.owner(), allocation.task()).status())) {
      tasks.change(allocation.owner(), allocation.task(), "STARTING", null, "Запускается браузер");
    }
    events.emitAdministrators("node", node.get(), 0);
    return allocation;
  }

  private record Allocation(
      UUID id, UUID owner, UUID task, UUID connection, boolean restoreProfile, String url) {}

  private record Scheduler(UUID lastOwner, boolean drain) {}

  public record AdmissionState(boolean paused, boolean deploymentDrain, long version) {}

  public record AdmissionCommand(String type, String reason, Long expectedVersion) {}
}
