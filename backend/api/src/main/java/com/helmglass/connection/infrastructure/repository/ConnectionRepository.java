package com.helmglass.connection.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.connection.api.ConnectionContracts;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.net.URI;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ConnectionRepository {
  private static final String VIEW =
      """
      SELECT c.*,s.task_id AS current_task_id,s.id AS session_id,l.id AS login_operation_id
      FROM connections c LEFT JOIN LATERAL (SELECT id,task_id FROM browser_sessions
      WHERE connection_id=c.id AND binding_released_at IS NULL ORDER BY requested_at DESC LIMIT 1) s ON true
      LEFT JOIN LATERAL (SELECT id FROM connection_login_operations WHERE connection_id=c.id
      AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED') ORDER BY created_at DESC LIMIT 1) l ON true
      """;
  private final JdbcClient jdbc;
  private final ChangeRepository changes;

  public ConnectionRepository(JdbcClient jdbc, ChangeRepository changes) {
    this.jdbc = jdbc;
    this.changes = changes;
  }

  public ConnectionContracts.ConnectionView owned(UUID userId, UUID id, boolean lock) {
    return jdbc.sql(VIEW + " WHERE c.user_id=:user AND c.id=:id" + (lock ? " FOR UPDATE OF c" : ""))
        .param("user", userId)
        .param("id", id)
        .query(ConnectionContracts.ConnectionView.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void savePreference(UUID id, String preference) {
    jdbc.sql(
            "UPDATE connections SET save_preference=:preference,version=version+1,updated_at=now()"
                + " WHERE id=:id")
        .param("id", id)
        .param("preference", preference)
        .update();
  }

  public ConnectionContracts.ConnectionView create(
      UUID userId, UUID siteId, ConnectionContracts.Create input) {
    UUID id = UUID.randomUUID();
    URI uri = URI.create(input.startUrl());
    String origin =
        uri.getScheme() + "://" + uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
    jdbc.sql(
            """
            INSERT INTO connections(id,user_id,site_id,display_name,start_url,origin,save_preference,status)
            VALUES(:id,:user,:site,:name,:url,:origin,:save,'NEEDS_LOGIN')
            """)
        .param("id", id)
        .param("user", userId)
        .param("site", siteId)
        .param("name", input.displayName().trim())
        .param("url", input.startUrl())
        .param("origin", origin)
        .param("save", input.savePreference())
        .update();
    jdbc.sql(
            """
            INSERT INTO connection_origins(id,connection_id,user_id,origin,role,admitted_scope_version,
            confirmation_source) VALUES(:id,:connection,:user,:origin,'APP',1,'EXPLICIT_CREATE')
            """)
        .param("id", UUID.randomUUID())
        .param("connection", id)
        .param("user", userId)
        .param("origin", origin)
        .update();
    jdbc.sql(
            """
            INSERT INTO user_sites(user_id,site_id,scope) VALUES(:user,:site,'connections')
            ON CONFLICT(user_id,site_id,scope) DO UPDATE SET last_selected_at=now()
            """)
        .param("user", userId)
        .param("site", siteId)
        .update();
    return owned(userId, id, false);
  }

  public void bind(UUID connectionId, UUID sessionId) {
    int updated =
        jdbc.sql(
                """
                UPDATE browser_allocations SET connection_id=:connection,version=version+1
                WHERE session_id=:session AND (connection_id IS NULL OR connection_id=:connection)
                AND state IN ('RESERVED','ASSIGNED')
                """)
            .param("session", sessionId)
            .param("connection", connectionId)
            .update();
    if (updated != 1) {
      throw DomainException.conflict(
          "CONNECTION_SWITCH_REQUIRED", "Use explicit account switching for this browser");
    }
    jdbc.sql(
            """
            UPDATE browser_sessions SET connection_id=:connection,
              save_policy=CASE WHEN connection_id IS NULL THEN
                CASE WHEN (SELECT save_preference FROM connections WHERE id=:connection)='SAVE'
                  THEN 'SAVE_ON_CLOSE' ELSE 'DISCARD_CHANGES' END ELSE save_policy END,
              version=version+1 WHERE id=:session
            """)
        .param("session", sessionId)
        .param("connection", connectionId)
        .update();
  }

  public boolean profileReady(UUID connectionId, UUID versionId) {
    return jdbc.sql(
                """
                SELECT count(*) FROM browser_profiles p JOIN browser_profile_versions v ON v.id=p.current_version_id
                WHERE p.connection_id=:connection AND v.id=:version AND v.state='READY'
                """)
            .param("connection", connectionId)
            .param("version", versionId)
            .query(Long.class)
            .single()
        == 1;
  }

  public long instructionRevision(UUID taskId) {
    return taskId == null
        ? 0
        : jdbc.sql("SELECT instruction_revision FROM tasks WHERE id=:id")
            .param("id", taskId)
            .query(Long.class)
            .single();
  }

  public void discardChanges(UUID sessionId) {
    jdbc.sql(
            "UPDATE browser_sessions SET save_policy='DISCARD_CHANGES',version=version+1 WHERE"
                + " id=:id")
        .param("id", sessionId)
        .update();
  }

  public void resumeTask(UUID taskId, String intent) {
    if (taskId == null) {
      return;
    }
    jdbc.sql(
            """
            UPDATE tasks SET state=:state,version=version+1,updated_at=now()
            WHERE id=:id AND state IN ('WAITING_USER','PAUSING','PAUSED') AND NOT mutation_barrier
            """)
        .param("id", taskId)
        .param("state", "CONTINUE".equals(intent) ? "WAITING_AGENT" : "PAUSED")
        .update();
  }

  public void rename(UUID id, String name) {
    jdbc.sql(
            "UPDATE connections SET display_name=:name,version=version+1,updated_at=now() WHERE"
                + " id=:id")
        .param("id", id)
        .param("name", name.trim())
        .update();
  }

  public void deleting(UUID id) {
    jdbc.sql(
            "UPDATE connections SET status='DELETING',version=version+1,updated_at=now() WHERE"
                + " id=:id")
        .param("id", id)
        .update();
  }

  public record Deletion(
      UUID operationId, UUID userId, UUID connectionId, int progress, Instant deadline) {}

  public Optional<UUID> deletionOperation(UUID id) {
    return jdbc.sql(
            "SELECT id FROM operations WHERE target_id=:id AND kind=:kind ORDER BY created_at DESC"
                + " LIMIT 1")
        .param("id", id)
        .param("kind", "connections.delete:" + id)
        .query(UUID.class)
        .optional();
  }

  public List<Deletion> dueDeletions() {
    return jdbc.sql(
            """
            SELECT o.id operation_id,o.user_id,o.target_id connection_id,o.progress,o.deadline
            FROM operations o JOIN connections c ON c.id=o.target_id AND c.user_id=o.user_id
            WHERE o.kind='connections.delete:'||c.id::text AND c.status='DELETING'
              AND o.state IN ('PENDING','RUNNING') AND o.next_attempt_at<=now() AND o.attempts<8
            ORDER BY o.next_attempt_at,o.id LIMIT 1
            """)
        .query(Deletion.class)
        .list();
  }

  public Optional<Deletion> claimDeletion(UUID operationId) {
    return jdbc.sql(
            """
            UPDATE operations SET state='RUNNING',next_attempt_at=now()+interval '30 seconds',
              deadline=CASE WHEN progress=0 THEN now()+interval '5 minutes' ELSE deadline END,
              version=version+1,updated_at=now()
            WHERE id=:id AND state IN ('PENDING','RUNNING') AND next_attempt_at<=now() AND attempts<8
            RETURNING id operation_id,user_id,target_id connection_id,progress,deadline
            """)
        .param("id", operationId)
        .query(Deletion.class)
        .optional();
  }

  public void prepareDeletion(UUID connectionId, UUID operationId) {
    jdbc.sql(
            """
            INSERT INTO operation_items(operation_id,item_key,target_id,phase)
            SELECT :operation,'task:'||id::text,id,'CONNECTION_REQUIRED' FROM (
              SELECT task_id id FROM task_connections WHERE connection_id=:connection
              UNION SELECT task_id id FROM browser_sessions WHERE connection_id=:connection AND task_id IS NOT NULL
            ) tasks ON CONFLICT DO NOTHING
            """)
        .param("operation", operationId)
        .param("connection", connectionId)
        .update();
    jdbc.sql("UPDATE operations SET progress=25 WHERE id=:id AND progress<25")
        .param("id", operationId)
        .update();
  }

  public List<UUID> deletionTasks(UUID operationId) {
    return jdbc.sql(
            """
            SELECT target_id FROM operation_items WHERE operation_id=:id
              AND phase='CONNECTION_REQUIRED' AND state='PENDING' ORDER BY item_key LIMIT 100
            """)
        .param("id", operationId)
        .query(UUID.class)
        .list();
  }

  public void taskDetached(UUID operationId, UUID taskId) {
    jdbc.sql(
            """
            UPDATE operation_items SET state='SUCCEEDED',version=version+1,updated_at=now()
            WHERE operation_id=:operation AND target_id=:task AND phase='CONNECTION_REQUIRED'
            """)
        .param("operation", operationId)
        .param("task", taskId)
        .update();
  }

  public List<UUID> activeSessions(UUID connectionId) {
    return jdbc.sql(
            """
            SELECT id FROM browser_sessions WHERE connection_id=:id AND binding_released_at IS NULL
              AND state<>'STOPPING'
                ORDER BY id LIMIT 100 FOR UPDATE
            """)
        .param("id", connectionId)
        .query(UUID.class)
        .list();
  }

  public boolean deletionRuntimeClosed(UUID connectionId) {
    return !jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE connection_id=:id AND binding_released_at IS NULL)
              OR EXISTS(SELECT 1 FROM browser_allocations WHERE connection_id=:id AND state<>'RELEASED')
            """)
        .param("id", connectionId)
        .query(Boolean.class)
        .single();
  }

  public void deferDeletion(Deletion deletion, String code, boolean failed) {
    jdbc.sql(
            """
            UPDATE operations SET attempts=attempts+CASE WHEN :failed THEN 1 ELSE 0 END,
              state=CASE WHEN deadline<=now() OR :failed AND attempts>=7 THEN 'NEEDS_ATTENTION' ELSE 'RUNNING' END,
              failure_code=:code,next_attempt_at=now()+interval '5 seconds',version=version+1,updated_at=now()
            WHERE id=:id AND state IN ('PENDING','RUNNING')
            """)
        .param("id", deletion.operationId())
        .param("failed", failed)
        .param("code", code)
        .update();
    deletionChanged(deletion);
  }

  public boolean resumeDeletion(UUID operationId) {
    var resumed =
        jdbc.sql(
                """
                UPDATE operations SET state='PENDING',attempts=0,next_attempt_at=now(),deadline=now()+interval '5 minutes',
                  failure_code=NULL,version=version+1,updated_at=now() WHERE id=:id AND state='NEEDS_ATTENTION'
                  RETURNING id operation_id,user_id,target_id connection_id,progress,deadline
                """)
            .param("id", operationId)
            .query(Deletion.class)
            .optional();
    resumed.ifPresent(this::deletionChanged);
    return resumed.isPresent();
  }

  public void deletionChanged(Deletion deletion) {
    long version =
        jdbc.sql("SELECT version FROM operations WHERE id=:id")
            .param("id", deletion.operationId())
            .query(Long.class)
            .single();
    changes.changed(deletion.userId(), "operations", deletion.operationId(), version);
  }

  public void deleted(UUID id) {
    jdbc.sql("DELETE FROM connection_origins WHERE connection_id=:id").param("id", id).update();
    jdbc.sql(
            "UPDATE task_connections SET selected=false,version=version+1 WHERE connection_id=:id"
                + " AND selected")
        .param("id", id)
        .update();
    jdbc.sql(
            "UPDATE connections SET"
                + " status='DELETED',account_label=NULL,version=version+1,updated_at=now() WHERE"
                + " id=:id AND status='DELETING'")
        .param("id", id)
        .update();
  }

  public PageResult<ConnectionContracts.ConnectionView> list(UUID userId, PageQuery query) {
    String snapshot = changes.snapshot(userId, "connections", query);
    String where =
        " WHERE c.user_id=:user AND c.status<>'DELETED' AND (display_name ILIKE :q OR origin ILIKE"
            + " :q)";
    String status = query.filters().getFirst("status");
    String excludedStatus = query.filters().getFirst("excludeStatus");
    if (status != null) {
      where += " AND status=:status";
    }
    if (excludedStatus != null) {
      if (!excludedStatus.equals("DELETING")
          || query.filters().getOrDefault("excludeStatus", List.of()).size() != 1) {
        throw new DomainException(
            400, "INVALID_CONNECTION_FILTER", "Only DELETING may be excluded");
      }
      where += " AND c.status<>:excludedStatus";
    }
    var parameters = new HashMap<String, Object>();
    parameters.put("user", userId);
    parameters.put("q", query.escapedQuery());
    if (status != null) {
      parameters.put("status", status);
    }
    if (excludedStatus != null) {
      parameters.put("excludedStatus", excludedStatus);
    }
    List<String> sites = query.filters().getOrDefault("siteId", List.of());
    if (sites.size() > 50) {
      throw new DomainException(400, "INVALID_SITE_FILTER", "At most 50 sites may be selected");
    }
    if (!sites.isEmpty()) {
      where += " AND c.site_id IN (:sites)";
      parameters.put("sites", sites.stream().map(UUID::fromString).distinct().toList());
    }
    long total =
        jdbc.sql("SELECT count(*) FROM connections c" + where)
            .params(parameters)
            .query(Long.class)
            .single();
    var rows =
        jdbc.sql(
                VIEW
                    + where
                    + " ORDER BY "
                    + query.sqlOrder(
                        Map.of(
                            "updatedAt",
                            "c.updated_at",
                            "displayName",
                            "c.display_name",
                            "accountLabel",
                            "c.account_label",
                            "lastSuccessfulLoginAt",
                            "c.last_successful_login_at",
                            "status",
                            "c.status"),
                        "c.updated_at DESC,c.id DESC")
                    + " LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(ConnectionContracts.ConnectionView.class)
            .list();
    return new PageResult<>(
        rows, total, query.page(), query.pageSize(), query.sortDescriptor(), snapshot);
  }

  public Optional<ConnectionContracts.ConnectionView> latest(UUID userId, String origin) {
    return jdbc.sql(
            """
            SELECT c.*,NULL::uuid current_task_id,NULL::uuid session_id,NULL::uuid login_operation_id
            FROM connections c JOIN connection_origins o ON o.connection_id=c.id
            WHERE c.user_id=:user AND o.origin=:origin AND o.role='APP' AND o.status='ACTIVE'
            AND c.status IN ('SAVED','AUTHENTICATED') ORDER BY c.last_used_at DESC NULLS LAST,
            c.last_successful_login_at DESC NULLS LAST,c.id LIMIT 1
            """)
        .param("user", userId)
        .param("origin", origin)
        .query(ConnectionContracts.ConnectionView.class)
        .optional();
  }

  public List<Map<String, Object>> suggestions(
      UUID userId, String scope, String query, int limit, List<UUID> excludedIds) {
    String exclusion = excludedIds.isEmpty() ? "" : " AND s.id NOT IN (:excluded)";
    var statement =
        jdbc.sql(
                """
                SELECT s.id,s.display_name AS "displayName",s.normalized_host host FROM sites s
                JOIN user_sites us ON us.site_id=s.id WHERE us.user_id=:user AND us.scope=:scope
                AND (s.normalized_host ILIKE :q OR s.display_name ILIKE :q)
                """
                    + exclusion
                    + " ORDER BY us.last_selected_at DESC,us.last_used_at DESC NULLS LAST,s.id"
                    + " LIMIT :limit")
            .param("user", userId)
            .param("scope", scope)
            .param("q", "%" + query.replace("%", "\\%").replace("_", "\\_") + "%")
            .param("limit", limit);
    if (!excludedIds.isEmpty()) {
      statement.param("excluded", excludedIds);
    }
    return statement.query().listOfRows();
  }

  public List<Map<String, Object>> selectedSites(
      UUID userId, String scope, List<UUID> selectedIds) {
    if (selectedIds.isEmpty()) {
      return List.of();
    }
    return jdbc.sql(
            """
            SELECT s.id,s.display_name AS "displayName",s.normalized_host host FROM sites s
            JOIN user_sites us ON us.site_id=s.id WHERE us.user_id=:user AND us.scope=:scope
            AND s.id IN (:selected) ORDER BY s.id
            """)
        .param("user", userId)
        .param("scope", scope)
        .param("selected", selectedIds)
        .query()
        .listOfRows();
  }
}
