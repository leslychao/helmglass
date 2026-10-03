package com.helmglass.task.api;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class TaskContracts {
  private TaskContracts() {}

  public record Create(@NotNull @Size(max = 16000) String goal, @Size(max = 2048) String startUrl,
      @NotNull @Size(max = 50) List<UUID> connectionIds,
      @NotNull @Pattern(regexp = "TABLE|FILE|TEXT") String outputFormat,
      boolean confirmImportantActions, @Min(60) @Max(86400) int browserTimeLimitSeconds,
      @NotNull @Pattern(regexp = "DRAFT|PREPARE") String intent) {}

  public record Edit(@NotNull Long expectedVersion, @NotNull @Size(max = 16000) String goal,
      @Size(max = 2048) String startUrl, @NotNull @Size(max = 50) List<UUID> connectionIds,
      @NotNull @Pattern(regexp = "TABLE|FILE|TEXT") String outputFormat,
      boolean confirmImportantActions, @Min(60) @Max(86400) int browserTimeLimitSeconds) {}

  public record ExpectedVersion(@NotNull Long expectedVersion) {}

  public record Resume(@NotNull Long expectedTaskVersion, UUID resolutionId,
      boolean consentNewBrowser) {}

  public record Clarification(@NotNull UUID clarificationId, @NotBlank @Size(max = 4096) String text,
      @NotNull Long expectedInstructionRevision, @NotNull Long expectedTaskVersion) {}

  public record Completion(@NotNull Long expectedTaskVersion, @NotNull Long instructionRevision,
      @NotNull UUID resultId, UUID continuationClaimId,
      @NotNull Long resultRevision, @NotNull @Pattern(regexp = "SUCCESS|PARTIAL|NOT_ACHIEVED") String outcome) {}

  public record Reconcile(@NotNull Long expectedTaskVersion, UUID commandId,
      UUID humanOperationId, UUID evidenceId) {}

  public record Capability(boolean allowed, boolean visible, String reason) {}

  public record TaskView(UUID id, long displayNumber, long version, long instructionRevision,
      String goal, String title, String startUrl, String outputFormat,
      boolean confirmImportantActions, int browserTimeLimitSeconds, String state, String outcome,
      String origin, String waitReason, String failureCode, boolean mutationBarrier,
      Instant createdAt, Instant updatedAt, List<UUID> connectionIds, Map<String, Object> currentSession,
      Map<String, Capability> capabilities, String contextRef, UUID lastSessionId,
      Map<String, Object> activeRequest, Map<String, Object> outstandingCommand,
      Map<String, Object> lastCommand, Map<String, Object> usage, Map<String, Object> continuation,
      UUID unresolvedHumanOperationId) {}
}
