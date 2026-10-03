package com.helmglass.identity.application;

import com.helmglass.api.DomainException;
import com.helmglass.identity.infrastructure.KeycloakSessionClient;
import com.helmglass.identity.infrastructure.repository.LogoutRepository;
import com.helmglass.identity.infrastructure.repository.LogoutRepository.SessionLogout;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class LogoutService {

  private static final String COOKIE_NAME = "__Host-helm_session";
  private final HttpClient proxy =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
  private final LogoutRepository logouts;
  private final KeycloakSessionClient keycloak;

  public LogoutService(LogoutRepository logouts, KeycloakSessionClient keycloak) {
    this.logouts = logouts;
    this.keycloak = keycloak;
  }

  @Scheduled(fixedDelay = 1000)
  public void cleanSessions() {
    for (var operation : logouts.pending()) {
      finish(operation);
    }
  }

  /** Ends the provider session before returning to login; durable retries cover provider failure. */
  public boolean finishProviderSession(UUID operationId) {
    var operation = logouts.find(operationId).orElseThrow(DomainException::notFound);
    if (operation.state().equals("SUCCEEDED")) {
      return true;
    }
    return operation.state().equals("PENDING") && finish(operation);
  }

  private boolean finish(SessionLogout operation) {
    try {
      keycloak.logoutSession(operation.sid());
      logouts.completed(operation.id());
      return true;
    } catch (DomainException error) {
      logouts.retry(operation.id());
      return false;
    }
  }

  @PreDestroy
  void close() {
    proxy.close();
  }

  public List<String> clearProxySession(String ticketCookie) {
    if (ticketCookie == null || ticketCookie.isBlank()) {
      return List.of();
    }
    var request =
        HttpRequest.newBuilder(URI.create("http://oauth2-proxy:4180/oauth2/sign_out"))
            .timeout(Duration.ofSeconds(5))
            .header("Cookie", COOKIE_NAME + "=" + ticketCookie)
            .GET()
            .build();
    try {
      var response = proxy.send(request, HttpResponse.BodyHandlers.discarding());
      if (response.statusCode() < 200 || response.statusCode() >= 400) {
        throw new DomainException(503, "SESSION_CLEAR_PENDING", "Browser session clearing failed");
      }
      return response.headers().allValues("Set-Cookie");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw clearingFailure("Browser session clearing was interrupted", error);
    } catch (IOException error) {
      throw clearingFailure("Browser session clearing failed", error);
    }
  }

  private static DomainException clearingFailure(String message, Exception cause) {
    var failure = new DomainException(503, "SESSION_CLEAR_PENDING", message);
    failure.initCause(cause);
    return failure;
  }
}
