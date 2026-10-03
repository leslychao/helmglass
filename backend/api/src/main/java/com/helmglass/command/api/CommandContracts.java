package com.helmglass.command.api;

import jakarta.validation.constraints.NotNull;
import java.time.Instant;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

public final class CommandContracts {
  private CommandContracts() {}

  public record Submit(@NotNull UUID commandId, @NotNull Long expectedTaskVersion,
      @NotNull Long instructionRevision, UUID browserSessionId, Long controlEpoch,
      Long pageEpoch, Long privacyEpoch, UUID continuationClaimId, UUID intentId,
      Instant deadline, @NotNull JsonNode action) {}
}
