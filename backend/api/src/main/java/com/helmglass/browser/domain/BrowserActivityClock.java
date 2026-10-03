package com.helmglass.browser.domain;

import java.time.Instant;
import java.util.UUID;

/** Confirmed activity clock, independent of optimistic edits to the browser binding. */
public record BrowserActivityClock(
    UUID userId,
    UUID taskId,
    UUID sessionId,
    UUID workerId,
    UUID workerBootId,
    long allocationEpoch,
    long privacyEpoch,
    String privacyMode,
    Instant lastActivityAt,
    Instant idleDeadlineAt,
    Instant budgetDeadlineAt) {}
