package ru.helmglass.api.artifacts;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
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
  private final ru.helmglass.api.JsonSupport json;
  private final Semaphore transfers = new Semaphore(2);

  public ArtifactService(
      JdbcClient jdbc,
      WorkerClient worker,
      EventService events,
      ru.helmglass.api.JsonSupport json,
      @Value("${helm.artifact-directory}") String directory)
      throws IOException {
    this.jdbc = jdbc;
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
            "/sessions/" + session + "/artifacts?archive=true&after=" + source.cursor(),
            null);
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
      transfers.acquire();
      try {
        transferArtifact(owner, task, session, operation, metadata);
      } finally {
        transfers.release();
      }
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw ApiException.conflict(
          "TRANSFER_INTERRUPTED", "Передача файла прервана; она будет продолжена.");
    }
  }

  private synchronized void transferArtifact(
      UUID owner, UUID task, UUID session, UUID operation, JsonNode metadata) {
    UUID id = UUID.fromString(metadata.path("id").asString());
    if (jdbc.sql(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=:id AND (owner_id<>:owner OR task_id IS"
                + " DISTINCT FROM :task))")
        .param("id", id)
        .param("owner", owner)
        .param("task", task)
        .query(Boolean.class)
        .single()) {
      throw ApiException.notFound();
    }
    if (operation != null) {
      boolean belongs =
          jdbc.sql(
                  "SELECT EXISTS(SELECT 1 FROM operations WHERE id=:operation AND owner_id=:owner"
                      + " AND task_id=:task AND session_id=:session)")
              .param("operation", operation)
              .param("owner", owner)
              .param("task", task)
              .param("session", session)
              .query(Boolean.class)
              .single();
      if (!belongs) {
        throw ApiException.notFound();
      }
      jdbc.sql(
              "UPDATE artifacts SET operation_id=:operation WHERE id=:id AND owner_id=:owner AND"
                  + " task_id=:task AND operation_id IS NULL")
          .param("operation", operation)
          .param("id", id)
          .param("owner", owner)
          .param("task", task)
          .update();
    }
    if (jdbc.sql(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=:id AND owner_id=:owner AND"
                + " status='READY')")
        .param("id", id)
        .param("owner", owner)
        .query(Boolean.class)
        .single()) {
      return;
    }
    String name = metadata.path("name").asString("file");
    String mime = metadata.path("mimeType").asString("application/octet-stream");
    if (name.length() > 300 || mime.length() > 150) {
      throw ApiException.invalid("artifact", "Некорректные свойства файла.");
    }
    jdbc.sql(
            """
INSERT INTO artifacts(id,owner_id,task_id,operation_id,name,mime_type,status,complete,source_url,source_ref,duration_seconds,relative_path)
VALUES (:id,:owner,:task,:operation,:name,:mime,'UPLOADING',:complete,:url,:ref,:duration,:path)
ON CONFLICT(id) DO NOTHING
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
        .update();
    Path temporary = directory.resolve(id + ".part");
    Path destination = directory.resolve(id.toString());
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      long bytes = 0;
      try (InputStream input =
              worker.artifact("/sessions/" + session + "/artifacts/" + id + "?archive=true");
          var output = Files.newOutputStream(temporary)) {
        byte[] buffer = new byte[65536];
        for (int count; (count = input.read(buffer)) != -1; ) {
          output.write(buffer, 0, count);
          digest.update(buffer, 0, count);
          bytes = Math.addExact(bytes, count);
        }
      }
      String hash = HexFormat.of().formatHex(digest.digest());
      if (metadata.path("sizeBytes").isNumber() && metadata.path("sizeBytes").asLong() != bytes
          || metadata.path("sha256").isString()
              && !hash.equalsIgnoreCase(metadata.path("sha256").asString())) {
        throw new IOException("Artifact integrity mismatch");
      }
      Files.move(
          temporary,
          destination,
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING);
      jdbc.sql(
              "UPDATE artifacts SET status='READY',size_bytes=:bytes,sha256=:hash WHERE id=:id AND"
                  + " owner_id=:owner")
          .param("bytes", bytes)
          .param("hash", hash)
          .param("id", id)
          .param("owner", owner)
          .update();
      events.emit(owner, "artifact", id, 1);
      events.emit(owner, "task", task, 0);
    } catch (IOException | NoSuchAlgorithmException | ArithmeticException exception) {
      jdbc.sql("UPDATE artifacts SET status='FAILED' WHERE id=:id AND owner_id=:owner")
          .param("id", id)
          .param("owner", owner)
          .update();
      try {
        Files.deleteIfExists(temporary);
      } catch (IOException ignored) {
        // The stable FAILED record allows cleanup to retry without exposing a ready file.
      }
      throw ApiException.conflict(
          "ARTIFACT_TRANSFER_FAILED",
          "Исходный файл не сохранён полностью; повторная выдача пока недоступна.");
    }
  }

  public Contracts.Artifact get(UUID owner, UUID id) {
    return jdbc.sql("SELECT * FROM artifacts WHERE id=:id AND owner_id=:owner")
        .param("id", id)
        .param("owner", owner)
        .query(this::map)
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  public Contracts.Artifact getReady(UUID owner, UUID id) {
    Contracts.Artifact artifact = get(owner, id);
    if (!"READY".equals(artifact.status())
        || !artifact.complete()
        || artifact.sizeBytes() == null) {
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
    return Files.newInputStream(directory.resolve(id.toString()));
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
        Files.deleteIfExists(directory.resolve(id + ".part"));
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
