package com.helmglass.continuation.api;

import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public final class ContinuationContracts {
  private ContinuationContracts() {}

  public record Claim(@NotNull UUID continuationId, @NotNull Long expectedInstructionRevision) {}
}
