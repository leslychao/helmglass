package ru.helmglass.api.audio;

import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.artifacts.ArtifactService;
import ru.helmglass.api.events.EventService;
import tools.jackson.databind.JsonNode;

@Service
public class AudioAnalysisService {
  private static final Logger log = LoggerFactory.getLogger(AudioAnalysisService.class);
  private static final Set<String> SECTIONS =
      Set.of("transcript", "intervals", "acoustics", "emotions");
  private final JdbcClient jdbc;
  private final TransactionTemplate transactions;
  private final ArtifactService artifacts;
  private final EventService events;
  private final JsonSupport json;
  private final AudioProcessorClient processor;
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final AtomicBoolean active = new AtomicBoolean();
  private final Map<UUID, Completion> completions = new ConcurrentHashMap<>();
  private final Semaphore waitingCalls = new Semaphore(16);

  public AudioAnalysisService(
      JdbcClient jdbc,
      PlatformTransactionManager manager,
      ArtifactService artifacts,
      EventService events,
      JsonSupport json,
      AudioProcessorClient processor) {
    this.jdbc = jdbc;
    this.transactions = new TransactionTemplate(manager);
    this.artifacts = artifacts;
    this.events = events;
    this.json = json;
    this.processor = processor;
  }

  public Map<String, Object> analyze(UUID owner, UUID artifactId, String mode) {
    return state(owner, enqueue(owner, artifactId, mode));
  }

