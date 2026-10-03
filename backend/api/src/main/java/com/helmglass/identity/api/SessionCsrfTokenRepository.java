package com.helmglass.identity.api;

import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.CsrfTokenRepository;
import org.springframework.security.web.csrf.DefaultCsrfToken;

public class SessionCsrfTokenRepository implements CsrfTokenRepository {
  private static final String COOKIE = "__Host-helm_csrf";
  private final StringRedisTemplate redis;
  private final UserEphemeralState userState;
  private final SecureRandom random = new SecureRandom();

  public SessionCsrfTokenRepository(StringRedisTemplate redis, UserEphemeralState userState) {
    this.redis = redis;
    this.userState = userState;
  }

  @Override
  public CsrfToken generateToken(HttpServletRequest request) {
    byte[] nonce = new byte[32];
    random.nextBytes(nonce);
    var actor = Actors.current(request);
    return new DefaultCsrfToken("X-XSRF-TOKEN", "_csrf",
        userState.csrfToken(actor.userId(), actor.loginId(),
            Base64.getUrlEncoder().withoutPadding().encodeToString(nonce)));
  }

  @Override
  public void saveToken(CsrfToken token, HttpServletRequest request, HttpServletResponse response) {
    AuthenticatedActor actor = Actors.current(request);
    String key = "helm:csrf:" + actor.loginId();
    if (token == null) {
      redis.delete(key);
    } else {
      userState.set(actor.userId(), key, token.getToken(), Duration.ofHours(8));
    }
    expose(token, response);
  }

  static void expose(CsrfToken token, HttpServletResponse response) {
    ResponseCookie cookie = ResponseCookie.from(COOKIE, token == null ? "" : token.getToken())
        .httpOnly(false).secure(true).sameSite("Lax").path("/")
        .maxAge(token == null ? Duration.ZERO : Duration.ofHours(8)).build();
    response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
  }

  @Override
  public CsrfToken loadToken(HttpServletRequest request) {
    Object value = request.getAttribute(AuthenticatedActor.class.getName());
    if (!(value instanceof AuthenticatedActor actor) || actor.loginId() == null) {
      return null;
    }
    String token = redis.opsForValue().get("helm:csrf:" + actor.loginId());
    return token == null ? null : new DefaultCsrfToken("X-XSRF-TOKEN", "_csrf", token);
  }
}
