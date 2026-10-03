package com.helmglass.recovery.application;

import com.helmglass.account.application.AccountCleanupService;
import com.helmglass.account.infrastructure.DeletionLedger;
import com.helmglass.account.infrastructure.repository.AccountCleanupRepository;
import com.helmglass.api.JsonSupport;
import com.helmglass.recovery.domain.RecoveryProof;
import com.helmglass.recovery.infrastructure.repository.RecoveryRepository;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** One-shot recovery: external evidence, durable fencing, ledger replay and confirmed purge. */
@Service
public class RecoveryService {
  private final RecoveryRepository recovery;
  private final AccountCleanupRepository cleanup;
  private final AccountCleanupService accountCleanup;
  private final DeletionLedger ledger;
  private final JsonSupport json;
  private final TransactionTemplate transaction;

  public RecoveryService(
      RecoveryRepository recovery,
      AccountCleanupRepository cleanup,
      AccountCleanupService accountCleanup,
      DeletionLedger ledger,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.recovery = recovery;
    this.cleanup = cleanup;
    this.accountCleanup = accountCleanup;
    this.ledger = ledger;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
    transaction.setTimeout(30);
  }

  public void recover(Path directory) throws IOException {
    byte[] proofBytes;
    RecoveryProof proof;
    try {
      proofBytes = read(directory.resolve("proof.json"), 2_097_152);
      proof = json.read(new String(proofBytes, StandardCharsets.UTF_8), RecoveryProof.class);
    } catch (IOException | RuntimeException error) {
      transaction.executeWithoutResult(status -> recovery.closeAdmission());
      throw error;
    }
    String proofHash = JsonSupport.sha256(proofBytes);
    // A lost successful response is reconciled by status; old evidence cannot start another
    // restore.
    if (recovery.completed(proof.recoveryId(), proofHash)) {
      throw new IllegalStateException(
          "Recovery already completed; use its read-only status receipt");
    }
    transaction.executeWithoutResult(status -> recovery.closeAdmission());
    byte[] manifestBytes = read(directory.resolve("deletion-ledger.json"), 33_554_432);
    RecoveryProof.Manifest manifest =
        json.read(new String(manifestBytes, StandardCharsets.UTF_8), RecoveryProof.Manifest.class);
    proof.validate(manifest);
    verifyHash(manifestBytes, proof.ledgerManifestSha256());
    byte[] fencingBytes = read(directory.resolve("fencing.json"), 2_097_152);
    verifyHash(fencingBytes, proof.fencingEvidenceSha256());
    RecoveryProof.RuntimeFencing fencing =
        json.read(
            new String(fencingBytes, StandardCharsets.UTF_8), RecoveryProof.RuntimeFencing.class);
    if (!proof.runtimeFencing().equals(fencing)) {
      throw new IllegalStateException("Runtime proof differs from the inspected fencing receipt");
    }
    byte[] redisBytes = read(directory.resolve("redis.json"), 2_097_152);
    verifyHash(redisBytes, proof.redisEvidenceSha256());
    proof.validateRedis(
        json.read(
            new String(redisBytes, StandardCharsets.UTF_8), RecoveryProof.RedisReplacement.class));
    recoverVerified(proof, manifest, proofHash);
  }

  public RecoveryRepository.Receipt status(Path directory) throws IOException {
    byte[] bytes = read(directory.resolve("proof.json"), 2_097_152);
    RecoveryProof proof = json.read(new String(bytes, StandardCharsets.UTF_8), RecoveryProof.class);
    return recovery.receipt(proof.recoveryId(), JsonSupport.sha256(bytes));
  }

  void recoverVerified(RecoveryProof proof, RecoveryProof.Manifest manifest, String proofHash) {
    Instant deadline = Instant.now().plus(Duration.ofMinutes(30));
    String state = transaction.execute(status -> recovery.begin(proof, proofHash));
    UUID id = proof.recoveryId();
    if ("FENCING".equals(state)) {
      while (!Boolean.TRUE.equals(transaction.execute(status -> recovery.fenceBatch(id)))) {
        requireTime(deadline);
      }
      state = "LEDGER";
    }
    if ("LEDGER".equals(state)) {
      mergeLedger(id, manifest, deadline);
      while (!Boolean.TRUE.equals(
          transaction.execute(status -> recovery.closeFencedRuntimeBatch()))) {
        requireTime(deadline);
      }
      transaction.executeWithoutResult(status -> recovery.phase(id, "PURGING"));
    }
    while (recovery.pendingDeletions()) {
      requireTime(deadline);
      var due = cleanup.duePurges();
      if (due.isEmpty()) {
        throw new IllegalStateException(
            "Recovery is fenced; account cleanup requires a later retry or provider"
                + " reconciliation");
      }
      for (UUID request : due) {
        accountCleanup.processPurge(request);
      }
    }
    transaction.executeWithoutResult(status -> recovery.complete(id));
  }

  private void mergeLedger(UUID recoveryId, RecoveryProof.Manifest manifest, Instant deadline) {
    Set<String> expected = new HashSet<>();
    for (var object : manifest.entries()) {
      requireTime(deadline);
      var entry = ledger.restoreIndependent(object.key(), object.sha256());
      if (entry.purgeStartedAt().isAfter(manifest.capturedAt())) {
        throw new IllegalStateException("Deletion entry is newer than its independent manifest");
      }
      expected.add(object.key());
      transaction.executeWithoutResult(status -> recovery.mergeDeletion(recoveryId, entry));
    }
    String cursor = null;
    Set<String> cursors = new HashSet<>();
    do {
      requireTime(deadline);
      var page = ledger.list(cursor);
      for (String key : page.keys()) {
        if (!expected.remove(key)) {
          throw new IllegalStateException(
              "Independent deletion manifest does not cover current ledger objects");
        }
      }
      cursor = page.nextCursor();
      if (cursor != null && (!cursors.add(cursor) || cursors.size() > 1000)) {
        throw new IllegalStateException("Deletion ledger listing exceeded the supported bound");
      }
    } while (cursor != null);
    if (!expected.isEmpty()) {
      throw new IllegalStateException("Independent deletion ledger has missing objects");
    }
  }

  private static byte[] read(Path file, int limit) throws IOException {
    if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
      throw new IOException("Required recovery evidence file is absent or unsafe");
    }
    try (var input = Files.newInputStream(file)) {
      byte[] bytes = input.readNBytes(limit + 1);
      if (bytes.length > limit) {
        throw new IOException("Recovery evidence exceeds its supported size");
      }
      return bytes;
    }
  }

  private static void verifyHash(byte[] bytes, String expected) {
    if (!JsonSupport.sha256(bytes).equals(expected)) {
      throw new IllegalStateException("Recovery evidence checksum does not match the proof");
    }
  }

  private static void requireTime(Instant deadline) {
    if (!Instant.now().isBefore(deadline)) {
      throw new IllegalStateException("Recovery remains fenced after its bounded execution window");
    }
  }
}
