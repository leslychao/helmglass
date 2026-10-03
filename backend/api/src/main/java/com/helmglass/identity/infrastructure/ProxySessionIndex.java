package com.helmglass.identity.infrastructure;

import com.helmglass.api.DomainException;
import com.helmglass.identity.domain.AuthenticatedActor;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.stereotype.Component;

/** Indexes opaque Redis ticket IDs only after OAuth2 Proxy confirms their current subject/session. */
@Component
public class ProxySessionIndex {
  private static final String COOKIE_NAME = "__Host-helm_session";
  private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
  private final UserEphemeralState state;
  private final JwtDecoder decoder;
  private final URI endpoint;

  public ProxySessionIndex(UserEphemeralState state, JwtDecoder decoder,
      @Value("${helm.oauth2-proxy.address:http://oauth2-proxy:4180}") String address) {
    this.state = state;
    this.decoder = decoder;
    endpoint = URI.create(address + "/oauth2/auth");
  }

  public void track(AuthenticatedActor actor, Jwt bearer, List<String> cookieHeaders) {
    Optional<String> selected = selectCookie(cookieHeaders);
    if (selected.isEmpty()) {
      return;
    }
    String value = selected.get();
    String key = ticketId(value);
    if (state.contains(actor.userId(), key)) {
      return;
    }
    HttpRequest request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(5))
        .header("Cookie", COOKIE_NAME + "=" + value).GET().build();
    try {
      var response = client.send(request, HttpResponse.BodyHandlers.discarding());
      if (response.statusCode() != 202) {
        throw denied();
      }
      String encoded = response.headers().firstValue("X-Auth-Request-Access-Token").orElseThrow(ProxySessionIndex::denied);
      Jwt verified = decoder.decode(encoded);
      if (!Objects.equals(verified.getIssuer(), bearer.getIssuer())
          || !Objects.equals(verified.getSubject(), bearer.getSubject())
          || !Objects.equals(verified.getClaimAsString("sid"), bearer.getClaimAsString("sid"))
          || !verified.getAudience().contains("helm-api-web")
          || !"helm-web".equals(verified.getClaimAsString("azp"))) {
        throw denied();
      }
      state.registerProxySession(actor.userId(), key);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new DomainException(503, "SESSION_INDEX_UNAVAILABLE", "Session admission is temporarily unavailable");
    } catch (IOException error) {
      throw new DomainException(503, "SESSION_INDEX_UNAVAILABLE", "Session admission is temporarily unavailable");
    } catch (JwtException error) {
      throw denied();
    }
  }

  static Optional<String> selectCookie(List<String> headers) {
    String selected = null;
    for (String header : headers) {
      for (String item : header.split(";")) {
        String cookie = item.trim();
        int separator = cookie.indexOf('=');
        if (separator < 0 || !cookie.substring(0, separator).equals(COOKIE_NAME)) {
          continue;
        }
        if (selected != null) {
          throw denied();
        }
        selected = cookie.substring(separator + 1);
      }
    }
    return Optional.ofNullable(selected);
  }

  /** OAuth2 Proxy 7.15's signed-cookie and v2 persistence envelope, without decoding session data. */
  static String ticketId(String value) {
    if (value.length() > 2048) {
      throw denied();
    }
    try {
      String[] signed = value.split("\\|", -1);
      if (signed.length != 3 || !signed[1].matches("[0-9]{1,12}")
          || Base64.getUrlDecoder().decode(signed[2]).length != 32) {
        throw denied();
      }
      String ticket = new String(Base64.getUrlDecoder().decode(signed[0]), StandardCharsets.US_ASCII);
      String[] parts = ticket.split("\\.", -1);
      if (parts.length != 3 || !parts[0].equals("v2")
          || Base64.getUrlDecoder().decode(parts[2]).length != 16) {
        throw denied();
      }
      String key = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.US_ASCII);
      if (!key.matches("__Host-helm_session-[a-f0-9]{32}")) {
        throw denied();
      }
      return key;
    } catch (IllegalArgumentException error) {
      throw denied();
    }
  }

  @PreDestroy
  void close() {
    client.close();
  }

  private static DomainException denied() {
    return new DomainException(401, "PROXY_SESSION_BINDING", "Browser session binding is invalid");
  }
}
