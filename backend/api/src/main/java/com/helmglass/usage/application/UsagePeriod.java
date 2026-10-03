package com.helmglass.usage.application;

import com.helmglass.api.DomainException;
import com.helmglass.task.domain.TaskState;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;
import org.springframework.util.MultiValueMap;

public record UsagePeriod(Instant from, Instant to, String timezone, List<String> states,
    List<UUID> sites, boolean unknownSite) {
  public UsagePeriod {
    try {
      ZoneId.of(timezone);
    } catch (DateTimeException error) {
      throw new DomainException(400, "INVALID_USAGE_TIMEZONE", "Unknown usage timezone");
    }
    if (!from.isBefore(to) || Duration.between(from, to).compareTo(Duration.ofDays(366)) > 0) {
      throw new DomainException(400, "INVALID_USAGE_PERIOD",
          "Usage period must be within 366 days");
    }
    states = List.copyOf(states);
    sites = List.copyOf(sites);
    if (states.size() > TaskState.values().length || sites.size() > 50) {
      throw new DomainException(400, "INVALID_FILTER", "Too many usage filters");
    }
    states.forEach(TaskState::valueOf);
  }

  public static UsagePeriod from(Instant from, Instant to, String timezone,
      MultiValueMap<String, String> parameters) {
    String basis = parameters.getFirst("basis");
    if (basis != null && !basis.equals("TASK_CREATED")) {
      throw new DomainException(400, "INVALID_USAGE_BASIS", "Usage uses task creation cohorts");
    }
    List<String> siteIds = values(parameters, "siteId");
    return new UsagePeriod(from, to, timezone, values(parameters, "state"),
        siteIds.stream().filter(value -> !value.equals("unknown")).map(UUID::fromString).toList(),
        siteIds.contains("unknown"));
  }

  private static List<String> values(MultiValueMap<String, String> parameters, String key) {
    List<String> plain = parameters.get(key);
    List<String> array = parameters.get(key + "[]");
    if (plain != null && array != null) {
      throw new DomainException(400, "INVALID_FILTER", "Use one spelling for each usage filter");
    }
    if (plain != null) {
      return plain;
    }
    return array == null ? List.of() : array;
  }
}
