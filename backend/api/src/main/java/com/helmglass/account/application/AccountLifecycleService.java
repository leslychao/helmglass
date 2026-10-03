package com.helmglass.account.application;

import com.helmglass.administration.api.AdminContracts;
import com.helmglass.account.infrastructure.repository.AccountCleanupRepository;
import com.helmglass.administration.infrastructure.repository.AdministrationRepository;
import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.task.application.TaskLifecycleService;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountLifecycleService {
  private final AdministrationRepository accounts;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final TaskLifecycleService tasks;
  private final AccountCleanupRepository cleanup;

  public AccountLifecycleService(AdministrationRepository accounts, IdentityRepository identities,
      OperationRepository operations, TaskLifecycleService tasks, AccountCleanupRepository cleanup) {
    this.accounts = accounts;
    this.identities = identities;
    this.operations = operations;
    this.tasks = tasks;
    this.cleanup = cleanup;
  }

  @Transactional
  public MutationReceipt change(AuthenticatedActor actor, UUID id, AdminContracts.Reason input,
      MutationContext context, String action) {
    actor.requireAdmin();
    if (actor.userId().equals(id) && !action.equals("unblock")) {
      throw new DomainException(403, "SELF_PROTECTION", "You cannot disable your own account");
    }
    identities.lockActive(actor.userId());
    var before = accounts.user(id, true);
    String kind = "admin.account." + action + ":" + id;
    var replay = operations.replay(actor, kind, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    long version = ((Number) before.get("version")).longValue();
    DomainException.requireVersion(version, input.expectedVersion());
    String state = (String) before.get("accountState");
    String next = switch (action) {
      case "block" -> "BLOCKED";
      case "unblock" -> "ACTIVE";
      case "delete" -> "DELETING";
      default -> throw new IllegalArgumentException("Unsupported account transition");
    };
    boolean allowed = action.equals("unblock") ? state.equals("BLOCKED")
        : action.equals("block") ? state.equals("ACTIVE") : java.util.List.of("ACTIVE", "BLOCKED").contains(state);
    if (!allowed) {
      throw DomainException.conflict("ACCOUNT_STATE_CONFLICT", "Account state does not permit this operation");
    }
    accounts.accountState(id, next);
    UUID resourceId = id;
    if (action.equals("delete")) {
      resourceId = UUID.randomUUID();
      accounts.requestDeletion(resourceId, id, state);
    }
    var receipt = operations.save(actor, kind, context, input, action.equals("delete") ? "deletionRequest" : "user",
        resourceId, action.equals("delete") ? 1 : version + 1, false);
    cleanup.scheduleIdentity(id, receipt.operationId());
    if (!action.equals("unblock")) {
      tasks.scheduleAccountStop(id, receipt.operationId());
    }
    accounts.audit(actor, id, "user", "ACCOUNT_" + next, input.reason(),
        Map.of("accountState", state), Map.of("accountState", next), receipt);
    return receipt;
  }

  @Transactional
  public MutationReceipt restore(AuthenticatedActor actor, UUID requestId, AdminContracts.Reason input,
      MutationContext context) {
    actor.requireAdmin();
    identities.lockActive(actor.userId());
    var deletion = accounts.deletion(requestId);
    var replay = operations.replay(actor, "admin.deletion.cancel:" + requestId, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(deletion.version(), input.expectedVersion());
    if (!deletion.status().equals("REQUESTED") || !Instant.now().isBefore(deletion.restoreUntil())) {
      throw DomainException.conflict("RESTORE_WINDOW_CLOSED", "Account recovery period has ended");
    }
    accounts.accountState(deletion.userId(), deletion.previousAccountState());
    accounts.cancelDeletion(requestId);
    var receipt = operations.save(actor, "admin.deletion.cancel:" + requestId, context, input,
        "deletionRequest", requestId, deletion.version() + 1, false);
    cleanup.scheduleIdentity(deletion.userId(), receipt.operationId());
    accounts.audit(actor, deletion.userId(), "user", "DELETION_CANCELLED", input.reason(),
        Map.of("accountState", "DELETING"), Map.of("accountState", deletion.previousAccountState()), receipt);
    return receipt;
  }

  public Map<String, Object> operation(AuthenticatedActor actor, UUID id) {
    actor.requireAdmin();
    return cleanup.operation(id);
  }

  @Transactional
  public MutationReceipt retry(AuthenticatedActor actor, UUID id, AdminContracts.Reason input,
      MutationContext context) {
    actor.requireAdmin();
    identities.lockActive(actor.userId());
    String kind = "admin.cleanup.retry:" + id;
    var replay = operations.replay(actor, kind, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    var operation = cleanup.lockOperation(id);
    DomainException.requireVersion(operation.version(), input.expectedVersion());
    if (!operation.state().equals("NEEDS_ATTENTION")) {
      throw DomainException.conflict("CLEANUP_RETRY_UNAVAILABLE", "Cleanup is not waiting for an explicit retry");
    }
    cleanup.retry(operation);
    var receipt = operations.save(actor, kind, context, input, "operation", id,
        operation.version() + 1, true);
    accounts.audit(actor, operation.targetUserId(), "user", "CLEANUP_RETRY", input.reason(),
        Map.of("state", "NEEDS_ATTENTION"), Map.of("state", "RUNNING"), receipt);
    return receipt;
  }
}
