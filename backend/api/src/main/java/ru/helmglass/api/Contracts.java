package ru.helmglass.api;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

public final class Contracts {
  private Contracts() {}

  public record Page<T>(List<T> items, long total, int page, int pageSize) {}

  public record Me(
      UUID id,
      long version,
      String name,
      String email,
      String status,
      Set<String> roles,
      String avatarUrl) {}

  public record ProfileInput(String name, Long expectedVersion) {}

  public record AdminUsersSummary(long users, long blocked, long waitingTasks) {}

  public record TaskInput(
      String title,
      String goal,
      String startUrl,
      String outputFormat,
      Boolean requireConfirmation,
      List<UUID> preferredConnectionIds,
      Boolean prepare) {}

  public record TaskCommand(
      String type,
      Long expectedVersion,
      UUID requestId,
      Long requestVersion,
      String text,
      UUID connectionId,
      String viewerId,
      Boolean confirmBrowserLoss,
      Boolean saveConnection,
      Boolean resume,
      String outcome,
      String title,
      String goal,
      String startUrl,
      String outputFormat,
      Boolean requireConfirmation,
      List<UUID> preferredConnectionIds,
      String accountLabel,
      String accountSubject) {}

  public record Task(
      UUID id,
      long version,
      long instructionRevision,
      String title,
      String goal,
      String startUrl,
      String site,
      String outputFormat,
      boolean requireConfirmation,
      List<UUID> preferredConnectionIds,
      String source,
      String status,
      String outcome,
      String waitReason,
      String summary,
      InteractionRequest request,
      Browser browser,
      JsonNode result,
      Map<String, Object> usage,
      List<String> allowedCommands,
      Instant createdAt,
      Instant updatedAt) {}

  public record InteractionRequest(
      UUID id, String type, String prompt, long version, JsonNode options, UUID operationId) {}

  public record Browser(
      UUID id,
      String status,
      UUID nodeId,
      String controlOwner,
      long controlEpoch,
      boolean privateMode,
      String currentUrl,
      boolean canView,
      boolean canControl,
      long version) {}

  public record Connection(
      UUID id,
      long version,
      String name,
      String site,
      String startUrl,
      String status,
      String accountSubject,
      String accountLabel,
      Instant lastUsedAt,
      Browser browser,
      Instant createdAt,
      Instant updatedAt) {}

  public record ConnectionInput(String name, String site, String startUrl) {}

  public record RenameInput(String name, Long expectedVersion) {}

  public record LoginInput(
      String action, String viewerId, String accountLabel, String accountSubject) {}

  public record ControlInput(
      String type,
      String viewerId,
      Boolean resume,
      Boolean saveConnection,
      UUID connectionId,
      String accountLabel,
      String accountSubject) {}

  public record TicketInput(String role, String viewerId) {}

  public record Ticket(String url, String ticket, String role, Instant expiresAt) {}

  public record ReadNotifications(UUID id, Long throughSequence) {}

  public record AdminCommand(
      String type,
      String reason,
      String browserLimitMode,
      Integer browserLimit,
      Integer waitingLimit,
      Long expectedVersion) {}

  public record NodeCommand(String type, String reason) {}

  public record BrowserAction(
      UUID operationId,
      String type,
      JsonNode arguments,
      long instructionRevision,
      Long controlEpoch) {}

  public record Operation(
      UUID id,
      UUID taskId,
      String type,
      String status,
      JsonNode result,
      String errorCode,
      String errorMessage,
      Instant createdAt,
      Instant completedAt) {}

  public record WorkerResult(String status, JsonNode result, JsonNode error) {}

  public record Artifact(
      UUID id,
      String name,
      String mimeType,
      String status,
      Long sizeBytes,
      String sha256,
      boolean complete,
      String sourceUrl,
      String sourceRef,
      java.math.BigDecimal durationSeconds,
      String downloadUrl) {}
}
