package com.helmglass.task.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.UUID;

public final class ActionRequestContracts {
  private ActionRequestContracts() {}

  public record Answer(@NotNull Long expectedVersion, @NotBlank String intentHash,
      @NotNull @Pattern(regexp = "APPROVE|DENY|ANSWER") String decision,
      @Size(max = 4096) String text, UUID selectedConnectionId) {}
}
