package com.helmglass.administration.infrastructure.repository;

import com.helmglass.administration.api.AdminContracts;
import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.identity.api.PolicyContracts.Quotas;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.domain.QuotaCeiling;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.util.LinkedMultiValueMap;

@Repository
public class AdministrationRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final ChangeRepository changes;

  public AdministrationRepository(JdbcClient jdbc, JsonSupport json, ChangeRepository changes) {
    this.jdbc = jdbc;
    this.json = json;
    this.changes = changes;
  }

  public Map<String, Object> overview() {
    var values =
        jdbc.sql(
                """
                SELECT (SELECT count(*) FROM browser_allocations WHERE state='ASSIGNED') AS "confirmedBusy",
                (SELECT count(*) FROM browser_allocations WHERE state IN ('RESERVED','RELEASING','QUARANTINED')) AS "unconfirmedOccupied",
                (SELECT count(*) FROM tasks WHERE state IN ('WAITING_AGENT','WAITING_USER','QUEUED')) AS "waitingTasks",
                (SELECT count(*) FROM tasks WHERE state='QUEUED') AS "queuedForBrowser",
                (SELECT count(*) FROM browser_workers WHERE heartbeat_at<now()-interval '15 seconds') AS "unavailableWorkers",
                (SELECT count(*) FROM operations WHERE state IN ('PENDING','RUNNING','NEEDS_ATTENTION')) AS "pendingOperations",
                (SELECT count(*) FROM application_users WHERE state='BLOCKED') AS "blockedUsers",
                (SELECT count(*) FROM application_users WHERE state<>'DELETED') AS "totalUsers",
                p.version,p.accepting_allocations AS "acceptingAllocations",p.standard_browser_limit AS "standardBrowserLimit",
                (SELECT coalesce(sum(greatest(0,w.capacity-(SELECT count(*) FROM browser_allocations a
                  WHERE a.worker_id=w.id AND a.state<>'RELEASED'))),0) FROM browser_workers w
                  WHERE w.observed_state='READY' AND w.heartbeat_at>now()-interval '15 seconds') AS "physicalFree",
                (SELECT coalesce(sum(greatest(0,w.capacity-(SELECT count(*) FROM browser_allocations a
                  WHERE a.worker_id=w.id AND a.state<>'RELEASED'))),0) FROM browser_workers w
                  WHERE w.desired_mode='ENABLED' AND w.observed_state='READY'
                  AND w.heartbeat_at>now()-interval '15 seconds') AS "allocatableFree"
                FROM platform_settings p
                """)
            .query()
            .singleRow();
    if (!Boolean.TRUE.equals(values.get("acceptingAllocations"))) {
      values.put("allocatableFree", 0L);
    }
    values.put("observedAt", Instant.now());
    values.put("completeness", "COMPLETE");
    return values;
  }

  public Map<String, Object> user(UUID id, boolean lock) {
    var rows =
        jdbc.sql(
                """
                SELECT id,display_name AS "displayName",email,state AS "accountState",version,
                access_epoch AS "accessEpoch",created_at AS "createdAt",last_activity_at AS "lastActivityAt"
                FROM application_users WHERE id=:id
                """
                    + (lock ? " FOR UPDATE" : ""))
            .param("id", id)
            .query()
            .listOfRows();
    if (rows.isEmpty()) {
      throw DomainException.notFound();
    }
    var user = rows.getFirst();
    user.put("limits", "DELETED".equals(user.get("accountState")) ? null : limits(id, false));
    user.putAll(
        jdbc.sql(
                """
                SELECT (SELECT count(*) FROM browser_allocations WHERE user_id=:id AND state<>'RELEASED') AS "occupiedBrowsers",
                (SELECT count(*) FROM tasks WHERE user_id=:id AND state IN ('WAITING_AGENT','WAITING_USER','QUEUED')) AS "queuedTasks",
                (SELECT id FROM account_deletion_requests WHERE user_id=:id AND status IN ('REQUESTED','PURGING')) AS "deletionRequestId",
                (SELECT restore_until FROM account_deletion_requests WHERE user_id=:id AND status IN ('REQUESTED','PURGING')) AS "deletionDeadline",
                (SELECT version FROM account_deletion_requests WHERE user_id=:id AND status IN ('REQUESTED','PURGING')) AS "deletionRequestVersion",
                (SELECT purge_operation_id FROM account_deletion_requests WHERE user_id=:id
                  ORDER BY delete_requested_at DESC LIMIT 1) AS "purgeOperationId"
                """)
            .param("id", id)
            .query()
            .singleRow());
    user.put("usage", Map.of("completeness", "UNKNOWN"));
    return user;
  }

  public Map<String, Object> limits(UUID userId, boolean lock) {
    var rows =
        jdbc.sql(
                """
                SELECT l.version AS "limitVersion",l.browser_mode AS "browserMode",l.browser_custom AS "browserCustom",
                  l.queued_mode AS "queuedMode",l.queued_custom AS "queuedCustom",
                  p.browser_limit AS "personalBrowserLimit",p.queued_limit AS "personalQueuedLimit",
                  s.standard_browser_limit AS "standardBrowserLimit"
                FROM admin_user_limits l JOIN user_policies p ON p.user_id=l.user_id
                CROSS JOIN platform_settings s WHERE l.user_id=:id
                """
                    + (lock ? " FOR UPDATE OF l" : ""))
            .param("id", userId)
            .query()
            .listOfRows();
    return rows.isEmpty() ? null : limitsFromRow(rows.getFirst());
  }

  private static Map<String, Object> limitsFromRow(Map<String, Object> row) {
    Map<String, Object> limits = new HashMap<>();
    Object version = row.remove("limitVersion");
    for (String field :
        List.of(
            "browserMode",
            "browserCustom",
            "queuedMode",
            "queuedCustom",
            "personalBrowserLimit",
            "personalQueuedLimit")) {
      limits.put(field, row.remove(field));
    }
    int standard = ((Number) row.remove("standardBrowserLimit")).intValue();
    if (version == null) {
      return null;
    }
    limits.put("version", version);
    var browsers =
        QuotaCeiling.browsers(
            (String) limits.get("browserMode"),
            (Integer) limits.get("browserCustom"),
            standard,
            (Integer) limits.get("personalBrowserLimit"));
    var queued =
        QuotaCeiling.queued(
            (String) limits.get("queuedMode"),
            (Integer) limits.get("queuedCustom"),
            (Integer) limits.get("personalQueuedLimit"));
    limits.put(
        "quotas",
        new Quotas(
            browsers.assigned(), queued.assigned(), browsers.effective(), queued.effective()));
    return limits;
  }

  public PageResult<Map<String, Object>> users(UUID actorId, PageQuery query) {
    String snapshot = changes.snapshot(actorId, "users", query);
    String population = """
        WITH users AS (
          SELECT u.id,u.display_name AS "displayName",u.email,u.state AS "accountState",u.version,
            u.created_at AS "createdAt",u.last_activity_at AS "lastActivityAt",
            (SELECT count(*) FROM browser_allocations a WHERE a.user_id=u.id AND a.state<>'RELEASED') AS "occupiedBrowsers",
            (SELECT count(*) FROM tasks t WHERE t.user_id=u.id AND t.state IN ('WAITING_AGENT','WAITING_USER','QUEUED')) AS "queuedTasks",
            (SELECT count(*) FROM operations o WHERE o.state IN ('PENDING','RUNNING','NEEDS_ATTENTION')
              AND EXISTS(SELECT 1 FROM admin_audit_log a WHERE a.operation_id=o.id AND a.target_user_id=u.id)) AS "pendingOperations"
          FROM application_users u
        )
        """;
    String where = " WHERE (u.\"displayName\" ILIKE :q OR u.email ILIKE :q OR u.id::text=:exact)";
    Map<String, Object> parameters = new HashMap<>();
    parameters.put("q", query.escapedQuery());
    parameters.put("exact", query.query());
    List<String> states = query.filters().get("accountState");
    if (states != null && !states.isEmpty()) {
      if (states.size() > 5 || !List.of("ACTIVE", "BLOCKED", "DELETING", "PURGING", "DELETED").containsAll(states)) {
        throw new DomainException(400, "INVALID_FILTER", "Unsupported account state filter");
      }
      where += " AND u.\"accountState\" IN (:states)";
      parameters.put("states", states);
    }
    if (enabledFilter(query, "pending")) { where += " AND u.\"pendingOperations\">0"; }
    if (enabledFilter(query, "waiting")) { where += " AND u.\"queuedTasks\">0"; }
    long total = jdbc.sql(population + "SELECT count(*) FROM users u" + where)
        .params(parameters).query(Long.class).single();
    var users = jdbc.sql(population + """
        SELECT u.*,l.version AS "limitVersion",l.browser_mode AS "browserMode",l.browser_custom AS "browserCustom",
          l.queued_mode AS "queuedMode",l.queued_custom AS "queuedCustom",
          p.browser_limit AS "personalBrowserLimit",p.queued_limit AS "personalQueuedLimit",
          s.standard_browser_limit AS "standardBrowserLimit"
        FROM users u LEFT JOIN admin_user_limits l ON l.user_id=u.id
          LEFT JOIN user_policies p ON p.user_id=u.id CROSS JOIN platform_settings s
        """ + where + " ORDER BY " + query.sqlOrder(Map.of(
          "displayName", "\"displayName\"", "email", "email", "accountState", "\"accountState\"",
          "occupiedBrowsers", "\"occupiedBrowsers\"", "queuedTasks", "\"queuedTasks\"",
          "createdAt", "\"createdAt\"", "lastActiveAt", "\"lastActivityAt\"", "lastActivityAt", "\"lastActivityAt\""),
          "\"lastActivityAt\" DESC,id") + " LIMIT :limit OFFSET :offset")
        .params(parameters).param("limit", query.pageSize()).param("offset", query.offset()).query().listOfRows();
    for (var user : users) {
      Map<String, Object> limits = limitsFromRow(user);
      user.put("limits", "DELETED".equals(user.get("accountState")) ? null : limits);
    }
    return new PageResult<>(users, total, query.page(), query.pageSize(), query.sortDescriptor(), snapshot);
  }

  private static boolean enabledFilter(PageQuery query, String name) {
    List<String> values = query.filters().get(name);
    if (values == null) { return false; }
    if (values.size() != 1 || !List.of("true", "false").contains(values.getFirst())) {
      throw new DomainException(400, "INVALID_FILTER", "Expected one boolean filter");
    }
    return values.getFirst().equals("true");
  }

  public PageResult<Map<String, Object>> safeTasks(UUID actorId, UUID userId, PageQuery query) {
    if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM application_users WHERE id=:id)")
        .param("id", userId)
        .query(Boolean.class)
        .single()) {
      throw DomainException.notFound();
    }
    var snapshotParameters = new LinkedMultiValueMap<>(query.filters());
    snapshotParameters.set("adminActorId", actorId.toString());
    snapshotParameters.set("view", "admin-safe-tasks");
    String snapshot = changes.snapshot(userId, "tasks", PageQuery.from(snapshotParameters));
    String recent =
        """
        WITH recent AS (
          SELECT id,state,wait_reason,failure_code,created_at FROM tasks WHERE user_id=:user
          ORDER BY created_at DESC,id DESC LIMIT 50
        )
        """;
    String where =
        " WHERE (t.id::text ILIKE :q OR t.state ILIKE :q"
            + " OR t.wait_reason ILIKE :q OR t.failure_code ILIKE :q)";
    Map<String, Object> parameters = new HashMap<>();
    parameters.put("user", userId);
    parameters.put("q", query.escapedQuery());
    List<String> states = query.filters().get("state");
    if (states == null) {
      states = query.filters().get("state[]");
    }
    if (states != null && !states.isEmpty()) {
      if (states.size() > 50) {
        throw new DomainException(400, "INVALID_FILTER", "Too many task state filters");
      }
      where += " AND t.state IN (:states)";
      parameters.put("states", states);
    }
    long total =
        jdbc.sql(recent + "SELECT count(*) FROM recent t" + where)
            .params(parameters)
            .query(Long.class)
            .single();
    var rows =
        jdbc.sql(
                recent
                    + """
                    SELECT t.id,t.state,t.wait_reason AS "waitReason",t.failure_code AS "failureCode",
                      t.created_at AS "createdAt",b.id AS "browserSessionId",b.worker_id AS "workerId"
                    FROM recent t LEFT JOIN LATERAL (
                      SELECT id,worker_id FROM browser_sessions WHERE task_id=t.id AND binding_released_at IS NULL
                      ORDER BY requested_at DESC,id DESC LIMIT 1
                    ) b ON true
                    """
                    + where
                    + " ORDER BY "
                    + query.sqlOrder(
                        Map.of(
                            "id",
                            "t.id",
                            "state",
                            "t.state",
                            "waitReason",
                            "t.wait_reason",
                            "failureCode",
                            "t.failure_code",
                            "createdAt",
                            "t.created_at",
                            "browserSessionId",
                            "b.id",
                            "workerId",
                            "b.worker_id"),
                        "t.created_at DESC,t.id DESC")
                    + " LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query()
            .listOfRows();
    return new PageResult<>(
        rows, total, query.page(), query.pageSize(), query.sortDescriptor(), snapshot);
  }

  public Map<String, Object> browsers() {
    return Map.of(
        "workers",
        jdbc.sql(
                """
                SELECT id,boot_id AS "bootId",capacity,version,desired_mode AS "desiredMode",
                observed_state AS "observedState",image_version AS "imageVersion",heartbeat_at AS "heartbeatAt"
                FROM browser_workers ORDER BY id
                """)
            .query()
            .listOfRows(),
        "allocations",
        jdbc.sql(
                """
                SELECT id,session_id AS "sessionId",user_id AS "userId",worker_id AS "workerId",
                slot_index AS "slotIndex",state,version FROM browser_allocations WHERE state<>'RELEASED'
                ORDER BY created_at LIMIT 1000
                """)
            .query()
            .listOfRows());
  }

  public void limits(UUID userId, AdminContracts.Limits input) {
    jdbc.sql(
            """
            UPDATE admin_user_limits SET browser_mode=:browser,browser_custom=:browserCustom,
            queued_mode=:queued,queued_custom=:queuedCustom,version=version+1,updated_at=now() WHERE user_id=:id
            """)
        .param("id", userId)
        .param("browser", input.browserMode())
        .param("browserCustom", input.browserCustom())
        .param("queued", input.queuedMode())
        .param("queuedCustom", input.queuedCustom())
        .update();
  }

  public void accountState(UUID id, String state) {
    jdbc.sql(
            """
            UPDATE application_users SET state=:state,version=version+1,access_epoch=access_epoch+1,
            reauthentication_after=now(),updated_at=now() WHERE id=:id
            """)
        .param("id", id)
        .param("state", state)
        .update();
    jdbc.sql(
            """
            UPDATE application_logins SET state='REVOKED',revoked_at=now(),revoke_reason='ACCOUNT_STATE',
            version=version+1 WHERE user_id=:id AND state='ACTIVE'
            """)
        .param("id", id)
        .update();
    jdbc.sql(
            """
            UPDATE client_grants SET status='REVOKED',revoked_at=now(),version=version+1
            WHERE user_id=:id AND status='ACTIVE'
            """)
        .param("id", id)
        .update();
  }

  public void requestDeletion(UUID requestId, UUID userId, String previous) {
    jdbc.sql(
            """
            INSERT INTO account_deletion_requests(id,user_id,previous_account_state,delete_requested_at,restore_until)
            VALUES(:id,:user,:previous,now(),now()+interval '168 hours')
            """)
        .param("id", requestId)
        .param("user", userId)
        .param("previous", previous)
        .update();
  }

  public record Deletion(
      UUID id,
      UUID userId,
      String previousAccountState,
      String status,
      long version,
      Instant restoreUntil) {}

  public Deletion deletion(UUID id) {
    return jdbc.sql("SELECT * FROM account_deletion_requests WHERE id=:id FOR UPDATE")
        .param("id", id)
        .query(Deletion.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void cancelDeletion(UUID id) {
    jdbc.sql(
            "UPDATE account_deletion_requests SET status='CANCELLED',version=version+1 WHERE"
                + " id=:id")
        .param("id", id)
        .update();
  }

  public void admission(boolean accepted) {
    jdbc.sql(
            "UPDATE platform_settings SET"
                + " accepting_allocations=:value,version=version+1,updated_at=now()")
        .param("value", accepted)
        .update();
  }

  public long platformVersion() {
    return jdbc.sql("SELECT version FROM platform_settings FOR UPDATE").query(Long.class).single();
  }

  public long workerVersion(UUID id) {
    return jdbc.sql("SELECT version FROM browser_workers WHERE id=:id FOR UPDATE")
        .param("id", id)
        .query(Long.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void workerMode(UUID id, String mode) {
    jdbc.sql("UPDATE browser_workers SET desired_mode=:mode,version=version+1 WHERE id=:id")
        .param("id", id)
        .param("mode", mode)
        .update();
  }

  public void audit(
      AuthenticatedActor actor,
      UUID targetId,
      String targetType,
      String action,
      String reason,
      Object before,
      Object after,
      MutationReceipt receipt) {
    jdbc.sql(
            """
            INSERT INTO admin_audit_log(id,actor_id,actor_name,actor_email,target_id,target_type,
            target_user_id,action,reason,previous_value,new_value,operation_id,request_id)
            VALUES(:id,:actor,:name,:email,:target,:type,:user,:action,:reason,CAST(:before AS jsonb),
            CAST(:after AS jsonb),:operation,:request)
            """)
        .param("id", UUID.randomUUID())
        .param("actor", actor.userId())
        .param("name", actor.displayName())
        .param("email", actor.email())
        .param("target", targetId)
        .param("type", targetType)
        .param("user", targetType.equals("user") ? targetId : null)
        .param("action", action)
        .param("reason", reason.trim())
        .param("before", json.write(before))
        .param("after", json.write(after))
        .param("operation", receipt.operationId())
        .param("request", receipt.requestId())
        .update();
    changes.changed(actor.userId(), "users", targetId, System.currentTimeMillis());
    changes.changed(actor.userId(), "audit", targetId, System.currentTimeMillis());
  }

  public PageResult<Map<String, Object>> audit(UUID actorId, UUID userId, PageQuery query) {
    String where = " WHERE (reason ILIKE :q OR action ILIKE :q)";
    Map<String, Object> parameters = new HashMap<>();
    parameters.put("q", query.escapedQuery());
    if (userId != null) {
      where += " AND target_user_id=:user";
      parameters.put("user", userId);
    }
    long total =
        jdbc.sql("SELECT count(*) FROM admin_audit_log" + where)
            .params(parameters)
            .query(Long.class)
            .single();
    var rows =
        jdbc.sql(
                """
                SELECT id,actor_id AS "actorId",actor_name AS "actorName",target_id AS "targetId",
                target_type AS "targetType",action,reason,operation_id AS "operationId",occurred_at AS "occurredAt"
                FROM admin_audit_log
                """
                    + where
                    + " ORDER BY occurred_at DESC,id LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query()
            .listOfRows();
    var parametersForSnapshot = new LinkedMultiValueMap<>(query.filters());
    parametersForSnapshot.set("targetUserId", userId == null ? "all" : userId.toString());
    return new PageResult<>(
        rows,
        total,
        query.page(),
        query.pageSize(),
        query.sortDescriptor(),
        changes.snapshot(actorId, "audit", PageQuery.from(parametersForSnapshot)));
  }
}
