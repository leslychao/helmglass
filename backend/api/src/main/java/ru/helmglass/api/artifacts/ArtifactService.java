package ru.helmglass.api.artifacts;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.channels.Channels;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SecureDirectoryStream;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributeView;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.browsers.WorkerClient;
import ru.helmglass.api.events.EventService;
import tools.jackson.databind.JsonNode;

@Service
public class ArtifactService {
  private final JdbcClient jdbc;
  private final WorkerClient worker;
  private final EventService events;
  private final Path directory;
  private final JsonSupport json;
  private final TransactionTemplate transactions;
  private final Semaphore registrations = new Semaphore(2);
  private final Semaphore waitingCalls = new Semaphore(16);
  private final Map<UUID, Delivery> deliveries = new ConcurrentHashMap<>();

  public ArtifactService(
      JdbcClient jdbc,
      WorkerClient worker,
      EventService events,
      PlatformTransactionManager manager,
      JsonSupport json,
      @Value("${helm.artifact-directory}") String directory)
      throws IOException {
    this.jdbc = jdbc;
    this.transactions = new TransactionTemplate(manager);
    this.worker = worker;
    this.events = events;
    this.json = json;
    this.directory = Path.of(directory).toAbsolutePath().normalize();
    Files.createDirectories(this.directory);
  }

  public void importResults(UUID owner, UUID task, UUID session, UUID operation, JsonNode result) {
    if (result == null) {
      return;
    }
    JsonNode artifacts = result.path("artifacts");
    if (artifacts.isArray()) {
      for (JsonNode artifact : artifacts) {
        importArtifact(owner, task, session, operation, artifact);
      }
    }
    JsonNode artifact = result.path("artifact");
    if (artifact.isObject()) {
      importArtifact(owner, task, session, operation, artifact);
    }
  }

  public boolean importSessionBatch(UUID session) {
    var source =
        jdbc.sql("SELECT owner_id,task_id,artifact_cursor FROM browser_sessions WHERE id=:id")
            .param("id", session)
            .query(
                (row, index) ->
                    new Source(
                        row.getObject("owner_id", UUID.class),
                        row.getObject("task_id", UUID.class),
                        row.getLong("artifact_cursor")))
            .single();
    if (source.task() == null) {
      return true;
    }
    JsonNode page =
        worker.call(
            "GET",
            "/sessions/" + session + "/artifacts?after=" + source.cursor(),
            null);
    if (!page.path("artifacts").isArray()
        || page.path("artifacts").size() > 100
        || !page.path("nextCursor").isIntegralNumber()
        || page.path("nextCursor").asLong() < source.cursor()
        || !page.path("hasMore").isBoolean()
        || page.path("hasMore").asBoolean()
            && page.path("nextCursor").asLong() <= source.cursor()) {
      throw ApiException.conflict(
          "ARTIFACT_MANIFEST_INVALID", "Список исходных файлов не подтверждён.");
    }
    for (JsonNode metadata : page.path("artifacts")) {
      UUID operation =
          metadata.path("operationId").isString()
              ? UUID.fromString(metadata.path("operationId").asString())
              : null;
      importArtifact(source.owner(), source.task(), session, operation, metadata);
    }
    jdbc.sql("UPDATE browser_sessions SET artifact_cursor=:cursor WHERE id=:id")
        .param("cursor", page.path("nextCursor").asLong(source.cursor()))
        .param("id", session)
        .update();
    return !page.path("hasMore").asBoolean();
  }

  private record Source(UUID owner, UUID task, long cursor) {}

  private void importArtifact(
      UUID owner, UUID task, UUID session, UUID operation, JsonNode metadata) {
    try {
      registrations.acquire();
      try {
        registerArtifact(owner, task, session, operation, metadata);
      } finally {
        registrations.release();
      }
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw ApiException.conflict(
          "REGISTRATION_INTERRUPTED", "Проверка результата прервана; она будет продолжена.");
    }
  }

