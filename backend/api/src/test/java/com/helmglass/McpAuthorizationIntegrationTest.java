package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.helmglass.account.application.AccountLifecycleService;
import com.helmglass.administration.api.AdminContracts;
import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.identity.application.IdentityService;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;

@SpringJUnitConfig({CoreOwnersIntegrationTest.Owners.class, IdentityService.class})
class McpAuthorizationIntegrationTest {
  private final IdentityService identities;
  private final IdentityRepository repository;
  private final AccountLifecycleService accounts;
  private final UserPolicyService policies;
  private final JdbcClient jdbc;

  @Autowired
  McpAuthorizationIntegrationTest(
      IdentityService identities,
      IdentityRepository repository,
      AccountLifecycleService accounts,
      UserPolicyService policies,
      JdbcClient jdbc) {
    this.identities = identities;
    this.repository = repository;
    this.accounts = accounts;
    this.policies = policies;
    this.jdbc = jdbc;
  }

  @Test
  void unseenOfflineSessionCannotCrossBlockBarrierWithANewTokenIssueTime() {
    String subject = UUID.randomUUID().toString();
    Instant originalAuthentication = Instant.now().minusSeconds(120);
    var web =
        identities.authenticate(
            token(subject, UUID.randomUUID().toString(), "helm-web", originalAuthentication)
                .build(),
            false);
    var admin = administrator();
    change(admin, web.userId(), 1, "block");
    change(admin, web.userId(), 2, "unblock");

    Jwt refresh =
        token(subject, UUID.randomUUID().toString(), "helm-mcp", originalAuthentication)
            .issuedAt(Instant.now())
            .build();
    assertThatThrownBy(() -> identities.authenticate(refresh, true))
        .isInstanceOfSatisfying(
            DomainException.class,
            error -> {
              assertThat(error.getStatus()).isEqualTo(401);
              assertThat(error.getCode()).isEqualTo("REAUTHENTICATION_REQUIRED");
            });
    assertThat(grantCount(web.userId())).isZero();
  }

  @Test
  void knownRevokedGrantNeverReactivatesOnRefresh() {
    String subject = UUID.randomUUID().toString();
    String sid = UUID.randomUUID().toString();
    Instant authentication = Instant.now().minusSeconds(120);
    var web =
        identities.authenticate(token(subject, sid, "helm-web", authentication).build(), false);
    var mcp =
        identities.authenticate(token(subject, sid, "helm-mcp", authentication).build(), true);
    policies.revoke(web, mcp.grantId(), context());

    assertThatThrownBy(
            () ->
                identities.authenticate(
                    token(subject, sid, "helm-mcp", authentication).issuedAt(Instant.now()).build(),
                    true))
        .isInstanceOfSatisfying(
            DomainException.class, error -> assertThat(error.getCode()).isEqualTo("GRANT_REVOKED"));
    assertThat(grantCount(web.userId())).isOne();
    assertThat(repository.authorizationActive(web.userId(), null, mcp.grantId(), mcp.accessEpoch()))
        .isFalse();

    var reauthorized =
        identities.authenticate(
            token(subject, UUID.randomUUID().toString(), "helm-mcp", Instant.now()).build(), true);
    assertThat(reauthorized.grantId()).isNotEqualTo(mcp.grantId());
  }

  @Test
  void freshAuthenticationAfterBarrierAdmitsBothChannelsButEqualityDoesNot() {
    String subject = UUID.randomUUID().toString();
    var web =
        identities.authenticate(
            token(subject, UUID.randomUUID().toString(), "helm-web", Instant.now()).build(), false);
    var admin = administrator();
    change(admin, web.userId(), 1, "block");
    change(admin, web.userId(), 2, "unblock");
    Instant barrier =
        Objects.requireNonNull(repository.find(web.userId()).orElseThrow().reauthenticationAfter());

    for (String client : List.of("helm-web", "helm-mcp")) {
      assertThatThrownBy(
              () ->
                  identities.authenticate(
                      token(subject, UUID.randomUUID().toString(), client, barrier).build(),
                      client.equals("helm-mcp")))
          .isInstanceOfSatisfying(
              DomainException.class,
              error -> assertThat(error.getCode()).isEqualTo("REAUTHENTICATION_REQUIRED"));
    }
    await()
        .atMost(Duration.ofSeconds(3))
        .until(() -> Instant.now().truncatedTo(ChronoUnit.SECONDS).isAfter(barrier));
    Instant freshAuthentication = Instant.now().truncatedTo(ChronoUnit.SECONDS);
    var freshMcp =
        identities.authenticate(
            token(subject, UUID.randomUUID().toString(), "helm-mcp", freshAuthentication).build(),
            true);
    var freshWeb =
        identities.authenticate(
            token(subject, UUID.randomUUID().toString(), "helm-web", freshAuthentication).build(),
            false);
    assertThat(freshMcp.grantId()).isNotNull();
    assertThat(freshWeb.loginId()).isNotNull();
    assertThat(freshMcp.accessEpoch())
        .isEqualTo(freshWeb.accessEpoch())
        .isGreaterThan(web.accessEpoch());
  }

