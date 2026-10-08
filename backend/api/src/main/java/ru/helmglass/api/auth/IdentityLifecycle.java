package ru.helmglass.api.auth;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import ru.helmglass.api.JsonSupport;

/** Deletes credentials only after the account owner has entered its irreversible purge stage. */
@Service
public class IdentityLifecycle {
  private final HttpClient client =
      HttpClient.newBuilder()
          .connectTimeout(Duration.ofSeconds(5))
          .followRedirects(HttpClient.Redirect.NEVER)
          .build();
  private final String base;
  private final String secret;
  private final JsonSupport json;

  public IdentityLifecycle(
      @Value("${KEYCLOAK_INTERNAL_URL}") String base,
      @Value("${KEYCLOAK_LIFECYCLE_SECRET}") String secret,
      JsonSupport json) {
    this.base = base;
    this.secret = secret;
    this.json = json;
    if (secret.isBlank()) {
      throw new IllegalArgumentException("Keycloak lifecycle secret is required");
    }
  }

  public boolean delete(UUID owner) {
    String body =
        "grant_type=client_credentials&client_id=helmglass-lifecycle&client_secret="
            + URLEncoder.encode(secret, StandardCharsets.UTF_8);
    HttpRequest tokenRequest =
        HttpRequest.newBuilder(URI.create(base + "/realms/helmglass/protocol/openid-connect/token"))
            .timeout(Duration.ofSeconds(15))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
    try {
      HttpResponse<java.io.InputStream> tokenResponse =
          client.send(tokenRequest, HttpResponse.BodyHandlers.ofInputStream());
      String token;
      try (var input = tokenResponse.body()) {
        byte[] bytes = input.readNBytes(65537);
        if (tokenResponse.statusCode() != 200 || bytes.length > 65536) {
          return false;
        }
        token =
            json.read(new String(bytes, StandardCharsets.UTF_8)).path("access_token").asString("");
      }
      if (token.isBlank()) {
        return false;
      }
      HttpRequest deletion =
          HttpRequest.newBuilder(URI.create(base + "/admin/realms/helmglass/users/" + owner))
              .timeout(Duration.ofSeconds(15))
              .header("Authorization", "Bearer " + token)
              .DELETE()
              .build();
      int status = client.send(deletion, HttpResponse.BodyHandlers.discarding()).statusCode();
      return status == 204 || status == 404;
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      return false;
    } catch (IOException exception) {
      return false;
    }
  }
}
