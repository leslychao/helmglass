package com.helmglass.connection.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.UUID;
import java.util.Map;
import java.net.URI;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.helmglass.task.api.TaskContracts.Capability;

public final class ConnectionContracts {
  private ConnectionContracts() {}

  public record Create(@NotBlank @Size(max = 200) String displayName,
      @NotBlank @Size(max = 2048) String startUrl,
      @NotNull @Pattern(regexp = "ASK|SAVE|SESSION_ONLY") String savePreference) {}

  public record Resolve(@NotBlank @Size(max = 2048) String url, @NotNull Boolean loginRequired,
      @NotNull Long expectedTaskVersion, @NotNull Long instructionRevision) {}

  public record Rename(@NotNull Long expectedVersion, @NotBlank @Size(max = 200) String displayName) {}

  public record ConnectionView(UUID id, UUID siteId, String displayName, String startUrl,
      String origin, String accountLabel, String status, String savePreference, long scopeVersion,
      long version, Instant createdAt, Instant updatedAt, Instant lastSuccessfulLoginAt,
      Instant lastCheckedAt, Instant lastUsedAt, UUID currentTaskId, UUID loginOperationId, UUID sessionId) {
    @JsonProperty
    public String host() {
      return URI.create(origin).getHost();
    }

    @JsonProperty
    public Map<String, Capability> capabilities() {
      boolean available = !status.equals("DELETING") && !status.equals("DELETED");
      boolean busy = sessionId != null || loginOperationId != null;
      return Map.of("login", new Capability(available && !busy, true, busy ? "Continue the existing browser" : null),
          "check", new Capability(available && !busy && status.equals("SAVED"), true,
              busy ? "Connection is currently in use" : "A saved profile is required"),
          "delete", new Capability(available, true, available ? null : "Deletion is in progress"));
    }
  }
}
