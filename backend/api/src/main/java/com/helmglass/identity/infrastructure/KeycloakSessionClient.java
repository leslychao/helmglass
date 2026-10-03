package com.helmglass.identity.infrastructure;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.bootstrap.RuntimeSecrets;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Bounded Keycloak administrative calls for persisted user/session identities. */
@Component
public class KeycloakSessionClient {
  private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final RuntimeSecrets secrets;
  private final JsonSupport json;
  private final String address;
  private final String realm;
  private String token;
  private Instant tokenExpiresAt = Instant.EPOCH;

  public KeycloakSessionClient(RuntimeSecrets secrets, JsonSupport json,
      @Value("${helm.keycloak.address:http://keycloak:8080/auth}") String address,
      @Value("${helm.keycloak.realm:helm}") String realm) {
    this.secrets = secrets;
    this.json = json;
    this.address = address.replaceAll("/$", "");
    this.realm = encode(realm);
  }

  public void logoutSession(String sid) {
    URI endpoint = URI.create(address + "/admin/realms/" + realm + "/sessions/" + encode(sid));
    HttpRequest request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(10))
        .header("Authorization", "Bearer " + accessToken()).DELETE().build();
    try {
      var response = client.send(request, HttpResponse.BodyHandlers.discarding());
      if (response.statusCode() != 204 && response.statusCode() != 404) {
        throw unavailable();
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw unavailable();
    } catch (IOException error) {
      throw unavailable();
    }
  }

  public void reconcileUser(String subject, boolean enabled) {
    URI endpoint = userEndpoint(subject);
    var update = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(5))
        .header("Authorization", "Bearer " + accessToken()).header("Content-Type", "application/json")
        .PUT(HttpRequest.BodyPublishers.ofString("{\"enabled\":" + enabled + "}")).build();
    requireStatus(send(update), 204);
    if (!enabled) {
      var logout = HttpRequest.newBuilder(URI.create(endpoint + "/logout")).timeout(Duration.ofSeconds(5))
          .header("Authorization", "Bearer " + accessToken()).POST(HttpRequest.BodyPublishers.noBody()).build();
      requireStatus(send(logout), 204);
    }
  }

  public void deleteUser(String subject) {
    URI endpoint = userEndpoint(subject);
    var delete = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(5))
        .header("Authorization", "Bearer " + accessToken()).DELETE().build();
    int deleted = send(delete);
    if (deleted != 204 && deleted != 404) {
      throw unavailable();
    }
    var read = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(5))
        .header("Authorization", "Bearer " + accessToken()).GET().build();
    requireStatus(send(read), 404);
  }

  private URI userEndpoint(String subject) {
    return URI.create(address + "/admin/realms/" + realm + "/users/" + encode(subject));
  }

  private int send(HttpRequest request) {
    try {
      return client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw unavailable();
    } catch (IOException error) {
      throw unavailable();
    }
  }

  private static void requireStatus(int actual, int expected) {
    if (actual != expected) {
      throw unavailable();
    }
  }

  private synchronized String accessToken() {
    if (token != null && tokenExpiresAt.isAfter(Instant.now().plusSeconds(30))) {
      return token;
    }
    String form = "grant_type=client_credentials&client_id=" + encode(secrets.keycloakClientId())
        + "&client_secret=" + encode(secrets.keycloakClientSecret());
    var request = HttpRequest.newBuilder(URI.create(address + "/realms/" + realm + "/protocol/openid-connect/token"))
        .timeout(Duration.ofSeconds(10)).header("Content-Type", "application/x-www-form-urlencoded")
        .POST(HttpRequest.BodyPublishers.ofString(form)).build();
    try {
      var response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
      try (InputStream body = response.body()) {
        byte[] encoded = body.readNBytes(262145);
        if (response.statusCode() != 200 || encoded.length > 262144) {
          throw unavailable();
        }
        var value = json.read(new String(encoded, StandardCharsets.UTF_8));
        String accessToken = value.path("access_token").asString();
        long lifetime = value.path("expires_in").asLong();
        if (accessToken.isBlank() || lifetime < 1 || lifetime > 86400) {
          throw unavailable();
        }
        token = accessToken;
        tokenExpiresAt = Instant.now().plusSeconds(lifetime);
        return token;
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw unavailable();
    } catch (IOException error) {
      throw unavailable();
    }
  }

  @PreDestroy
  void close() {
    client.close();
  }

  private static String encode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8);
  }

  private static DomainException unavailable() {
    return new DomainException(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Session cleanup is pending");
  }
}