  /** Returns a bounded first transcript page, waiting only for committed results. */
  public Map<String, Object> analyzeAndRead(UUID owner, UUID artifactId, String mode) {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
    UUID id = enqueue(owner, artifactId, mode);
    if (System.nanoTime() < deadline && waitingCalls.tryAcquire()) {
      Completion completion = completions.compute(id, (key, current) -> current == null
          ? new Completion(new CompletableFuture<>(), 1)
          : new Completion(current.signal(), current.waiters() + 1));
      try {
        // Register before reading: completion between enqueue and registration is not lost.
        boolean ready = transcriptReady(owner, id);
        long remaining = deadline - System.nanoTime();
        if (!ready && remaining > 0) {
          try {
            completion.signal().get(remaining, TimeUnit.NANOSECONDS);
          } catch (TimeoutException exception) {
            // Another API instance can complete the durable analysis without a local signal.
          } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
          } catch (ExecutionException exception) {
            throw new IllegalStateException("Audio completion notification failed", exception);
          }
        }
      } finally {
        completions.computeIfPresent(id, (key, current) -> current.waiters() == 1
            ? null : new Completion(current.signal(), current.waiters() - 1));
        waitingCalls.release();
      }
    }
    return page(owner, id, "transcript", 0, 100, null, null);
  }

  private boolean transcriptReady(UUID owner, UUID id) {
    return jdbc.sql("SELECT transcript_complete OR status IN ('SUCCEEDED','PARTIAL','FAILED')"
            + " FROM audio_analyses WHERE id=:id AND owner_id=:owner")
        .param("id", id)
        .param("owner", owner)
        .query(Boolean.class)
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  private record Completion(CompletableFuture<Void> signal, int waiters) {}

  private UUID enqueue(UUID owner, UUID artifactId, String mode) {
    if (!Set.of("transcript", "full").contains(mode == null ? "" : mode)) {
      throw ApiException.invalid("mode", "Выберите transcript или full.");
    }
    var artifact = artifacts.getReady(owner, artifactId);
    if (!artifact.mimeType().startsWith("audio/")) {
      throw ApiException.invalid("artifactId", "Требуется сохранённое аудио.");
    }
    JsonNode metadata;
    try {
      metadata = processor.metadata();
    } catch (IOException exception) {
      throw ApiException.conflict(
          "AUDIO_PROCESSOR_UNAVAILABLE", "Исполнитель аудио пока недоступен.");
    }
    String processingVersion = metadata.path("processingVersion").asString();
    UUID id =
        transactions.execute(
            status -> {
              lockOwner(owner);
              // Recheck readiness inside the ownership transaction, without reading the file or
              // network.
              artifacts.getReady(owner, artifactId);
              jdbc.sql(
                      """
                      INSERT INTO audio_analyses
                        (id,owner_id,artifact_id,source_sha256,processing_version,metadata,requested_mode,status)
                      VALUES (:id,:owner,:artifact,:sha,:version,CAST(:metadata AS jsonb),:mode,'QUEUED')
                      ON CONFLICT(owner_id,artifact_id,processing_version) DO NOTHING
                      """)
                  .param("id", UUID.randomUUID())
                  .param("owner", owner)
                  .param("artifact", artifactId)
                  .param("sha", artifact.sha256())
                  .param("version", processingVersion)
                  .param("metadata", json.write(metadata))
                  .param("mode", mode)
                  .update();
              UUID analysisId =
                  jdbc.sql(
                          """
                          SELECT id FROM audio_analyses WHERE owner_id=:owner AND artifact_id=:artifact
                            AND processing_version=:version FOR UPDATE
                          """)
                      .param("owner", owner)
                      .param("artifact", artifactId)
                      .param("version", processingVersion)
                      .query(UUID.class)
                      .single();
              if ("full".equals(mode)) {
                jdbc.sql(
                        """
                        UPDATE audio_analyses SET requested_mode='full',version=version+1,updated_at=now(),
                          status=CASE WHEN transcript_complete AND status<>'RUNNING' THEN 'QUEUED' ELSE status END,
                          checkpoint=CASE WHEN transcript_complete AND status<>'RUNNING'
                            THEN jsonb_set(checkpoint,'{offset}','0') ELSE checkpoint END,
                          attempts=CASE WHEN transcript_complete AND status<>'RUNNING' THEN 0 ELSE attempts END,
                          next_attempt_at=now()
                        WHERE id=:id AND requested_mode='transcript'
                        """)
                    .param("id", analysisId)
                    .update();
              }
              changed(owner, analysisId);
              return analysisId;
            });
    dispatch();
    return id;
  }

  public Map<String, Object> latest(UUID owner, UUID artifact) {
    artifacts.get(owner, artifact);
    UUID id =
        jdbc.sql(
                """
                SELECT id FROM audio_analyses WHERE owner_id=:owner AND artifact_id=:artifact
                ORDER BY created_at DESC,id LIMIT 1
                """)
            .param("owner", owner)
            .param("artifact", artifact)
            .query(UUID.class)
            .optional()
            .orElse(null);
    return id == null
        ? Map.of("available", false)
        : Map.of("available", true, "analysis", state(owner, id));
  }

  public List<Summary> summaries(UUID owner, UUID task) {
    return jdbc.sql(
            """
            SELECT a.id,f.name,a.requested_mode,a.status,a.transcript_complete,a.acoustics_complete,
              a.emotions_complete,a.error_code FROM audio_analyses a JOIN artifacts f ON f.id=a.artifact_id
            WHERE a.owner_id=:owner AND f.task_id=:task ORDER BY a.created_at DESC,a.id LIMIT 10
            """)
        .param("owner", owner)
        .param("task", task)
        .query(
            (row, index) ->
                new Summary(
                    row.getObject("id", UUID.class),
                    row.getString("name"),
                    row.getString("requested_mode"),
                    row.getString("status"),
                    row.getBoolean("transcript_complete"),
                    row.getBoolean("acoustics_complete"),
                    row.getBoolean("emotions_complete"),
                    row.getString("error_code")))
        .list();
  }

  private void changed(UUID owner, UUID id) {
    events.emit(owner, "audio-analysis", id, 0);
    jdbc.sql(
            """
            SELECT f.task_id FROM audio_analyses a JOIN artifacts f ON f.id=a.artifact_id
            WHERE a.id=:id AND a.owner_id=:owner AND f.task_id IS NOT NULL
            """)
        .param("id", id)
        .param("owner", owner)
        .query(UUID.class)
        .optional()
        .ifPresent(task -> events.emit(owner, "audio-analysis", task, 0));
    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
      @Override
      public void afterCommit() {
        Completion completion = completions.get(id);
        if (completion != null && transcriptReady(owner, id)) {
          completion.signal().complete(null);
        }
      }
    });
  }

  public record Summary(
      UUID analysisId,
      String name,
      String mode,
      String status,
      boolean transcriptComplete,
      boolean acousticsComplete,
      boolean emotionsComplete,
      String errorCode) {}

  public Map<String, Object> state(UUID owner, UUID id) {
    return jdbc.sql("SELECT * FROM audio_analyses WHERE id=:id AND owner_id=:owner")
        .param("id", id)
        .param("owner", owner)
        .query(
            (row, index) -> {
              Map<String, Object> result = new LinkedHashMap<>();
              JsonNode checkpoint = json.read(row.getString("checkpoint"));
              result.put("analysisId", id);
              result.put("artifactId", row.getObject("artifact_id", UUID.class));
              result.put("processingVersion", row.getString("processing_version"));
              result.put("sourceSha256", row.getString("source_sha256"));
              JsonNode context =
                  artifacts.audioContext(owner, row.getObject("artifact_id", UUID.class));
              boolean contextOmitted =
                  json.write(context).getBytes(StandardCharsets.UTF_8).length > 16384;
              result.put("instructionContext", contextOmitted ? null : context);
              result.put("instructionContextOmitted", contextOmitted);
              result.put("mode", row.getString("requested_mode"));
              result.put("status", row.getString("status"));
              result.put("version", row.getLong("version"));
              result.put("transcriptComplete", row.getBoolean("transcript_complete"));
              result.put("acousticsComplete", row.getBoolean("acoustics_complete"));
              result.put("emotionsComplete", row.getBoolean("emotions_complete"));
              result.put("intervalsComplete", checkpoint.path("intervalsComplete").asBoolean());
              result.put("processedSeconds", checkpoint.path("offset").asLong() / 16000.0);
              result.put("durationSeconds", row.getBigDecimal("duration_seconds"));
              result.put(
                  "stageErrors",
                  checkpoint.path("errors").isObject() ? checkpoint.path("errors") : Map.of());
              result.put("errorCode", row.getString("error_code"));
              result.put("metadata", json.read(row.getString("metadata")));
              result.put("metrics", json.read(row.getString("metrics")));
              Map<String, String> stages = new LinkedHashMap<>();
              for (String section : SECTIONS) {
                boolean requested =
                    "full".equals(row.getString("requested_mode"))
                        || "transcript".equals(section)
                        || "intervals".equals(section);
                boolean complete = Boolean.TRUE.equals(result.get(section + "Complete"));
                boolean failed =
                    checkpoint.path("errors").has(section)
                        || Set.of("FAILED", "PARTIAL").contains(row.getString("status"));
                String stage = "NOT_REQUESTED";
                if (requested) {
                  if (complete) {
                    stage = "SUCCEEDED";
                  } else if (failed) {
                    stage = "FAILED";
                  } else {
                    stage = row.getString("status");
                  }
                }
                stages.put(section, stage);
              }
              result.put("stages", stages);
              List<String> quality = new ArrayList<>();
              if (checkpoint.path("intervalsComplete").asBoolean()
                  && checkpoint.path("speechSeconds").asDouble() == 0) {
                quality.add("NO_SPEECH_DETECTED");
              }
              if (checkpoint.path("unreliableF0").asBoolean()) {
                quality.add("F0_CONTAINS_UNRELIABLE_OR_UNVOICED_SAMPLES");
              }
              if (Set.of("PARTIAL", "FAILED").contains(row.getString("status"))) {
                quality.add("LIMITED_COVERAGE");
              }
              result.put("qualityFlags", quality);
              double speech = checkpoint.path("speechSeconds").asDouble();
              long words = checkpoint.path("words").asLong();
              BigDecimal duration = row.getBigDecimal("duration_seconds");
              Map<String, Object> tempo = new LinkedHashMap<>();
              tempo.put("recognizedWords", words);
              tempo.put("speechSeconds", speech);
              tempo.put(
                  "withPausesWpm",
                  duration != null && duration.signum() > 0
                      ? 60 * words / duration.doubleValue()
                      : null);
              tempo.put("withoutPausesWpm", speech > 0 ? 60 * words / speech : null);
              tempo.put("reason", speech > 0 ? null : "NO_SPEECH_DETECTED");
              result.put("tempo", tempo);
              return result;
            })
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  public Map<String, Object> page(
      UUID owner, UUID id, String section, long cursor, int limit, Double from, Double to) {
    if (!SECTIONS.contains(section)
        || cursor < 0
        || limit < 1
        || limit > 100
        || from != null && (!Double.isFinite(from) || from < 0)
        || to != null && (!Double.isFinite(to) || to < 0 || from != null && to <= from)) {
      throw ApiException.invalid("page", "Недопустимый раздел, диапазон или размер страницы.");
    }
    Map<String, Object> result = new LinkedHashMap<>(state(owner, id));
    String field =
        switch (section) {
          case "transcript" -> "transcriptComplete";
          case "intervals" -> "intervalsComplete";
          case "acoustics" -> "acousticsComplete";
          default -> "emotionsComplete";
        };
    result.put("section", section);
    result.put("sectionComplete", result.get(field));
    var rows =
        jdbc.sql(
                """
                SELECT id,payload::text FROM audio_analysis_items
                WHERE analysis_id=:id AND section=:section AND id>:cursor
                  AND (:start IS NULL OR end_seconds>CAST(:start AS numeric))
                  AND (:end IS NULL OR start_seconds<CAST(:end AS numeric))
                ORDER BY id LIMIT :limit
                """)
            .param("id", id)
            .param("section", section)
            .param("cursor", cursor)
            .param("start", from, Types.DOUBLE)
            .param("end", to, Types.DOUBLE)
            .param("limit", limit + 1)
            .query((row, index) -> new Item(row.getLong("id"), row.getString("payload")))
            .list();
    int bytes = json.write(result).getBytes(StandardCharsets.UTF_8).length + 512;
    List<JsonNode> items = new ArrayList<>();
    long next = cursor;
    for (Item row : rows) {
      int size = row.payload().getBytes(StandardCharsets.UTF_8).length + 1;
      if (items.size() == limit || bytes + size > 65536) {
        break;
      }
      items.add(json.read(row.payload()));
      bytes += size;
      next = row.id();
    }
    result.put("items", items);
    result.put("hasMore", rows.size() > items.size());
    result.put("nextCursor", rows.size() > items.size() ? Long.toString(next) : null);
    return result;
  }

  public Map<String, Object> intervals(UUID id, UUID attempt, double from, double to, long cursor) {
    UUID owner =
        jdbc.sql(
                """
                SELECT owner_id FROM audio_analyses WHERE id=:id AND attempt=:attempt
                  AND status='RUNNING' AND lease_until>now() AND transcript_complete
                """)
            .param("id", id)
            .param("attempt", attempt)
            .query(UUID.class)
            .optional()
            .orElseThrow(ApiException::notFound);
    if (to - from > 20.1) {
      throw ApiException.invalid("range", "Слишком большой фрагмент.");
    }
    Map<String, Object> page = page(owner, id, "intervals", cursor, 100, from, to);
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("items", page.get("items"));
    result.put("hasMore", page.get("hasMore"));
    result.put("nextCursor", page.get("nextCursor"));
    return result;
  }

  @Scheduled(fixedDelay = 1000)
  void dispatch() {
    if (active.compareAndSet(false, true)) {
      executor.execute(
          () -> {
            try {
              Job job = transactions.execute(status -> claim());
              if (job != null) {
                execute(job);
              }
            } catch (RuntimeException exception) {
              log.warn("Audio dispatch failed: {}", exception.getClass().getSimpleName());
            } finally {
              active.set(false);
            }
          });
    }
  }

  private Job claim() {
    if (jdbc.sql("SELECT id FROM audio_executor WHERE id=1 FOR UPDATE SKIP LOCKED")
        .query(Integer.class)
        .optional()
        .isEmpty()) {
      return null;
    }
    var expired =
        jdbc.sql(
                """
                SELECT id,owner_id FROM audio_analyses WHERE status='RUNNING' AND lease_until<now()
                """)
            .query(
                (row, index) ->
                    new Expired(
                        row.getObject("id", UUID.class), row.getObject("owner_id", UUID.class)))
            .optional();
    if (expired.isPresent()) {
      Expired previous = expired.orElseThrow();
      jdbc.sql("SELECT id FROM accounts WHERE id=:owner FOR UPDATE")
          .param("owner", previous.owner())
          .query(UUID.class)
          .single();
      int recovered =
          jdbc.sql(
                  """
                  UPDATE audio_analyses SET status=CASE WHEN attempts<3 THEN 'QUEUED'
                    WHEN checkpoint<>'{}'::jsonb THEN 'PARTIAL' ELSE 'FAILED' END,
                    attempt=NULL,lease_until=NULL,error_code='LEASE_EXPIRED',version=version+1,
                    updated_at=now(),next_attempt_at=now()+interval '5 seconds'
                  WHERE id=:id AND status='RUNNING' AND lease_until<now()
                  """)
              .param("id", previous.id())
              .update();
      if (recovered == 1) {
        changed(previous.owner(), previous.id());
      }
    }
    if (jdbc.sql("SELECT EXISTS(SELECT 1 FROM audio_analyses WHERE status='RUNNING')")
        .query(Boolean.class)
        .single()) {
      return null;
    }
    UUID id =
        jdbc.sql(
                """
                SELECT a.id FROM audio_analyses a JOIN accounts u ON u.id=a.owner_id
                WHERE a.status='QUEUED' AND a.next_attempt_at<=now() AND u.status='ACTIVE'
                ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF u SKIP LOCKED
                """)
            .query(UUID.class)
            .optional()
            .orElse(null);
    if (id == null) {
      return null;
    }
    UUID attempt = UUID.randomUUID();
    jdbc.sql(
            """
            UPDATE audio_analyses SET status='RUNNING',attempt=:attempt,lease_until=now()+interval '30 seconds',
              run_mode=requested_mode,attempts=attempts+1,error_code=NULL,version=version+1,updated_at=now()
            WHERE id=:id
            """)
        .param("id", id)
        .param("attempt", attempt)
        .update();
    Job job =
        jdbc.sql(
                """
                SELECT a.*,f.size_bytes FROM audio_analyses a JOIN artifacts f ON f.id=a.artifact_id WHERE a.id=:id
                """)
            .param("id", id)
            .query(
                (row, index) ->
                    new Job(
                        id,
                        row.getObject("owner_id", UUID.class),
                        attempt,
                        row.getObject("artifact_id", UUID.class),
                        row.getString("processing_version"),
                        row.getString("run_mode"),
                        row.getBoolean("transcript_complete"),
                        row.getLong("size_bytes"),
                        json.read(row.getString("checkpoint"))))
            .single();
    changed(job.owner(), job.id());
    return job;
  }

  private void execute(Job job) {
    Map<String, Object> request = new LinkedHashMap<>();
    request.put("analysisId", job.id());
    request.put("attempt", job.attempt());
    request.put("artifactId", job.artifact());
    request.put("processingVersion", job.processingVersion());
    request.put("mode", job.mode());
    request.put("transcriptComplete", job.transcriptComplete());
    request.put("sizeBytes", job.size());
    request.put("checkpoint", job.checkpoint());
    try {
      processor.process(
          request,
          message -> {
            switch (message.path("type").asString()) {
              case "heartbeat" -> heartbeat(job);
              case "block" -> saveBlock(job, message);
              case "complete" -> complete(job, message);
              case "error" -> fail(job, message.path("code").asString("PROCESSING_FAILED"), false);
              default -> throw new IllegalArgumentException("Unknown audio message");
            }
          });
    } catch (IOException exception) {
      if ("PROCESSOR_VERSION_CHANGED".equals(exception.getMessage())) {
        fail(job, "PROCESSOR_VERSION_CHANGED", false);
      } else {
        String failure =
            "PROCESSOR_BUSY".equals(exception.getMessage())
                ? "PROCESSOR_BUSY"
                : "PROCESSOR_CONNECTION_LOST";
        fail(job, failure, true);
      }
    } catch (DataAccessException exception) {
      fail(job, "RESULT_STORAGE_UNAVAILABLE", true);
    } catch (RuntimeException exception) {
      fail(job, "PROCESSOR_RESULT_INVALID", false);
    }
  }

  private void heartbeat(Job job) {
    int changed =
        jdbc.sql(
                """
                UPDATE audio_analyses SET lease_until=now()+interval '30 seconds'
                WHERE id=:id AND attempt=:attempt AND status='RUNNING' AND lease_until>now()
                  AND EXISTS(SELECT 1 FROM accounts WHERE id=:owner AND status='ACTIVE')
                """)
            .param("id", job.id())
            .param("attempt", job.attempt())
            .param("owner", job.owner())
            .update();
    if (changed != 1) {
      throw ApiException.conflict("AUDIO_LEASE_LOST", "Попытка обработки устарела.");
    }
  }

  private void saveBlock(Job job, JsonNode message) {
    JsonNode checkpoint = message.path("checkpoint");
    JsonNode data = message.path("data");
    long offset = checkpoint.path("offset").asLong(-1);
    double start = message.path("start").asDouble(-1);
    double end = message.path("end").asDouble(-1);
    if (!checkpoint.isObject()
        || !data.isObject()
        || offset < 0
        || start < 0
        || end < start
        || end - start > 20.1
        || Math.abs(offset / 16000.0 - end) > 0.001
        || json.write(checkpoint).length() > 8192) {
      throw new IllegalArgumentException("Invalid audio checkpoint");
    }
    transactions.executeWithoutResult(
        status -> {
          lockOwner(job.owner());
          JsonNode current = lockAttempt(job);
          if (Math.abs(current.path("offset").asLong() / 16000.0 - start) > 0.001) {
            throw new IllegalArgumentException("Non-contiguous audio block");
          }
          for (String section : SECTIONS) {
            JsonNode items = data.path(section);
            if (items.isMissingNode()) {
              continue;
            }
            if (!items.isArray()
                || items.size() > 6000
                || job.transcriptComplete()
                    && Set.of("transcript", "intervals").contains(section)
                    && !items.isEmpty()) {
              throw new IllegalArgumentException("Invalid audio section");
            }
            for (JsonNode item : items) {
              double left = item.path("start").asDouble(-1);
              double right = item.path("end").asDouble(-1);
              if (!item.isObject()
                  || left < 0
                  || right < left
                  || right > end + 0.001
                  || json.write(item).getBytes(StandardCharsets.UTF_8).length > 4096) {
                throw new IllegalArgumentException("Invalid audio item");
              }
            }
            jdbc.sql(
                    """
                    INSERT INTO audio_analysis_items(analysis_id,section,start_seconds,end_seconds,payload)
                    SELECT :id,:section,(v->>'start')::numeric,(v->>'end')::numeric,v
                    FROM jsonb_array_elements(CAST(:items AS jsonb)) v
                    """)
                .param("id", job.id())
                .param("section", section)
                .param("items", json.write(items))
                .update();
          }
          jdbc.sql(
                  """
                  UPDATE audio_analyses SET checkpoint=CAST(:checkpoint AS jsonb),version=version+1,
                    updated_at=now(),lease_until=now()+interval '30 seconds' WHERE id=:id
                  """)
              .param("id", job.id())
              .param("checkpoint", json.write(checkpoint))
              .update();
          changed(job.owner(), job.id());
        });
  }

  private void complete(Job job, JsonNode message) {
    JsonNode checkpoint = message.path("checkpoint");
    double duration = message.path("duration").asDouble(-1);
    if (duration <= 0 || !Double.isFinite(duration) || !checkpoint.isObject()) {
      throw new IllegalArgumentException("Invalid audio completion");
    }
    transactions.executeWithoutResult(
        status -> {
          lockOwner(job.owner());
          JsonNode current = lockAttempt(job);
          if (Math.abs(current.path("offset").asLong() / 16000.0 - duration) > 0.001) {
            throw new IllegalArgumentException("Incomplete audio timeline");
          }
          boolean transcript =
              job.transcriptComplete() || !checkpoint.path("errors").has("transcript");
          boolean full = "full".equals(job.mode());
          boolean acoustics = full && !checkpoint.path("errors").has("acoustics");
          boolean emotions = full && !checkpoint.path("errors").has("emotions");
          boolean upgrade =
              !full
                  && transcript
                  && jdbc.sql("SELECT requested_mode='full' FROM audio_analyses WHERE id=:id")
                      .param("id", job.id())
                      .query(Boolean.class)
                      .single();
          String result = "PARTIAL";
          if (upgrade) {
            result = "QUEUED";
          } else if (transcript && (!full || acoustics && emotions)) {
            result = "SUCCEEDED";
          }
          Map<String, Object> metrics =
              Map.of(
                  "wallSeconds",
                  message.path("wallSeconds").asDouble(),
                  "cpuSeconds",
                  message.path("cpuSeconds").asDouble(),
                  "processPeakRssKiB",
                  message.path("processPeakRssKiB").asLong(),
                  "asrCalls",
                  checkpoint.path("asrCalls").asLong(),
                  "emotionCalls",
                  checkpoint.path("emotionCalls").asLong());
          jdbc.sql(
                  """
                  UPDATE audio_analyses SET status=:status,transcript_complete=:transcript,
                    acoustics_complete=:acoustics,emotions_complete=:emotions,duration_seconds=:duration,
                    checkpoint=CASE WHEN :upgrade THEN jsonb_set(CAST(:checkpoint AS jsonb),'{offset}','0')
                      ELSE CAST(:checkpoint AS jsonb) END,metrics=CAST(:metrics AS jsonb),
                    attempt=NULL,lease_until=NULL,attempts=CASE WHEN :upgrade THEN 0 ELSE attempts END,
                    version=version+1,updated_at=now(),next_attempt_at=now() WHERE id=:id
                  """)
              .param("id", job.id())
              .param("status", result)
              .param("transcript", transcript)
              .param("acoustics", acoustics)
              .param("emotions", emotions)
              .param("duration", duration)
              .param("upgrade", upgrade)
              .param("checkpoint", json.write(checkpoint))
              .param("metrics", json.write(metrics))
              .update();
          changed(job.owner(), job.id());
        });
  }

  private void fail(Job job, String code, boolean retryable) {
    if (!code.matches("[A-Z_]{1,80}")) {
      code = "PROCESSING_FAILED";
    }
    final String failure = code;
    transactions.executeWithoutResult(
        status -> {
          if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=:owner AND status='ACTIVE')")
              .param("owner", job.owner())
              .query(Boolean.class)
              .single()) {
            return;
          }
          lockOwner(job.owner());
          int changed =
              jdbc.sql(
                      """
                      UPDATE audio_analyses SET status=CASE
                        WHEN :retry AND attempts<3 THEN 'QUEUED'
                        WHEN coalesce((checkpoint->>'offset')::bigint,0)>0 OR transcript_complete THEN 'PARTIAL'
                        ELSE 'FAILED' END,attempt=NULL,lease_until=NULL,error_code=:code,
                        next_attempt_at=now()+CASE WHEN :busy THEN interval '5 seconds' ELSE interval '30 seconds' END,
                        version=version+1,updated_at=now()
                      WHERE id=:id AND attempt=:attempt AND status='RUNNING' AND lease_until>now()
                      """)
                  .param("retry", retryable)
                  .param("busy", "PROCESSOR_BUSY".equals(failure))
                  .param("code", failure)
                  .param("id", job.id())
                  .param("attempt", job.attempt())
                  .update();
          if (changed == 1) {
            changed(job.owner(), job.id());
          }
        });
  }

  private JsonNode lockAttempt(Job job) {
    return jdbc.sql(
            """
            SELECT checkpoint::text FROM audio_analyses WHERE id=:id AND attempt=:attempt
              AND status='RUNNING' AND lease_until>now() FOR UPDATE
            """)
        .param("id", job.id())
        .param("attempt", job.attempt())
        .query(String.class)
        .optional()
        .map(json::read)
        .orElseThrow(ApiException::notFound);
  }

  private void lockOwner(UUID owner) {
    jdbc.sql("SELECT id FROM accounts WHERE id=:owner AND status='ACTIVE' FOR UPDATE")
        .param("owner", owner)
        .query(UUID.class)
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  @PreDestroy
  void close() {
    executor.shutdownNow();
  }

  private record Item(long id, String payload) {}

  private record Expired(UUID id, UUID owner) {}

  private record Job(
      UUID id,
      UUID owner,
      UUID attempt,
      UUID artifact,
      String processingVersion,
      String mode,
      boolean transcriptComplete,
      long size,
      JsonNode checkpoint) {}
}
