package com.helmglass.account.infrastructure;

import com.helmglass.api.JsonSupport;
import com.helmglass.bootstrap.RuntimeSecrets;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Arrays;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Immutable transport copy on the installation's independently managed encrypted off-host mount.
 */
@Component
public class IndependentDeletionStore {
  private static final int MAX_ENTRY_BYTES = 4096;
  private static final String KEY_PATTERN =
      "control/deletions/[a-f0-9]{64}/"
          + "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json";
  private final Path directory;
  private final String installationId;
  private final JsonSupport json;

  @Autowired
  public IndependentDeletionStore(
      @Value("${helm.deletion-ledger-directory:}") String directory,
      RuntimeSecrets secrets,
      JsonSupport json) {
    this(directory.isBlank() ? null : Path.of(directory), secrets.installationId(), json);
  }

  IndependentDeletionStore(Path directory, String installationId, JsonSupport json) {
    this.directory = directory;
    this.installationId = installationId;
    this.json = json;
  }

  public record Binding(int schemaVersion, String installationId) {}

  public void record(String key, byte[] bytes) {
    if (key == null
        || !key.matches(KEY_PATTERN)
        || bytes == null
        || bytes.length == 0
        || bytes.length > MAX_ENTRY_BYTES) {
      throw new IllegalArgumentException("Invalid independent deletion entry");
    }
    try {
      verifyBinding();
      String filename = key.substring(DeletionLedger.PREFIX.length()).replace('/', '-');
      Path destination = directory.resolve(filename);
      if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
        verifyEntry(destination, bytes);
        forceDirectory();
        return;
      }
      Path pending =
          Files.createTempFile(
              directory,
              ".pending-",
              ".json",
              PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
      try {
        try (var channel =
            FileChannel.open(pending, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
          ByteBuffer buffer = ByteBuffer.wrap(bytes);
          while (buffer.hasRemaining()) {
            channel.write(buffer);
          }
          channel.force(true);
        }
        try {
          Files.createLink(destination, pending);
        } catch (FileAlreadyExistsException error) {
          verifyEntry(destination, bytes);
        }
        forceDirectory();
        verifyEntry(destination, bytes);
      } finally {
        Files.deleteIfExists(pending);
      }
    } catch (IOException error) {
      throw new IllegalStateException("Independent deletion ledger is unavailable", error);
    }
  }

  public byte[] readVerified(String key, String checksum) {
    if (key == null
        || !key.matches(KEY_PATTERN)
        || checksum == null
        || !checksum.matches("[a-f0-9]{64}")) {
      throw new IllegalArgumentException("Invalid independent deletion entry reference");
    }
    try {
      verifyBinding();
      String filename = key.substring(DeletionLedger.PREFIX.length()).replace('/', '-');
      byte[] bytes = readBounded(directory.resolve(filename));
      if (!JsonSupport.sha256(bytes).equals(checksum)) {
        throw new IllegalStateException("Independent deletion entry differs from its manifest");
      }
      return bytes;
    } catch (IOException error) {
      throw new IllegalStateException("Independent deletion ledger could not be read", error);
    }
  }

  private void verifyBinding() throws IOException {
    if (directory == null
        || !directory.isAbsolute()
        || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
        || !directory.normalize().equals(directory.toRealPath())) {
      throw new IllegalStateException("An independent deletion ledger mount is required");
    }
    Set<PosixFilePermission> privatePermissions = PosixFilePermissions.fromString("rwx------");
    if (!privatePermissions.containsAll(
        Files.getPosixFilePermissions(directory, LinkOption.NOFOLLOW_LINKS))) {
      throw new IllegalStateException("Independent deletion ledger directory must be private");
    }
    Path marker = directory.resolve(".helm-ledger.json");
    byte[] bytes = readBounded(marker);
    Binding binding = json.read(new String(bytes, StandardCharsets.UTF_8), Binding.class);
    if (binding.schemaVersion() != 1 || !installationId.equals(binding.installationId())) {
      throw new IllegalStateException(
          "Independent deletion ledger belongs to another installation");
    }
  }

  private static void verifyEntry(Path path, byte[] expected) throws IOException {
    if (!Arrays.equals(readBounded(path), expected)) {
      throw new IllegalStateException("Independent deletion ledger entry conflicts with its owner");
    }
  }

  private static byte[] readBounded(Path path) throws IOException {
    if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
      throw new IllegalStateException("Independent deletion ledger entry is not a regular file");
    }
    try (var input = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
      byte[] bytes = input.readNBytes(MAX_ENTRY_BYTES + 1);
      if (bytes.length == 0 || bytes.length > MAX_ENTRY_BYTES) {
        throw new IllegalStateException("Independent deletion ledger entry exceeds its limit");
      }
      return bytes;
    }
  }

  private void forceDirectory() throws IOException {
    try (var channel = FileChannel.open(directory, StandardOpenOption.READ)) {
      channel.force(true);
    }
  }
}
