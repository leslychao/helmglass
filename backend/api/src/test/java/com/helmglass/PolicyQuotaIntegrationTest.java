package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.helmglass.administration.api.AdminContracts;
import com.helmglass.administration.application.AdministrationService;
import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.identity.api.PolicyContracts;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

@SpringJUnitConfig(CoreOwnersIntegrationTest.Owners.class)
class PolicyQuotaIntegrationTest {
  private final UserPolicyService policies;
  private final IdentityRepository identities;
  private final AdministrationService administration;
  private final JsonSupport json;
  private final TransactionTemplate transaction;
  private final JdbcClient jdbc;
  private final RealtimeDeliveryService realtime;

  @Autowired
  PolicyQuotaIntegrationTest(
      UserPolicyService policies,
      IdentityRepository identities,
      AdministrationService administration,
      JsonSupport json,
      JdbcClient jdbc,
      RealtimeDeliveryService realtime,
      PlatformTransactionManager transactions) {
    this.policies = policies;
    this.identities = identities;
    this.administration = administration;
    this.json = json;
    this.jdbc = jdbc;
    this.realtime = realtime;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void assignedQuotaChangeRefreshesOnlyTargetPolicyAndReplayDoesNotDuplicateDelivery()
      throws Exception {
    var target = actor(false);
    var other = actor(false);
    var admin = actor(true);
    update(target, 2, 4);
    assertThat(policyIntents(target.userId())).isEqualTo(1);
    // Personal and assigned policies now both reach version 2: their events must not collide.
    realtime.relay();
    var otherBefore = policies.get(other);
    var targetSocket = subscribe(target);
    var otherSocket = subscribe(other);
    try {
      var input = new AdminContracts.Limits(1L, "QA quota change", "CUSTOM", 1, "CUSTOM", 2);
      var mutation = context();
      var receipt = administration.limits(admin, target.userId(), input, mutation);
      assertThat(administration.limits(admin, target.userId(), input, mutation)).isEqualTo(receipt);
      assertThat(policyIntents(receipt.operationId())).isEqualTo(1);
      realtime.relay();
      var messages = ArgumentCaptor.forClass(TextMessage.class);
      verify(targetSocket, times(2)).sendMessage(messages.capture());
      assertThat(json.read(messages.getAllValues().getLast().getPayload()))
          .isEqualTo(json.read("{\"type\":\"invalidate\",\"resources\":[\"policy\"]}"));
      verify(otherSocket).sendMessage(any(TextMessage.class));
      var refreshed = policies.get(target);
      assertThat(refreshed.maxBrowserSessions()).isEqualTo(2);
      assertThat(refreshed.maxQueuedRuns()).isEqualTo(4);
      assertThat(refreshed.quotas()).isEqualTo(new PolicyContracts.Quotas(1, 2, 1, 2));
      assertThat(policies.get(other)).isEqualTo(otherBefore);
      realtime.relay();
      verify(targetSocket, times(2)).sendMessage(any(TextMessage.class));
    } finally {
      realtime.afterConnectionClosed(targetSocket, CloseStatus.NORMAL);
      realtime.afterConnectionClosed(otherSocket, CloseStatus.NORMAL);
    }
  }

  @Test
  void quotaRollbackAndUnauthorizedChangesLeaveNoPolicyEventOrChangedValues() {
    var target = actor(false);
    var admin = actor(true);
    var before = policies.get(target);
    var input = new AdminContracts.Limits(1L, "QA rollback", "CUSTOM", 1, "CUSTOM", 0);
    assertThatThrownBy(() -> administration.limits(target, target.userId(), input, context()))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Administrator");
    var receipt =
        transaction.execute(
            status -> {
              var accepted = administration.limits(admin, target.userId(), input, context());
              assertThat(policyIntents(accepted.operationId())).isEqualTo(1);
              assertThat(policies.get(target).quotas().effectiveBrowserLimit()).isEqualTo(1);
              status.setRollbackOnly();
              return accepted;
            });
    assertThat(receipt).isNotNull();
    assertThat(policyIntents(Objects.requireNonNull(receipt).operationId())).isZero();
    assertThat(policies.get(target)).isEqualTo(before);
  }

  private long policyIntents(UUID operationId) {
    return jdbc.sql(
            "SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:id AND"
                + " event_type='policy'")
        .param("id", operationId)
        .query(Long.class)
        .single();
  }

  private WebSocketSession subscribe(AuthenticatedActor actor) throws Exception {
    WebSocketSession socket = mock(WebSocketSession.class);
    when(socket.getId()).thenReturn(UUID.randomUUID().toString());
    when(socket.isOpen()).thenReturn(true);
    when(socket.getAttributes())
        .thenReturn(
            Map.of(
                AuthenticatedActor.class.getName(),
                actor,
                "helm.authorizationExpiresAt",
                Instant.now().plusSeconds(300)));
    realtime.afterConnectionEstablished(socket);
    realtime.handleMessage(
        socket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"self\"]}"));
    return socket;
  }

