package com.helmglass.realtime.domain;

import java.util.Map;
import java.util.UUID;

/** Exact media consumer identity; requestId remains stable across outbox delivery attempts. */
public record ViewerFence(
    UUID requestId,
    UUID workerId,
    UUID workerBootId,
    UUID browserSessionId,
    long allocationEpoch,
    UUID viewerId,
    long viewGeneration) {

  public Map<String, Object> binding() {
    return Map.of(
        "workerBootId",
        workerBootId,
        "browserSessionId",
        browserSessionId,
        "allocationEpoch",
        allocationEpoch,
        "viewerId",
        viewerId,
        "viewGeneration",
        viewGeneration);
  }
}
