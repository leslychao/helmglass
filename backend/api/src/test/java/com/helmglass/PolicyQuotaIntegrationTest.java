package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;

@SpringJUnitConfig(CoreOwnersIntegrationTest.Owners.class)
class PolicyQuotaIntegrationTest {
  private final UserPolicyService policies;
  private final IdentityRepository identities;
  private final AdministrationService administration;
  private final JsonSupport json;
  private final TransactionTemplate transaction;

  @Autowired
  PolicyQuotaIntegrationTest(
      UserPolicyService policies,
      IdentityRepository identities,
      AdministrationService administration,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.policies = policies;
    this.identities = identities;
    this.administration = administration;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
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
    return new AuthenticatedActor(
        account.id(),
        UUID.randomUUID(),
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
