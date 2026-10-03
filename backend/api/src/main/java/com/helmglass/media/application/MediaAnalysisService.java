package com.helmglass.media.application;

import com.helmglass.api.DomainException;
import com.helmglass.artifact.application.ArtifactService;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import java.math.RoundingMode;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/** Prepares saved source audio for the caller; it never runs recognition or starts a capture. */
@Service
public class MediaAnalysisService {
  private final ArtifactService artifacts;
  private final UserPolicyService policies;

  public MediaAnalysisService(ArtifactService artifacts, UserPolicyService policies) {
    this.artifacts = artifacts;
    this.policies = policies;
  }

  public Map<String, Object> get(AuthenticatedActor actor, UUID artifactId, UUID expectedTaskId) {
    var source = artifacts.audioSource(actor, artifactId);
    if (expectedTaskId != null && !source.taskId().equals(expectedTaskId)) {
      throw DomainException.notFound();
    }
    policies.authorize(actor.userId(), "READ_MEDIA", null);
    var metadata = source.metadata();
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("type", "audio_observation");
    result.put("schemaVersion", 1);
    result.put("artifactId", artifactId);
    result.put("taskId", source.taskId());
    result.put("artifactState", "READY");
    result.put("sha256", source.sha256());
    result.put("mimeType", source.mimeType());
    result.put("byteLength", source.byteLength());
    result.put("durationMs", metadata.durationSeconds().movePointRight(3)
        .setScale(0, RoundingMode.HALF_UP).longValueExact());
    result.put("codec", metadata.codec());
    result.put("channels", metadata.channels());
    result.put("sampleRate", metadata.sampleRate());
    result.put("timeOrigin", "ARTIFACT_START");
    result.put("source", Map.of("kind", metadata.sourceKind(), "coverage", metadata.coverage(),
        "coveredIntervals", metadata.coveredIntervals(), "intervalTimeOrigin", "SOURCE_START"));
    result.put("qualityFlags", metadata.quality());
    if (metadata.captureTimeline() != null) {
      result.put("captureTimeline", metadata.captureTimeline());
    }
    result.put("contentPath", "/api/v1/artifacts/" + artifactId + "/content");
    result.put("delivery", Map.of("status", "UNVERIFIED", "reason", "HOST_AUDIO_ACCESS_NOT_VERIFIED"));
    result.put("captions", Map.of("status", "UNAVAILABLE", "reason", "NO_SAVED_CAPTIONS"));
    result.put("acoustics", Map.of("status", "NOT_REQUESTED"));
    return result;
  }

  public Map<String, Object> segments(AuthenticatedActor actor, UUID artifactId, UUID expectedTaskId,
      String component, String cursor, int limit) {
    if (!List.of("CAPTIONS", "ACOUSTICS").contains(component) || limit < 1 || limit > 100
        || cursor != null && !cursor.isEmpty()) {
      throw new DomainException(422, "AUDIO_SEGMENTS_QUERY_INVALID", "Invalid saved audio segment query");
    }
    get(actor, artifactId, expectedTaskId);
    // No capture currently commits captions or acoustics. Absence is explicit and never starts
    // inference or fabricates timestamps. A future supported source must persist its provenance.
    return Map.of("artifactId", artifactId, "component", component, "items", List.of(),
        "hasMore", false, "status", "UNAVAILABLE", "reason",
        component.equals("CAPTIONS") ? "NO_SAVED_CAPTIONS" : "ACOUSTICS_NOT_REQUESTED");
  }
}
