package com.helmglass.realtime.domain;

import java.util.UUID;

/** Browser-owner authorization snapshot for normal, read-only widget media. */
public record BrowserMediaBinding(
    UUID sessionId,
    UUID workerId,
    UUID workerBootId,
    long allocationEpoch,
    long controlEpoch,
    long pageEpoch,
    long privacyEpoch,
    long mediaGeneration,
    String unavailableReason) {
  public boolean available() {
    return unavailableReason == null;
  }
}
