package ru.helmglass.api.audio;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.function.Consumer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import ru.helmglass.api.JsonSupport;
import tools.jackson.databind.JsonNode;

@Component
public class AudioProcessorClient {
  private final String url;
  private final String token;
  private final JsonSupport json;

  public AudioProcessorClient(
      @Value("${helm.audio-url}") String url,
      @Value("${helm.audio-token}") String token,
      JsonSupport json) {
    this.url = url;
    this.token = token;
    this.json = json;
  }

  public JsonNode metadata() throws IOException {
    HttpURLConnection connection = connect("/metadata");
    try {
      if (connection.getResponseCode() != 200) {
        throw new IOException("PROCESSOR_UNAVAILABLE");
      }
      try (var input = connection.getInputStream()) {
        byte[] bytes = input.readNBytes(16385);
        if (bytes.length > 16384) {
          throw new IOException("PROCESSOR_METADATA_LIMIT");
        }
        JsonNode metadata = json.read(new String(bytes, StandardCharsets.UTF_8));
        if (!metadata.path("processingVersion").asString("").matches("[0-9a-f]{64}")) {
          throw new IOException("PROCESSOR_VERSION_INVALID");
        }
        return metadata;
      }
    } finally {
      connection.disconnect();
    }
  }

  public void process(Map<String, Object> job, Consumer<JsonNode> receive) throws IOException {
    HttpURLConnection connection = connect("/process");
    try {
      connection.setRequestMethod("POST");
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/json");
      byte[] body = json.write(job).getBytes(StandardCharsets.UTF_8);
      connection.setFixedLengthStreamingMode(body.length);
      try (var output = connection.getOutputStream()) {
        output.write(body);
      }
      int status = connection.getResponseCode();
      if (status == 412) {
        throw new IOException("PROCESSOR_VERSION_CHANGED");
      }
      if (status != 200) {
        throw new IOException(status == 409 ? "PROCESSOR_BUSY" : "PROCESSOR_UNAVAILABLE");
      }
      long lastProgress = System.nanoTime();
      try (var input = new BufferedInputStream(connection.getInputStream(), 65536)) {
        ByteArrayOutputStream line = new ByteArrayOutputStream(65536);
        for (int value; (value = input.read()) != -1; ) {
          if (value != '\n') {
            if (line.size() >= 1024 * 1024) {
              throw new IOException("PROCESSOR_BLOCK_LIMIT");
            }
            line.write(value);
            continue;
          }
          JsonNode message = json.read(line.toString(StandardCharsets.UTF_8));
          line.reset();
          if (!"heartbeat".equals(message.path("type").asString())) {
            lastProgress = System.nanoTime();
          }
          if (System.nanoTime() - lastProgress > Duration.ofMinutes(5).toNanos()) {
            throw new IOException("PROCESSOR_PROGRESS_TIMEOUT");
          }
          receive.accept(message);
          if ("complete".equals(message.path("type").asString())
              || "error".equals(message.path("type").asString())) {
            return;
          }
        }
        throw new IOException("PROCESSOR_STREAM_LOST");
      }
    } finally {
      connection.disconnect();
    }
  }

  private HttpURLConnection connect(String path) throws IOException {
    HttpURLConnection connection =
        (HttpURLConnection) URI.create(url + path).toURL().openConnection();
    connection.setConnectTimeout(5000);
    connection.setReadTimeout(15000);
    connection.setInstanceFollowRedirects(false);
    connection.setRequestProperty("X-Audio-Token", token);
    return connection;
  }
}
