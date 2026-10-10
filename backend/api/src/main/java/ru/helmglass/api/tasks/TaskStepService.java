package ru.helmglass.api.tasks;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;
import ru.helmglass.api.Idempotency;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.events.EventService;
import tools.jackson.databind.JsonNode;

/** Owns the durable record of agent tool invocations within a task. */
@Service
public class TaskStepService {
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final EventService events;
  private final Identity identity;
  private final Idempotency idempotency;

  public TaskStepService(JdbcClient jdbc, JsonSupport json, EventService events,
      Identity identity, Idempotency idempotency) {
    this.jdbc = jdbc;
    this.json = json;
    this.events = events;
    this.identity = identity;
    this.idempotency = idempotency;
  }

  public Contracts.Page<Contracts.TaskStep> list(
      UUID owner, UUID task, MultiValueMap<String, String> values) {
    requireTask(owner, task);
    ListQuery query = ListQuery.from(values);
    String where = "owner_id=:owner AND task_id=:task";
    Map<String, Object> parameters = new HashMap<>(Map.of("owner", owner, "task", task));
    if (query.search() != null && !query.search().isBlank()) {
      where += " AND (title ILIKE :search OR tool_name ILIKE :search OR result ILIKE :search)";
      parameters.put("search", "%" + query.search() + "%");
    }
    String before = values.getFirst("beforeSequence");
    if (before != null) {
      long sequence;
      try {
        sequence = Long.parseLong(before);
      } catch (NumberFormatException exception) {
        throw ApiException.invalid("beforeSequence", "Некорректная граница страницы.");
      }
      if (sequence < 1) {
        throw ApiException.invalid("beforeSequence", "Некорректная граница страницы.");
      }
      where += " AND sequence<=:before";
      parameters.put("before", sequence);
    }
    long total = jdbc.sql("SELECT count(*) FROM task_steps WHERE " + where)
        .params(parameters).query(Long.class).single();
    List<Contracts.TaskStep> items = jdbc.sql("SELECT * FROM task_steps WHERE " + where
            + " ORDER BY sequence DESC LIMIT 10 OFFSET :offset")
        .params(parameters).param("offset", (long) (query.page() - 1) * 10)
        .query(this::map).list();
    return new Contracts.Page<>(items, total, query.page(), 10);
  }

  /** Resolves resources through their owner's access boundary, without storing their contents. */
  public UUID taskForCall(UUID owner, JsonNode input) {
    if (input.has("taskId")) {
      UUID task = UUID.fromString(input.path("taskId").asString());
      requireTask(owner, task);
      return task;
    }
    if (input.has("operationId")) {
      return jdbc.sql("SELECT task_id FROM operations WHERE id=:id AND owner_id=:owner")
          .param("id", UUID.fromString(input.path("operationId").asString()))
          .param("owner", owner).query(UUID.class).optional().orElseThrow(ApiException::notFound);
    }
    if (input.has("artifactId")) {
      return jdbc.sql("SELECT task_id FROM artifacts WHERE id=:id AND owner_id=:owner")
          .param("id", UUID.fromString(input.path("artifactId").asString()))
          .param("owner", owner).query(UUID.class).optional().orElseThrow(ApiException::notFound);
    }
    if (input.has("analysisId")) {
      return jdbc.sql("SELECT f.task_id FROM audio_analyses a JOIN artifacts f ON f.id=a.artifact_id"
              + " WHERE a.id=:id AND a.owner_id=:owner AND f.owner_id=:owner")
          .param("id", UUID.fromString(input.path("analysisId").asString()))
          .param("owner", owner).query(UUID.class).optional().orElseThrow(ApiException::notFound);
    }
    return null;
  }

