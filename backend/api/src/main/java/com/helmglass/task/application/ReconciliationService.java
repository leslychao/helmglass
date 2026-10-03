package com.helmglass.task.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.infrastructure.repository.ReconciliationRepository;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ReconciliationService {
  private final ReconciliationRepository reconciliation;
  private final CommandRepository tasks;
  private final IdentityRepository identities;
  private final OperationRepository operations;

  public ReconciliationService(ReconciliationRepository reconciliation, CommandRepository tasks,
      IdentityRepository identities, OperationRepository operations) {
    this.reconciliation = reconciliation;
    this.tasks = tasks;
    this.identities = identities;
    this.operations = operations;
  }

  public void unknownCommand(UUID userId, UUID taskId, UUID commandId) {
    if (reconciliation.existing(commandId, null).isEmpty()) {
      reconciliation.unavailable(userId, taskId, commandId, null);
    }
  }

  @Transactional
  public MutationReceipt reconcile(AuthenticatedActor actor, UUID taskId, TaskContracts.Reconcile input,
      MutationContext context) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    var task = tasks.lockTask(actor.userId(), taskId);
    var replay = operations.replay(actor, "tasks.reconcile:" + taskId, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(task.version(), input.expectedTaskVersion());
    if ((input.commandId() == null) == (input.humanOperationId() == null)) {
      throw new DomainException(422, "RECONCILIATION_SOURCE_REQUIRED", "Exactly one source is required");
    }
    if (input.evidenceId() != null) {
      throw new DomainException(422, "EVIDENCE_NOT_VERIFIED", "No verified evidence exists for this source");
    }
    reconciliation.requireSource(taskId, input.commandId(), input.humanOperationId());
    UUID id = reconciliation.existing(input.commandId(), input.humanOperationId())
        .orElseGet(() -> reconciliation.unavailable(actor.userId(), taskId, input.commandId(), input.humanOperationId()));
    return operations.bindExisting(actor, "tasks.reconcile:" + taskId, context, input,
        id, "resolution", id, operations.owned(actor.userId(), id).version());
  }
}
