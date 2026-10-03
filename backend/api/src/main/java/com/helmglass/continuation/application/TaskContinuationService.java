package com.helmglass.continuation.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.BrowserControlService.ControlIntent;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.continuation.api.ContinuationContracts;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

@Service
public class TaskContinuationService {
  public record Ready(UUID taskId, UUID sourceOperationId, UUID sourceCommandId, String reason) {}
  private final ContinuationRepository continuations;
  private final CommandRepository tasks;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final UserPolicyService policies;
  private final ChangeRepository changes;
  private final ApplicationEventPublisher events;

  public TaskContinuationService(ContinuationRepository continuations, CommandRepository tasks,
      IdentityRepository identities, OperationRepository operations, BrowserRepository browsers,
      ControlRepository controls, UserPolicyService policies, ChangeRepository changes,
      ApplicationEventPublisher events) {
    this.continuations = continuations;
    this.tasks = tasks;
    this.identities = identities;
    this.operations = operations;
    this.browsers = browsers;
    this.controls = controls;
    this.policies = policies;
    this.changes = changes;
    this.events = events;
  }

  @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
  public void ready(Ready ready) {
    continuations.ready(ready.taskId(), ready.sourceOperationId(), ready.sourceCommandId(), ready.reason());
  }

  @Transactional
  public MutationReceipt claim(AuthenticatedActor actor, UUID taskId, ContinuationContracts.Claim input,
      MutationContext context) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    var task = tasks.lockTask(actor.userId(), taskId);
    var replay = operations.replay(actor, "tasks.continue:" + taskId, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(task.instructionRevision(), input.expectedInstructionRevision());
    if (!task.state().equals("WAITING_AGENT") || task.mutationBarrier() || tasks.outstanding(taskId)) {
      throw DomainException.conflict("CONTINUATION_BLOCKED", "Task is not ready to continue");
    }
    var continuation = continuations.current(taskId).orElseThrow(DomainException::notFound);
    if (!continuation.id().equals(input.continuationId()) || !continuation.expiresAt().isAfter(Instant.now())) {
      throw DomainException.conflict("CONTINUATION_EXPIRED", "Continuation is no longer current");
    }
    if (continuation.state().equals("CLAIMED")) {
      throw DomainException.conflict("CONTINUATION_BUSY", "Continuation already has a recipient");
    }
    UUID claimId = UUID.randomUUID();
    var receipt = operations.save(actor, "tasks.continue:" + taskId, context, input,
        "continuationClaim", claimId, continuation.version() + 1, continuation.sessionId() == null);
    Long epoch = null;
    Instant expiry = continuation.expiresAt();
    if (continuation.sessionId() != null) {
      var session = browsers.owned(actor.userId(), continuation.sessionId());
      var lease = controls.lock(session.id());
      if (!session.state().equals("ACTIVE") || !session.privacy().equals("NORMAL")
          || !lease.ownerKind().equals("AGENT") || !lease.state().equals("ACTIVE")) {
        throw DomainException.conflict("CONTINUATION_BLOCKED", "Browser control is not ready");
      }
      expiry = Instant.now().plusSeconds(120).isBefore(expiry) ? Instant.now().plusSeconds(120) : expiry;
      epoch = controls.claimAgent(session.id(), claimId, receipt.operationId(), expiry);
      Map<String, Object> control = new HashMap<>();
      control.put("browserSessionId", session.id());
      control.put("allocationEpoch", session.allocationEpoch());
      control.put("controlEpoch", epoch);
      control.put("pageEpoch", session.pageEpoch());
      control.put("privacyEpoch", session.privacyEpoch());
      control.put("policyVersion", policies.getForExecution(actor.userId()).version());
      control.put("mode", "AGENT");
      control.put("leaseExpiresAt", expiry);
      events.publishEvent(new ControlIntent(session.workerId(),
          WorkerGateway.envelope("control", UUID.randomUUID(), control)));
    }
    continuations.claim(continuation.id(), claimId, actor.clientId(), actor.grantId(), epoch, expiry);
    changes.changed(actor.userId(), "tasks", taskId, task.version());
    return receipt;
  }

  /** Called under the task lock, in the transaction that accepts the first progress operation. */
  public void consume(AuthenticatedActor actor, UUID taskId, long instructionRevision, UUID claimId) {
    var current = continuations.current(taskId);
    if (current.isEmpty()) {
      if (claimId != null) {
        throw DomainException.conflict("ALREADY_CONSUMED", "Continuation claim is no longer current");
      }
      return;
    }
    var continuation = current.get();
    if (!continuation.state().equals("CLAIMED") || !Objects.equals(claimId, continuation.claimId())
        || !actor.clientId().equals(continuation.claimClientId())
        || !Objects.equals(actor.grantId(), continuation.claimGrantId())
        || instructionRevision != continuation.instructionRevision()
        || !continuation.expiresAt().isAfter(Instant.now())) {
      throw DomainException.conflict("CONTINUATION_CLAIM_REQUIRED", "Current continuation claim is required");
    }
    if (continuation.sessionId() != null) {
      var lease = controls.get(continuation.sessionId());
      if (!lease.ownerKind().equals("AGENT") || !lease.state().equals("ACTIVE")
          || !Objects.equals(lease.epoch(), continuation.claimControlEpoch())) {
        throw DomainException.conflict("CONTINUATION_BLOCKED", "Claim control binding is stale");
      }
    }
    continuations.consume(continuation.id());
  }

  public void cancel(UUID taskId) {
    continuations.cancel(taskId);
  }
}
