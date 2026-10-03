package com.helmglass.api;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import java.util.regex.Pattern;

public record MutationContext(String key, UUID requestId) {
  private static final Pattern COMPACT_REQUEST_ID = Pattern.compile("[a-fA-F0-9]{32}");
  private static final Pattern UUID_REQUEST_ID =
      Pattern.compile(
          "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}");

  public MutationContext {
    if (key == null || key.isBlank() || key.length() > 200) {
      throw new DomainException(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required");
    }
  }

  public static MutationContext from(HttpServletRequest request) {
    String supplied = request.getHeader("X-Request-ID");
    UUID requestId = supplied == null ? UUID.randomUUID() : parseRequestId(supplied);
    request.setAttribute("helm.requestId", requestId);
    return new MutationContext(request.getHeader("Idempotency-Key"), requestId);
  }

  private static UUID parseRequestId(String value) {
    if (COMPACT_REQUEST_ID.matcher(value).matches()) {
      // Nginx's canonical $request_id is the same 128 bits without UUID separators.
      return UUID.fromString(
          value.substring(0, 8)
              + "-"
              + value.substring(8, 12)
              + "-"
              + value.substring(12, 16)
              + "-"
              + value.substring(16, 20)
              + "-"
              + value.substring(20));
    }
    if (!UUID_REQUEST_ID.matcher(value).matches()) {
      throw new DomainException(
          400, "REQUEST_ID_INVALID", "Request correlation ID has an invalid format");
    }
    return UUID.fromString(value);
  }
}
