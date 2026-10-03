package com.helmglass.recovery.domain;

import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Read-only launcher evidence; the launcher must inspect the complete original Docker runtime. */
public record RecoveryProof(
    int schemaVersion,
    UUID recoveryId,
    String backupId,
    String restorePoint,
    String walLossWindow,
    boolean runtimeFenced,
    RuntimeFencing runtimeFencing,
    String fencingEvidenceSha256,
    boolean transientRedisDiscarded,
    String redisEvidenceSha256,
    String ledgerManifestSha256) {
  public record RuntimeFencing(
      String daemonId,
      Instant observedAt,
      List<String> expectedContainerIds,
      List<Container> containers) {}

  public record Container(String containerId, String service, String state) {}

  public record Manifest(
      int schemaVersion,
      UUID recoveryId,
      String backupId,
      String restorePoint,
      Instant capturedAt,
      String source,
      List<LedgerObject> entries) {}

  public record LedgerObject(String key, String sha256) {}

  public record RedisReplacement(
      int schemaVersion,
      UUID recoveryId,
      String daemonId,
      String volume,
      String source,
      Instant observedAt) {}

  public void validateRedis(RedisReplacement redis) {
    require(
        redis != null
            && redis.schemaVersion() == 1
            && recoveryId.equals(redis.recoveryId())
            && runtimeFencing.daemonId().equals(redis.daemonId())
            && ("helm-glass-redis-recovery-" + recoveryId).equals(redis.volume())
            && "new-empty-volume".equals(redis.source())
            && redis.observedAt() != null
            && !redis.observedAt().isBefore(runtimeFencing.observedAt())
            && !redis.observedAt().isAfter(Instant.now().plusSeconds(60)),
        "Transient Redis replacement does not match this recovery");
  }

  public void validate(Manifest manifest) {
    require(schemaVersion == 1 && recoveryId != null, "Recovery identity is missing");
    require(
        text(backupId, 200) && text(restorePoint, 500) && text(walLossWindow, 1000),
        "Recovery boundary is missing");
    require(
        runtimeFenced
            && transientRedisDiscarded
            && checksum(fencingEvidenceSha256)
            && checksum(redisEvidenceSha256)
            && checksum(ledgerManifestSha256),
        "Recovery evidence is incomplete");
    require(
        runtimeFencing != null
            && text(runtimeFencing.daemonId(), 200)
            && runtimeFencing.observedAt() != null
            && !runtimeFencing.observedAt().isAfter(Instant.now().plusSeconds(60)),
        "Runtime inspection is missing");
    var expected = runtimeFencing.expectedContainerIds();
    var containers = runtimeFencing.containers();
    require(
        expected != null
            && !expected.isEmpty()
            && expected.size() <= 1024
            && containers != null
            && containers.size() == expected.size(),
        "Runtime inventory is incomplete");
    Set<String> expectedIds = new HashSet<>(expected);
    require(expectedIds.size() == expected.size(), "Runtime inventory contains duplicates");
    Set<String> observed = new HashSet<>();
    for (Container container : containers) {
      require(
          container != null
              && checksum(container.containerId())
              && text(container.service(), 80)
              && container.state() != null
              && Set.of("created", "exited", "dead", "absent").contains(container.state())
              && observed.add(container.containerId()),
          "A previous runtime is not confirmed stopped");
    }
    require(
        observed.equals(expectedIds), "Runtime inventory does not cover the previous installation");
    require(
        manifest != null
            && manifest.schemaVersion() == 1
            && recoveryId.equals(manifest.recoveryId())
            && backupId.equals(manifest.backupId())
            && restorePoint.equals(manifest.restorePoint())
            && "independent-current".equals(manifest.source())
            && manifest.capturedAt() != null
            && !manifest.capturedAt().isBefore(runtimeFencing.observedAt())
            && !manifest.capturedAt().isAfter(Instant.now().plusSeconds(60))
            && manifest.entries() != null
            && manifest.entries().size() <= 100_000,
        "Current independent deletion ledger evidence is missing");
    Set<String> keys = new HashSet<>();
    for (LedgerObject entry : manifest.entries()) {
      require(
          entry != null
              && text(entry.key(), 300)
              && checksum(entry.sha256())
              && keys.add(entry.key()),
          "Deletion manifest contains an invalid or duplicate entry");
    }
  }

  private static boolean text(String value, int maximum) {
    return value != null && !value.isBlank() && value.length() <= maximum;
  }

  private static boolean checksum(String value) {
    return value != null && value.matches("[a-f0-9]{64}");
  }

  private static void require(boolean valid, String message) {
    if (!valid) {
      throw new IllegalStateException(message);
    }
  }
}
