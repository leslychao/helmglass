package com.helmglass.identity.infrastructure;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.helmglass.api.DomainException;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;

class ProxySessionIndexTest {
  private static final String KEY = "__Host-helm_session-0123456789abcdef0123456789abcdef";

  @Test
  void pinnedCookieParserExtractsOnlyTicketIdAndRejectsDuplicates() {
    String value = cookie(KEY);
    assertThat(ProxySessionIndex.ticketId(value)).isEqualTo(KEY);
    assertThat(ProxySessionIndex.selectCookie(List.of("other=a; __Host-helm_session=" + value))).contains(value);
    assertThatThrownBy(() -> ProxySessionIndex.selectCookie(List.of("__Host-helm_session=" + value,
        "__Host-helm_session=" + value))).isInstanceOf(DomainException.class);
    assertThatThrownBy(() -> ProxySessionIndex.ticketId(cookie("helm:csrf:someone")))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(() -> ProxySessionIndex.ticketId("invalid"))
        .isInstanceOf(DomainException.class);
  }

  @Test
  void cookieSubjectAndSessionMustMatchVerifiedBearerBeforeIndexing() throws IOException {
    var state = mock(UserEphemeralState.class);
    var decoder = mock(JwtDecoder.class);
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/oauth2/auth", exchange -> {
      exchange.getResponseHeaders().add("X-Auth-Request-Access-Token", "fixture-token");
      exchange.sendResponseHeaders(202, -1);
      exchange.close();
    });
    server.start();
    var index = new ProxySessionIndex(state, decoder, "http://127.0.0.1:" + server.getAddress().getPort());
    var actor = new AuthenticatedActor(UUID.randomUUID(), UUID.randomUUID(), null, "helm-web",
        "Fixture", "fixture@example.test", 1, Set.of(), false);
    Jwt bearer = token("subject", "session");
    try {
      when(decoder.decode("fixture-token")).thenReturn(token("someone-else", "session"));
      assertThatThrownBy(() -> index.track(actor, bearer, List.of("__Host-helm_session=" + cookie(KEY))))
          .isInstanceOf(DomainException.class);
      verify(state, never()).registerProxySession(any(), anyString());
      when(decoder.decode("fixture-token")).thenReturn(token("subject", "different-session"));
      assertThatThrownBy(() -> index.track(actor, bearer, List.of("__Host-helm_session=" + cookie(KEY))))
          .isInstanceOf(DomainException.class);
      when(decoder.decode("fixture-token")).thenReturn(bearer);
      index.track(actor, bearer, List.of("__Host-helm_session=" + cookie(KEY)));
      verify(state).registerProxySession(actor.userId(), KEY);
    } finally {
      index.close();
      server.stop(0);
    }
  }

  private static Jwt token(String subject, String sid) {
    return Jwt.withTokenValue("fixture-token").header("alg", "RS256")
        .issuer("https://issuer.example").subject(subject).audience(List.of("helm-api-web"))
        .claim("azp", "helm-web").claim("sid", sid).expiresAt(Instant.now().plusSeconds(60)).build();
  }

  private static String cookie(String key) {
    var base64 = Base64.getUrlEncoder().withoutPadding();
    String ticket = "v2." + base64.encodeToString(key.getBytes(StandardCharsets.US_ASCII))
        + "." + base64.encodeToString(new byte[16]);
    return Base64.getUrlEncoder().encodeToString(ticket.getBytes(StandardCharsets.US_ASCII))
        + "|1790985600|" + Base64.getUrlEncoder().encodeToString(new byte[32]);
  }
}
