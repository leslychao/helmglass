package com.helmglass.usage.api;

import com.helmglass.api.PageResult;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class UsageContracts {
  private UsageContracts() {}

  public record Metric(
      BigDecimal value,
      BigDecimal knownValue,
      String completeness,
      long measuredCount,
      long expectedCount) {}

  public record Daily(LocalDate date, long taskCount, Map<String, Metric> metrics) {}

  public record CalendarDay(
      LocalDate date, Instant from, Instant to, Map<String, Metric> metrics) {}

  public record Calendar(
      String scope,
      String basis,
      UUID userId,
      Instant from,
      Instant to,
      String timezone,
      Instant asOf,
      Map<String, Metric> metrics,
      List<CalendarDay> daily) {}

  public enum StateGroup {
    SUCCESS,
    ACTIVE,
    PARTIAL,
    NOT_ACHIEVED,
    ERROR,
    CANCELLED
  }

  public record StateCount(StateGroup state, long count) {}

  public record Summary(
      String scope,
      String basis,
      Instant from,
      Instant to,
      String timezone,
      Instant asOf,
      long taskCount,
      long terminalCount,
      long successfulCount,
      Double successRate,
      Map<String, Metric> metrics,
      List<Daily> daily,
      List<StateCount> states) {}

  public record Site(
      UUID id,
      String host,
      long taskCount,
      long terminalCount,
      long successfulCount,
      Double successRate,
      Map<String, Metric> metrics) {}

  public record Measurement(
      UUID id,
      UUID sessionId,
      UUID attemptId,
      String metric,
      BigDecimal value,
      String unit,
      String completeness,
      Instant intervalStart,
      Instant intervalEnd,
      Instant recordedAt) {}

  public record UnknownInterval(UUID sessionId, Instant from, Instant to, String reason) {}

  public record TaskUsage(
      UUID taskId,
      Instant asOf,
      Map<String, Metric> metrics,
      PageResult<Measurement> measurements,
      PageResult<UnknownInterval> unknownIntervals) {}
}