  @Transactional
  public void begin(UUID owner, UUID task, UUID call, String tool, String title, Object request) {
    identity.requireActive(owner);
    jdbc.sql("SELECT id FROM accounts WHERE id=:owner FOR UPDATE")
        .param("owner", owner).query(UUID.class).single();
    jdbc.sql("SELECT id FROM tasks WHERE id=:task AND owner_id=:owner FOR UPDATE")
        .param("task", task).param("owner", owner).query(UUID.class)
        .optional().orElseThrow(ApiException::notFound);
    String hash = idempotency.requestHash(request);
    var existing = jdbc.sql("SELECT owner_id=:owner AND task_id=:task AND tool_name=:tool"
            + " AND request_hash=:hash FROM task_steps WHERE id=:id")
        .param("owner", owner).param("task", task).param("tool", tool).param("hash", hash)
        .param("id", call).query(Boolean.class).optional();
    if (existing.isPresent()) {
      if (!existing.get()) {
        throw ApiException.conflict("IDEMPOTENCY_CONFLICT", "callId уже использован другим вызовом.");
      }
      return;
    }
    jdbc.sql("""
        INSERT INTO task_steps(id,task_id,owner_id,sequence,tool_name,title,request_hash,status)
        VALUES (:id,:task,:owner,
          (SELECT coalesce(max(sequence),0)+1 FROM task_steps WHERE task_id=:task),
          :tool,:title,:hash,'RUNNING')
        """)
        .param("id", call).param("task", task).param("owner", owner)
        .param("tool", tool).param("title", title).param("hash", hash).update();
    record(owner, call);
  }

  public void requireBrowserCall(UUID owner, UUID task, UUID call) {
    if (call == null || !jdbc.sql("SELECT EXISTS(SELECT 1 FROM task_steps WHERE id=:id"
            + " AND task_id=:task AND owner_id=:owner AND tool_name='browser.execute')")
        .param("id", call).param("task", task).param("owner", owner).query(Boolean.class).single()) {
      throw ApiException.invalid("callId", "Вызов браузера не зарегистрирован.");
    }
  }

  @Transactional
  public void finish(UUID owner, UUID call, boolean failed, long durationMs) {
    jdbc.sql("SELECT id FROM accounts WHERE id=:owner FOR UPDATE")
        .param("owner", owner).query(UUID.class).single();
    int changed = jdbc.sql("""
        UPDATE task_steps SET status=:status,result=:result,duration_ms=:duration,
          version=version+1,updated_at=now(),completed_at=now()
        WHERE id=:id AND owner_id=:owner AND status='RUNNING'
        """)
        .param("status", failed ? "FAILED" : "SUCCEEDED")
        .param("result", failed ? "Инструмент отклонил запрос." : null)
        .param("duration", durationMs).param("id", call).param("owner", owner).update();
    if (changed == 1) {
      record(owner, call);
    }
  }

  private void record(UUID owner, UUID call) {
    Contracts.TaskStep step = jdbc.sql("SELECT * FROM task_steps WHERE id=:id AND owner_id=:owner")
        .param("id", call).param("owner", owner).query(this::map).single();
    jdbc.sql("""
        INSERT INTO task_history(id,task_id,owner_id,sequence,type,title,step_id,step_change)
        VALUES (:id,:task,:owner,
          (SELECT coalesce(max(sequence),0)+1 FROM task_history WHERE task_id=:task),
          'AGENT_STEP',:title,:step,CAST(:change AS jsonb))
        """)
        .param("id", UUID.randomUUID()).param("task", step.taskId()).param("owner", owner)
        .param("title", step.title()).param("step", call)
        .param("change", json.write(Map.of("step", step))).update();
    // Tool accounting does not change the task's command version.
    long version = jdbc.sql("SELECT version FROM tasks WHERE id=:id")
        .param("id", step.taskId()).query(Long.class).single();
    events.emit(owner, "step", step.taskId(), step.version());
    events.emit(owner, "task", step.taskId(), version);
  }

  private void requireTask(UUID owner, UUID task) {
    if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=:task AND owner_id=:owner)")
        .param("task", task).param("owner", owner).query(Boolean.class).single()) {
      throw ApiException.notFound();
    }
  }

  private Contracts.TaskStep map(ResultSet row, int index) throws SQLException {
    return new Contracts.TaskStep(row.getObject("id", UUID.class),
        row.getObject("task_id", UUID.class), row.getLong("sequence"),
        row.getString("tool_name"), row.getString("title"), row.getString("status"),
        row.getLong("version"), row.getString("result"),
        row.getObject("duration_ms", Long.class), Database.instant(row, "created_at"),
        Database.instant(row, "updated_at"), Database.instant(row, "started_at"),
        Database.instant(row, "completed_at"));
  }
}
