package com.helmglass.identity.domain;

import com.helmglass.api.DomainException;
import java.util.Set;
import java.util.UUID;

public record AuthenticatedActor(UUID userId, UUID loginId, UUID grantId, String clientId,
    String displayName, String email, long accessEpoch, Set<String> permissions, boolean mcp) {
  public void requireScope(String scope) {
    if (mcp && !permissions.contains(scope)) {
      throw new DomainException(403, "SCOPE_REQUIRED", "Required permission is missing");
    }
  }

  public void requireAdmin() {
    if (mcp || !permissions.contains("platform_admin")) {
      throw new DomainException(403, "ADMIN_REQUIRED", "Administrator access is required");
    }
  }
}
