package ru.helmglass.api;

import java.math.BigDecimal;
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
      List<UUID> preferredConnectionIds,
      String accountLabel,
      String accountSubject) {
    public TaskCommand {
      if (type == null || !Set.of("PREPARE", "AMEND", "RESUME", "STOP", "ANSWER",
          "CONFIRM", "REJECT", "CHOOSE_CONNECTION", "FINISH", "TAKE_CONTROL", "RETURN_CONTROL",
          "BEGIN_LOGIN", "FINISH_LOGIN", "REQUIRE_LOGIN", "CLOSE_BROWSER", "OPEN_BROWSER").contains(type)) {
        throw ApiException.invalid("type", "Неизвестная команда задачи.");
      }
    }
  }

  public record Task(
      UUID id,
      long version,
      long instructionRevision,
      String title,
      String goal,
      String startUrl,
      String site,
      String outputFormat,
      boolean chatBound,
      Continuation continuation,
      List<UUID> preferredConnectionIds,
      String source,
      String status,
      String outcome,
      String waitReason,
      String summary,
      InteractionRequest request,
      InteractionResponse lastResponse,
      Browser browser,
      JsonNode result,
      TaskTiming timing,
      Map<String, Object> usage,
      List<String> allowedCommands,
      long stepCount,
      Instant createdAt,
      Instant updatedAt) {}

  public record TaskTiming(BigDecimal elapsedSeconds, boolean running) {}

  public record Continuation(String status, String reason) {}

  public record InteractionRequest(
      UUID id,
      String type,
      String prompt,
      long version,
      long instructionRevision,
      JsonNode options,
      UUID operationId) {}

  public record InteractionResponse(
      UUID requestId,
      long requestVersion,
      long instructionRevision,
      String type,
      String prompt,
      UUID operationId,
      String command,
      String text,
      UUID connectionId,
      Instant answeredAt) {}

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
      long version,
      String profileSaveError,
      UUID taskId,
      UUID connectionId,
      boolean loginConfirmed,
      Instant startedAt,
      Instant closedAt,
      Instant idleCloseAt,
      String closeReason) {}

  public record CookieCheck(int usableCount, Instant checkedAt) {
    public CookieCheck {
      if (usableCount < 0 || usableCount > 10_000 || checkedAt == null) {
        throw new IllegalArgumentException("Invalid cookie check");
      }
    }
  }

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
      Instant updatedAt,
      long profileRevision,
      Instant profileSavedAt,
      String profileSaveError,
      List<String> authorizedOrigins,
      CookieCheck cookieCheck,
      long taskCount) {}

  public record ConnectionInput(String name, String site, String startUrl) {}

  public record RenameInput(String name, Long expectedVersion) {}

  public record LoginInput(
      String action, String viewerId, String accountLabel, String accountSubject,
      UUID pageVisitId) {}

  public record ControlInput(
      String type,
      String viewerId,
      Boolean resume,
      Boolean saveConnection,
      UUID connectionId,
      String accountLabel,
      String accountSubject,
      Long controlEpoch) {
    public ControlInput(String type, String viewerId, Boolean resume, Boolean saveConnection,
        UUID connectionId, String accountLabel, String accountSubject) {
      this(type, viewerId, resume, saveConnection, connectionId, accountLabel, accountSubject, null);
    }
  }

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

  public record NodeCommand(String type, String reason, Long expectedVersion) {}

  public record BrowserAction(
      UUID operationId,
      UUID stepId,
      String type,
      JsonNode arguments,
      long instructionRevision,
      Long controlEpoch,
      String confirmationPrompt) {}

  public record StepSource(String title, String url) {}

  public record StepEvidence(
      String type, UUID operationId, UUID artifactId, String text, List<StepSource> sources) {}

  public record StepCommand(
      String type, UUID stepId, Long expectedVersion, long instructionRevision,
      String operationKey, String objectKey, String title, String completionCriterion,
      String outcome, String result, List<StepEvidence> evidence) {}

  public record TaskStep(
      UUID id, UUID taskId, long sequence, String operationKey, String objectKey,
      String title, String completionCriterion, String status, long version, String result,
      JsonNode evidence, Instant createdAt, Instant updatedAt, Instant startedAt,
      Instant completedAt) {}

  public record Operation(
      UUID id,
      UUID taskId,
      UUID stepId,
      String type,
      String status,
      JsonNode result,
      String errorCode,
      String errorMessage,
      Instant createdAt,
      Instant completedAt) {}

  public record OperationSummary(
      UUID id, UUID taskId, UUID stepId, String type, String status, Instant createdAt) {}

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