  private void registerArtifact(
      UUID owner, UUID task, UUID session, UUID operation, JsonNode metadata) {
    if (!metadata.path("sizeBytes").isIntegralNumber()
        || metadata.path("sizeBytes").asLong() <= 0
        || metadata.path("sizeBytes").asLong() > 2_147_483_648L
        || !metadata.path("sha256").isString()
        || !metadata.path("sha256").asString().matches("[a-fA-F0-9]{64}")) {
      throw ApiException.invalid("artifact", "Для проверки нужны размер и SHA-256 файла.");
    }
    long expectedSize = metadata.path("sizeBytes").asLong();
    String expectedHash = metadata.path("sha256").asString().toLowerCase(Locale.ROOT);
    UUID id = UUID.fromString(metadata.path("id").asString());
    boolean belongs =
        jdbc.sql(
                "SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE id=:session"
                    + " AND owner_id=:owner AND task_id=:task)")
            .param("session", session)
            .param("owner", owner)
            .param("task", task)
            .query(Boolean.class)
            .single();
    if (!belongs) {
      throw ApiException.notFound();
    }
    if (operation != null
        && !jdbc.sql(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE id=:operation AND owner_id=:owner"
                    + " AND task_id=:task AND session_id=:session)")
            .param("operation", operation)
            .param("owner", owner)
            .param("task", task)
            .param("session", session)
            .query(Boolean.class)
            .single()) {
      throw ApiException.notFound();
    }
    String name = metadata.path("name").asString("file");
    String mime = metadata.path("mimeType").asString("application/octet-stream");
    if (name.length() > 300 || mime.length() > 150) {
      throw ApiException.invalid("artifact", "Некорректные свойства файла.");
    }
    // Persist the receipt before publication so a crash after rename can finish the same record.
    jdbc.sql(
            """
            INSERT INTO artifacts(id,owner_id,task_id,operation_id,name,mime_type,status,
              complete,source_url,source_ref,duration_seconds,relative_path,size_bytes,sha256)
            VALUES (:id,:owner,:task,:operation,:name,:mime,'UPLOADING',:complete,:url,:ref,
              :duration,:path,:size,:hash) ON CONFLICT(id) DO NOTHING
            """)
        .param("id", id)
        .param("owner", owner)
        .param("task", task)
        .param("operation", operation)
        .param("name", name)
        .param("mime", mime)
        .param("complete", metadata.path("complete").asBoolean(false))
        .param("url", metadata.path("sourceUrl").asString(null))
        .param("ref", metadata.path("sourceRef").asString(null))
        .param(
            "duration",
            metadata.path("durationSeconds").isNumber()
                ? metadata.path("durationSeconds").decimalValue()
                : null)
        .param("path", id.toString())
        .param("size", expectedSize)
        .param("hash", expectedHash)
        .update();
    try {
      transactions.executeWithoutResult(
          transaction -> {
            var receipt =
                jdbc.sql(
                        "SELECT owner_id,task_id,status,size_bytes,sha256"
                            + " FROM artifacts WHERE id=:id FOR UPDATE")
                    .param("id", id)
                    .query(
                        (row, index) ->
                            new Registration(
                                row.getObject("owner_id", UUID.class),
                                row.getObject("task_id", UUID.class),
                                row.getString("status"),
                                row.getObject("size_bytes", Long.class),
                                row.getString("sha256")))
                    .single();
            if (!owner.equals(receipt.owner()) || !task.equals(receipt.task())) {
              throw ApiException.notFound();
            }
            if (receipt.size() != null
                && (receipt.size() != expectedSize
                    || !expectedHash.equalsIgnoreCase(receipt.hash()))) {
              throw ApiException.conflict(
                  "ARTIFACT_INTEGRITY_MISMATCH",
                  "Квитанция исходного файла изменилась.");
            }
            if (operation != null) {
              jdbc.sql(
                      "UPDATE artifacts SET operation_id=:operation WHERE id=:id"
                          + " AND operation_id IS NULL")
                  .param("id", id)
                  .param("operation", operation)
                  .update();
            }
            if ("READY".equals(receipt.status())) {
              return;
            }
            try {
              publishFile(session, id, expectedSize, expectedHash);
            } catch (IOException exception) {
              throw new UncheckedIOException(exception);
            }
            jdbc.sql(
                    "UPDATE artifacts SET status='READY',size_bytes=:size,sha256=:hash"
                        + " WHERE id=:id")
                .param("id", id)
                .param("size", expectedSize)
                .param("hash", expectedHash)
                .update();
          });
    } catch (UncheckedIOException exception) {
      jdbc.sql(
              "UPDATE artifacts SET status='FAILED' WHERE id=:id AND owner_id=:owner"
                  + " AND status<>'READY'")
          .param("id", id)
          .param("owner", owner)
          .update();
      signalDelivery(id);
      throw ApiException.conflict(
          "ARTIFACT_REGISTRATION_FAILED",
          "Результат не прошёл проверку. Исходные данные сохранены для повторной обработки.");
    }
    signalDelivery(id);
    events.emit(owner, "artifact", id, 1);
    events.emit(owner, "task", task, 0);
  }

