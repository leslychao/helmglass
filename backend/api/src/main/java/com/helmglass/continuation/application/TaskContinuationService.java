package com.helmglass.continuation.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.continuation.api.ContinuationContracts;
import com.helmglass.continuation.api.ContinuationContracts.PreparedMessage;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository.Continuation;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository.TaskBinding;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.domain.ChatPresentation;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class TaskContinuationService {
  public record Ready(UUID taskId, UUID sourceOperationId, UUID sourceCommandId, String reason) {}

  public record Waiting(UUID taskId, UUID sourceOperationId, UUID sourceCommandId, String reason) {}

  public record Consent(UUID taskId, boolean granted) {}

  public record Cancelled(UUID taskId) {}

  private final ContinuationRepository continuations;
  private final CommandRepository tasks;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final ChangeRepository changes;
  private final BrowserControlService controlOwner;
  private final RealtimeDeliveryService presentations;
  private final TransactionTemplate transaction;
  private final boolean hostMessageVerified;

  public TaskContinuationService(
      ContinuationRepository continuations,
      CommandRepository tasks,
      IdentityRepository identities,
      OperationRepository operations,
      BrowserRepository browsers,
      ControlRepository controls,
      ChangeRepository changes,
      BrowserControlService controlOwner,
      RealtimeDeliveryService presentations,
      PlatformTransactionManager transactions,
      @Value("${helm.continuation.verified-host-message-contract:}")
          String verifiedMessageContract) {
    this.continuations = continuations;
    this.tasks = tasks;
    this.identities = identities;
    this.operations = operations;
    this.browsers = browsers;
    this.controls = controls;
    this.changes = changes;
    this.controlOwner = controlOwner;
    this.presentations = presentations;
    this.hostMessageVerified = "CHATGPT_WEB:2026-10-03".equals(verifiedMessageContract);
    transaction = new TransactionTemplate(transactions);
    transaction.setTimeout(5);
  }

  /** Publication may establish the original destination, but cannot move an existing intent. */
  @Transactional
  public void bindDestination(AuthenticatedActor actor, HostConversationContext host, UUID taskId) {
    identities.lockActive(actor.userId());
    TaskBinding task = ownedTask(actor, taskId);
    ChatPresentation slot =
        presentations.lockCurrentPresentation(actor, host).orElseThrow(DomainException::notFound);
    if (!slot.taskId().equals(taskId)) throw DomainException.notFound();
    continuations.bind(task, slot, hostMessageVerified);
  }

  @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
  public void consent(Consent value) {
    if (value.taskId() == null) return;
    continuations.lockTask(value.taskId());
    continuations.consent(value.taskId(), value.granted());
    if (!value.granted()) {
      cancel(value.taskId());
    } else if (hostMessageVerified) {
      continuations
          .enableWaitingDelivery(value.taskId())
          .ifPresent(intent -> changed(intent, Instant.now()));
    }
  }

  @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
  public void cancelled(Cancelled value) {
    if (value.taskId() != null) cancel(value.taskId());
  }

  @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
  public void waiting(Waiting value) {
    if (value.taskId() != null)
      waitForResult(
          value.taskId(), value.sourceOperationId(), value.sourceCommandId(), value.reason());
  }

  /** The accepting owner calls this in the same transaction, before its external dispatch. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void waitForResult(UUID taskId, UUID operation, UUID command, String reason) {
    if ((operation == null) == (command == null))
      throw new IllegalArgumentException("One continuation source is required");
    TaskBinding task = continuations.lockTask(taskId);
    if (command != null && !continuations.commandNeedsContinuation(command)) return;
    if (continuations.source(taskId, operation, command).isPresent()) return;
    if (List.of("COMPLETED", "FAILED", "CANCELLED", "STOPPING", "PAUSED", "PAUSING")
        .contains(task.state())) return;
    if (continuations.current(taskId).isPresent()) {
      throw DomainException.conflict(
          "CONTINUATION_PENDING", "The current continuation must be consumed first");
    }
    changed(
        continuations.waitForResult(task, operation, command, reason, hostMessageVerified),
        Instant.now());
  }

  @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
  public void ready(Ready ready) {
    TaskBinding task = continuations.lockTask(ready.taskId());
    if (ready.sourceCommandId() != null
        && !continuations.commandNeedsContinuation(ready.sourceCommandId())) return;
    var existing =
        continuations.source(task.id(), ready.sourceOperationId(), ready.sourceCommandId());
    if (existing.isEmpty()) {
      // An immediate operation (answer/resume) still registers and completes its intent atomically.
      if (!task.state().equals("WAITING_AGENT") || task.mutationBarrier()) return;
      waitForResult(task.id(), ready.sourceOperationId(), ready.sourceCommandId(), ready.reason());
      existing =
          continuations.source(task.id(), ready.sourceOperationId(), ready.sourceCommandId());
    }
    if (existing.isEmpty()) return;
    Continuation value = existing.get();
    if (!value.state().equals("WAITING_RESULT")) return;
    String sourceState = continuations.sourceState(value);
    if (List.of("UNKNOWN", "NEEDS_ATTENTION").contains(sourceState) || task.mutationBarrier()) {
      changed(
          continuations.transition(value.id(), "BLOCKED", "RECONCILIATION_REQUIRED"),
          Instant.now());
      return;
    }
    if (!List.of("SUCCEEDED", "FAILED").contains(sourceState)) return;
    if (task.instructionRevision() != value.instructionRevision()
        || !task.state().equals("WAITING_AGENT")) {
      changed(continuations.transition(value.id(), "CANCELLED", "TASK_NOT_READY"), Instant.now());
      return;
    }
    if (!value.expiresAt().isAfter(Instant.now())) {
      changed(
          continuations.transition(value.id(), "EXPIRED", "CONTINUATION_EXPIRED"), Instant.now());
      return;
    }
    Instant due = ready.sourceCommandId() == null ? Instant.now() : Instant.now().plusSeconds(5);
    changed(continuations.ready(value.id(), due), due);
  }

  @Transactional
  public PreparedMessage prepareMessage(
      AuthenticatedActor actor,
      HostConversationContext host,
      UUID taskId,
      ContinuationContracts.PrepareMessage input,
      MutationContext context) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    TaskBinding task = ownedTask(actor, taskId);
    ChatPresentation slot =
        presentations.requireCurrentViewer(
            actor,
            host,
            input.viewScopeId(),
            input.presentationRevision(),
            input.viewerInstanceId());
    Continuation value = ownedContinuation(actor, taskId, input.continuationId());
    requireDestination(actor, host, value);
    if (!slot.taskId().equals(taskId)
        || !hostMessageVerified
        || !task.continuationConsent()
        || !value.mode().equals("WIDGET_RETURN")) {
      throw DomainException.conflict(
          "AUTOMATIC_CONTINUATION_UNAVAILABLE",
          "Host message delivery has not been accepted for this task");
    }
    requireReadyTask(task, value);
    var replay =
        operations.replay(actor, "continuations.prepare_message:" + taskId, context, input);
    if (replay.isPresent()) {
      if (!Objects.equals(value.dispatchId(), replay.get().resource().id())
          || !Objects.equals(value.dispatchViewerInstanceId(), input.viewerInstanceId())
          || !value.state().equals("DISPATCHING")
          || value.dispatchExpiresAt() == null
          || !value.dispatchExpiresAt().isAfter(Instant.now())) {
        throw DomainException.conflict(
            "DISPATCH_NOT_SENDABLE", "Read the current continuation receipt without sending again");
      }
      return prepared(value);
    }
    if (!value.state().equals("READY")
        || value.dispatchId() != null
        || value.dispatchNotBefore() == null
        || value.dispatchNotBefore().isAfter(Instant.now())) {
      throw DomainException.conflict(
          "CONTINUATION_NOT_READY", "Continuation cannot be dispatched now");
    }
    Instant expiry =
        earliest(
            value.expiresAt(), slot.viewerAuthorizationExpiresAt(), Instant.now().plusSeconds(120));
    String text =
        "Продолжи исходную задачу "
            + taskId
            + ". Сначала прочитай tasks.get, затем вызови tasks.continue"
            + " с continuationId="
            + value.id()
            + " и expectedInstructionRevision="
            + value.instructionRevision()
            + ". Используй полученный claim и свежий OBSERVE; не создавай новую задачу или"
            + " браузер.";
    value =
        continuations.prepare(
            value, input.viewerInstanceId(), input.presentationRevision(), text, expiry);
    operations.save(
        actor,
        "continuations.prepare_message:" + taskId,
        context,
        input,
        "continuationDispatch",
        value.dispatchId(),
        value.version(),
        true);
    changed(value, Instant.now());
    return prepared(value);
  }

  @Transactional
  public MutationReceipt recordDelivery(
      AuthenticatedActor actor,
      HostConversationContext host,
      ContinuationContracts.RecordDelivery input,
      MutationContext context) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    Continuation value = continuations.dispatch(input.dispatchId());
    ownedTask(actor, value.taskId());
    value = ownedContinuation(actor, value.taskId(), value.id());
    requireDestination(actor, host, value);
    var replay =
        operations.replay(
            actor, "continuations.record_delivery:" + input.dispatchId(), context, input);
    if (replay.isPresent()) return replay.get();
    String outcome = input.outcome().name();
    if (value.deliveryOutcome() != null
        && !value.deliveryOutcome().equals(outcome)
        && !(value.deliveryOutcome().equals("UNKNOWN") && outcome.equals("DELIVERED"))) {
      throw DomainException.conflict(
          "DELIVERY_RECEIPT_CONFLICT", "The dispatch already has a different outcome");
    }
    if (!outcome.equals(value.deliveryOutcome())) {
      String state = value.state();
      String reason = value.blockReason();
      if (state.equals("DISPATCHING") || state.equals("DELIVERY_UNKNOWN")) {
        state =
            switch (input.outcome()) {
              case DELIVERED -> "DELIVERED";
              case UNKNOWN -> "DELIVERY_UNKNOWN";
              case REJECTED -> "BLOCKED";
            };
        reason =
            input.outcome() == ContinuationContracts.DeliveryOutcome.REJECTED
                ? "HOST_REJECTED"
                : null;
      }
      value = continuations.delivery(value, outcome, state, reason);
      changed(value, Instant.now());
    }
    return operations.save(
        actor,
        "continuations.record_delivery:" + input.dispatchId(),
        context,
        input,
        "continuationDispatch",
        input.dispatchId(),
        value.version(),
        true);
  }

  @Transactional
  public MutationReceipt claim(
      AuthenticatedActor actor,
      HostConversationContext host,
      UUID taskId,
      ContinuationContracts.Claim input,
      MutationContext context) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    TaskBinding task = ownedTask(actor, taskId);
    Continuation value = ownedContinuation(actor, taskId, input.continuationId());
    if (value.mode().equals("WIDGET_RETURN")) requireDestination(actor, host, value);
    var replay = operations.replay(actor, "tasks.continue:" + taskId, context, input);
    if (replay.isPresent()) return replay.get();
    DomainException.requireVersion(task.instructionRevision(), input.expectedInstructionRevision());
    requireReadyTask(task, value);
    if (value.state().equals("CLAIMED"))
      throw DomainException.conflict("CONTINUATION_BUSY", "Continuation already has a recipient");
    if (!List.of("READY", "DISPATCHING", "DELIVERED", "DELIVERY_UNKNOWN").contains(value.state())
        && !(value.state().equals("BLOCKED") && "HOST_REJECTED".equals(value.blockReason()))) {
      throw DomainException.conflict("CONTINUATION_BLOCKED", "Continuation is not claimable");
    }
    UUID claimId = UUID.randomUUID();
    var receipt =
        operations.save(
            actor,
            "tasks.continue:" + taskId,
            context,
            input,
            "continuationClaim",
            claimId,
            value.version() + 1,
            value.sessionId() == null);
    Long epoch = null;
    Instant expiry = value.expiresAt();
    if (value.sessionId() != null) {
      var session = browsers.owned(actor.userId(), value.sessionId());
      var lease = controls.lock(session.id());
      if (!session.state().equals("ACTIVE")
          || !session.privacy().equals("NORMAL")
          || !lease.ownerKind().equals("AGENT")
          || !lease.state().equals("ACTIVE")
          || !lease.expiresAt().isAfter(Instant.now())) {
        throw DomainException.conflict("CONTINUATION_BLOCKED", "Browser control is not ready");
      }
      expiry = earliest(expiry, Instant.now().plusSeconds(120));
      epoch = controls.claimAgent(session.id(), claimId, receipt.operationId(), expiry);
      controlOwner.publishControl(actor.userId(), session.id(), "AGENT");
    }
    changed(
        continuations.claim(value.id(), claimId, actor.clientId(), actor.grantId(), epoch, expiry),
        Instant.now());
    return receipt;
  }

  /** Called under the task lock, in the transaction accepting the first progress operation. */
  public void consume(
      AuthenticatedActor actor, UUID taskId, long instructionRevision, UUID claimId) {
    var current = continuations.current(taskId);
    if (current.isEmpty()) {
      if (claimId != null)
        throw DomainException.conflict(
            "ALREADY_CONSUMED", "Continuation claim is no longer current");
      return;
    }
    Continuation value = current.get();
    if (!value.state().equals("CLAIMED")
        || !Objects.equals(claimId, value.claimId())
        || !actor.clientId().equals(value.claimClientId())
        || !Objects.equals(actor.grantId(), value.claimGrantId())
        || instructionRevision != value.instructionRevision()
        || !value.expiresAt().isAfter(Instant.now())) {
      throw DomainException.conflict(
          "CONTINUATION_CLAIM_REQUIRED", "Current continuation claim is required");
    }
    if (value.sessionId() != null) {
      var lease = controls.get(value.sessionId());
      if (!lease.ownerKind().equals("AGENT")
          || !lease.state().equals("ACTIVE")
          || !lease.expiresAt().isAfter(Instant.now())
          || !Objects.equals(lease.epoch(), value.claimControlEpoch())) {
        throw DomainException.conflict("CONTINUATION_BLOCKED", "Claim control binding is stale");
      }
    }
    changed(continuations.consume(value.id()), Instant.now());
  }

  public void cancel(UUID taskId) {
    for (Continuation value : continuations.cancel(taskId)) changed(value, Instant.now());
  }

  @Scheduled(fixedDelay = 1000)
  public void expire() {
    for (Continuation due : continuations.due()) {
      transaction.executeWithoutResult(
          status -> {
            identities.lockState(due.userId());
            continuations.lockTask(due.taskId());
            Continuation value = continuations.get(due.id());
            if (List.of("CONSUMED", "CANCELLED", "EXPIRED").contains(value.state())) return;
            if (!value.expiresAt().isAfter(Instant.now())) {
              // A claimed executor remains fenced by the current intent until control is
              // reconciled.
              boolean claimed = value.state().equals("CLAIMED") && value.sessionId() != null;
              changed(
                  continuations.transition(
                      value.id(),
                      claimed ? "BLOCKED" : "EXPIRED",
                      claimed ? "CLAIM_EXPIRED" : "CONTINUATION_EXPIRED"),
                  Instant.now());
            } else if (value.state().equals("DISPATCHING")
                && value.dispatchExpiresAt() != null
                && !value.dispatchExpiresAt().isAfter(Instant.now())) {
              changed(
                  continuations.delivery(value, "UNKNOWN", "DELIVERY_UNKNOWN", null),
                  Instant.now());
            }
          });
    }
  }

  private TaskBinding ownedTask(AuthenticatedActor actor, UUID taskId) {
    if (!continuations.owner(taskId).equals(actor.userId())) throw DomainException.notFound();
    return continuations.lockTask(taskId);
  }

  private Continuation ownedContinuation(AuthenticatedActor actor, UUID taskId, UUID id) {
    Continuation value = continuations.get(id);
    if (!value.userId().equals(actor.userId()) || !value.taskId().equals(taskId))
      throw DomainException.notFound();
    return value;
  }

  private void requireDestination(
      AuthenticatedActor actor, HostConversationContext host, Continuation value) {
    ChatPresentation slot =
        presentations.lockCurrentPresentation(actor, host).orElseThrow(DomainException::notFound);
    if (!slot.id().equals(value.viewScopeId())
        || !actor.clientId().equals(value.destinationClientId())
        || !Objects.equals(actor.grantId(), value.destinationGrantId())
        || !Objects.equals(slot.grantVersion(), value.destinationGrantVersion())
        || !Objects.equals(actor.accessEpoch(), value.destinationAccessEpoch())) {
      throw DomainException.conflict(
          "CONTINUATION_DESTINATION_CHANGED", "Continue in the original authorized conversation");
    }
  }

  private void requireReadyTask(TaskBinding task, Continuation value) {
    if (task.instructionRevision() != value.instructionRevision()
        || task.continuationBindingVersion() != value.bindingVersion()
        || !value.expiresAt().isAfter(Instant.now())) {
      throw DomainException.conflict("CONTINUATION_EXPIRED", "Continuation is no longer current");
    }
    if (!task.state().equals("WAITING_AGENT")
        || task.mutationBarrier()
        || tasks.outstanding(task.id())) {
      throw DomainException.conflict("CONTINUATION_BLOCKED", "Task is not ready to continue");
    }
  }

  private void changed(Continuation value, Instant notBefore) {
    changes.changed(
        value.userId(), "tasks", value.taskId(), value.id(), value.version(), notBefore);
  }

  private static PreparedMessage prepared(Continuation value) {
    return new PreparedMessage(
        value.dispatchId(), value.dispatchText(), value.dispatchExpiresAt(), value.version());
  }

  private static Instant earliest(Instant first, Instant... remaining) {
    Instant result = first;
    for (Instant value : remaining) if (value.isBefore(result)) result = value;
    return result;
  }
}
