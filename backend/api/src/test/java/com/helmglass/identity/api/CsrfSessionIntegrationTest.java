package com.helmglass.identity.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.helmglass.enrollment.application.WorkerEnrollmentService;
import com.helmglass.identity.application.IdentityService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.ProxySessionIndex;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.api.ActorHandshakeInterceptor;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.test.context.web.WebAppConfiguration;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.testcontainers.containers.GenericContainer;

@SpringJUnitConfig(CsrfSessionIntegrationTest.SecurityFixture.class)
@WebAppConfiguration
@TestPropertySource(
    properties = {
      "helm.public-origin=https://helm.example",
      "helm.mcp-clients=helm-mcp",
      "helm.issuer-uri=https://issuer.example",
      "helm.jwk-set-uri=https://issuer.example/keys"
    })
class CsrfSessionIntegrationTest {
  private static final GenericContainer<?> REDIS =
      new GenericContainer<>("redis:8.4.6-alpine").withExposedPorts(6379);

  static {
    REDIS.start();
  }

  @Configuration
  @EnableWebSecurity
  @EnableWebMvc
  @Import({SecurityConfiguration.class, UserEphemeralState.class, Endpoints.class})
  static class SecurityFixture {
    @Bean
    IdentityService identities() {
      return mock(IdentityService.class);
    }

    @Bean
    IdentityRepository repository() {
      return mock(IdentityRepository.class);
    }

    @Bean
    WorkerEnrollmentService enrollments() {
      return mock(WorkerEnrollmentService.class);
    }

    @Bean
    ProxySessionIndex sessions() {
      return mock(ProxySessionIndex.class);
    }

    @Bean
    @Primary
    JwtDecoder fixtureDecoder() {
      return mock(JwtDecoder.class);
    }

    @Bean
    LettuceConnectionFactory redisConnection() {
      return new LettuceConnectionFactory(REDIS.getHost(), REDIS.getMappedPort(6379));
    }

    @Bean
    StringRedisTemplate redis(LettuceConnectionFactory connection) {
      return new StringRedisTemplate(connection);
    }
  }

  @RestController
  static class Endpoints {
    @GetMapping("/api/v1/me")
    Map<String, String> bootstrap(CsrfToken csrf, HttpServletResponse response) {
      SessionCsrfTokenRepository.expose(csrf, response);
      return Map.of("status", "ready");
    }

    @GetMapping("/events/v1/user")
    Map<String, String> channel() {
      return Map.of("status", "ready");
    }

    @PostMapping("/api/v1/tasks")
    Map<String, String> mutate() {
      return Map.of("status", "accepted");
    }

    @GetMapping({
      "/stream/v1/signaling/test",
      "/stream/v1/input/test",
      "/stream/v1/widget/signaling/test",
      "/events/v1/widget/tasks/test"
    })
    Map<String, Boolean> handshake(HttpServletRequest request, HttpServletResponse response) {
      Map<String, Object> attributes = new HashMap<>();
      new ActorHandshakeInterceptor()
          .beforeHandshake(
              new ServletServerHttpRequest(request),
              new ServletServerHttpResponse(response),
              new TextWebSocketHandler(),
              attributes);
      return Map.of(
          "actorPresent",
          attributes.get(AuthenticatedActor.class.getName()) instanceof AuthenticatedActor,
          "expiryPresent",
          attributes.get("helm.authorizationExpiresAt") instanceof Instant);
    }
  }

  private final WebApplicationContext context;
  private final IdentityService identities;
  private final JwtDecoder decoder;
  private final StringRedisTemplate redis;
  private MockMvc mvc;
  private AuthenticatedActor actor;

  @Autowired
  CsrfSessionIntegrationTest(
      WebApplicationContext context,
      IdentityService identities,
      JwtDecoder decoder,
      StringRedisTemplate redis) {
    this.context = context;
    this.identities = identities;
    this.decoder = decoder;
    this.redis = redis;
  }

  @BeforeEach
  void admittedLogin() {
    actor =
        new AuthenticatedActor(
            UUID.randomUUID(),
            UUID.randomUUID(),
            null,
            "helm-web",
            "Fixture",
            "fixture@example.test",
            1,
            Set.of(),
            false);
    var token =
        Jwt.withTokenValue("fixture")
            .header("alg", "RS256")
            .issuer("https://issuer.example")
            .subject("fixture")
            .audience(List.of("helm-api-web"))
            .claim("azp", "helm-web")
            .expiresAt(Instant.now().plusSeconds(60))
            .build();
    when(decoder.decode("fixture")).thenReturn(token);
    when(identities.authenticate(any(Jwt.class), eq(false))).thenReturn(actor);
    mvc = MockMvcBuilders.webAppContextSetup(context).apply(springSecurity()).build();
  }

