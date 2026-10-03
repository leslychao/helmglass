package com.helmglass.task.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class TaskContextRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public TaskContextRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public record Header(UUID id, long instructionRevision, String goal) {}

  public Header header(UUID userId, UUID taskId) {
    return jdbc.sql("SELECT id,instruction_revision,goal FROM tasks WHERE id=:id AND user_id=:user")
        .param("id", taskId).param("user", userId).query(Header.class).optional().orElseThrow(DomainException::notFound);
  }

  public List<Map<String, Object>> page(UUID taskId, String section, long cursor, int limit) {
    String sql = switch (section) {
      case "INSTRUCTIONS" -> "SELECT revision AS cursor,id,revision,text,disposition,accepted_at AS \"acceptedAt\" FROM task_clarifications WHERE task_id=:id AND revision>:cursor ORDER BY revision LIMIT :limit";
      case "HISTORY" -> "SELECT sequence AS cursor,event_id AS id,sequence,type,code,summary,occurred_at AS \"occurredAt\" FROM task_execution_events WHERE task_id=:id AND sequence>:cursor ORDER BY sequence LIMIT :limit";
      case "RESULTS" -> "SELECT revision AS cursor,id,revision,final,conclusion,limitations::text,missing::text,coverage::text,created_at AS \"createdAt\" FROM task_results WHERE task_id=:id AND revision>:cursor ORDER BY revision LIMIT :limit";
      case "OPERATIONS" -> "SELECT n AS cursor,id,kind,state,version,progress,failure_code AS \"failureCode\" FROM (SELECT row_number() OVER(ORDER BY created_at,id) n,* FROM operations WHERE target_id=:id) o WHERE n>:cursor ORDER BY n LIMIT :limit";
      default -> throw new DomainException(422, "INVALID_CONTEXT_SECTION", "Context section is invalid");
    };
    var rows = jdbc.sql(sql).param("id", taskId).param("cursor", cursor).param("limit", limit).query().listOfRows();
    if (section.equals("RESULTS")) {
      for (var row : rows) {
        for (String field : List.of("limitations", "missing", "coverage")) {
          row.put(field, json.read((String) row.get(field)));
        }
      }
    }
    return rows;
  }
}
