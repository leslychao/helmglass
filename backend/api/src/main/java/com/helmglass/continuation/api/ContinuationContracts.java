package com.helmglass.continuation.api;

import jakarta.validation.constraints.NotNull;
import java.time.Instant;
import java.util.UUID;

public final class ContinuationContracts {
  private ContinuationContracts() {}

  public record Claim(@NotNull UUID continuationId, @NotNull Long expectedInstructionRevision) {}

  public record PrepareMessage(
      @NotNull UUID continuationId,
      @NotNull UUID viewScopeId,
      @NotNull Long presentationRevision,
      @NotNull UUID viewerInstanceId) {}

  public enum DeliveryOutcome {
    DELIVERED,
    UNKNOWN,
    REJECTED
  }

  public record RecordDelivery(@NotNull UUID dispatchId, @NotNull DeliveryOutcome outcome) {}

  public record PreparedMessage(
      UUID dispatchId, String text, Instant expiresAt, long continuationVersion) {}
}
