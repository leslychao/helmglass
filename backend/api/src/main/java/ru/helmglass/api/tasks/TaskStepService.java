package ru.helmglass.api.tasks;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.events.EventService;
import tools.jackson.databind.JsonNode;

/** Owns durable business progress; a successful browser command is not a business outcome. */
@Service
public class TaskStepService {
  private static final Set<String> ACTIVE = Set.of("RUNNING", "WAITING", "UNKNOWN");
  private static final Set<String> FINAL = Set.of("SUCCEEDED", "PARTIAL", "FAILED", "SKIPPED");
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final EventService events;
  private final Identity identity;

  public TaskStepService(JdbcClient jdbc, JsonSupport json, EventService events, Identity identity) {
    this.jdbc = jdbc;
    this.json = json;
    this.events = events;
    this.identity = identity;
  }

  public Contracts.Page<Contracts.TaskStep> list(
      UUID owner, UUID task, MultiValueMap<String, String> values) {
    requireTask(owner, task);
    ListQuery query = ListQuery.from(values);
    String where = "owner_id=:owner AND task_id=:task";
    Map<String, Object> parameters = new HashMap<>(Map.of("owner", owner, "task", task));
    if (query.search() != null && !query.search().isBlank()) {
      where += " AND (title ILIKE :search OR result ILIKE :search)";
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

  @Transactional
  public Contracts.TaskStep command(UUID owner, UUID task, Contracts.StepCommand command) {
    identity.requireActive(owner);
    jdbc.sql("SELECT id FROM accounts WHERE id=:owner FOR UPDATE")
        .param("owner", owner).query(UUID.class).single();
    TaskState state = jdbc.sql("SELECT status,instruction_revision FROM tasks"
            + " WHERE id=:task AND owner_id=:owner FOR UPDATE")
        .param("task", task).param("owner", owner)
        .query((row, index) -> new TaskState(row.getString("status"),
            row.getLong("instruction_revision"))).optional().orElseThrow(ApiException::notFound);
    if (command.instructionRevision() != state.revision()) {
      throw ApiException.conflict("STALE_INSTRUCTION", "Поручение изменилось.");
    }
    if (TaskService.TERMINAL.contains(state.status())
        || Set.of("DRAFT", "STOPPING", "PAUSED", "PAUSING").contains(state.status())) {
      throw ApiException.conflict("TASK_NOT_RUNNING", "Задача не разрешает изменение шагов.");
    }
    if ("DECLARE".equals(command.type())) {
      return declare(owner, task, command);
    }
    Contracts.TaskStep step = get(owner, task, command.stepId());
    if (command.expectedVersion() == null || command.expectedVersion() != step.version()) {
      throw ApiException.conflict("STALE_STEP", "Шаг изменился. Прочитайте актуальное состояние.");
    }
    String status;
    String result = command.result();
    JsonNode evidence = step.evidence();
    switch (command.type() == null ? "" : command.type()) {
      case "START", "RETRY" -> {
        boolean retry = "RETRY".equals(command.type());
        if (!(retry ? Set.of("FAILED", "PARTIAL", "SKIPPED")
            : Set.of("PLANNED", "WAITING")).contains(step.status())
            || "WAITING_USER".equals(state.status())) {
          throw unavailable();
        }
        requireNoPending(task, step.id());
        requireNoActive(task, step.id());
        status = "RUNNING";
        result = null;
        evidence = json.tree(List.of());
      }
      case "WAIT" -> {
        if (!Set.of("RUNNING", "WAITING").contains(step.status())) {
          throw unavailable();
        }
        status = "WAITING";
        result = TaskService.required(result, "result", 4000);
      }
      case "COMPLETE" -> {
        if (!Set.of("RUNNING", "WAITING").contains(step.status())
            || !Set.of("SUCCEEDED", "PARTIAL", "FAILED")
                .contains(command.outcome() == null ? "" : command.outcome())) {
          throw unavailable();
        }
        requireNoPending(task, step.id());
        status = command.outcome();
        result = TaskService.required(result, "result", 4000);
        evidence = evidence(owner, task, command.evidence(), !"FAILED".equals(status));
      }
      case "SKIP" -> {
        if (!Set.of("PLANNED", "FAILED", "PARTIAL").contains(step.status())) {
          throw unavailable();
        }
        requireNoPending(task, step.id());
        status = "SKIPPED";
        result = TaskService.required(result, "result", 4000);
      }
      default -> throw ApiException.invalid("type", "Неизвестная команда шага.");
    }
    return transition(step, status, result, evidence, command.type());
  }

  private Contracts.TaskStep declare(UUID owner, UUID task, Contracts.StepCommand command) {
    String operation = TaskService.required(command.operationKey(), "operationKey", 128);
    String object = TaskService.required(command.objectKey(), "objectKey", 500);
    String title = TaskService.required(command.title(), "title", 300);
    String criterion = TaskService.required(command.completionCriterion(), "completionCriterion", 2000);
    var previous = jdbc.sql("SELECT * FROM task_steps WHERE task_id=:task"
            + " AND operation_key=:operation AND object_key=:object")
        .param("task", task).param("operation", operation).param("object", object)
        .query(this::map).optional();
    if (previous.isPresent()) {
      Contracts.TaskStep step = previous.get();
      if (!step.title().equals(title) || !step.completionCriterion().equals(criterion)) {
        throw ApiException.conflict("STEP_IDENTITY_CONFLICT",
            "Эта операция над объектом уже зарегистрирована с другим описанием.");
      }
      return step;
    }
    UUID id = UUID.randomUUID();
    jdbc.sql("""
        INSERT INTO task_steps(id,task_id,owner_id,operation_key,object_key,sequence,
          title,completion_criterion,status)
        VALUES (:id,:task,:owner,:operation,:object,
          (SELECT coalesce(max(sequence),0)+1 FROM task_steps WHERE task_id=:task),
          :title,:criterion,'PLANNED')
        """)
        .param("id", id).param("task", task).param("owner", owner)
        .param("operation", operation).param("object", object)
        .param("title", title).param("criterion", criterion).update();
    Contracts.TaskStep step = get(owner, task, id);
    record(step, null, "DECLARE");
    return step;
  }

  /** Called in the action transaction before accepting a new command. */
  public void requireRunning(UUID owner, UUID task, UUID id) {
    if (id == null) {
      throw ApiException.invalid("stepId", "Сначала объявите и начните бизнес-шаг.");
    }
    Contracts.TaskStep step = get(owner, task, id);
    // Read-only verification of an unknown external effect belongs to the same step.
    if (!Set.of("RUNNING", "UNKNOWN").contains(step.status())) {
      throw ApiException.conflict("STEP_NOT_RUNNING", "Сначала начните соответствующий бизнес-шаг.");
    }
  }

  public void requireSettled(UUID owner, UUID task, String outcome) {
    boolean open = jdbc.sql("SELECT EXISTS(SELECT 1 FROM task_steps WHERE task_id=:task"
            + " AND owner_id=:owner AND status IN ('PLANNED','RUNNING','WAITING','UNKNOWN'))")
        .param("task", task).param("owner", owner).query(Boolean.class).single();
    if (open) {
      throw ApiException.conflict("STEPS_UNFINISHED",
          "Зафиксируйте результаты начатых шагов и причины пропуска остальных.");
    }
    if ("SUCCEEDED".equals(outcome) && jdbc.sql("SELECT EXISTS(SELECT 1 FROM task_steps"
            + " WHERE task_id=:task AND status IN ('FAILED','PARTIAL'))")
        .param("task", task).query(Boolean.class).single()) {
      throw ApiException.conflict("STEP_OUTCOME_CONFLICT",
          "Полный результат не согласован с исходами бизнес-шагов.");
    }
  }

  /** Mirrors task suspension/termination without changing the browser or task lifecycle. */
  public void taskState(UUID owner, UUID task, String status, String description) {
    var active = jdbc.sql("SELECT * FROM task_steps WHERE task_id=:task AND owner_id=:owner"
            + " AND status IN ('RUNNING','WAITING','UNKNOWN')")
        .param("task", task).param("owner", owner).query(this::map).optional();
    if (active.isPresent()) {
      Contracts.TaskStep step = active.get();
      boolean unknown = hasUnknown(task, step.id());
      if (unknown) {
        transition(step, "UNKNOWN", "Не удалось подтвердить результат. Требуется проверка.",
            step.evidence(), "EXTERNAL_RESULT_UNKNOWN");
      } else if (TaskService.TERMINAL.contains(status)) {
        transition(step, "FAILED", "Выполнение шага прервано: " + description,
            step.evidence(), "TASK_FINISHED");
      } else if (Set.of("WAITING_USER", "PAUSED", "PAUSING", "STOPPING").contains(status)) {
        transition(step, "WAITING", description, step.evidence(), "TASK_WAITING");
      } else if (Set.of("WAITING_CHATGPT", "RUNNING", "STARTING").contains(status)
          && Set.of("UNKNOWN", "WAITING").contains(step.status())) {
        transition(step, "RUNNING", null, step.evidence(), "EXTERNAL_RESULT_RESOLVED");
      }
    }
    if (TaskService.TERMINAL.contains(status)) {
      // Read in bounded batches: a task may contain arbitrarily many object-level steps.
      List<Contracts.TaskStep> planned;
      do {
        planned = jdbc.sql("SELECT * FROM task_steps WHERE task_id=:task AND owner_id=:owner"
                + " AND status='PLANNED' ORDER BY sequence LIMIT 100")
            .param("task", task).param("owner", owner).query(this::map).list();
        for (Contracts.TaskStep step : planned) {
          transition(step, "SKIPPED", "Шаг не выполнялся: задача завершена.",
              step.evidence(), "TASK_FINISHED");
        }
      } while (planned.size() == 100);
    }
  }

  public void operationUnknown(UUID owner, UUID task, UUID operation) {
    var step = jdbc.sql("SELECT s.* FROM task_steps s JOIN operations o ON o.step_id=s.id"
            + " WHERE o.id=:operation AND s.task_id=:task AND s.owner_id=:owner")
        .param("operation", operation).param("task", task).param("owner", owner)
        .query(this::map).optional();
    step.ifPresent(value -> transition(value, "UNKNOWN",
        "Не удалось подтвердить результат. Требуется проверка.", value.evidence(),
        "EXTERNAL_RESULT_UNKNOWN"));
  }

  private void requireNoActive(UUID task, UUID id) {
    if (jdbc.sql("SELECT EXISTS(SELECT 1 FROM task_steps WHERE task_id=:task AND id<>:id"
            + " AND status IN ('RUNNING','WAITING','UNKNOWN'))")
        .param("task", task).param("id", id).query(Boolean.class).single()) {
      throw ApiException.conflict("STEP_IN_PROGRESS", "Сначала завершите текущий бизнес-шаг.");
    }
  }

  private void requireNoPending(UUID task, UUID step) {
    if (jdbc.sql("SELECT EXISTS(SELECT 1 FROM operations WHERE task_id=:task AND step_id=:step"
            + " AND status IN ('ACCEPTED','AWAITING_CONFIRMATION','DISPATCHED','UNKNOWN'))")
        .param("task", task).param("step", step).query(Boolean.class).single()) {
      throw ApiException.conflict("STEP_OPERATION_PENDING", "Сначала установите результат действия.");
    }
  }

  private boolean hasUnknown(UUID task, UUID step) {
    return jdbc.sql("SELECT EXISTS(SELECT 1 FROM operations WHERE task_id=:task"
            + " AND step_id=:step AND status='UNKNOWN')")
        .param("task", task).param("step", step).query(Boolean.class).single();
  }

  private JsonNode evidence(UUID owner, UUID task, List<Contracts.StepEvidence> evidence,
      boolean required) {
    List<Contracts.StepEvidence> items = evidence == null ? List.of() : evidence;
    if (items.size() > 20 || required && items.isEmpty()) {
      throw ApiException.invalid("evidence", "Нужны подтверждения результата, не более 20.");
    }
    for (Contracts.StepEvidence item : items) {
      if (item == null || item.type() == null) {
        throw ApiException.invalid("evidence", "Укажите вид подтверждения.");
      }
      boolean valid;
      switch (item.type()) {
        case "OPERATION" -> valid = item.operationId() != null && item.artifactId() == null
            && item.text() == null && item.sources() == null
            && jdbc.sql("SELECT EXISTS(SELECT 1 FROM operations WHERE id=:id AND task_id=:task"
                    + " AND owner_id=:owner AND status='SUCCEEDED')")
                .param("id", item.operationId()).param("task", task).param("owner", owner)
                .query(Boolean.class).single();
        case "ARTIFACT" -> valid = item.artifactId() != null && item.operationId() == null
            && item.text() == null && item.sources() == null
            && jdbc.sql("SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=:id AND task_id=:task"
                    + " AND owner_id=:owner AND status='READY' AND complete)")
                .param("id", item.artifactId()).param("task", task).param("owner", owner)
                .query(Boolean.class).single();
        case "MODEL_RESULT" -> {
          valid = item.operationId() == null && item.artifactId() == null
              && item.sources() != null && !item.sources().isEmpty() && item.sources().size() <= 10;
          TaskService.required(item.text(), "evidence.text", 4000);
          if (valid) {
            for (Contracts.StepSource source : item.sources()) {
              if (source == null) {
                throw ApiException.invalid("evidence.sources", "Укажите источник результата.");
              }
              TaskService.required(source.title(), "source.title", 300);
              TaskService.site(TaskService.required(source.url(), "source.url", 4096));
            }
          }
        }
        default -> valid = false;
      }
      if (!valid) {
        throw ApiException.invalid("evidence", "Подтверждение недоступно или не готово.");
      }
    }
    JsonNode result = json.tree(items);
    if (json.write(result).length() > 65536) {
      throw ApiException.invalid("evidence", "Подтверждения превышают допустимый размер.");
    }
    return result;
  }

  private Contracts.TaskStep transition(Contracts.TaskStep step, String status, String result,
      JsonNode evidence, String reason) {
    if (result != null && result.length() > 4000) {
      result = result.substring(0, 3999) + "…";
    }
    if (step.status().equals(status) && Objects.equals(step.result(), result)
        && step.evidence().equals(evidence)) {
      return step;
    }
    int changed = jdbc.sql("""
        UPDATE task_steps SET status=:status,result=:result,evidence=CAST(:evidence AS jsonb),
          version=version+1,updated_at=now(),
          started_at=CASE WHEN :started THEN coalesce(started_at,now()) ELSE started_at END,
          completed_at=CASE WHEN :finished THEN now() ELSE NULL END
        WHERE id=:id AND version=:version
        """)
        .param("status", status).param("result", result).param("evidence", json.write(evidence))
        .param("started", ACTIVE.contains(status)).param("finished", FINAL.contains(status))
        .param("id", step.id()).param("version", step.version()).update();
    if (changed != 1) {
      throw ApiException.conflict("STALE_STEP", "Шаг изменился.");
    }
    UUID owner = jdbc.sql("SELECT owner_id FROM task_steps WHERE id=:id")
        .param("id", step.id()).query(UUID.class).single();
    Contracts.TaskStep updated = get(owner, step.taskId(), step.id());
    record(updated, step.status(), reason);
    return updated;
  }

  private void record(Contracts.TaskStep step, String previous, String reason) {
    Map<String, Object> change = new HashMap<>();
    change.put("previousStatus", previous);
    change.put("reason", reason);
    change.put("step", step);
    UUID owner = jdbc.sql("SELECT owner_id FROM tasks WHERE id=:task")
        .param("task", step.taskId()).query(UUID.class).single();
    jdbc.sql("""
        INSERT INTO task_history(id,task_id,owner_id,sequence,type,title,step_id,step_change)
        VALUES (:id,:task,:owner,
          (SELECT coalesce(max(sequence),0)+1 FROM task_history WHERE task_id=:task),
          'BUSINESS_STEP',:title,:step,CAST(:change AS jsonb))
        """)
        .param("id", UUID.randomUUID()).param("task", step.taskId()).param("owner", owner)
        .param("title", step.title()).param("step", step.id())
        .param("change", json.write(change)).update();
    long version = jdbc.sql("UPDATE tasks SET version=version+1,updated_at=now()"
            + " WHERE id=:task RETURNING version")
        .param("task", step.taskId()).query(Long.class).single();
    events.emit(owner, "step", step.taskId(), version);
    events.emit(owner, "task", step.taskId(), version);
  }

  private void requireTask(UUID owner, UUID task) {
    if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=:task AND owner_id=:owner)")
        .param("task", task).param("owner", owner).query(Boolean.class).single()) {
      throw ApiException.notFound();
    }
  }

  private Contracts.TaskStep get(UUID owner, UUID task, UUID id) {
    if (id == null) {
      throw ApiException.invalid("stepId", "Укажите бизнес-шаг.");
    }
    return jdbc.sql("SELECT * FROM task_steps WHERE id=:id AND task_id=:task AND owner_id=:owner")
        .param("id", id).param("task", task).param("owner", owner)
        .query(this::map).optional().orElseThrow(ApiException::notFound);
  }

  private Contracts.TaskStep map(ResultSet row, int index) throws SQLException {
    return new Contracts.TaskStep(row.getObject("id", UUID.class),
        row.getObject("task_id", UUID.class), row.getLong("sequence"),
        row.getString("operation_key"), row.getString("object_key"), row.getString("title"),
        row.getString("completion_criterion"), row.getString("status"), row.getLong("version"),
        row.getString("result"), json.read(row.getString("evidence")),
        Database.instant(row, "created_at"), Database.instant(row, "updated_at"),
        Database.instant(row, "started_at"), Database.instant(row, "completed_at"));
  }

  private static ApiException unavailable() {
    return ApiException.conflict("STEP_TRANSITION_UNAVAILABLE", "Недопустимый переход шага.");
  }

  private record TaskState(String status, long revision) {}
}
