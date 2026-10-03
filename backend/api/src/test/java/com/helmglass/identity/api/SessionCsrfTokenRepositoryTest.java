package com.helmglass.identity.api;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.web.csrf.DefaultCsrfToken;

class SessionCsrfTokenRepositoryTest {
  @Test
  void bootstrapExposesExistingTokenWithoutRotatingIt() {
    var response = new MockHttpServletResponse();
    var existing = new DefaultCsrfToken("X-XSRF-TOKEN", "_csrf", "existing-server-token");
    SessionCsrfTokenRepository.expose(existing, response);
    String cookie = response.getHeader("Set-Cookie");
    assertThat(cookie).contains("__Host-helm_csrf=existing-server-token", "Path=/", "Secure", "SameSite=Lax", "Max-Age=28800")
        .doesNotContain("HttpOnly", "Domain=");
  }
}
