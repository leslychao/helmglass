package com.helmglass.connection.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ConnectionResolutionRepository {
  private static final String CANDIDATE = """
      SELECT c.id,c.site_id,c.display_name,c.account_label,c.start_url,c.scope_version,c.status,
      c.last_used_at,p.current_version_id profile_version_id,
      EXISTS(SELECT 1 FROM browser_allocations a JOIN browser_sessions bs ON bs.id=a.session_id
        WHERE a.connection_id=c.id AND a.state IN ('RESERVED','ASSIGNED','RELEASING','QUARANTINED')
        AND bs.task_id IS DISTINCT FROM :task) busy
      FROM connections c JOIN connection_origins o ON o.connection_id=c.id
      LEFT JOIN browser_profiles p ON p.connection_id=c.id AND p.state='ACTIVE'
      WHERE c.user_id=:user AND o.origin=:origin AND o.role='APP' AND o.status='ACTIVE'
      """;
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public ConnectionResolutionRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public record TaskScope(UUID id, long version, long instructionRevision, String state,
      boolean mutationBarrier, String connectionMode) {}

  public record Candidate(UUID id, UUID siteId, String displayName, String accountLabel,
      String startUrl, long scopeVersion, String status, Instant lastUsedAt,
      UUID profileVersionId, boolean busy) {}

  public TaskScope lockTask(UUID userId, UUID taskId) {
    return jdbc.sql("""
        SELECT t.id,t.version,t.instruction_revision,t.state,t.mutation_barrier,p.connection_mode
        FROM tasks t JOIN user_policies p ON p.user_id=t.user_id
        WHERE t.id=:task AND t.user_id=:user FOR UPDATE OF t,p
        """).param("task", taskId).param("user", userId).query(TaskScope.class).optional()
        .orElseThrow(DomainException::notFound);
  }

  public Optional<Candidate> current(UUID userId, UUID taskId, String origin) {
    return jdbc.sql(CANDIDATE + """
        AND EXISTS(SELECT 1 FROM browser_sessions s WHERE s.task_id=:task
        AND s.connection_id=c.id AND s.binding_released_at IS NULL)
        """).param("user", userId).param("task", taskId).param("origin", origin)
        .query(Candidate.class).optional();
  }

  public Optional<Candidate> preferred(UUID userId, UUID taskId, String origin) {
    return jdbc.sql(CANDIDATE + """
        AND EXISTS(SELECT 1 FROM task_connections tc WHERE tc.task_id=:task AND tc.connection_id=c.id)
        ORDER BY (SELECT selected FROM task_connections WHERE task_id=:task AND connection_id=c.id) DESC,
        (SELECT preference_rank FROM task_connections WHERE task_id=:task AND connection_id=c.id) ASC NULLS LAST
        LIMIT 1
        """).param("user", userId).param("task", taskId).param("origin", origin)
        .query(Candidate.class).optional();
  }

  public List<Candidate> automatic(UUID userId, UUID taskId, String origin) {
    return jdbc.sql(CANDIDATE + """
        AND c.status NOT IN ('DELETING','DELETED')
        ORDER BY c.last_used_at DESC NULLS LAST LIMIT 101
        """).param("user", userId).param("task", taskId).param("origin", origin)
        .query(Candidate.class).list();
  }

  public Candidate lockCandidate(UUID userId, UUID taskId, String origin, UUID connectionId) {
    return jdbc.sql(CANDIDATE + " AND c.id=:id FOR UPDATE OF c")
        .param("user", userId).param("task", taskId).param("origin", origin)
        .param("id", connectionId).query(Candidate.class).optional()
        .orElseThrow(DomainException::notFound);
  }

  public void select(UUID userId, UUID taskId, Candidate candidate, String reason) {
    jdbc.sql("""
        UPDATE task_connections SET selected=false,version=version+1
        WHERE task_id=:task AND site_id=:site AND selected AND connection_id<>:connection
        """).param("task", taskId).param("site", candidate.siteId())
        .param("connection", candidate.id()).update();
    int changed = jdbc.sql("""
        INSERT INTO task_connections(task_id,connection_id,user_id,site_id,selected,selection_reason,selected_at)
        VALUES(:task,:connection,:user,:site,true,:reason,now())
        ON CONFLICT(task_id,connection_id) DO UPDATE SET selected=true,selection_reason=:reason,
        selected_at=now(),version=task_connections.version+1
        WHERE NOT task_connections.selected
        """).param("task", taskId).param("connection", candidate.id()).param("user", userId)
        .param("site", candidate.siteId()).param("reason", reason).update();
    if (changed > 0) {
      jdbc.sql("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=:task")
          .param("task", taskId).update();
    }
  }

  public UUID request(UUID taskId, UUID connectionId, String kind, String prompt,
      String intentHash, Map<String, Object> context) {
    Optional<UUID> current = jdbc.sql("""
        SELECT id FROM user_action_requests WHERE task_id=:task AND status='OPEN'
        AND intent_hash=:hash AND expires_at>now()
        """).param("task", taskId).param("hash", intentHash).query(UUID.class).optional();
    if (current.isPresent()) {
      return current.get();
    }
    if (jdbc.sql("SELECT EXISTS(SELECT 1 FROM user_action_requests WHERE task_id=:task AND status='OPEN' AND expires_at>now())")
        .param("task", taskId).query(Boolean.class).single()) {
      throw DomainException.conflict("USER_REQUEST_PENDING", "Answer the existing request first");
    }
    UUID id = UUID.randomUUID();
    jdbc.sql("""
        INSERT INTO user_action_requests(id,task_id,connection_id,kind,intent_hash,prompt,context,expires_at)
        VALUES(:id,:task,:connection,:kind,:hash,:prompt,CAST(:context AS jsonb),now()+interval '30 minutes')
        """).param("id", id).param("task", taskId).param("connection", connectionId)
        .param("kind", kind).param("hash", intentHash).param("prompt", prompt)
        .param("context", json.write(context)).update();
    jdbc.sql("""
        UPDATE tasks SET state='WAITING_USER',wait_reason=:reason,version=version+1,updated_at=now()
        WHERE id=:task
        """).param("task", taskId).param("reason", context.get("purpose")).update();
    return id;
  }

  public void saveResult(UUID operationId, Map<String, Object> resolution) {
    jdbc.sql("UPDATE operations SET evidence=CAST(:result AS jsonb) WHERE id=:id")
        .param("id", operationId).param("result", json.write(resolution)).update();
  }

  public Map<String, Object> result(UUID operationId) {
    return json.map(jdbc.sql("SELECT evidence::text FROM operations WHERE id=:id")
        .param("id", operationId).query(String.class).single());
  }
}
