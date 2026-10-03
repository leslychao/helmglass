package com.helmglass.account.infrastructure;

import com.helmglass.account.infrastructure.repository.AccountCleanupRepository.Purge;
import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.services.s3.model.S3Exception;

/** Immutable external tombstones are written before any irreversible purge effect. */
@Component
public class DeletionLedger {
  public static final String BUCKET = "hg-staging";
  public static final String PREFIX = "control/deletions/";
  private static final int MAX_ENTRY_BYTES = 4096;
  private final ObjectStorage storage;
  private final JsonSupport json;
  private final IndependentDeletionStore independent;

  public DeletionLedger(
      ObjectStorage storage, JsonSupport json, IndependentDeletionStore independent) {
    this.storage = storage;
    this.json = json;
    this.independent = independent;
  }

  public record Entry(
      int schemaVersion,
      UUID requestId,
      UUID userId,
      String identityHash,
      Instant purgeStartedAt) {}

  public String record(Purge purge) {
    var entry =
        new Entry(1, purge.id(), purge.userId(), purge.identityHash(), purge.purgeStartedAt());
    String encoded = json.write(entry);
    String checksum = JsonSupport.sha256(encoded);
    String key = key(entry);
    byte[] bytes = encoded.getBytes(StandardCharsets.UTF_8);
    // The independently durable entry precedes all destructive effects, including S3-side purge.
    independent.record(key, bytes);
    store(key, bytes, checksum);
    Entry persisted = read(key);
    if (!persisted.equals(entry)) {
      throw DomainException.conflict(
          "DELETION_LEDGER_CONFLICT", "Deletion record differs from the persisted tombstone");
    }
    return checksum;
  }

  /** Imports only an independently verified tombstone before recovery can expose account data. */
  public Entry restoreIndependent(String key, String checksum) {
    byte[] bytes = independent.readVerified(key, checksum);
    Entry entry = decode(key, bytes, checksum);
    store(key, bytes, checksum);
    readVerified(key, checksum);
    return entry;
  }

  private void store(String key, byte[] bytes, String checksum) {
    if (storage.metadata(BUCKET, key).isEmpty()) {
      try {
        storage.putImmutable(
            BUCKET,
            key,
            new ByteArrayInputStream(bytes),
            bytes.length,
            checksum,
            "application/json");
      } catch (S3Exception error) {
        // A conflict or an unknown remote result is resolved by reading this exact immutable key.
        if (storage.metadata(BUCKET, key).isEmpty()) {
          throw error;
        }
      }
    }
  }

  public ObjectStorage.ObjectPage list(String cursor) {
    return storage.list(BUCKET, PREFIX, cursor);
  }

  public Entry read(String key) {
    return readVerified(key, null);
  }

  public Entry readVerified(String key, String expectedChecksum) {
    if (!key.startsWith(PREFIX) || !key.endsWith(".json")) {
      throw new IllegalArgumentException("Invalid deletion ledger key");
    }
    try (var body = storage.open(BUCKET, key)) {
      byte[] bytes = body.readNBytes(MAX_ENTRY_BYTES + 1);
      if (bytes.length > MAX_ENTRY_BYTES) {
        throw new IllegalStateException("Deletion ledger entry exceeds the supported size");
      }
      return decode(key, bytes, expectedChecksum);
    } catch (IOException error) {
      throw new IllegalStateException("Deletion ledger could not be verified", error);
    }
  }

  private Entry decode(String key, byte[] bytes, String expectedChecksum) {
    if (expectedChecksum != null && !JsonSupport.sha256(bytes).equals(expectedChecksum)) {
      throw new IllegalStateException(
          "Deletion ledger checksum differs from the independent manifest");
    }
    Entry entry = json.read(new String(bytes, StandardCharsets.UTF_8), Entry.class);
    if (entry.schemaVersion() != 1
        || entry.requestId() == null
        || entry.userId() == null
        || entry.identityHash() == null
        || !entry.identityHash().matches("[a-f0-9]{64}")
        || entry.purgeStartedAt() == null
        || !key(entry).equals(key)) {
      throw new IllegalStateException("Deletion ledger entry is invalid");
    }
    return entry;
  }

  private static String key(Entry entry) {
    return PREFIX + entry.identityHash() + "/" + entry.requestId() + ".json";
  }
}