  private record Registration(UUID owner, UUID task, String status, Long size, String hash) {}

  private void publishFile(UUID session, UUID id, long size, String hash) throws IOException {
    if (Files.isSymbolicLink(directory)) {
      throw new IOException("Invalid artifact root");
    }
    try (var stream = Files.newDirectoryStream(directory)) {
      if (!(stream instanceof SecureDirectoryStream<Path> root)) {
        throw new IOException("Atomic secure file publication is unavailable");
      }
      Path name = Path.of(id.toString());
      try {
        attributes(root, name);
      } catch (NoSuchFileException absent) {
        try (var sessions = root.newDirectoryStream(Path.of("sessions"), LinkOption.NOFOLLOW_LINKS);
            var working =
                sessions.newDirectoryStream(
                    Path.of(session.toString()), LinkOption.NOFOLLOW_LINKS);
            var files = working.newDirectoryStream(Path.of("artifacts"), LinkOption.NOFOLLOW_LINKS)) {
          BasicFileAttributes verified = verifyFile(files, name, size, hash);
          // SecureDirectoryStream.move has ATOMIC_MOVE semantics and never streams the content.
          files.move(name, root, name);
          BasicFileAttributes published = attributes(root, name);
          if (!sameFile(verified, published)) {
            throw new IOException("Artifact changed during publication");
          }
        }
        return;
      }
      // Rename may have committed before the database did; an existing file is never overwritten.
      verifyFile(root, name, size, hash);
    }
  }

  private static BasicFileAttributes attributes(SecureDirectoryStream<Path> files, Path name)
      throws IOException {
    return files
        .getFileAttributeView(name, BasicFileAttributeView.class, LinkOption.NOFOLLOW_LINKS)
        .readAttributes();
  }

  private static boolean sameFile(BasicFileAttributes first, BasicFileAttributes second) {
    return second.isRegularFile()
        && Objects.equals(first.fileKey(), second.fileKey())
        && first.size() == second.size()
        && first.lastModifiedTime().equals(second.lastModifiedTime());
  }

