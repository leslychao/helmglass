package com.helmglass.artifact.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.helmglass.api.DomainException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

public final class ArtifactContracts {
  public static final long MAX_BYTES = 268_435_456;
  public static final int PART_BYTES = 16_777_216;
  public static final int MAX_SCREENSHOT_BYTES = 16_777_216;

  private ArtifactContracts() {}

  public enum SourceKind {
    FILE,
    STREAM_SEGMENTS,
    PLAYBACK_CAPTURE
  }

  public enum Coverage {
    FULL,
    PARTIAL,
    UNKNOWN
  }

  public enum Quality {
    MIXED_AUDIO,
    LATE_CAPTURE,
    LIMIT_REACHED,
    PLAYBACK_CHANGED
  }

  public enum PlaybackState {
    PLAYING,
    PAUSED,
    ENDED
  }

  public sealed interface CaptureMetadata permits Metadata, ScreenshotMetadata {
    int schemaVersion();

    UUID commandId();

    UUID attemptId();

    UUID browserSessionId();

    long allocationEpoch();

    long pageEpoch();

    long privacyEpoch();

    String kind();

    String mimeType();

    long byteLength();

    String sha256();
  }

  public record ScreenshotViewport(@Min(1) @Max(4096) int width, @Min(1) @Max(4096) int height) {}

  public record ScreenshotMetadata(
      @Min(1) @Max(1) int schemaVersion,
      @NotNull UUID commandId,
      @NotNull UUID attemptId,
      @NotNull UUID browserSessionId,
      @Min(1) long allocationEpoch,
      @Min(1) long pageEpoch,
      @Min(1) long privacyEpoch,
      @NotNull @Pattern(regexp = "SCREENSHOT") String kind,
      @NotNull @Pattern(regexp = "image/png") String mimeType,
      @Min(1) @Max(MAX_SCREENSHOT_BYTES) long byteLength,
      @NotNull @Pattern(regexp = "[a-f0-9]{64}") String sha256,
      @NotNull @Pattern(regexp = "BROWSER_SCREENSHOT") String sourceKind,
      @Valid @NotNull ScreenshotViewport viewport)
      implements CaptureMetadata {}

  public record TimelineEvent(
      @NotNull @DecimalMin("0") @DecimalMax("1800") BigDecimal recordingSeconds,
      @NotNull @DecimalMin("0") @DecimalMax("86400") BigDecimal sourceSeconds,
      @NotNull PlaybackState state,
      @NotNull @DecimalMin("0.0625") @DecimalMax("16") BigDecimal playbackRate,
      @NotNull Boolean muted,
      @NotNull @DecimalMin("0") @DecimalMax("1") BigDecimal volume) {}

  public record Interval(
      @NotNull @DecimalMin("0") BigDecimal startSeconds,
      @NotNull @DecimalMin(value = "0", inclusive = false) BigDecimal endSeconds) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Metadata(
      @Min(1) @Max(1) int schemaVersion,
      @NotNull UUID commandId,
      @NotNull UUID attemptId,
      @NotNull UUID browserSessionId,
      @Min(0) long allocationEpoch,
      @Min(0) long pageEpoch,
      @Min(0) long privacyEpoch,
      @NotNull @Pattern(regexp = "AUDIO") String kind,
      @NotBlank @Size(max = 128) String mimeType,
      @Min(1) @Max(MAX_BYTES) long byteLength,
      @NotNull @Pattern(regexp = "[a-f0-9]{64}") String sha256,
      @NotNull SourceKind sourceKind,
      @NotNull Coverage coverage,
      @NotNull @Size(max = 1000) List<@Valid Interval> coveredIntervals,
      @NotNull @DecimalMin(value = "0", inclusive = false) @DecimalMax("1800")
          BigDecimal durationSeconds,
      @NotBlank @Size(max = 80) String codec,
      @Min(1) @Max(32) int channels,
      @Min(8000) @Max(384000) int sampleRate,
      @NotNull @Size(max = 4) List<@NotNull Quality> quality,
      @Size(max = 1000) List<@Valid TimelineEvent> captureTimeline)
      implements CaptureMetadata {
    public void validateTimeline() {
      BigDecimal end = BigDecimal.ZERO;
      for (Interval interval : coveredIntervals) {
        if (interval.startSeconds().compareTo(end) < 0
            || interval.endSeconds().compareTo(interval.startSeconds()) <= 0) {
          throw new DomainException(
              422,
              "ARTIFACT_TIMELINE_INVALID",
              "Source coverage intervals must be ordered and non-overlapping");
        }
        end = interval.endSeconds();
      }
      if (captureTimeline != null) {
        BigDecimal recordedAt = BigDecimal.ZERO;
        for (TimelineEvent event : captureTimeline) {
          if (event.recordingSeconds().compareTo(recordedAt) < 0) {
            throw new DomainException(
                422, "ARTIFACT_TIMELINE_INVALID", "Capture timeline must follow recording order");
          }
          recordedAt = event.recordingSeconds();
        }
      }
    }
  }

  public record Allocation(UUID artifactId, UUID transferId, String transferToken) {
    @Override
    public String toString() {
      return "ArtifactAllocation[redacted]";
    }
  }

  public record Receipt(UUID artifactId, String sha256, long byteLength, String state) {}
}
