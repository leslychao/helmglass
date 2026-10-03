package com.helmglass.profile.domain;

import java.util.List;
import java.util.UUID;

public record ProfileBinding(UUID userId, UUID connectionId, UUID profileId, long revision,
    long scopeVersion, int formatVersion, List<String> storageOrigins, List<String> cookieDomains) {
  public ProfileBinding {
    storageOrigins = List.copyOf(storageOrigins);
    cookieDomains = List.copyOf(cookieDomains);
  }
}
