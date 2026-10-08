package ru.helmglass.api.tasks;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.util.MultiValueMap;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import tools.jackson.databind.JsonNode;

@Service
public class TaskQueries {
  private final JdbcClient jdbc;
  private final TaskService tasks;
  private final JsonSupport json;

  public TaskQueries(JdbcClient jdbc, TaskService tasks, JsonSupport json) {
    this.jdbc = jdbc;
    this.tasks = tasks;
    this.json = json;
  }

  public Object summary(UUID owner, ListQuery query) {
    Map<String, Object> summary = new java.util.LinkedHashMap<>(tasks.summary(owner, query));
    summary.put(
        "sources",
        jdbc.sql("SELECT DISTINCT source FROM tasks WHERE owner_id=:owner ORDER BY source")
            .param("owner", owner)
            .query(String.class)
            .list());
    return summary;
  }

  public Contracts.Page<String> sites(UUID owner, ListQuery query) {
    String where = "owner_id=:owner AND site IS NOT NULL";
    Map<String, Object> parameters = new java.util.HashMap<>(Map.of("owner", owner));
    if (query.search() != null && !query.search().isBlank()) {
      where += " AND site ILIKE :search";
      parameters.put("search", "%" + query.search() + "%");
    }
    long total =
        jdbc.sql("SELECT count(DISTINCT site) FROM tasks WHERE " + where)
            .params(parameters)
            .query(Long.class)
            .single();
    var items =
        jdbc.sql(
                "SELECT DISTINCT site FROM tasks WHERE "
                    + where
                    + " ORDER BY site LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(String.class)
            .list();
    return new Contracts.Page<>(items, total, query.page(), query.pageSize());
  }

  public Object history(UUID owner, UUID id, MultiValueMap<String, String> values) {
    tasks.get(owner, id);
    ListQuery query = ListQuery.from(values);
    String where = "task_id=:task AND owner_id=:owner";
    Map<String, Object> parameters = new java.util.HashMap<>(Map.of("task", id, "owner", owner));
    if (query.search() != null && !query.search().isBlank()) {
      where += " AND (title ILIKE :search OR detail ILIKE :search)";
      parameters.put("search", "%" + query.search() + "%");
    }
    List<String> types = values.getOrDefault("type", query.status());
    if (!types.isEmpty()) {
      where += " AND type IN (:types)";
      parameters.put("types", types);
    }
    if (values.getFirst("beforeSequence") != null) {
      where += " AND sequence<=:before";
      parameters.put("before", Long.parseLong(values.getFirst("beforeSequence")));
    }
    long total =
        jdbc.sql("SELECT count(*) FROM task_history WHERE " + where)
            .params(parameters)
            .query(Long.class)
            .single();
    var items =
        jdbc.sql(
                "SELECT id,sequence,type,title,detail,created_at FROM task_history WHERE "
                    + where
                    + " ORDER BY sequence DESC LIMIT 10 OFFSET :offset")
            .params(parameters)
            .param("offset", (long) (query.page() - 1) * 10)
            .query(
                (row, index) ->
                    new History(
                        row.getObject("id", UUID.class),
                        row.getLong("sequence"),
                        row.getString("type"),
                        row.getString("title"),
                        row.getString("detail"),
                        Database.instant(row, "created_at")))
            .list();
    return new Contracts.Page<>(items, total, query.page(), 10);
  }

  public Object rows(UUID owner, UUID id, MultiValueMap<String, String> values) {
    Contracts.Task task = tasks.get(owner, id);
    ListQuery query = ListQuery.from(values);
    Map<String, Object> parameters = new java.util.HashMap<>(Map.of("task", id, "owner", owner));
    String where = "task_id=:task AND owner_id=:owner";
    if (query.search() != null && !query.search().isBlank()) {
      where += " AND cells::text ILIKE :search";
      parameters.put("search", "%" + query.search() + "%");
    }
    String order = "id";
    if (query.sort() != null) {
      boolean allowed = false;
      if (task.result() != null) {
        for (JsonNode column : task.result().path("columns")) {
          if (query.sort().equals(column.path("key").asString())) {
            allowed = true;
          }
        }
      }
      if (allowed) {
        order = "cells -> :sort";
        parameters.put("sort", query.sort());
      }
    }
    long total =
        jdbc.sql("SELECT count(*) FROM result_rows WHERE " + where)
            .params(parameters)
            .query(Long.class)
            .single();
    var items =
        jdbc.sql(
                "SELECT id,cells FROM result_rows WHERE "
                    + where
                    + " ORDER BY "
                    + order
                    + (query.ascending() ? " ASC" : " DESC")
                    + " NULLS LAST,id LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(
                (row, index) ->
                    Map.of(
                        "id",
                        Long.toString(row.getLong("id")),
                        "cells",
                        json.read(row.getString("cells"))))
            .list();
    return new Contracts.Page<>(items, total, query.page(), query.pageSize());
  }

  public record History(
      UUID id,
      long sequence,
      String type,
      String title,
      String detail,
      java.time.Instant createdAt) {}
}
