package ru.helmglass.api.browsers;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import ru.helmglass.api.JsonSupport;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;

@Component
public class WorkerClient {
  private static final int MAXIMUM_REPLY_BYTES = 2 * 1024 * 1024;
  private static final long[] RETRY_DELAYS_MILLIS = {1000, 3000, 10000};
  private static final Set<String> KNOWN_ERRORS =
      Set.of(
          "PROFILE_TOO_LARGE",
          "PROFILE_RECORD_TOO_LARGE",
          "PROFILE_COMPLEXITY_LIMIT",
          "PROFILE_STORAGE_UNAVAILABLE",
          "PROFILE_INVALID",
          "PROFILE_SNAPSHOT_CHANGED",
          "PROFILE_REVISION_CHANGED",
          "PROFILE_UNSUPPORTED_VALUE",
          "PROFILE_SAVE_FAILED",
          "VIEWER_LIMIT_REACHED");
  private final HttpClient http =
      HttpClient.newBuilder()
          .connectTimeout(Duration.ofSeconds(5))
          .version(HttpClient.Version.HTTP_1_1)
          .followRedirects(HttpClient.Redirect.NEVER)
          .build();
  private final String baseUrl;
  private final String token;
  private final JsonSupport json;
  private final ScheduledExecutorService deadlines =
      Executors.newSingleThreadScheduledExecutor(
          Thread.ofPlatform().daemon().name("worker-response-deadline").factory());

  public WorkerClient(
      @Value("${helm.worker-url}") String baseUrl,
      @Value("${helm.worker-token}") String token,
      JsonSupport json) {
    this.baseUrl = baseUrl.replaceAll("/$", "");
    this.token = token;
    this.json = json;
  }

  public JsonNode call(String method, String path, Object body) {
    return call(method, path, body, Duration.ofSeconds(40));
  }

  public JsonNode call(String method, String path, Object body, Duration timeout) {
    long deadline = System.nanoTime() + timeout.toNanos();
    boolean retryable =
        "GET".equals(method)
            || "DELETE".equals(method)
            || "POST".equals(method)
                && (path.endsWith("/control")
                    || path.endsWith("/profile/export")
                        && body instanceof java.util.Map<?, ?> values
                        && values.containsKey("operationId"));
    for (int attempt = 0; ; attempt++) {
      try {
        return callOnce(method, path, body, deadline);
      } catch (WorkerException failure) {
        if (!retryable
            || attempt == RETRY_DELAYS_MILLIS.length
            || !(failure.status() == 0 || Set.of(502, 503, 504).contains(failure.status()))
            || "WORKER_INTERRUPTED".equals(failure.code())) {
          throw failure;
        }
        long delay = RETRY_DELAYS_MILLIS[attempt];
        if (deadline - System.nanoTime() <= TimeUnit.MILLISECONDS.toNanos(delay)) {
          throw failure;
        }
        try {
          Thread.sleep(delay);
        } catch (InterruptedException exception) {
          Thread.currentThread().interrupt();
          throw new WorkerException("WORKER_INTERRUPTED", 0, exception);
        }
      }
    }
  }

  private JsonNode callOnce(String method, String path, Object body, long deadline) {
    Duration timeout = Duration.ofNanos(Math.max(1, deadline - System.nanoTime()));
    try {
      HttpRequest request = request(method, path, body).timeout(timeout).build();
      HttpResponse<InputStream> response =
          http.send(request, HttpResponse.BodyHandlers.ofInputStream());
      try (InputStream input = bounded(response.body(), deadline)) {
        byte[] bytes = input.readNBytes(MAXIMUM_REPLY_BYTES + 1);
        if (bytes.length > MAXIMUM_REPLY_BYTES) {
          throw new WorkerException("WORKER_REPLY_TOO_LARGE", response.statusCode());
        }
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
          if (bytes.length > 0) {
            try {
              String code =
                  json.read(new String(bytes, StandardCharsets.UTF_8)).path("code").asString("");
              if (KNOWN_ERRORS.contains(code)) {
                throw new WorkerException(code, response.statusCode());
              }
            } catch (JacksonException exception) {
              // A proxy may return HTML; preserve its HTTP failure without exposing the body.
            }
          }
          throw new WorkerException("WORKER_HTTP_" + response.statusCode(), response.statusCode());
        }
        return bytes.length == 0
            ? json.tree(java.util.Map.of())
            : json.read(new String(bytes, StandardCharsets.UTF_8));
      }
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new WorkerException("WORKER_INTERRUPTED", 0, exception);
    } catch (IOException exception) {
      throw new WorkerException("WORKER_UNREACHABLE", 0, exception);
    }
  }

  public InputStream artifact(String path) throws IOException {
    Duration timeout = Duration.ofMinutes(6);
    long deadline = System.nanoTime() + timeout.toNanos();
    try {
      var response =
          http.send(
              request("GET", path, null).timeout(timeout).build(),
              HttpResponse.BodyHandlers.ofInputStream());
      if (response.statusCode() != 200) {
        response.body().close();
        throw new IOException("Worker artifact unavailable");
      }
      return bounded(response.body(), deadline);
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new IOException("Worker artifact interrupted", exception);
    }
  }

  private InputStream bounded(InputStream input, long deadline) {
    return new FilterInputStream(input) {
      private volatile boolean expired;
      private final ScheduledFuture<?> timer =
          deadlines.schedule(
              () -> {
                expired = true;
                try {
                  input.close();
                } catch (IOException exception) {
                  // The consuming read reports the deadline, independently of transport shutdown.
                }
              },
              Math.max(0, deadline - System.nanoTime()),
              TimeUnit.NANOSECONDS);

      private void checkDeadline() throws IOException {
        if (expired || System.nanoTime() >= deadline) {
          throw new IOException("Worker response timed out");
        }
      }

      @Override
      public int read() throws IOException {
        checkDeadline();
        int result = input.read();
        checkDeadline();
        return result;
      }

      @Override
      public int read(byte[] bytes, int offset, int length) throws IOException {
        checkDeadline();
        int result = input.read(bytes, offset, length);
        checkDeadline();
        return result;
      }

      @Override
      public void close() throws IOException {
        timer.cancel(false);
        input.close();
      }
    };
  }

  @jakarta.annotation.PreDestroy
  void closeDeadlines() {
    deadlines.shutdownNow();
  }

  private HttpRequest.Builder request(String method, String path, Object body) {
    String payload = body == null ? "" : json.write(body);
    if (payload.length() > 256 * 1024) {
      throw new IllegalArgumentException("Worker request is too large");
    }
    return HttpRequest.newBuilder(URI.create(baseUrl + path))
        .timeout(Duration.ofSeconds(40))
        .header("X-Worker-Token", token)
        .header("Content-Type", "application/json")
        .method(
            method,
            body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(payload));
  }

  public static class WorkerException extends RuntimeException {
    private final String code;
    private final int status;

    public WorkerException(String code, int status) {
      this(code, status, null);
    }

    private WorkerException(String code, int status, Throwable cause) {
      super(code, cause);
      this.code = code;
      this.status = status;
    }

    public String code() {
      return code;
    }

    public int status() {
      return status;
    }
  }
}
