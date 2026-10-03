package com.helmglass.task.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.api.ResultContracts;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ResultRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final ChangeRepository changes;

  public ResultRepository(JdbcClient jdbc, JsonSupport json, ChangeRepository changes) {
    this.jdbc = jdbc;
    this.json = json;
    this.changes = changes;
  }

  public record Published(UUID id, long revision) {}

  public Published insert(UUID taskId, ResultContracts.Publish input) {
    UUID id = UUID.randomUUID();
    long revision = jdbc.sql(
        "SELECT coalesce(max(revision),0)+1 FROM task_results WHERE task_id=:id")
        .param("id", taskId).query(Long.class).single();
    jdbc.sql("""
        INSERT INTO task_results(id,task_id,revision,conclusion,limitations,missing,columns,
          coverage,sections,sources,artifact_ids)
        VALUES(:id,:task,:revision,:conclusion,CAST(:limitations AS jsonb),CAST(:missing AS jsonb),
        CAST(:columns AS jsonb),CAST(:coverage AS jsonb),CAST(:sections AS jsonb),
        CAST(:sources AS jsonb),
        ARRAY(SELECT jsonb_array_elements_text(CAST(:artifacts AS jsonb))::uuid))
        """).param("id", id).param("task", taskId).param("revision", revision)
        .param("conclusion", input.conclusion())
        .param("limitations", json.write(input.limitations()))
        .param("missing", json.write(input.missing())).param("columns", json.write(input.columns()))
        .param("coverage", json.write(input.coverage()))
        .param("sections", json.write(input.sections()))
        .param("sources", json.write(input.sources()))
        .param("artifacts", json.write(input.artifactIds())).update();
    int order = 0;
    for (Map<String, Object> row : input.rows()) {
      String data = json.write(row);
      jdbc.sql("""
          INSERT INTO task_result_rows(result_id,row_id,row_order,data,search_text)
          VALUES(:result,:id,:order,CAST(:data AS jsonb),:search)
          """).param("result", id).param("id", UUID.randomUUID()).param("order", order++)
          .param("data", data).param("search", data).update();
    }
    for (UUID artifactId : input.artifactIds()) {
      int changed = jdbc.sql("""
          UPDATE task_artifacts SET result_id=coalesce(result_id,:result),version=version+1
          WHERE id=:artifact AND task_id=:task AND state='READY'
          """).param("result", id).param("artifact", artifactId).param("task", taskId).update();
      if (changed != 1) {
        throw DomainException.conflict("ARTIFACT_NOT_READY", "Result artifact is not ready");
      }
    }
    return new Published(id, revision);
  }

  public Map<String, Object> latest(UUID userId, UUID taskId) {
    if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=:task AND user_id=:user)")
        .param("task", taskId).param("user", userId).query(Boolean.class).single()) {
      throw DomainException.notFound();
    }
    var rows = jdbc.sql("""
        SELECT r.id,r.task_id AS "taskId",r.revision,r.final,r.conclusion,r.limitations::text,
        r.missing::text,r.columns::text,r.coverage::text,r.sections::text,r.sources::text,
        r.created_at AS "createdAt",t.output_format AS "outputFormat"
        FROM task_results r JOIN tasks t ON t.id=r.task_id WHERE r.task_id=:task
        ORDER BY r.revision DESC LIMIT 1
        """).param("task", taskId).query().listOfRows();
    if (rows.isEmpty()) {
      return null;
    }
    var result = rows.getFirst();
    for (String key : List.of("limitations", "missing", "columns", "coverage", "sections",
        "sources")) {
      result.put(key, json.read((String) result.get(key)));
    }
    result.put("files", jdbc.sql("""
        SELECT a.id,a.filename,a.mime AS "mimeType",a.size AS bytes,a.state
        FROM task_results r JOIN task_artifacts a ON a.id=ANY(r.artifact_ids)
        WHERE r.id=:id ORDER BY array_position(r.artifact_ids,a.id)
        """).param("id", result.get("id")).query().listOfRows());
    return result;
  }

  public PageResult<Map<String, Object>> rows(UUID userId, UUID resultId, PageQuery query) {
    String columns = ownedColumns(userId, resultId);
    String snapshot = changes.snapshot(userId, "result:" + resultId, query);
    String order = "row_order ASC,row_id ASC";
    if (query.sort() != null) {
      String type = null;
      for (var column : json.read(columns)) {
        if (column.path("key").asString().equals(query.sort())) {
          type = column.path("type").asString();
          break;
        }
      }
      if (type == null) {
        throw new DomainException(400, "INVALID_SORT", "Unknown result column");
      }
      String value = switch (type) {
        case "NUMBER" -> "CASE WHEN jsonb_typeof(data->:column)='number'"
            + " THEN (data->>:column)::numeric END";
        case "BOOLEAN" -> "CASE WHEN jsonb_typeof(data->:column)='boolean'"
            + " THEN (data->>:column)::boolean END";
        default -> "data->>:column";
      };
      order = value + " " + query.direction() + " NULLS LAST,row_id " + query.direction();
    }
    long count = jdbc.sql("""
        SELECT count(*) FROM task_result_rows WHERE result_id=:id AND search_text ILIKE :q
        """).param("id", resultId).param("q", query.escapedQuery()).query(Long.class).single();
    var rows = jdbc.sql("""
        SELECT row_id id,row_order AS "rowOrder",data::text FROM task_result_rows
        WHERE result_id=:id AND search_text ILIKE :q ORDER BY
        """ + order + " LIMIT :limit OFFSET :offset")
        .param("id", resultId).param("q", query.escapedQuery()).param("limit", query.pageSize())
        .param("column", query.sort())
        .param("offset", query.offset()).query().listOfRows();
    for (var row : rows) {
      row.put("data", json.read((String) row.get("data")));
    }
    return new PageResult<>(rows, count, query.page(), query.pageSize(), query.sortDescriptor(),
        snapshot);
  }

  public Map<String, Object> row(UUID userId, UUID resultId, UUID rowId) {
    ownedColumns(userId, resultId);
    var rows = jdbc.sql("""
        SELECT row_id AS id,row_order AS "rowOrder",data::text FROM task_result_rows
        WHERE result_id=:result AND row_id=:row
        """).param("result", resultId).param("row", rowId).query().listOfRows();
    if (rows.isEmpty()) {
      throw DomainException.notFound();
    }
    var row = rows.getFirst();
    row.put("data", json.read((String) row.get("data")));
    return row;
  }

  private String ownedColumns(UUID userId, UUID resultId) {
    return jdbc.sql("""
        SELECT r.columns::text FROM task_results r JOIN tasks t ON t.id=r.task_id
        WHERE r.id=:id AND t.user_id=:user
        """).param("id", resultId).param("user", userId).query(String.class).optional()
        .orElseThrow(DomainException::notFound);
  }
}