  @Test
  void personalLimitsInheritOrTightenAssignedCapsAndPreserveZeroQueue() {
    var user = actor(false);
    var admin = actor(true);
    assertThat(policies.get(user).quotas().assignedBrowserLimit()).isEqualTo(2);
    assertThat(policies.get(user).quotas().effectiveQueuedLimit()).isNull();
    assertThatThrownBy(() -> update(user, 3, null))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("cannot exceed");
    update(user, 1, 0);
    var policy = policies.get(user);
    assertThat(policy.maxBrowserSessions()).isEqualTo(1);
    assertThat(policy.quotas().effectiveBrowserLimit()).isEqualTo(1);
    assertThat(policy.quotas().effectiveQueuedLimit()).isZero();
    administration.limits(
        admin,
        user.userId(),
        new AdminContracts.Limits(1L, "Quota fixture", "CUSTOM", 1, "CUSTOM", 0),
        context());
    assertThatThrownBy(() -> update(user, 1, 1))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("cannot exceed");
    update(user, null, null);
    assertThat(policies.get(user).maxBrowserSessions()).isNull();
    assertThat(policies.get(user).quotas().effectiveBrowserLimit()).isEqualTo(1);
    assertThat(policies.get(user).quotas().effectiveQueuedLimit()).isZero();
    administration.limits(
        admin,
        user.userId(),
        new AdminContracts.Limits(2L, "Pool fixture", "POOL", null, "UNLIMITED", null),
        context());
    assertThat(policies.get(user).quotas().effectiveBrowserLimit()).isNull();
    update(user, 7, 20);
    assertThat(policies.get(user).quotas().effectiveBrowserLimit()).isEqualTo(7);
  }

  @Test
  void loweringAssignedCapacityPreservesPreferenceAndInvalidatesOtherAdministratorSnapshots() {
    var user = actor(false);
    var firstAdmin = actor(true);
    var secondAdmin = actor(true);
    update(user, 2, null);
    var parameters = new LinkedMultiValueMap<String, String>();
    parameters.set("q", user.userId().toString());
    var before = administration.users(secondAdmin, PageQuery.from(parameters));
    assertThat(before.items()).hasSize(1);
    administration.limits(
        firstAdmin,
        user.userId(),
        new AdminContracts.Limits(1L, "Reduce future admissions", "CUSTOM", 1, "UNLIMITED", null),
        context());
    var policy = policies.get(user);
    assertThat(policy.maxBrowserSessions()).isEqualTo(2);
    assertThat(policy.quotas().effectiveBrowserLimit()).isEqualTo(1);
    parameters.set("snapshot", before.snapshot());
    assertThatThrownBy(() -> administration.users(secondAdmin, PageQuery.from(parameters)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Refresh");
    parameters.remove("snapshot");
    var row =
        json.read(
            json.write(
                administration.users(secondAdmin, PageQuery.from(parameters)).items().getFirst()));
    var detail = json.read(json.write(administration.user(secondAdmin, user.userId())));
    assertThat(row.path("limits")).isEqualTo(detail.path("limits"));
    assertThat(row.path("limits").path("personalBrowserLimit").asInt()).isEqualTo(2);
    assertThat(row.path("limits").path("quotas").path("effectiveBrowserLimit").asInt())
        .isEqualTo(1);
    assertThat(row.has("limitVersion")).isFalse();
    assertThatThrownBy(() -> administration.users(user, PageQuery.from(parameters)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Administrator");
    update(user, null, null);
    assertThat(policies.get(user).quotas().effectiveBrowserLimit()).isEqualTo(1);
  }

  private void update(AuthenticatedActor actor, Integer browsers, Integer queued) {
    var current = policies.get(actor);
    policies.update(
        actor,
        new PolicyContracts.Update(
            current.version(),
            "ALL",
            "AUTO",
            List.of(),
            true,
            List.of(),
            null,
            null,
            null,
            queued,
            null,
            browsers),
        context());
  }

  private AuthenticatedActor actor(boolean admin) {
    var account =
        transaction.execute(
            status ->
                identities.resolve(
                    "https://issuer.example",
                    UUID.randomUUID().toString(),
                    "Quota test",
                    "quota@example.test"));
    Objects.requireNonNull(account);
    var login =
        transaction.execute(
            status ->
                identities.admitLogin(
                    account,
                    "https://issuer.example",
                    UUID.randomUUID().toString(),
                    Instant.now(),
                    Instant.now().plusSeconds(300)));
    return new AuthenticatedActor(
        account.id(),
        Objects.requireNonNull(login),
        null,
        "helm-web",
        account.displayName(),
        account.email(),
        account.accessEpoch(),
        admin ? Set.of("platform_admin") : Set.of(),
        false);
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
