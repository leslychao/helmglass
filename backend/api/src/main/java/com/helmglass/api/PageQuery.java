package com.helmglass.api;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.util.MultiValueMap;

public record PageQuery(int page, int pageSize, String query, String sort, String direction,
    String snapshot, MultiValueMap<String, String> filters) {
  public static PageQuery from(MultiValueMap<String, String> values) {
    int page = Integer.parseInt(Objects.requireNonNullElse(values.getFirst("page"), "1"));
    int size = Integer.parseInt(Objects.requireNonNullElse(values.getFirst("pageSize"), "20"));
    String sort = values.getFirst("sort");
    String direction = values.getFirst("direction");
    String query = Objects.requireNonNullElse(values.getFirst("q"), "").trim();
    if (page < 1 || size < 1 || size > 100 || page > 100000 || query.length() > 200
        || (sort == null) != (direction == null)
        || (direction != null && !List.of("asc", "desc").contains(direction))) {
      throw new DomainException(400, "INVALID_PAGE", "Invalid page or sort parameters");
    }
    return new PageQuery(page, size, query, sort, direction, values.getFirst("snapshot"), values);
  }

  public int offset() {
    return Math.multiplyExact(page - 1, pageSize);
  }

  public String sqlOrder(Map<String, String> fields, String defaultOrder) {
    if (sort == null) {
      return defaultOrder;
    }
    String column = fields.get(sort);
    if (column == null) {
      throw new DomainException(400, "INVALID_SORT", "Unsupported sort field");
    }
    return column + " " + direction + ", id " + direction;
  }

  public Map<String, String> sortDescriptor() {
    return sort == null ? null : Map.of("field", sort, "direction", direction);
  }

  public String escapedQuery() {
    return "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
  }
}
