package com.helmglass.realtime.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class ChannelTicketService {
  public record TicketBinding(UUID userId, UUID loginId, UUID grantId, long accessEpoch,
      UUID taskId, UUID sessionId, UUID viewerInstanceId, UUID controllerInstanceId,
      long controlEpoch, long pageEpoch, long privacyEpoch, long mediaGeneration, long viewGeneration,
      String purpose, Instant expiresAt, Instant viewerAuthorizationExpiresAt) {}

  private final StringRedisTemplate redis;
  private final JsonSupport json;
  private final UserEphemeralState userState;
  private final SecureRandom random = new SecureRandom();

  public ChannelTicketService(StringRedisTemplate redis, JsonSupport json, UserEphemeralState userState) {
    this.redis = redis;
    this.json = json;
    this.userState = userState;
  }

  public Map<String, Object> issue(TicketBinding binding, String urlName, String url) {
    byte[] bytes = new byte[32];
    random.nextBytes(bytes);
    String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    String key = "helm:ticket:" + JsonSupport.sha256(token);
    userState.set(binding.userId(), key, json.write(binding),
        Duration.ofSeconds(30));
    return Map.of("ticket", token, urlName, url, "expiresAt", binding.expiresAt(),
        "viewGeneration", binding.viewGeneration(), "viewerAuthorizationExpiresAt", binding.viewerAuthorizationExpiresAt());
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
    if (token.length() > 100) {
      throw new DomainException(401, "INVALID_TICKET", "Ticket is invalid");
    }
    String value = redis.opsForValue().getAndDelete("helm:ticket:" + JsonSupport.sha256(token));
    if (value == null) {
      throw new DomainException(401, "TICKET_EXPIRED", "Ticket has expired or was already used");
    }
    var binding = json.read(value, TicketBinding.class);
    boolean matchingPurpose = purpose.equals("VIDEO")
        ? binding.purpose().equals("NORMAL_VIDEO") || binding.purpose().equals("PRIVATE_VIDEO")
        : binding.purpose().equals(purpose);
    if (!matchingPurpose || !binding.sessionId().equals(sessionId)
        || !binding.expiresAt().isAfter(Instant.now())) {
      throw new DomainException(403, "TICKET_BINDING_MISMATCH", "Ticket does not authorize this channel");
    }
    return binding;
  }
}
