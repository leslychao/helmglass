package ru.helmglass.api.auth;

import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.web.BearerTokenAuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;

@Configuration
public class SecurityConfiguration {
  @Bean
  JwtDecoder jwtDecoder(
      @Value("${helm.issuer}") String issuer, @Value("${helm.jwk-set-uri}") String jwks) {
    NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwks).build();
    OAuth2TokenValidator<Jwt> audience =
        jwt ->
            jwt.getAudience().contains("helmglass-api")
                ? OAuth2TokenValidatorResult.success()
                : OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token"));
    decoder.setJwtValidator(
        new DelegatingOAuth2TokenValidator<>(
            JwtValidators.createDefaultWithIssuer(issuer), audience));
    return decoder;
  }

  @Bean
  SecurityFilterChain securityFilterChain(
      HttpSecurity http,
      @Value("${helm.public-url}") String publicUrl,
      @Value("${helm.issuer}") String issuer)
      throws Exception {
    http.sessionManagement(
        session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
    http.csrf(
        csrf ->
            csrf.csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
                .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler())
                .ignoringRequestMatchers("/internal/**", "/mcp", "/mcp/**"));
    http.authorizeHttpRequests(
        access ->
            access
                .requestMatchers(
                    "/actuator/health", "/internal/**", "/.well-known/**", "/widget/events")
                .permitAll()
                .anyRequest()
                .authenticated());
    BearerTokenAuthenticationEntryPoint challenge = new BearerTokenAuthenticationEntryPoint();
    challenge.setResourceMetadataParameterResolver(
        request -> publicUrl + "/.well-known/oauth-protected-resource/mcp");
    http.oauth2ResourceServer(
        resource ->
            resource
                .jwt(jwt -> {})
                .authenticationEntryPoint(challenge)
                .protectedResourceMetadata(
                    metadata ->
                        metadata.protectedResourceMetadataCustomizer(
                            builder ->
                                builder
                                    .resource(publicUrl + "/mcp")
                                    .resourceName("Helm Glass")
                                    .authorizationServer(issuer)
                                    .scope("openid")
                                    .scope("profile")
                                    .scope("email")
                                    .scope("offline_access")
                                    .tlsClientCertificateBoundAccessTokens(false))));
    http.exceptionHandling(
        errors ->
            errors.defaultAuthenticationEntryPointFor(
                challenge, request -> request.getRequestURI().equals("/mcp")));
    return http.build();
  }

  public static Set<String> roles(Jwt jwt) {
    Set<String> result = new HashSet<>();
    var realm = jwt.getClaimAsMap("realm_access");
    if (realm != null && realm.get("roles") instanceof Collection<?> values) {
      for (Object value : values) {
        if (value instanceof String role && Set.of("USER", "ADMIN").contains(role)) {
          result.add(role);
        }
      }
    }
    return Set.copyOf(result);
  }
}
