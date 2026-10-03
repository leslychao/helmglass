package com.helmglass.enrollment.api;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.UUID;

public final class EnrollmentContracts {
  private EnrollmentContracts() {}

  public record Request(
      @Min(1) @Max(1) int schemaVersion,
      @NotBlank @Pattern(regexp = "[A-Za-z0-9_-]{1,80}") String installationId,
      @NotNull UUID workerId,
      @NotNull UUID bootId,
      @Min(1) @Max(16) int capacity,
      @NotBlank @Size(min = 32, max = 512) String enrollmentToken,
      @NotBlank @Size(max = 16_384) String csrPem) {
    @Override
    public String toString() {
      return "WorkerEnrollmentRequest[redacted]";
    }
  }

  public record Response(int schemaVersion, UUID workerId, UUID bootId,
      String certificatePem, String caPem, Instant expiresAt) {}
}
