package com.helmglass.account.infrastructure;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.helmglass.account.infrastructure.repository.AccountCleanupRepository.Purge;
import com.helmglass.api.JsonSupport;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

class IndependentDeletionStoreTest {
  private static final String INSTALLATION = "independent-ledger-fixture";
  private final JsonSupport json = new JsonSupport(JsonMapper.builder().build());
  private final String key =
      DeletionLedger.PREFIX + "a".repeat(64) + "/" + UUID.randomUUID() + ".json";

  @TempDir Path directory;

  @BeforeEach
  void bindDirectory() throws Exception {
    Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
    Files.writeString(
        directory.resolve(".helm-ledger.json"),
        json.write(new IndependentDeletionStore.Binding(1, INSTALLATION)));
  }

  @Test
  void immutableEntrySurvivesNewOwnerAndRejectsConflictingReplay() {
    byte[] bytes = "persisted-independent-entry".getBytes(StandardCharsets.UTF_8);
    var store = new IndependentDeletionStore(directory, INSTALLATION, json);
    store.record(key, bytes);
    store.record(key, bytes);
    var reopened = new IndependentDeletionStore(directory, INSTALLATION, json);
    assertThat(reopened.readVerified(key, JsonSupport.sha256(bytes))).isEqualTo(bytes);
    assertThatThrownBy(() -> store.record(key, new byte[] {1, 2, 3}))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("conflicts");
    assertThatThrownBy(() -> reopened.readVerified(key, "0".repeat(64)))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("manifest");
    assertThat(reopened.readVerified(key, JsonSupport.sha256(bytes))).isEqualTo(bytes);
  }

  @Test
  void concurrentSameEntryHasOneImmutablePublicationAndNoPendingFiles() throws Exception {
    byte[] bytes = "one-independent-entry".getBytes(StandardCharsets.UTF_8);
    var store = new IndependentDeletionStore(directory, INSTALLATION, json);
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
      var pending = new ArrayList<Future<?>>();
      for (int index = 0; index < 16; index++) {
        pending.add(executor.submit(() -> store.record(key, bytes)));
      }
      for (Future<?> operation : pending) {
        operation.get(10, TimeUnit.SECONDS);
      }
    }
    try (var entries = Files.list(directory)) {
      assertThat(entries.map(path -> path.getFileName().toString()).toList())
          .hasSize(2)
          .noneMatch(name -> name.startsWith(".pending-"));
    }
  }

  @Test
  void absentForeignPublicOrLinkedDirectoryCannotBeUsedAsIndependentProof() throws Exception {
    byte[] bytes = new byte[] {1};
    assertThatThrownBy(
            () -> new IndependentDeletionStore((Path) null, INSTALLATION, json).record(key, bytes))
        .isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(
            () -> new IndependentDeletionStore(directory, "foreign", json).record(key, bytes))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("another installation");
    Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
    assertThatThrownBy(
            () -> new IndependentDeletionStore(directory, INSTALLATION, json).record(key, bytes))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("private");
    Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
    Path linked = directory.resolve("linked");
    Files.createSymbolicLink(linked, directory);
    assertThatThrownBy(
            () -> new IndependentDeletionStore(linked, INSTALLATION, json).record(key, bytes))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("mount");
    String filename = key.substring(DeletionLedger.PREFIX.length()).replace('/', '-');
    Files.createSymbolicLink(directory.resolve(filename), directory.resolve(".helm-ledger.json"));
    assertThatThrownBy(
            () -> new IndependentDeletionStore(directory, INSTALLATION, json).record(key, bytes))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("regular");
  }

  @Test
  void missingIndependentCopyStopsCanonicalLedgerBeforeStorageEffects() {
    ObjectStorage storage = mock(ObjectStorage.class);
    var unavailable = new IndependentDeletionStore((Path) null, INSTALLATION, json);
    var ledger = new DeletionLedger(storage, json, unavailable);
    var purge =
        new Purge(
            UUID.randomUUID(),
            UUID.randomUUID(),
            "PURGING",
            Instant.now(),
            UUID.randomUUID(),
            Instant.now(),
            null,
            "a".repeat(64),
            "fixture-subject");
    assertThatThrownBy(() -> ledger.record(purge)).isInstanceOf(IllegalStateException.class);
    verifyNoInteractions(storage);
  }
}
