package ru.helmglass.api;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.util.MultiValueMap;

public record ListQuery(
    String search,
    List<String> status,
    List<String> site,
    List<String> source,
    Instant from,
    Instant to,
    String sort,
    boolean ascending,
    int page,
    int pageSize,
    UUID taskId) {
  public static ListQuery from(MultiValueMap<String, String> values) {
    String search = values.getFirst("search");
    if (search != null && search.length() > 300) {
      throw ApiException.invalid("search", "Слишком длинный поиск.");
    }
    int page = number(values.getFirst("page"), 1);
    int size = number(values.getFirst("pageSize"), 20);
    validatePage(page, size);
    if ("true".equals(values.getFirst("suggestions"))) {
      page = 1;
      size = 3;
    }
    UUID taskId = null;
    String selectedTask = values.getFirst("taskId");
    if (selectedTask != null && !selectedTask.isBlank()) {
      try {
        taskId = UUID.fromString(selectedTask);
      } catch (IllegalArgumentException exception) {
        throw ApiException.invalid("taskId", "Недопустимый номер задачи.");
      }
    }
    return new ListQuery(
        search,
        list(values, "status"),
        list(values, "site"),
        list(values, "source"),
        date(values.getFirst("from"), false),
        date(values.getFirst("to"), true),
        values.getFirst("sort"),
        "asc".equals(values.getFirst("direction")),
        page,
        size,
        taskId);
  }

  public Filter tasks(UUIDOwner owner, boolean states) {
    List<String> clauses = new ArrayList<>(List.of("t.owner_id=:owner"));
    Map<String, Object> parameters = new HashMap<>();
    parameters.put("owner", owner.id());
    if (taskId != null) {
      clauses.add("t.id=:taskId");
      parameters.put("taskId", taskId);
    } else if (search != null && !search.isBlank()) {
      clauses.add("(t.title ILIKE :search OR t.goal ILIKE :search OR t.id::text ILIKE :search)");
      parameters.put("search", "%" + search + "%");
    }
    addList(clauses, parameters, "t.status", "status", states ? status : List.of());
    addList(clauses, parameters, "t.site", "site", site);
    addList(clauses, parameters, "t.source", "source", source);
    if (from != null) {
      clauses.add("t.created_at>=:from");
      parameters.put("from", java.sql.Timestamp.from(from));
    }
    if (to != null) {
      clauses.add("t.created_at<:to");
      parameters.put("to", java.sql.Timestamp.from(to));
    }
    return new Filter(String.join(" AND ", clauses), parameters);
  }

  public static void validatePage(int page, int size) {
    if (page < 1 || page > 1000000 || !List.of(3, 5, 10, 20, 25, 50).contains(size)) {
      throw ApiException.invalid("page", "Недопустимые параметры страницы.");
    }
  }

  public long offset() {
    return (long) (page - 1) * pageSize;
  }

  public static void addList(
      List<String> clauses,
      Map<String, Object> parameters,
      String column,
      String name,
      List<String> values) {
    if (!values.isEmpty()) {
      clauses.add(column + " IN (:" + name + ")");
      parameters.put(name, values);
    }
  }

  public static List<String> list(MultiValueMap<String, String> values, String name) {
    List<String> result =
        values.getOrDefault(name, List.of()).stream()
            .flatMap(value -> java.util.Arrays.stream(value.split(",")))
            .filter(value -> !value.isBlank())
            .distinct()
            .toList();
    if (result.size() > 50) {
      throw ApiException.invalid(name, "Слишком много значений.");
    }
    return result;
  }

  private static int number(String value, int fallback) {
    return value == null || value.isBlank() ? fallback : Integer.parseInt(value);
  }

  private static Instant date(String value, boolean end) {
    if (value == null || value.isBlank()) {
      return null;
    }
    if (value.length() == 10) {
      LocalDate date = LocalDate.parse(value);
      return (end ? date.plusDays(1) : date).atStartOfDay().toInstant(ZoneOffset.UTC);
    }
    return Instant.parse(value);
  }

  public record Filter(String where, Map<String, Object> parameters) {}

  public record UUIDOwner(java.util.UUID id) {}
}
