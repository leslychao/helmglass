package com.helmglass.administration.application;

import com.helmglass.administration.api.AdminContracts;
import com.helmglass.administration.infrastructure.repository.AdministrationRepository;
import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.task.application.TaskLifecycleService;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AdministrationService {
  private static final UUID PLATFORM_ID = UUID.fromString("00000000-0000-0000-0000-000000000001");
  private final AdministrationRepository administration;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final TaskLifecycleService tasks;

  public AdministrationService(
      AdministrationRepository administration,
      IdentityRepository identities,
      OperationRepository operations,
      TaskLifecycleService tasks) {
    this.administration = administration;
    this.identities = identities;
    this.operations = operations;
    this.tasks = tasks;
  }

  public Map<String, Object> overview(AuthenticatedActor actor) {
    actor.requireAdmin();
    return administration.overview();
  }

  public Map<String, Object> browsers(AuthenticatedActor actor) {
    actor.requireAdmin();
    return administration.browsers();
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public PageResult<Map<String, Object>> users(AuthenticatedActor actor, PageQuery query) {
    actor.requireAdmin();
    return administration.users(actor.userId(), query);
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public Map<String, Object> user(AuthenticatedActor actor, UUID id) {
    actor.requireAdmin();
    return administration.user(id, false);
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public PageResult<Map<String, Object>> tasks(AuthenticatedActor actor, UUID id, PageQuery query) {
    actor.requireAdmin();
    return administration.safeTasks(actor.userId(), id, query);
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public PageResult<Map<String, Object>> audit(
      AuthenticatedActor actor, UUID userId, PageQuery query) {
    actor.requireAdmin();
    return administration.audit(actor.userId(), userId, query);
  }

  @Transactional
  public MutationReceipt limits(
      AuthenticatedActor actor, UUID id, AdminContracts.Limits input, MutationContext context) {
    actor.requireAdmin();
    for (UUID owner : List.of(actor.userId(), id).stream().distinct().sorted().toList()) {
      if (owner.equals(actor.userId())) {
        identities.lockActive(owner);
      } else if (List.of("PURGING", "DELETED").contains(identities.lockState(owner))) {
        throw DomainException.conflict("ACCOUNT_UNAVAILABLE", "User quotas are no longer editable");
      }
    }
    var before = administration.limits(id, true);
    if (before == null) {
      throw DomainException.notFound();
    }
    var replay = operations.replay(actor, "admin.limits:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    long version = ((Number) before.get("version")).longValue();
    DomainException.requireVersion(version, input.expectedVersion());
    if (input.browserMode().equals("CUSTOM") != (input.browserCustom() != null)
        || input.queuedMode().equals("CUSTOM") != (input.queuedCustom() != null)) {
      throw new DomainException(
          422, "INVALID_LIMIT_MODE", "Only custom modes accept a numeric limit");
    }
    administration.limits(id, input);
    var receipt =
        operations.save(
            actor, "admin.limits:" + id, context, input, "userLimits", id, version + 1, true);
    administration.audit(
        actor,
        id,
        "user",
        "LIMITS_CHANGED",
        input.reason(),
        before,
        administration.limits(id, false),
        receipt);
    return receipt;
  }

  @Transactional
  public MutationReceipt admission(
      AuthenticatedActor actor, AdminContracts.Admission input, MutationContext context) {
    actor.requireAdmin();
    identities.lockActive(actor.userId());
    var replay = operations.replay(actor, "admin.admission", context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    long version = administration.platformVersion();
    DomainException.requireVersion(version, input.expectedVersion());
    var before = administration.overview();
    administration.admission(input.acceptingAllocations());
    var receipt =
        operations.save(
            actor, "admin.admission", context, input, "platform", PLATFORM_ID, version + 1, true);
    administration.audit(
        actor,
        PLATFORM_ID,
        "platform",
        "ADMISSION_CHANGED",
        input.reason(),
        Map.of("acceptingAllocations", before.get("acceptingAllocations")),
        Map.of("acceptingAllocations", input.acceptingAllocations()),
        receipt);
    return receipt;
  }

  @Transactional
  public MutationReceipt workerMode(
      AuthenticatedActor actor,
      UUID id,
      AdminContracts.Reason input,
      MutationContext context,
      boolean drain) {
    actor.requireAdmin();
    identities.lockActive(actor.userId());
    String kind = drain ? "admin.worker.drain:" + id : "admin.worker.enable:" + id;
    var replay = operations.replay(actor, kind, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    long version = administration.workerVersion(id);
    DomainException.requireVersion(version, input.expectedVersion());
    String mode = drain ? "DRAINING" : "ENABLED";
    administration.workerMode(id, mode);
    var receipt = operations.save(actor, kind, context, input, "worker", id, version + 1, true);
    administration.audit(
        actor,
        id,
        "worker",
        "WORKER_MODE_CHANGED",
        input.reason(),
        Map.of(),
        Map.of("desiredMode", mode),
        receipt);
    return receipt;
  }

  @Transactional
  public MutationReceipt stopAll(
      AuthenticatedActor actor, UUID id, AdminContracts.Stop input, MutationContext context) {
    actor.requireAdmin();
    identities.lockActive(actor.userId());
    administration.user(id, true);
    var replay = operations.replay(actor, "admin.stopAll:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    var receipt =
        operations.save(actor, "admin.stopAll:" + id, context, input, "user", id, 1, false);
    tasks.scheduleAccountStop(id, receipt.operationId());
    administration.audit(
        actor, id, "user", "STOP_ALL_REQUESTED", input.reason(), Map.of(), Map.of(), receipt);
    return receipt;
  }
}
