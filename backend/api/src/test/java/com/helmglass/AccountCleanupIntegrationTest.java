package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.helmglass.account.application.AccountCleanupService;
import com.helmglass.account.application.AccountLifecycleService;
import com.helmglass.account.infrastructure.repository.AccountCleanupRepository;
import com.helmglass.account.infrastructure.repository.AccountDataRepository;
import com.helmglass.administration.api.AdminContracts;
import com.helmglass.administration.infrastructure.repository.AdministrationRepository;
import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.KeycloakSessionClient;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Real PostgreSQL owners; external providers are explicit doubles in this state-machine test. */
@SpringJUnitConfig(AccountCleanupIntegrationTest.Owners.class)
class AccountCleanupIntegrationTest {
  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    AccountLifecycleService.class,
    AccountCleanupService.class,
    AccountCleanupRepository.class,
    AccountDataRepository.class,
    AdministrationRepository.class
  })
  static class Owners {
    @Bean
    KeycloakSessionClient keycloak() {
      return mock(KeycloakSessionClient.class);
    }

    @Bean
    UserEphemeralState ephemeral() {
      return mock(UserEphemeralState.class);
    }

    @Bean
    ObjectStorage storage() {
      return mock(ObjectStorage.class);
    }

    @Bean
    ProfileKeyService keys() {
      return mock(ProfileKeyService.class);
    }
  }

  private final AccountLifecycleService accounts;
  private final AccountCleanupService cleanup;
  private final IdentityRepository identities;
  private final TaskLifecycleService tasks;
  private final BrowserRepository browsers;
  private final JdbcClient jdbc;
  private final KeycloakSessionClient keycloak;
  private final UserEphemeralState ephemeral;
  private final ObjectStorage storage;
  private final ProfileKeyService keys;
  private final TransactionTemplate transaction;

  @Autowired
  AccountCleanupIntegrationTest(
      AccountLifecycleService accounts,
      AccountCleanupService cleanup,
      IdentityRepository identities,
      TaskLifecycleService tasks,
      BrowserRepository browsers,
      JdbcClient jdbc,
      KeycloakSessionClient keycloak,
      UserEphemeralState ephemeral,
      ObjectStorage storage,
      ProfileKeyService keys,
      PlatformTransactionManager transactions) {
    this.accounts = accounts;
    this.cleanup = cleanup;
    this.identities = identities;
    this.tasks = tasks;
    this.browsers = browsers;
    this.jdbc = jdbc;
    this.keycloak = keycloak;
    this.ephemeral = ephemeral;
    this.storage = storage;
    this.keys = keys;
    transaction = new TransactionTemplate(transactions);
  }

  @BeforeEach
  void providers() {
    reset(keycloak, ephemeral, storage, keys);
    when(ephemeral.purgeBatch(any())).thenReturn(true);
    when(storage.purgeUserBatch(anyString(), any())).thenReturn(true);
  }

  @Test
  void retentionAllowsCancellationAndPurgeWaitsForConfirmedStorageDeletion() {
    var admin = actor(true);
    var user = actor(false);
    var deletion = delete(admin, user);
    cleanup.processPurge(deletion.resource().id());
    verify(storage, never()).purgeUserBatch(anyString(), any());
    accounts.restore(
        admin, deletion.resource().id(), new AdminContracts.Reason(1L, "Recover"), context());
    assertThat(identities.isActive(user.userId())).isTrue();

    var second =
        accounts.change(
            admin,
            user.userId(),
            new AdminContracts.Reason(3L, "Delete again"),
            context(),
            "delete");
    UUID requestId = second.resource().id();
    expire(requestId);
    cleanup.processPurge(requestId);
    next(requestId);
    when(storage.purgeUserBatch(anyString(), any()))
        .thenThrow(new DomainException(503, "STORAGE_UNAVAILABLE", "Unavailable"));
    cleanup.processPurge(requestId);
    assertThat(state(user.userId())).isEqualTo("PURGING");
    verify(storage).purgeUserBatch("hg-artifacts", user.userId());
    verify(keys, never()).destroy(any());
    assertThatThrownBy(
            () ->
                accounts.restore(
                    admin, requestId, new AdminContracts.Reason(2L, "Too late"), context()))
        .isInstanceOf(DomainException.class);
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM operation_items WHERE operation_id=(SELECT"
                        + " purge_operation_id FROM account_deletion_requests WHERE id=:id) AND"
                        + " state='SUCCEEDED'")
                .param("id", requestId)
                .query(Long.class)
                .single())
        .isOne();
  }

  @Test
  void occupiedRuntimeKeepsQuotaUntilConfirmedCloseBeforeAnyObjectDeletion() {
    var admin = actor(true);
    var user = actor(false);
    var task =
        tasks.create(
            user,
            new TaskContracts.Create(
                "Read", "https://example.com", List.of(), "TEXT", false, 1800, "PREPARE"),
            context());
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    jdbc.sql(
            "INSERT INTO browser_workers(id,boot_id,capacity,observed_state,image_version)"
                + " VALUES(:id,:boot,1,'READY','fixture')")
        .param("id", worker)
        .param("boot", boot)
        .update();
    var session =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    browsers.reserve(
                        user.userId(),
                        task.resource().id(),
                        new BrowserRepository.Worker(worker, boot, 1),
                        1800)));
    UUID request = delete(admin, user).resource().id();
    expire(request);
    cleanup.processPurge(request);
    next(request);
    cleanup.processPurge(request);
    verify(storage, never()).purgeUserBatch(anyString(), any());
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM browser_allocations WHERE session_id=:id AND"
                        + " state<>'RELEASED'")
                .param("id", session.id())
                .query(Long.class)
                .single())
        .isOne();
    jdbc.sql("UPDATE browser_sessions SET state='CLOSED',binding_released_at=now() WHERE id=:id")
        .param("id", session.id())
        .update();
    jdbc.sql("UPDATE browser_allocations SET state='RELEASED' WHERE session_id=:id")
        .param("id", session.id())
        .update();
    finish(request);
    assertThat(state(user.userId())).isEqualTo("DELETED");
  }

  @Test
  void confirmedPurgeRemovesOwnedDataKeepsAuditAndPreventsIdentityResurrection() {
    var admin = actor(true);
    var user = actor(false);
    String subject =
        jdbc.sql("SELECT subject FROM application_users WHERE id=:id")
            .param("id", user.userId())
            .query(String.class)
            .single();
    tasks.create(
        user,
        new TaskContracts.Create(
            "Private draft", "https://example.com", List.of(), "TEXT", false, 1800, "DRAFT"),
        context());
    UUID request = delete(admin, user).resource().id();
    expire(request);
    finish(request);
    assertThat(state(user.userId())).isEqualTo("DELETED");
    assertThat(
            jdbc.sql("SELECT count(*) FROM tasks WHERE user_id=:id")
                .param("id", user.userId())
                .query(Long.class)
                .single())
        .isZero();
    assertThat(
            jdbc.sql("SELECT count(*) FROM user_policies WHERE user_id=:id")
                .param("id", user.userId())
                .query(Long.class)
                .single())
        .isZero();
    assertThat(
            jdbc.sql("SELECT count(*) FROM admin_audit_log WHERE target_user_id=:id")
                .param("id", user.userId())
                .query(Long.class)
                .single())
        .isGreaterThanOrEqualTo(3);
    assertThat(
            jdbc.sql("SELECT email FROM application_users WHERE id=:id")
                .param("id", user.userId())
                .query(String.class)
                .single())
        .isEmpty();
    assertThatThrownBy(
            () ->
                transaction.execute(
                    status ->
                        identities.resolve(
                            "https://issuer.example", subject, "Old identity", "old@example.test")))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("permanently deleted");
    verify(keycloak).deleteUser(subject);
    cleanup.processPurge(request);
    assertThat(
            jdbc.sql("SELECT count(*) FROM operations WHERE target_id=:id AND kind='ACCOUNT_PURGE'")
                .param("id", request)
                .query(Long.class)
                .single())
        .isOne();
  }

  @Test
  void latestIdentityIntentWinsAndProviderFailuresNeverCompleteTheOperation() {
    var admin = actor(true);
    var user = actor(false);
    String subject =
        jdbc.sql("SELECT subject FROM application_users WHERE id=:id")
            .param("id", user.userId())
            .query(String.class)
            .single();
    var blocked =
        accounts.change(
            admin, user.userId(), new AdminContracts.Reason(1L, "Block"), context(), "block");
    var unblocked =
        accounts.change(
            admin, user.userId(), new AdminContracts.Reason(2L, "Unblock"), context(), "unblock");
    cleanup.processIdentity(user.userId());
    cleanup.advanceIdentity();
    verify(keycloak).reconcileUser(subject, true);
    verify(keycloak, never()).reconcileUser(subject, false);
    assertThat(operationState(blocked.operationId())).isEqualTo("CANCELLED");
    assertThat(operationState(unblocked.operationId())).isEqualTo("SUCCEEDED");
    var failed =
        accounts.change(
            admin, user.userId(), new AdminContracts.Reason(3L, "Block again"), context(), "block");
    doThrow(new DomainException(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Unavailable"))
        .when(keycloak)
        .reconcileUser(subject, false);
    for (int attempt = 0; attempt < 3; attempt++) {
      cleanup.processIdentity(user.userId());
    }
    assertThat(operationState(failed.operationId())).isEqualTo("NEEDS_ATTENTION");
    assertThat(identities.isActive(user.userId())).isFalse();
  }

  private MutationReceipt delete(AuthenticatedActor admin, AuthenticatedActor user) {
    return accounts.change(
        admin, user.userId(), new AdminContracts.Reason(1L, "Remove account"), context(), "delete");
  }

  private void finish(UUID request) {
    for (int batch = 0; batch < 100; batch++) {
      next(request);
      cleanup.processPurge(request);
      String status =
          jdbc.sql("SELECT status FROM account_deletion_requests WHERE id=:id")
              .param("id", request)
              .query(String.class)
              .single();
      if (status.equals("PURGED")) {
        return;
      }
    }
    throw new AssertionError("Purge did not finish within the bounded fixture");
  }

  private void expire(UUID request) {
    jdbc.sql(
            "UPDATE account_deletion_requests SET delete_requested_at=now()-interval '169"
                + " hours',restore_until=now()-interval '1 hour' WHERE id=:id")
        .param("id", request)
        .update();
  }

  private void next(UUID request) {
    jdbc.sql("UPDATE account_deletion_requests SET next_attempt_at=now() WHERE id=:id")
        .param("id", request)
        .update();
  }

  private String state(UUID userId) {
    return jdbc.sql("SELECT state FROM application_users WHERE id=:id")
        .param("id", userId)
        .query(String.class)
        .single();
  }

  private String operationState(UUID operationId) {
    return jdbc.sql("SELECT state FROM operations WHERE id=:id")
        .param("id", operationId)
        .query(String.class)
        .single();
  }

  private AuthenticatedActor actor(boolean admin) {
    var account =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    identities.resolve(
                        "https://issuer.example",
                        UUID.randomUUID().toString(),
                        "User",
                        "user@example.test")));
    return new AuthenticatedActor(
        account.id(),
        UUID.randomUUID(),
        null,
        "helm-web",
        "User",
        "user@example.test",
        1,
        admin ? Set.of("platform_admin") : Set.of(),
        false);
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }
}
