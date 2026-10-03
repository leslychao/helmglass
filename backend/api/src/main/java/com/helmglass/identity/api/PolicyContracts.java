package com.helmglass.identity.api;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;

public final class PolicyContracts {
  private PolicyContracts() {}

  public record Quotas(
      Integer assignedBrowserLimit,
      Integer assignedQueuedLimit,
      Integer effectiveBrowserLimit,
      Integer effectiveQueuedLimit) {}

  public record Policy(
      long version,
      String siteMode,
      String connectionMode,
      List<String> blockedActions,
      boolean requireConfirmationBeforeChanges,
      List<String> origins,
      Integer maxCommandsPerRun,
      Integer maxActiveSecondsPerRun,
      Integer maxParallelRuns,
      Integer maxQueuedRuns,
      Long maxRetainedMediaBytes,
      Integer maxBrowserSessions,
      Quotas quotas) {}

  public record Update(
      @NotNull Long expectedVersion,
      @NotNull @Pattern(regexp = "ALL|ALLOW_LIST|DENY_LIST") String siteMode,
      @NotNull @Pattern(regexp = "AUTO|EXPLICIT|PUBLIC_ONLY") String connectionMode,
      @NotNull @Size(max = 30) List<String> blockedActions,
      boolean requireConfirmationBeforeChanges,
      @NotNull @Size(max = 100) List<String> origins,
      @Min(1) Integer maxCommandsPerRun,
      @Min(60) Integer maxActiveSecondsPerRun,
      @Min(1) Integer maxParallelRuns,
      @Min(0) Integer maxQueuedRuns,
      @Min(0) Long maxRetainedMediaBytes,
      @Min(1) Integer maxBrowserSessions) {}
}
