package com.helmglass.realtime.domain;

import java.time.Instant;
import java.util.UUID;

/** Durable authority for one conversation's presentation and its currently admitted mount. */
public record ChatPresentation(
    UUID id,
    UUID userId,
    String clientId,
    String verifiedCorrelation,
    UUID taskId,
    long presentationRevision,
    UUID activeViewerInstanceId,
    long viewGeneration,
    String transferState,
    UUID grantId,
    long grantVersion,
    long accessEpoch,
    Instant viewerLeaseExpiresAt,
    Instant viewerAuthorizationExpiresAt,
    boolean eventsConnected,
    boolean mediaConnected,
    Instant mediaTicketExpiresAt,
    long controlEpoch,
    long pageEpoch,
    long privacyEpoch,
    long mediaGeneration,
    UUID browserSessionId,
    UUID workerId,
    UUID workerBootId,
    long allocationEpoch,
    Instant retiredAt) {

  public boolean current(UUID task, long revision) {
    return retiredAt == null && taskId.equals(task) && presentationRevision == revision;
  }

  public boolean viewerLeaseActive(Instant now) {
    return activeViewerInstanceId != null
        && viewerLeaseExpiresAt != null
        && viewerLeaseExpiresAt.isAfter(now)
        && viewerAuthorizationExpiresAt != null
        && viewerAuthorizationExpiresAt.isAfter(now);
  }
}