  @Test
  void webMediaHandshakeAdmitsTheOAuthActorAndRejectsMissingOrWrongAudience() throws Exception {
    var foreign =
        Jwt.withTokenValue("foreign")
            .header("alg", "RS256")
            .issuer("https://issuer.example")
            .subject("fixture")
            .audience(List.of("helm-mcp"))
            .claim("azp", "helm-mcp")
            .expiresAt(Instant.now().plusSeconds(60))
            .build();
    when(decoder.decode("foreign")).thenReturn(foreign);
    for (String path : List.of("/stream/v1/signaling/test", "/stream/v1/input/test")) {
      var request =
          mvc.perform(
                  get(path)
                      .header("Authorization", "Bearer fixture")
                      .header("Origin", "https://helm.example")
                      .header("Upgrade", "websocket"))
              .andExpect(status().isOk())
              .andReturn();
      assertThat(request.getRequest().getAttribute(AuthenticatedActor.class.getName()))
          .isEqualTo(actor);
      assertThat(request.getResponse().getContentAsString())
          .contains("\"actorPresent\":true", "\"expiryPresent\":true");
      mvc.perform(get(path).header("Origin", "https://helm.example"))
          .andExpect(status().isUnauthorized());
      mvc.perform(
              get(path)
                  .header("Authorization", "Bearer foreign")
                  .header("Origin", "https://helm.example"))
          .andExpect(status().isForbidden());
    }
  }

  @Test
  void widgetTicketHandshakeDoesNotAdmitAnOAuthActor() throws Exception {
    for (String path :
        List.of("/stream/v1/widget/signaling/test", "/events/v1/widget/tasks/test")) {
      var response =
          mvc.perform(
                  get(path)
                      .header("Origin", "https://widget.example")
                      .header("Upgrade", "websocket"))
              .andExpect(status().isOk())
              .andReturn()
              .getResponse();
      assertThat(response.getContentAsString())
          .contains("\"actorPresent\":false", "\"expiryPresent\":false");
    }
  }

  @Test
  void sameLoginChannelAuthenticationPreservesCsrfAndMutationStillRequiresTheToken()
      throws Exception {
    var bootstrap =
        mvc.perform(get("/api/v1/me").header("Authorization", "Bearer fixture"))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse();
    String token = redis.opsForValue().get("helm:csrf:" + actor.loginId());
    assertThat(token).isNotBlank();
    assertThat(bootstrap.getHeaders("Set-Cookie"))
        .anyMatch(value -> value.contains("__Host-helm_csrf=" + token));
    var channel =
        mvc.perform(
                get("/events/v1/user")
                    .header("Authorization", "Bearer fixture")
                    .header("Origin", "https://helm.example")
                    .header("Upgrade", "websocket"))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse();
    assertThat(channel.getHeaders("Set-Cookie")).noneMatch(value -> value.contains("Max-Age=0"));
    assertThat(redis.opsForValue().get("helm:csrf:" + actor.loginId())).isEqualTo(token);
    mvc.perform(
            post("/api/v1/tasks")
                .header("Authorization", "Bearer fixture")
                .header("Origin", "https://helm.example"))
        .andExpect(status().isForbidden());
    mvc.perform(
            post("/api/v1/tasks")
                .header("Authorization", "Bearer fixture")
                .header("Origin", "https://helm.example")
                .header("X-XSRF-TOKEN", "wrong"))
        .andExpect(status().isForbidden());
    mvc.perform(
            post("/api/v1/tasks")
                .header("Authorization", "Bearer fixture")
                .header("Origin", "https://helm.example")
                .header("X-XSRF-TOKEN", token))
        .andExpect(status().isOk());
    var loaded =
        mvc.perform(get("/api/v1/me").header("Authorization", "Bearer fixture"))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse();
    assertThat(loaded.getHeaders("Set-Cookie")).hasSize(1);
    assertThat(redis.opsForValue().get("helm:csrf:" + actor.loginId())).isEqualTo(token);
  }
}
