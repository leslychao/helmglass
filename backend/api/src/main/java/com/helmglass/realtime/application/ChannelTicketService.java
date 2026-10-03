package com.helmglass.realtime.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import com.helmglass.realtime.domain.ChatPresentation;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class ChannelTicketService {
  public record TicketBinding(
      UUID userId,
      UUID loginId,
      UUID grantId,
      long accessEpoch,
      UUID taskId,
      UUID sessionId,
      UUID viewerInstanceId,
      UUID controllerInstanceId,
      long controlEpoch,
      long pageEpoch,
      long privacyEpoch,
      long mediaGeneration,
      long viewGeneration,
      String purpose,
      Instant expiresAt,
      Instant viewerAuthorizationExpiresAt,
      UUID viewScopeId,
      long presentationRevision,
      long grantVersion,
      String origin) {}

  private final StringRedisTemplate redis;
  private final JsonSupport json;
  private final UserEphemeralState userState;
  private final SecureRandom random = new SecureRandom();

  public ChannelTicketService(
      StringRedisTemplate redis, JsonSupport json, UserEphemeralState userState) {
    this.redis = redis;
    this.json = json;
    this.userState = userState;
  }

  public Map<String, Object> issue(TicketBinding binding, String urlName, String url) {
    byte[] bytes = new byte[32];
    random.nextBytes(bytes);
    String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    String key = "helm:ticket:" + JsonSupport.sha256(token);
    userState.set(binding.userId(), key, json.write(binding), Duration.ofSeconds(30));
    return Map.of(
        "ticket",
        token,
        urlName,
        url,
        "expiresAt",
        binding.expiresAt(),
        "viewGeneration",
        binding.viewGeneration(),
        "viewerAuthorizationExpiresAt",
        binding.viewerAuthorizationExpiresAt());
  }

  public long nextViewGeneration(UUID userId, UUID sessionId, UUID viewerId) {
    String key = "helm:viewer-generation:" + sessionId + ":" + viewerId;
    Long generation = userState.increment(userId, key, Duration.ofDays(1));
    if (generation == null) {
      throw new DomainException(503, "VIEW_UNAVAILABLE", "Viewer admission is unavailable");
    }
    return generation;
  }

  public TicketBinding consume(String token, String purpose, UUID sessionId) {
    TicketBinding binding = consume(token, purpose);
    if (!Objects.equals(binding.sessionId(), sessionId)) {
      throw bindingMismatch();
    }
    return binding;
  }

  public Map<String, Object> eventTicket(ChatPresentation slot, String origin, String url) {
    Instant expires = Instant.now().plusSeconds(30);
    if (slot.viewerAuthorizationExpiresAt().isBefore(expires)) {
      expires = slot.viewerAuthorizationExpiresAt();
    }
    return issue(new TicketBinding(slot.userId(), null, slot.grantId(), slot.accessEpoch(),
        slot.taskId(), null, slot.activeViewerInstanceId(), null, 0, 0, 0, 0,
        slot.viewGeneration(), "TASK_EVENTS", expires, slot.viewerAuthorizationExpiresAt(),
        slot.id(), slot.presentationRevision(), slot.grantVersion(), origin), "url", url);
  }

  public TicketBinding consumeTaskEvents(String token, UUID taskId, String origin) {
    TicketBinding binding = consume(token, "TASK_EVENTS");
    if (binding.viewScopeId() == null || binding.grantId() == null
        || !Objects.equals(binding.taskId(), taskId) || !Objects.equals(binding.origin(), origin)) {
      throw bindingMismatch();
    }
    return binding;
  }

  private TicketBinding consume(String token, String purpose) {
    if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) {
      throw new DomainException(401, "INVALID_TICKET", "Ticket is invalid");
    }
    String value = redis.opsForValue().getAndDelete("helm:ticket:" + JsonSupport.sha256(token));
    if (value == null) {
      throw new DomainException(401, "TICKET_EXPIRED", "Ticket has expired or was already used");
    }
    var binding = json.read(value, TicketBinding.class);
    boolean matchingPurpose =
        purpose.equals("VIDEO")
            ? binding.purpose().equals("NORMAL_VIDEO") || binding.purpose().equals("PRIVATE_VIDEO")
            : binding.purpose().equals(purpose);
    if (!matchingPurpose
        || !binding.expiresAt().isAfter(Instant.now())) {
      throw bindingMismatch();
    }
    return binding;
  }

  private static DomainException bindingMismatch() {
    return new DomainException(403, "TICKET_BINDING_MISMATCH", "Ticket does not authorize this channel");
  }
}
