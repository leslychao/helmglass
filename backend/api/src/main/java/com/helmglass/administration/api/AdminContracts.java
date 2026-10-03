package com.helmglass.administration.api;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public final class AdminContracts {
  private AdminContracts() {}

  public record Reason(@NotNull Long expectedVersion, @NotBlank @Size(max = 1000) String reason) {}
  public record Stop(@NotBlank @Size(max = 1000) String reason) {}
  public record Admission(@NotNull Long expectedVersion, @NotBlank @Size(max = 1000) String reason,
      boolean acceptingAllocations) {}
  public record Limits(@NotNull Long expectedVersion, @NotBlank @Size(max = 1000) String reason,
      @NotNull @Pattern(regexp = "STANDARD|CUSTOM|POOL") String browserMode,
      @Min(1) Integer browserCustom, @NotNull @Pattern(regexp = "UNLIMITED|CUSTOM") String queuedMode,
      @Min(0) Integer queuedCustom) {}
}
