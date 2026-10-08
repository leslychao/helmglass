package ru.helmglass.api.auth;

import java.time.Instant;
import java.util.Set;
import java.util.UUID;

public record Actor(
    UUID id,
    Set<String> roles,
    String channel,
    String sessionId,
    Instant authenticatedAt,
    Instant expiresAt) {
  public boolean administrator() {
    return "WEB".equals(channel) && roles.contains("ADMIN");
  }
}
