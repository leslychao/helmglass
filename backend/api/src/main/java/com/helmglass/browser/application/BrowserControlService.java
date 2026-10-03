package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

@Service
public class BrowserControlService {
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final ChangeRepository changes;
  private final ApplicationEventPublisher events;
  private final UserPolicyService policies;
  private final ConnectionRepository connections;

  public record ControlIntent(UUID workerId, Map<String, Object> message) {}

  public BrowserControlService(
      BrowserRepository browsers,
      ControlRepository controls,
      IdentityRepository identities,
      OperationRepository operations,
      ChangeRepository changes,
      ApplicationEventPublisher events,
      UserPolicyService policies,
      ConnectionRepository connections) {
    this.browsers = browsers;
    this.controls = controls;
    this.identities = identities;
    this.operations = operations;
    this.changes = changes;
    this.events = events;
    this.policies = policies;
    this.connections = connections;
  }

  /** Physical closure makes an unacknowledged control transfer permanently unavailable. */
  @Transactional
  public void reconcileClosedOperations() {
    operations.failClosedControls();
  }

  @Transactional
  public MutationReceipt acquire(
      AuthenticatedActor actor,
      UUID id,
      BrowserContracts.TakeControl input,
      MutationContext context) {
    requireWeb(actor);
    identities.lockActive(actor.userId());
    var session = browsers.owned(actor.userId(), id);
    var lease = controls.lock(id);
    var replay = operations.replay(actor, "control.acquire:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(session.version(), input.expectedVersion());
    DomainException.requireVersion(lease.epoch(), input.controlEpoch());
    if (!session.state().equals("ACTIVE")
        || lease.state().equals("TRANSFERRING")
        || controls.sessionOperationPending(id)) {
      throw DomainException.conflict("CONTROL_UNAVAILABLE", "Browser is not ready for control");
    }
    if (session.privacy().equals("LOGIN_PRIVATE") && !input.privateLogin()) {
      throw DomainException.conflict(
          "LOGIN_VERIFICATION_REQUIRED", "Finish private login before leaving private mode");
    }
    if (lease.ownerKind().equals("HUMAN")
        && lease.expiresAt().isAfter(Instant.now())
        && !input.controllerInstanceId().equals(lease.controllerInstanceId())
        && !input.transferExistingController()) {
      throw DomainException.conflict("CONTROL_CONFLICT", "Another tab controls this browser");
    }
    var receipt =
        operations.save(
            actor,
            "control.acquire:" + id,
            context,
            input,
            "browserSession",
            id,
            session.version() + 1,
            false);
    controls.transfer(
        id, input.controllerInstanceId(), "HUMAN", input.privateLogin(), receipt.operationId());
    controls.bindLogin(id, actor.loginId());
    if (session.taskId() != null) {
      events.publishEvent(new TaskContinuationService.Cancelled(session.taskId()));
    }
    publishControl(actor.userId(), id, input.privateLogin() ? "HUMAN_PRIVATE" : "HUMAN");
    return receipt;
  }

  @Transactional
  public MutationReceipt release(
      AuthenticatedActor actor,
      UUID id,
      BrowserContracts.ReleaseControl input,
      MutationContext context) {
    requireWeb(actor);
    identities.lockActive(actor.userId());
    var session = browsers.owned(actor.userId(), id);
    var lease = controls.lock(id);
    var replay = operations.replay(actor, "control.release:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(lease.epoch(), input.controlEpoch());
    if (session.privacy().equals("LOGIN_PRIVATE")) {
      throw DomainException.conflict("LOGIN_VERIFICATION_REQUIRED", "Complete private login first");
    }
    if (!actor.loginId().equals(lease.loginId())
        || !lease.state().equals("ACTIVE")
        || !lease.expiresAt().isAfter(Instant.now())
        || !input.controllerInstanceId().equals(lease.controllerInstanceId())) {
      throw DomainException.conflict("CONTROL_CONFLICT", "This tab does not own control");
    }
    var receipt =
        operations.save(
            actor,
            "control.release:" + id,
            context,
            input,
            "browserSession",
            id,
            session.version() + 1,
            false);
    controls.returnIntent(id, input.intent());
    controls.transfer(id, null, "AGENT", false, receipt.operationId());
    if (session.taskId() != null) {
      boolean continueTask =
          "CONTINUE_IF_ALLOWED".equals(input.intent()) && !"PAUSED".equals(lease.priorTaskState());
      events.publishEvent(new TaskContinuationService.Consent(session.taskId(), continueTask));
      if (continueTask) {
        events.publishEvent(
            new TaskContinuationService.Waiting(
                session.taskId(), receipt.operationId(), null, "CONTROL_RETURNED"));
      }
    }
    publishControl(actor.userId(), id, "AGENT");
    return receipt;
  }

  @Transactional
  public Map<String, Object> renew(
      AuthenticatedActor actor, UUID id, BrowserContracts.Renew input) {
    requireWeb(actor);
    identities.lockActive(actor.userId());
    var session = browsers.owned(actor.userId(), id);
    var control = controls.lock(id);
    if (!actor.loginId().equals(control.loginId()) || !session.state().equals("ACTIVE")) {
      throw DomainException.conflict("CONTROL_CONFLICT", "This web login does not own control");
    }
    Instant expiry = controls.renew(id, input.controllerInstanceId(), input.controlEpoch());
    events.publishEvent(
        new ControlIntent(
            session.workerId(),
            WorkerGateway.envelope(
                "controlRenew",
                UUID.randomUUID(),
                Map.of(
                    "browserSessionId",
                    id,
                    "controlEpoch",
                    input.controlEpoch(),
                    "controllerInstance",
                    input.controllerInstanceId(),
                    "leaseExpiresAt",
                    expiry))));
    return Map.of("controlEpoch", input.controlEpoch(), "expiresAt", expiry);
  }

  @Transactional
  public void acknowledge(UUID workerId, UUID bootId, UUID sessionId, long epoch) {
    var lease = controls.lock(sessionId);
    var session = browsers.owned(lease.ownerId(), sessionId);
    if (!workerId.equals(session.workerId()) || !bootId.equals(session.workerBootId())) {
      throw new DomainException(
          403, "WORKER_BINDING_MISMATCH", "Worker cannot acknowledge control");
    }
    controls.activate(sessionId, epoch, lease.operationId());
    if (lease.claimFenceId() == null) {
      operations.completeControl(lease.operationId());
    }
    completeClaimFence(session, lease, epoch);
    if ("AGENT".equals(lease.desiredOwner())
        && session.taskId() != null
        && operations
            .owned(session.userId(), lease.operationId())
            .kind()
            .startsWith("control.release:")) {
      boolean keepPaused =
          "KEEP_PAUSED".equals(lease.returnIntent()) || "PAUSED".equals(lease.priorTaskState());
      controls.taskAfterReturn(sessionId, keepPaused);
      if (!keepPaused) {
        events.publishEvent(
            new TaskContinuationService.Ready(
                session.taskId(), lease.operationId(), null, "CONTROL_RETURNED"));
      }
    }
    changes.changed(session.userId(), "tasks", sessionId, session.version());
  }

  /** Revokes the old claim by draining the same runtime under a fresh control epoch. */
  @Transactional(propagation = Propagation.MANDATORY)
  public boolean fenceExpiredClaim(UUID userId, UUID sessionId, UUID claimId, long claimEpoch) {
    if (!identities.lockState(userId).equals("ACTIVE")) {
      return false;
    }
    var session = browsers.owned(userId, sessionId);
    var lease = controls.lock(sessionId);
    if (!session.state().equals("ACTIVE")
        || !session.privacy().equals("NORMAL")
        || session.taskId() == null
        || !session.budgetDeadlineAt().isAfter(Instant.now())) {
      return false;
    }
    if (claimId.equals(lease.claimFenceId())
        && Objects.equals(claimEpoch, lease.claimFenceEpoch())) {
      return lease.state().equals("TRANSFERRING") && "AGENT".equals(lease.desiredOwner());
    }
    if (!claimId.equals(lease.continuationClaimId())
        || lease.epoch() != claimEpoch
        || !lease.ownerKind().equals("AGENT")
        || !Set.of("ACTIVE", "TRANSFERRING").contains(lease.state())) {
      return false;
    }
    UUID operation =
        operations.createSystem(userId, "control.claim-fence", "browserSession", sessionId);
    operations.expireClaim(lease.operationId());
    controls.fenceClaim(lease, claimId, operation, session.budgetDeadlineAt());
    publishControl(userId, sessionId, "AGENT");
    return true;
  }

  /** The registry calls this only after its fresh physical recovery control was acknowledged. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void acknowledgeRecoveredClaim(UUID sessionId) {
    var lease = controls.lock(sessionId);
    var session = browsers.owned(lease.ownerId(), sessionId);
    if (session.state().equals("ACTIVE")
        && session.privacy().equals("NORMAL")
        && lease.state().equals("ACTIVE")
        && lease.ownerKind().equals("AGENT")) {
      completeClaimFence(session, lease, lease.epoch());
    }
  }

  private void completeClaimFence(
      BrowserRepository.Session session, ControlRepository.Lease lease, long epoch) {
    if (lease.claimFenceId() == null
        || lease.claimFenceEpoch() == null
        || epoch <= lease.claimFenceEpoch()
        || session.taskId() == null) {
      return;
    }
    controls.clearClaimFence(session.id());
    operations.completeControl(lease.operationId());
    events.publishEvent(
        new TaskContinuationService.ClaimFenced(
            session.taskId(), lease.claimFenceId(), lease.claimFenceEpoch(), epoch));
  }

  @Transactional
  public void inputDisconnected(UUID userId, UUID sessionId, UUID channelId) {
    browsers.owned(userId, sessionId);
    if (controls.beginInputFence(sessionId, channelId)) {
      publishControl(userId, sessionId, "QUIESCED");
    }
  }

  @Transactional
  public boolean acknowledgeInputFence(
      UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt) {
    var lease = controls.lock(sessionId);
    if (!lease.state().equals("QUIESCING")) {
      return false;
    }
    var session = browsers.owned(lease.ownerId(), sessionId);
    if (!workerId.equals(session.workerId())
        || !bootId.equals(session.workerBootId())
        || receipt.path("controlEpoch").asLong(-1) != lease.epoch()
        || !receipt.path("mode").asString().equals("QUIESCED")) {
      throw DomainException.conflict(
          "INPUT_FENCE_MISMATCH", "Input fencing receipt does not match");
    }
    long accepted = receipt.path("lastAcceptedInputSequence").asLong(-1);
    long applied = receipt.path("lastAppliedInputSequence").asLong(-1);
    if (accepted < 0 || applied < 0 || applied > accepted) {
      throw DomainException.conflict("INPUT_CHECKPOINT_MISSING", "Input checkpoint is unknown");
    }
    controls.finishInputFence(lease, accepted, applied);
    var account = identities.find(session.userId()).orElseThrow(DomainException::notFound);
    if (accepted == applied
        && identities.authorizationActive(
            session.userId(), lease.loginId(), null, account.accessEpoch())
        && session.state().equals("ACTIVE")) {
      controls.reconnectHuman(sessionId);
      publishControl(
          session.userId(),
          sessionId,
          session.privacy().equals("NORMAL") ? "HUMAN" : "HUMAN_PRIVATE");
    }
    changes.changed(session.userId(), "tasks", sessionId, session.version());
    return true;
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void publishControl(UUID userId, UUID id, String mode) {
    sendControl(userId, id, mode, true, null);
  }

  /** Redelivery preserves the control binding without emitting another resource invalidation. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void redeliverControl(UUID userId, UUID id, String mode) {
    sendControl(userId, id, mode, false, null);
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void publishCleanup(UUID userId, UUID id, Instant cleanupDeadline) {
    sendControl(userId, id, "QUIESCED", false, cleanupDeadline);
  }

  private void sendControl(
      UUID userId, UUID id, String mode, boolean changed, Instant cleanupDeadline) {
    var session = browsers.owned(userId, id);
    var lease = controls.get(id);
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("browserSessionId", id);
    body.put("allocationEpoch", session.allocationEpoch());
    body.put("controlEpoch", lease.epoch());
    body.put("pageEpoch", session.pageEpoch());
    body.put("privacyEpoch", session.privacyEpoch());
    body.put("policyVersion", policies.getForExecution(userId).version());
    if (session.connectionId() != null) {
      body.put("connectionId", session.connectionId());
      body.put(
          "scopeVersion", connections.owned(userId, session.connectionId(), false).scopeVersion());
    }
    body.put("mode", mode);
    body.put("leaseExpiresAt", lease.expiresAt());
    if (cleanupDeadline != null) {
      body.put("cleanupDeadline", cleanupDeadline);
    }
    if (lease.controllerInstanceId() != null) {
      body.put("controllerInstance", lease.controllerInstanceId());
    }
    events.publishEvent(
        new ControlIntent(
            session.workerId(), WorkerGateway.envelope("control", UUID.randomUUID(), body)));
    if (changed) {
      changes.changed(userId, "tasks", id, session.version());
    }
  }

  private static void requireWeb(AuthenticatedActor actor) {
    if (actor.mcp()) {
      throw new DomainException(403, "WEB_LOGIN_REQUIRED", "Human control requires web login");
    }
  }
}