  @Test
  void webLogoutPreservesIndependentMcpGrantAndOriginalOfflineAuthenticationTime() {
    String subject = UUID.randomUUID().toString();
    String sid = UUID.randomUUID().toString();
    Instant authentication = Instant.now().minusSeconds(3600);
    var web =
        identities.authenticate(token(subject, sid, "helm-web", authentication).build(), false);
    var mcp =
        identities.authenticate(token(subject, sid, "helm-mcp", authentication).build(), true);
    identities.logout(web, context());

    var refreshed =
        identities.authenticate(
            token(subject, sid, "helm-mcp", authentication).issuedAt(Instant.now()).build(), true);
    assertThat(refreshed.grantId()).isEqualTo(mcp.grantId());
    assertThat(refreshed.accessEpoch()).isEqualTo(mcp.accessEpoch());
    assertThat(grantCount(web.userId())).isOne();
    assertThat(repository.authorizationActive(web.userId(), null, mcp.grantId(), mcp.accessEpoch()))
        .isTrue();
    assertThatThrownBy(
            () ->
                identities.authenticate(
                    token(subject, sid, "helm-web", authentication).build(), false))
        .isInstanceOfSatisfying(
            DomainException.class, error -> assertThat(error.getCode()).isEqualTo("LOGIN_REVOKED"));
  }

  @Test
  void deletionRestoreRejectsAnUnseenPreexistingOfflineSession() {
    String subject = UUID.randomUUID().toString();
    Instant originalAuthentication = Instant.now().minusSeconds(120);
    var web =
        identities.authenticate(
            token(subject, UUID.randomUUID().toString(), "helm-web", originalAuthentication)
                .build(),
            false);
    var admin = administrator();
    var deletion =
        accounts.change(
            admin,
            web.userId(),
            new AdminContracts.Reason(1L, "Fixture deletion"),
            context(),
            "delete");
    accounts.restore(
        admin,
        deletion.resource().id(),
        new AdminContracts.Reason(1L, "Fixture restore"),
        context());

    assertThatThrownBy(
            () ->
                identities.authenticate(
                    token(subject, UUID.randomUUID().toString(), "helm-mcp", originalAuthentication)
                        .build(),
                    true))
        .isInstanceOfSatisfying(
            DomainException.class,
            error -> assertThat(error.getCode()).isEqualTo("REAUTHENTICATION_REQUIRED"));
    assertThat(grantCount(web.userId())).isZero();
  }

  @Test
  void recentIssueTimeCannotReplaceMissingAuthenticationTime() {
    for (String client : List.of("helm-web", "helm-mcp")) {
      Jwt token =
          token(UUID.randomUUID().toString(), UUID.randomUUID().toString(), client, Instant.now())
              .claims(claims -> claims.remove("auth_time"))
              .build();
      assertThatThrownBy(() -> identities.authenticate(token, client.equals("helm-mcp")))
          .isInstanceOfSatisfying(
              DomainException.class,
              error -> assertThat(error.getCode()).isEqualTo("AUTH_TIME_REQUIRED"));
    }
  }

  private void change(AuthenticatedActor admin, UUID userId, long version, String action) {
    accounts.change(
        admin,
        userId,
        new AdminContracts.Reason(version, "Fixture access review"),
        context(),
        action);
  }

  private AuthenticatedActor administrator() {
    return identities.authenticate(
        token(UUID.randomUUID().toString(), UUID.randomUUID().toString(), "helm-web", Instant.now())
            .claim("realm_access", Map.of("roles", List.of("platform_admin")))
            .build(),
        false);
  }

  private long grantCount(UUID userId) {
    return jdbc.sql("SELECT count(*) FROM client_grants WHERE user_id=:user")
        .param("user", userId)
        .query(Long.class)
        .single();
  }

  private static Jwt.Builder token(
      String subject, String sid, String clientId, Instant authentication) {
    Instant issued = Instant.now();
    return Jwt.withTokenValue("fixture-token")
        .header("alg", "RS256")
        .issuer("https://issuer.example")
        .subject(subject)
        .audience(List.of(clientId.equals("helm-mcp") ? "helm-mcp" : "helm-api-web"))
        .issuedAt(issued)
        .expiresAt(issued.plusSeconds(300))
        .claim("azp", clientId)
        .claim("sid", sid)
        .claim("auth_time", authentication)
        .claim("scope", "openid offline_access tasks:read tasks:write browser:view");
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
