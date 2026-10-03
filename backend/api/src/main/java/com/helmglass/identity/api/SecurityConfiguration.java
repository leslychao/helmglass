package com.helmglass.identity.api;

import com.helmglass.enrollment.application.WorkerEnrollmentService;
import com.helmglass.identity.application.IdentityService;
import com.helmglass.identity.infrastructure.ProxySessionIndex;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.session.NullAuthenticatedSessionStrategy;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;

@Configuration
public class SecurityConfiguration {
  @Bean
  JwtDecoder jwtDecoder(
      @Value("${helm.issuer-uri}") String issuer, @Value("${helm.jwk-set-uri}") String jwks) {
    NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwks).build();
    decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(issuer));
    return decoder;
  }

  @Bean
  @Order(1)
  SecurityFilterChain internal(
      HttpSecurity http,
      IdentityService identities,
      JwtDecoder decoder,
      WorkerEnrollmentService enrollment,
      ProxySessionIndex sessions,
      @Value("${helm.public-origin}") String origin,
      @Value("${helm.mcp-clients}") List<String> clients)
      throws Exception {
    http.securityMatcher("/internal/**")
        .sessionManagement(
            session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(csrf -> csrf.disable())
        .authorizeHttpRequests(
            auth ->
                auth.requestMatchers("/internal/mcp/**").authenticated().anyRequest().permitAll())
        .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()))
        .addFilterAfter(
            new IdentityFilter(identities, decoder, enrollment, sessions, origin, clients),
            BearerTokenAuthenticationFilter.class);
    return http.build();
  }

  @Bean
  @Order(2)
  SecurityFilterChain channelTickets(HttpSecurity http) throws Exception {
    http.securityMatcher("/stream/v1/widget/signaling/**", "/control/**", "/events/v1/widget/**")
        .sessionManagement(
            session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(csrf -> csrf.disable())
        .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
    return http.build();
  }

  @Bean
  @Order(3)
  SecurityFilterChain web(
      HttpSecurity http,
      IdentityService identities,
      JwtDecoder decoder,
      WorkerEnrollmentService enrollment,
      StringRedisTemplate redis,
      UserEphemeralState userState,
      ProxySessionIndex sessions,
      @Value("${helm.public-origin}") String origin,
      @Value("${helm.mcp-clients}") List<String> clients)
      throws Exception {
    http.sessionManagement(
            session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .exceptionHandling(
            errors ->
                errors.accessDeniedHandler(
                    (request, response, error) -> {
                      response.setStatus(403);
                      response.setContentType("application/problem+json");
                      String code =
                          error instanceof CsrfException ? "CSRF_REJECTED" : "ACCESS_DENIED";
                      response.getWriter().write("{\"status\":403,\"code\":\"" + code + "\"}");
                    }))
        .authorizeHttpRequests(
            auth ->
                auth.requestMatchers("/actuator/health", "/actuator/health/**")
                    .permitAll()
                    .anyRequest()
                    .authenticated())
        .addFilterBefore(
            new IdentityFilter(identities, decoder, enrollment, sessions, origin, clients),
            CsrfFilter.class)
        .csrf(
            csrf ->
                csrf.csrfTokenRepository(new SessionCsrfTokenRepository(redis, userState))
                    // OAuth admission owns the persisted login ID. Re-decoding its JWT is not a new
                    // login.
                    .sessionAuthenticationStrategy(new NullAuthenticatedSessionStrategy())
                    .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler()))
        .headers(
            headers ->
                headers.contentSecurityPolicy(
                    csp -> csp.policyDirectives("default-src 'none'; frame-ancestors 'none'")));
    return http.build();
  }
}
