package ru.helmglass.api.browsers;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import ru.helmglass.api.JsonSupport;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;

@Component
public class WorkerClient {
  private static final int MAXIMUM_REPLY_BYTES = 2 * 1024 * 1024;
  private static final Set<String> PROFILE_ERRORS = Set.of(
      "PROFILE_TOO_LARGE", "PROFILE_RECORD_TOO_LARGE", "PROFILE_COMPLEXITY_LIMIT",
      "PROFILE_STORAGE_UNAVAILABLE", "PROFILE_INVALID", "PROFILE_SNAPSHOT_CHANGED",
      "PROFILE_REVISION_CHANGED", "PROFILE_UNSUPPORTED_VALUE", "PROFILE_SAVE_FAILED");
  private final HttpClient http =
      HttpClient.newBuilder()
          .connectTimeout(Duration.ofSeconds(5))
          .version(HttpClient.Version.HTTP_1_1)
          .followRedirects(HttpClient.Redirect.NEVER)
          .build();
  private final String baseUrl;
  private final String token;
  private final JsonSupport json;

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
    try {
      HttpRequest request = request(method, path, body).timeout(timeout).build();
      HttpResponse<InputStream> response =
          http.send(request, HttpResponse.BodyHandlers.ofInputStream());
      try (InputStream input = response.body()) {
        byte[] bytes = input.readNBytes(MAXIMUM_REPLY_BYTES + 1);
        if (bytes.length > MAXIMUM_REPLY_BYTES) {
          throw new WorkerException("WORKER_REPLY_TOO_LARGE", response.statusCode());
        }
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
          if (bytes.length > 0) {
            try {
              String code = json.read(new String(bytes, StandardCharsets.UTF_8))
                  .path("code").asString("");
              if (PROFILE_ERRORS.contains(code)) {
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
      throw new WorkerException("WORKER_INTERRUPTED", 0);
    } catch (IOException exception) {
      throw new WorkerException("WORKER_UNREACHABLE", 0);
    }
  }

  public InputStream artifact(String path) throws IOException {
    try {
      var response =
          http.send(request("GET", path, null).build(), HttpResponse.BodyHandlers.ofInputStream());
      if (response.statusCode() != 200) {
        response.body().close();
        throw new IOException("Worker artifact unavailable");
      }
      return response.body();
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new IOException("Worker artifact interrupted", exception);
    }
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
      super(code);
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
