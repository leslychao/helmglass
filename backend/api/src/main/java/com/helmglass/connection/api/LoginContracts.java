package com.helmglass.connection.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;

public final class LoginContracts {
  private LoginContracts() {}

  public record Begin(UUID taskId, @NotNull UUID controllerInstanceId) {}

  public record Complete(
      @NotNull Long expectedVersion,
      @NotNull @Pattern(regexp = "SAVE_PROFILE|SESSION_ONLY") String mode,
      @NotBlank @Size(max = 200) String accountLabel,
      @NotNull @Size(max = 64) List<String> confirmedOrigins,
      UUID expectedProfileVersion,
      @NotNull @Pattern(regexp = "CONTINUE|KEEP_PAUSED") String continuationIntent,
      boolean userAsserted,
      @NotNull UUID controllerInstanceId,
      @NotNull Long controlEpoch,
      @NotNull Long pageEpoch) {}
}