  private static BasicFileAttributes verifyFile(
      SecureDirectoryStream<Path> files, Path name, long size, String hash) throws IOException {
    BasicFileAttributes before = attributes(files, name);
    if (!before.isRegularFile() || before.size() != size) {
      throw new IOException("Artifact size or type is invalid");
    }
    MessageDigest digest;
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException("SHA-256 is unavailable", exception);
    }
    long bytes = 0;
    try (InputStream input =
        Channels.newInputStream(
            files.newByteChannel(name, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)))) {
      byte[] buffer = new byte[65536];
      for (int count; (count = input.read(buffer)) != -1; ) {
        bytes += count;
        if (bytes > size) {
          throw new IOException("Artifact exceeds declared size");
        }
        digest.update(buffer, 0, count);
      }
    }
    if (bytes != size
        || !hash.equalsIgnoreCase(HexFormat.of().formatHex(digest.digest()))
        || !sameFile(before, attributes(files, name))) {
      throw new IOException("Artifact integrity mismatch");
    }
    return before;
  }

  public Contracts.Artifact get(UUID owner, UUID id) {
    return find(owner, id).orElseThrow(ApiException::notFound);
  }

  private Optional<Contracts.Artifact> find(UUID owner, UUID id) {
    return jdbc.sql("SELECT * FROM artifacts WHERE id=:id AND owner_id=:owner")
        .param("id", id)
        .param("owner", owner)
        .query(this::map)
        .optional();
  }

  private Optional<Contracts.Artifact> findReady(UUID owner, UUID id) {
    return find(owner, id).filter(ArtifactService::ready);
  }

  /** Waits for verified registration within the caller's remaining response budget. */
  public Optional<Contracts.Artifact> awaitReady(UUID owner, UUID id, long deadlineNanos) {
    if (System.nanoTime() >= deadlineNanos || !waitingCalls.tryAcquire()) {
      return findReady(owner, id);
    }
    Delivery delivery =
        deliveries.compute(
            id,
            (key, current) ->
                current == null
                    ? new Delivery(new CompletableFuture<>(), 1)
                    : new Delivery(current.signal(), current.waiters() + 1));
    try {
      // Register before reading so registration finishing here cannot lose its notification.
      var current = find(owner, id);
      long remaining = deadlineNanos - System.nanoTime();
      boolean terminal = current.isPresent() && !"UPLOADING".equals(current.get().status());
      if (terminal || remaining <= 0) {
        return current.filter(ArtifactService::ready);
      }
      try {
        delivery.signal().get(remaining, TimeUnit.NANOSECONDS);
      } catch (TimeoutException exception) {
        // Another API instance may have registered it; the durable record is authoritative.
      } catch (InterruptedException exception) {
        Thread.currentThread().interrupt();
      } catch (ExecutionException exception) {
        throw new IllegalStateException("Artifact registration notification failed", exception);
      }
      return findReady(owner, id);
    } finally {
      deliveries.computeIfPresent(
          id,
          (key, current) ->
              current.waiters() == 1
                  ? null
                  : new Delivery(current.signal(), current.waiters() - 1));
      waitingCalls.release();
    }
  }

  private void signalDelivery(UUID id) {
    Delivery delivery = deliveries.get(id);
    if (delivery != null) {
      delivery.signal().complete(null);
    }
  }

  private record Delivery(CompletableFuture<Void> signal, int waiters) {}

  private static boolean ready(Contracts.Artifact artifact) {
    return "READY".equals(artifact.status()) && artifact.complete() && artifact.sizeBytes() != null;
  }

  public Contracts.Artifact getReady(UUID owner, UUID id) {
    Contracts.Artifact artifact = get(owner, id);
    if (!ready(artifact)) {
      throw ApiException.conflict("FILE_NOT_READY", "Исходный файл пока не сохранён полностью.");
    }
    return artifact;
  }

  public Contracts.Page<Contracts.Artifact> list(UUID owner, UUID task, ListQuery query) {
    boolean owned =
        jdbc.sql("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=:task AND owner_id=:owner)")
            .param("task", task)
            .param("owner", owner)
            .query(Boolean.class)
            .single();
    if (!owned) {
      throw ApiException.notFound();
    }
    long total =
        jdbc.sql("SELECT count(*) FROM artifacts WHERE task_id=:task AND owner_id=:owner")
            .param("task", task)
            .param("owner", owner)
            .query(Long.class)
            .single();
    var items =
        jdbc.sql(
                "SELECT * FROM artifacts WHERE task_id=:task AND owner_id=:owner "
                    + "ORDER BY created_at,id LIMIT :limit OFFSET :offset")
            .param("task", task)
            .param("owner", owner)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(this::map)
            .list();
    return new Contracts.Page<>(items, total, query.page(), query.pageSize());
  }

  private Contracts.Artifact map(ResultSet row, int index) throws SQLException {
    UUID id = row.getObject("id", UUID.class);
    return new Contracts.Artifact(
        id,
        row.getString("name"),
        row.getString("mime_type"),
        row.getString("status"),
        row.getObject("size_bytes", Long.class),
        row.getString("sha256"),
        row.getBoolean("complete"),
        row.getString("source_url"),
        row.getString("source_ref"),
        row.getBigDecimal("duration_seconds"),
        "/api/artifacts/" + id + "/download");
  }

  public InputStream openOwnerArtifact(UUID owner, UUID id) throws IOException {
    getReady(owner, id);
    return Files.newInputStream(directory.resolve(id.toString()), LinkOption.NOFOLLOW_LINKS);
  }

  public JsonNode audioContext(UUID owner, UUID artifact) {
    String snapshot =
        jdbc.sql(
                """
                SELECT o.instruction_snapshot::text FROM artifacts a
                JOIN operations o ON o.id=a.operation_id
                JOIN tasks t ON t.id=a.task_id
                WHERE a.id=:id AND a.owner_id=:owner AND a.status='READY'
                  AND o.type='captureAudio' AND o.status='SUCCEEDED'
                  AND o.instruction_snapshot IS NOT NULL
                """)
            .param("id", artifact)
            .param("owner", owner)
            .query(String.class)
            .optional()
            .orElse(null);
    return json.read(snapshot);
  }

  public boolean purgeBatch(UUID owner) {
    List<UUID> ids =
        jdbc.sql("SELECT id FROM artifacts WHERE owner_id=:owner ORDER BY id LIMIT 100")
            .param("owner", owner)
            .query(UUID.class)
            .list();
    for (UUID id : ids) {
      try {
        Files.deleteIfExists(directory.resolve(id.toString()));
      } catch (IOException exception) {
        return false;
      }
      jdbc.sql("DELETE FROM artifacts WHERE id=:id AND owner_id=:owner")
          .param("id", id)
          .param("owner", owner)
          .update();
    }
    return ids.size() < 100;
  }
}
