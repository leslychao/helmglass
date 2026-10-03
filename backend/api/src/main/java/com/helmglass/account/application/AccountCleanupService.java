package com.helmglass.account.application;

import com.helmglass.account.infrastructure.repository.AccountCleanupRepository;
import com.helmglass.account.infrastructure.repository.AccountCleanupRepository.Purge;
import com.helmglass.account.infrastructure.repository.AccountCleanupRepository.Stage;
import com.helmglass.account.infrastructure.repository.AccountDataRepository;
import com.helmglass.api.DomainException;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.identity.infrastructure.KeycloakSessionClient;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.vault.VaultException;
import software.amazon.awssdk.core.exception.SdkException;

/** Coordinates replayable external cleanup; no external effect is inferred from a local commit. */
@Service
@Slf4j
public class AccountCleanupService {
  private record Work(Purge purge, Stage stage) {}

  private final AccountCleanupRepository cleanup;
  private final AccountDataRepository data;
  private final KeycloakSessionClient keycloak;
  private final UserEphemeralState ephemeral;
  private final ObjectStorage storage;
  private final ProfileKeyService keys;
  private final TransactionTemplate transaction;

  public AccountCleanupService(
      AccountCleanupRepository cleanup,
      AccountDataRepository data,
      KeycloakSessionClient keycloak,
      UserEphemeralState ephemeral,
      ObjectStorage storage,
      ProfileKeyService keys,
      PlatformTransactionManager transactions) {
    this.cleanup = cleanup;
    this.data = data;
    this.keycloak = keycloak;
    this.ephemeral = ephemeral;
    this.storage = storage;
    this.keys = keys;
    transaction = new TransactionTemplate(transactions);
    transaction.setTimeout(30);
  }

  @Scheduled(fixedDelay = 1000)
  public void advanceIdentity() {
    for (UUID userId : cleanup.pendingIdentity()) {
      processIdentity(userId);
    }
    transaction.executeWithoutResult(status -> cleanup.refreshStops());
  }

  public void processIdentity(UUID userId) {
    try {
      transaction.executeWithoutResult(
          status -> {
            var current = cleanup.lockIdentity(userId);
            if (current.completedVersion() >= current.desiredVersion() || current.attempts() >= 3) {
              return;
            }
            boolean enabled = current.state().equals("ACTIVE");
            keycloak.reconcileUser(current.subject(), enabled);
            if (!enabled && !ephemeral.purgeBatch(userId)) {
              cleanup.deferIdentity(userId);
              return;
            }
            cleanup.identityComplete(current);
          });
    } catch (DomainException | DataAccessException error) {
      transaction.executeWithoutResult(status -> cleanup.identityFailed(userId));
      log.warn("Account identity cleanup pending for {}", userId);
    }
  }

  @Scheduled(fixedDelay = 1000)
  public void advancePurge() {
    var due = cleanup.duePurges();
    if (!due.isEmpty()) {
      processPurge(due.getFirst());
    }
  }

  public void processPurge(UUID requestId) {
    Work work =
        transaction.execute(
            status -> {
              Purge purge = cleanup.begin(cleanup.lockPurge(requestId));
              if (!purge.status().equals("PURGING") || !cleanup.claim(requestId)) {
                return null;
              }
              return new Work(
                  purge, Objects.requireNonNull(cleanup.nextStage(purge.purgeOperationId())));
            });
    if (work == null) {
      return;
    }
    try {
      if (!perform(work)) {
        transaction.executeWithoutResult(
            status -> {
              if (work.stage().phase().equals("09_METADATA")) {
                cleanup.ready(requestId);
              } else {
                cleanup.defer(requestId, null, false);
              }
            });
        return;
      }
      transaction.executeWithoutResult(
          status -> {
            Purge current = cleanup.lockPurge(requestId);
            if (!current.status().equals("PURGING")) {
              return;
            }
            cleanup.stageComplete(
                current.purgeOperationId(), work.stage().itemKey(), Map.of("confirmed", true));
            cleanup.ready(requestId);
            if (work.stage().phase().equals("10_VERIFY")) {
              cleanup.complete(current);
            }
          });
    } catch (DomainException
        | DataAccessException
        | SdkException
        | VaultException
        | IllegalStateException error) {
      transaction.executeWithoutResult(
          status -> cleanup.defer(requestId, "PURGE_EFFECT_UNCONFIRMED", true));
      log.warn("Account purge {} remains unconfirmed at {}", requestId, work.stage().phase());
    }
  }

  private boolean perform(Work work) {
    Purge purge = work.purge();
    UUID userId = purge.userId();
    return switch (work.stage().phase()) {
      case "02_RUNTIME" -> cleanup.runtimesClosed(userId);
      case "03_ARTIFACTS" -> storage.purgeUserBatch("hg-artifacts", userId);
      case "04_PROFILES" -> storage.purgeUserBatch("hg-browser-profiles", userId);
      case "05_STAGING" -> storage.purgeUserBatch("hg-staging", userId);
      case "06_KEYS" -> {
        keys.destroy(userId);
        yield true;
      }
      case "07_REDIS" -> ephemeral.purgeBatch(userId);
      case "08_IDENTITY" -> {
        keycloak.deleteUser(purge.subject());
        yield true;
      }
      case "09_METADATA" ->
          Boolean.TRUE.equals(
              transaction.execute(
                  status -> {
                    cleanup.lockPurge(purge.id());
                    return cleanup.runtimesClosed(userId) && data.purgeBatch(userId);
                  }));
      case "10_VERIFY" -> {
        // Reconcile delayed object/key effects once more after metadata cleanup, before the
        // tombstone.
        keys.destroy(userId);
        yield cleanup.runtimesClosed(userId)
            && storage.purgeUserBatch("hg-artifacts", userId)
            && storage.purgeUserBatch("hg-browser-profiles", userId)
            && storage.purgeUserBatch("hg-staging", userId)
            && ephemeral.purgeBatch(userId);
      }
      default -> throw new IllegalStateException("Unsupported account purge phase");
    };
  }
}
