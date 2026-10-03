package com.helmglass.usage.application;

import com.helmglass.api.DomainException;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.usage.infrastructure.repository.UsageRepository;
import com.helmglass.usage.infrastructure.repository.UsageRepository.Checkpoint;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

@Service
public class UsageCheckpointService {
  private static final Duration MAX_CLOCK_SKEW = Duration.ofSeconds(5);
  private final UsageRepository usage;
  private final ChangeRepository changes;
  private final UsageProjectionService projections;

  public UsageCheckpointService(
      UsageRepository usage, ChangeRepository changes, UsageProjectionService projections) {
    this.usage = usage;
    this.changes = changes;
    this.projections = projections;
  }

  @Transactional
  public void record(UUID workerId, UUID bootId, UUID sessionId, JsonNode value) {
    if (!value.isObject() || !value.path("sourceId").asString().equals(bootId + ":" + sessionId)) {
      throw new DomainException(
          403, "USAGE_BINDING_MISMATCH", "Usage source does not match assignment");
    }
    var source = usage.source(workerId, bootId, sessionId);
    if (!value.path("browserComplete").isBoolean()) {
      throw new DomainException(422, "INVALID_USAGE_CHECKPOINT", "Usage completeness is required");
    }
    for (String field :
        List.of("sourceSequence", "browserMs", "executionMs", "humanMs", "loginMs")) {
      if (!value.path(field).isIntegralNumber()
          || value.path(field).asLong() < 0
          || value.path(field).asLong() > 9_007_199_254_740_991L) {
        throw new DomainException(
            422, "INVALID_USAGE_CHECKPOINT", "Invalid monotonic usage counter");
      }
    }
    var next =
        new Checkpoint(
            sessionId,
            bootId,
            value.path("sourceSequence").asLong(),
            value.path("browserMs").asLong(),
            value.path("executionMs").asLong(),
            value.path("humanMs").asLong(),
            value.path("loginMs").asLong(),
            value.path("browserComplete").asBoolean(),
            startedAt(value));
    if (value.has("neverReady")
        && (!value.path("neverReady").isBoolean()
            || (value.path("neverReady").asBoolean()
                && (source.readyAt() != null
                    || !next.browserComplete()
                    || next.browserMs() != 0
                    || next.executionMs() != 0
                    || next.humanMs() != 0
                    || next.loginMs() != 0)))) {
      throw new DomainException(
          422,
          "INVALID_STARTUP_USAGE",
          "Never-ready usage requires confirmed closure before readiness with zero counters");
    }
    if (next.sourceStartedAt().isBefore(source.requestedAt().minus(MAX_CLOCK_SKEW))
        || next.sourceStartedAt()
            .plusMillis(next.browserMs())
            .isAfter(Instant.now().plus(MAX_CLOCK_SKEW))) {
      throw new DomainException(
          422, "INVALID_USAGE_CLOCK", "Usage clock is outside the session lifetime");
    }
    Checkpoint previous = usage.checkpoint(sessionId);
    if (previous != null) {
      if (!previous.workerBootId().equals(next.workerBootId())
          || (previous.sourceStartedAt() != null
              && !previous.sourceStartedAt().equals(next.sourceStartedAt()))) {
        throw DomainException.conflict(
            "USAGE_SOURCE_CHANGED", "Usage clock cannot change within a session");
      }
      if (next.sourceSequence() == previous.sourceSequence() && !next.equals(previous)) {
        throw DomainException.conflict(
            "USAGE_RECEIPT_CONFLICT", "The same usage sequence cannot contain different counters");
      }
      if (next.sourceSequence() <= previous.sourceSequence()) {
        return;
      }
      if (next.browserMs() < previous.browserMs()
          || next.executionMs() < previous.executionMs()
          || next.humanMs() < previous.humanMs()
          || next.loginMs() < previous.loginMs()
          || previous.browserComplete()) {
        throw DomainException.conflict(
            "USAGE_COUNTER_REGRESSION", "Usage counter cannot move backwards");
      }
      long exclusiveDelta =
          next.executionMs()
              - previous.executionMs()
              + next.humanMs()
              - previous.humanMs()
              + next.loginMs()
              - previous.loginMs();
      if (exclusiveDelta > next.browserMs() - previous.browserMs() + 2) {
        throw new DomainException(
            422, "USAGE_OVERLAP", "Exclusive usage deltas exceed the measured interval");
      }
    }
    if (next.executionMs() + next.humanMs() + next.loginMs() > next.browserMs() + 2) {
      throw new DomainException(
          422, "USAGE_OVERLAP", "Exclusive usage counters exceed browser duration");
    }
    usage.saveCheckpoint(next, previous, source);
    projections.refresh(source.userId(), source.taskId());
    changes.changed(
        source.userId(),
        source.taskId() == null ? "usage" : "tasks",
        sessionId,
        next.sourceSequence());
  }

  private static Instant startedAt(JsonNode value) {
    if (!value.path("sourceStartedAt").isString()) {
      throw new DomainException(422, "INVALID_USAGE_CLOCK", "Usage clock origin is required");
    }
    try {
      return Instant.parse(value.path("sourceStartedAt").asString());
    } catch (DateTimeException error) {
      throw new DomainException(
          422, "INVALID_USAGE_CLOCK", "Usage clock origin must be an instant");
    }
  }
}
