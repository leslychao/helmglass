package com.helmglass.task.domain;

import com.helmglass.api.DomainException;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Getter
@Entity
@Table(name = "tasks")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class TaskAggregate {
  @Id private UUID id;
  private UUID userId;
  private long displayNumber;
  @Version private long version;
  private long instructionRevision;

  @Column(length = 16000)
  private String goal;

  private String title;
  private String startUrl;
  private UUID startSiteId;
  private String outputFormat;
  private boolean confirmImportantActions;
  private int browserTimeLimitSeconds;
  private String origin;

  @Enumerated(EnumType.STRING)
  private TaskState state;

  private String outcome;
  private String waitReason;
  private String failureCode;
  private boolean mutationBarrier;
  private long stopEpoch;
  private String continuationPreference;
  private boolean continuationConsent;
  private Instant createdAt;
  private Instant updatedAt;
  private Instant preparedAt;
  private Instant startedAt;
  private Instant endedAt;

  public TaskAggregate(
      UUID userId,
      long displayNumber,
      String goal,
      String startUrl,
      UUID siteId,
      String format,
      boolean confirmations,
      int budget,
      String origin) {
    id = UUID.randomUUID();
    this.userId = userId;
    this.displayNumber = displayNumber;
    instructionRevision = 1;
    this.goal = goal;
    title = goal.length() > 200 ? goal.substring(0, 200) : goal;
    this.startUrl = startUrl;
    startSiteId = siteId;
    outputFormat = format;
    confirmImportantActions = confirmations;
    browserTimeLimitSeconds = budget;
    this.origin = origin;
    state = TaskState.DRAFT;
    continuationPreference = "MANUAL";
    continuationConsent = origin.equals("MCP");
    createdAt = Instant.now();
    updatedAt = createdAt;
  }

  public void edit(
      String goal, String startUrl, UUID siteId, String format, boolean confirmations, int budget) {
    requireState(TaskState.DRAFT);
    this.goal = goal;
    title = goal.length() > 200 ? goal.substring(0, 200) : goal;
    this.startUrl = startUrl;
    startSiteId = siteId;
    outputFormat = format;
    confirmImportantActions = confirmations;
    browserTimeLimitSeconds = budget;
    updatedAt = Instant.now();
  }

  public void prepare() {
    requireState(TaskState.DRAFT);
    if (goal.isBlank()) {
      throw new DomainException(422, "GOAL_REQUIRED", "Prepared task requires a goal");
    }
    state = TaskState.WAITING_AGENT;
    preparedAt = Instant.now();
    updatedAt = preparedAt;
  }

  public void pause(boolean outstanding) {
    requirePrepared();
    if (state == TaskState.STOPPING) {
      throw DomainException.conflict("STOP_IN_PROGRESS", "Task is stopping");
    }
    state = outstanding ? TaskState.PAUSING : TaskState.PAUSED;
    updatedAt = Instant.now();
  }

  public void resume(boolean hasResolution) {
    if (state != TaskState.PAUSED && state != TaskState.INTERRUPTED) {
      throw DomainException.conflict("INVALID_TASK_STATE", "Task cannot be resumed");
    }
    if (mutationBarrier || (state == TaskState.INTERRUPTED && !hasResolution)) {
      throw DomainException.conflict("EFFECT_UNRESOLVED", "External effect must be reconciled");
    }
    state = TaskState.WAITING_AGENT;
    updatedAt = Instant.now();
  }

  public void stop(boolean resources) {
    if (state.terminal()) {
      return;
    }
    requirePrepared();
    stopEpoch++;
    state = resources ? TaskState.STOPPING : TaskState.CANCELLED;
    updatedAt = Instant.now();
    if (!resources) {
      endedAt = updatedAt;
    }
  }

  public void clarify() {
    requirePrepared();
    instructionRevision++;
    updatedAt = Instant.now();
  }

  public void complete(String finalOutcome) {
    requireState(TaskState.WAITING_AGENT);
    if (mutationBarrier) {
      throw DomainException.conflict("EFFECT_UNRESOLVED", "External effect must be reconciled");
    }
    if (!List.of("SUCCESS", "PARTIAL", "NOT_ACHIEVED").contains(finalOutcome)) {
      throw new DomainException(422, "INVALID_OUTCOME", "A valid outcome is required");
    }
    outcome = finalOutcome;
    state = TaskState.COMPLETED;
    endedAt = Instant.now();
    updatedAt = endedAt;
  }

  public void requirePrepared() {
    if (state == TaskState.DRAFT || state.terminal()) {
      throw DomainException.conflict("INVALID_TASK_STATE", "Task is not active");
    }
  }

  public void requireState(TaskState expected) {
    if (state != expected) {
      throw DomainException.conflict(
          "INVALID_TASK_STATE", "Task state does not permit this action");
    }
  }
}
