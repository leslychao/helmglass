package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.application.BrowserControlService.ControlIntent;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserSessionOperationRepository;
import com.helmglass.browser.infrastructure.repository.BrowserSessionOperationRepository.ClosingSession;
import com.helmglass.browser.infrastructure.repository.BrowserSessionOperationRepository.SessionOperation;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.time.Instant;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

/** Owns the quiescent save/close boundary and recovery of the same accepted profile transfer. */
@Slf4j
@Service
public class BrowserSessionOperationService {
  private static final Set<String> PENDING = Set.of("QUIESCING", "SAVING", "RESUMING", "CLOSING");
  private final BrowserSessionOperationRepository repository;
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final BrowserControlService controlService;
  private final IdentityRepository identities;
  private final UserPolicyService policies;
  private final OperationRepository operations;
  private final BrowserProfileService profiles;
  private final ConnectionRepository connections;
  private final ChangeRepository changes;
  private final ApplicationEventPublisher events;
  private final TransactionTemplate transaction;

  public BrowserSessionOperationService(
      BrowserSessionOperationRepository repository,
      BrowserRepository browsers,
      ControlRepository controls,
      BrowserControlService controlService,
      IdentityRepository identities,
      UserPolicyService policies,
      OperationRepository operations,
      BrowserProfileService profiles,
      ConnectionRepository connections,
      ChangeRepository changes,
      ApplicationEventPublisher events,
      PlatformTransactionManager transactions) {
    this.repository = repository;
    this.browsers = browsers;
    this.controls = controls;
    this.controlService = controlService;
    this.identities = identities;
    this.policies = policies;
    this.operations = operations;
    this.profiles = profiles;
    this.connections = connections;
    this.changes = changes;
    this.events = events;
    transaction = new TransactionTemplate(transactions);
    transaction.setTimeout(5);
  }

  @Transactional
  public MutationReceipt save(
      AuthenticatedActor actor,
      UUID sessionId,
      BrowserContracts.Save input,
      MutationContext context) {
    return begin(actor, sessionId, input, input, "SAVE", context);
  }

  @Transactional
  public MutationReceipt close(
      AuthenticatedActor actor,
      UUID sessionId,
      BrowserContracts.Close input,
      MutationContext context) {
    var binding =
        new BrowserContracts.Save(
            input.expectedVersion(),
            input.controlEpoch(),
            input.pageEpoch(),
            input.controllerInstanceId(),
            input.expectedProfileVersion());
    return begin(
        actor,
        sessionId,
        binding,
        input,
        input.saveChanges() ? "CLOSE_SAVE" : "CLOSE_DISCARD",
        context);
  }

  @Transactional
  public MutationReceipt savePolicy(
      AuthenticatedActor actor,
      UUID sessionId,
      BrowserContracts.SavePolicy input,
      MutationContext context) {
    if (actor.mcp() || actor.loginId() == null) {
      throw new DomainException(403, "WEB_LOGIN_REQUIRED", "Save preference requires a web login");
    }
    identities.lockActive(actor.userId());
    var session = browsers.owned(actor.userId(), sessionId);
    String kind = "browser.save-policy:" + sessionId;
    var replay = operations.replay(actor, kind, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(session.version(), input.expectedVersion());
    if (session.connectionId() == null) {
      throw DomainException.conflict("CONNECTION_REQUIRED", "Select a connection before saving");
    }
    if (!session.state().equals("ACTIVE")
        || !session.privacy().equals("NORMAL")
        || repository.pendingForSession(sessionId).isPresent()
        || repository.closeDue(sessionId)
        || !identities.loginActive(actor.userId(), actor.loginId())) {
      throw DomainException.conflict(
          "BROWSER_OPERATION_UNAVAILABLE", "Save preference cannot change now");
    }
    var connection = connections.owned(actor.userId(), session.connectionId(), true);
    DomainException.requireVersion(connection.version(), input.expectedConnectionVersion());
    if (Set.of("DELETING", "DELETED").contains(connection.status())) {
      throw DomainException.conflict("CONNECTION_UNAVAILABLE", "Connection is being deleted");
    }
    connections.savePreference(
        connection.id(), input.policy().equals("SAVE_ON_CLOSE") ? "SAVE" : "SESSION_ONLY");
    long version = repository.savePolicy(sessionId, input.policy());
    changes.changed(actor.userId(), "connections", connection.id(), connection.version() + 1);
    changes.changed(actor.userId(), "tasks", sessionId, version);
    return operations.save(actor, kind, context, input, "browserSession", sessionId, version, true);
  }

  /** Adopts server deadlines and terminal task cleanup into the same quiesce/save/close owner. */
  public void prepareDueClosures() {
    for (ClosingSession candidate : repository.dueClosures()) {
      try {
        transaction.executeWithoutResult(status -> prepareAutomaticClose(candidate));
      } catch (RuntimeException error) {
        log.warn(
            "Browser close admission deferred; sessionId={}, errorType={}",
            candidate.id(),
            error.getClass().getSimpleName());
      }
    }
  }

  private void prepareAutomaticClose(ClosingSession candidate) {
    if (!identities.lockState(candidate.userId()).equals("ACTIVE")) {
      return;
    }
    var session = browsers.owned(candidate.userId(), candidate.id());
    var control = controls.lock(session.id());
    if (repository.pendingForSession(session.id()).isPresent()
        || repository.automaticCloseExists(session.id())
        || !repository.closeDue(session.id())
        || !Set.of("ACTIVE", "STOPPING").contains(session.state())) {
      return;
    }
    boolean requestedSave = session.savePolicy().equals("SAVE_ON_CLOSE");
    boolean saving =
        requestedSave && session.connectionId() != null && session.privacy().equals("NORMAL");
    UUID operationId =
        operations.createSystem(
            session.userId(), "browser.auto-close", "browserSession", session.id());
    repository.create(
        operationId,
        session,
        control,
        null,
        null,
        saving ? "CLOSE_SAVE" : "CLOSE_DISCARD",
        policies.getForExecution(session.userId()).version(),
        saving ? repository.currentProfileVersion(session.userId(), session.connectionId()) : null);
    Instant deadline = Instant.now().plusSeconds(120);
    Instant budgetCleanupDeadline = session.budgetDeadlineAt().plusSeconds(120);
    if (deadline.isAfter(budgetCleanupDeadline)) {
      deadline = budgetCleanupDeadline;
    }
    repository.automatic(operationId, deadline);
    if (requestedSave && !saving) {
      repository.failure(operationId, "PROFILE_SAVE_UNAVAILABLE_AT_CLOSE");
    }
    controls.beginSessionBoundary(session.id(), operationId);
    if (!deadline.isAfter(Instant.now())) {
      controls.unknownInputBoundary(session.id(), control.operationId(), operationId);
      controls.closeRequested(session.id());
      finish(repository.lock(operationId), "UNKNOWN", "BROWSER_CLEANUP_DEADLINE");
      return;
    }
    controlService.publishCleanup(session.userId(), session.id(), deadline);
    changes.changed(
        session.userId(),
        "tasks",
        session.id(),
        browsers.owned(session.userId(), session.id()).version());
  }

  private MutationReceipt begin(
      AuthenticatedActor actor,
      UUID sessionId,
      BrowserContracts.Save binding,
      Object input,
      String intent,
      MutationContext context) {
    if (actor.mcp() || actor.loginId() == null) {
      throw new DomainException(
          403, "WEB_LOGIN_REQUIRED", "Browser save and close require a web login");
    }
    identities.lockActive(actor.userId());
    var session = browsers.owned(actor.userId(), sessionId);
    String kind = (intent.equals("SAVE") ? "browser.save:" : "browser.close:") + sessionId;
    var replay = operations.replay(actor, kind, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    var control = controls.lock(sessionId);
    DomainException.requireVersion(session.version(), binding.expectedVersion());
    DomainException.requireVersion(session.pageEpoch(), binding.pageEpoch());
    DomainException.requireVersion(control.epoch(), binding.controlEpoch());
    boolean saving = !intent.equals("CLOSE_DISCARD");
    if (!session.state().equals("ACTIVE")
        || !control.state().equals("ACTIVE")
        || !session.privacy().equals("NORMAL")
        || !session.budgetDeadlineAt().isAfter(Instant.now())
        || !identities.loginActive(actor.userId(), actor.loginId())) {
      throw DomainException.conflict(
          "BROWSER_OPERATION_UNAVAILABLE", "Browser is not ready for this operation");
    }
    if ((saving || control.ownerKind().equals("HUMAN"))
        && (!control.ownerKind().equals("HUMAN")
            || !actor.loginId().equals(control.loginId())
            || !binding.controllerInstanceId().equals(control.controllerInstanceId())
            || !control.expiresAt().isAfter(Instant.now()))) {
      throw DomainException.conflict(
          "CONTROL_CONFLICT", "Acquire control before saving or closing this browser");
    }
    if (saving) {
      if (session.connectionId() == null) {
        throw DomainException.conflict("CONNECTION_REQUIRED", "Select a connection before saving");
      }
      profiles.requireCurrentVersion(
          actor.userId(), session.connectionId(), binding.expectedProfileVersion());
    }
    var receipt =
        operations.save(
            actor, kind, context, input, "browserSession", sessionId, session.version() + 1, false);
    repository.create(
        receipt.operationId(),
        session,
        control,
        actor.loginId(),
        binding.controllerInstanceId(),
        intent,
        policies.getForExecution(actor.userId()).version(),
        binding.expectedProfileVersion());
    controls.beginSessionBoundary(sessionId, receipt.operationId());
    controlService.publishControl(actor.userId(), sessionId, "QUIESCED");
    return receipt;
  }

  @Transactional
  public boolean acknowledge(UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt) {
    var pending = repository.pendingForSession(sessionId);
    if (pending.isEmpty()) {
      return false;
    }
    identities.lockActive(repository.owner(pending.get()));
    var operation = repository.lock(pending.get());
    var session = browsers.owned(operation.userId(), sessionId);
    var control = controls.lock(sessionId);
    requireWorker(session, workerId, bootId);
    if (receipt.path("allocationEpoch").asLong(-1) != session.allocationEpoch()
        || receipt.path("controlEpoch").asLong(-1) != control.epoch()
        || receipt.path("privacyEpoch").asLong(-1) != session.privacyEpoch()
        || receipt.path("pageEpoch").asLong(-1) < session.pageEpoch()) {
      throw DomainException.conflict("BROWSER_BOUNDARY_STALE", "Browser boundary receipt is stale");
    }
    if (operation.state().equals("RESUMING")) {
      if (!receipt.path("mode").asString().equals("HUMAN")
          || !Objects.equals(control.operationId(), operation.id())
          || !Objects.equals(control.loginId(), operation.loginId())
          || !identities.loginActive(operation.userId(), operation.loginId())) {
        throw DomainException.conflict(
            "BROWSER_BOUNDARY_STALE", "Control resumption is no longer authorized");
      }
      controls.activate(sessionId, control.epoch(), operation.id());
      finish(operation, "SUCCEEDED", null);
      return true;
    }
    if (!operation.state().equals("QUIESCING")) {
      return true;
    }
    requireBinding(operation, session, control);
    long accepted = receipt.path("lastAcceptedInputSequence").asLong(-1);
    long applied = receipt.path("lastAppliedInputSequence").asLong(-1);
    if (!receipt.path("mode").asString().equals("QUIESCED")
        || accepted < 0
        || applied < 0
        || applied > accepted) {
      throw DomainException.conflict("INPUT_CHECKPOINT_MISSING", "Input boundary is unconfirmed");
    }
    browsers.runtimeEpochs(workerId, bootId, sessionId, receipt);
    controls.finishInputFence(control, accepted, applied);
    controls.checkpoint(operation.previousOperationId(), accepted, applied);
    if (accepted != applied) {
      finish(operation, "UNKNOWN", "HUMAN_EFFECT_UNKNOWN");
      return true;
    }
    if (operation.intent().equals("CLOSE_DISCARD")) {
      requestClose(operation);
    } else {
      profiles.requireCurrentVersion(
          operation.userId(), session.connectionId(), operation.expectedProfileVersion());
      var grant = profiles.prepareSave(operation.userId(), sessionId, session.connectionId(), true);
      UUID transferId = (UUID) grant.message().get("transferId");
      repository.transfer(operation.id(), transferId, grant.profileVersionId());
      events.publishEvent(new ControlIntent(grant.workerId(), grant.message()));
    }
    return true;
  }

  public boolean saved(UUID workerId, UUID bootId, UUID sessionId) {
    var pending = repository.pendingForSession(sessionId);
    if (pending.isEmpty()) {
      return false;
    }
    var session = browsers.owned(repository.owner(pending.get()), sessionId);
    requireWorker(session, workerId, bootId);
    progress(pending.get());
    return true;
  }

  @Scheduled(fixedDelay = 2000)
  public void reconcile() {
    for (UUID id : repository.pending()) {
      try {
        progress(id);
      } catch (RuntimeException error) {
        log.warn(
            "Browser operation deferred; operationId={}, errorType={}",
            id,
            error.getClass().getSimpleName());
      }
    }
  }

  public void progress(UUID id) {
    transaction.executeWithoutResult(
        status -> {
          var accountState = identities.lockState(repository.owner(id));
          var operation = repository.lock(id);
          if (!PENDING.contains(operation.state())) {
            return;
          }
          repository.attempted(id);
          var session = browsers.owned(operation.userId(), operation.sessionId());
          var control = controls.lock(session.id());
          if (operation.state().equals("CLOSING") && session.state().equals("CLOSED")) {
            finish(
                operation,
                operation.failureCode() == null ? "SUCCEEDED" : "FAILED",
                operation.failureCode());
            return;
          }
          if (!accountState.equals("ACTIVE")
              || !operation.deadline().isAfter(Instant.now())
              || (!operation.initiator().equals("SYSTEM")
                  && !identities.loginActive(operation.userId(), operation.loginId()))
              || session.state().equals("LOST")
              || session.state().equals("CLOSED")) {
            if (Objects.equals(control.operationId(), operation.id())) {
              controls.quiesceInput(session.id());
            }
            if (operation.state().equals("QUIESCING")) {
              controls.unknownInputBoundary(
                  session.id(), operation.previousOperationId(), operation.id());
            }
            if (operation.initiator().equals("SYSTEM") && !session.state().equals("CLOSED")) {
              controls.closeRequested(session.id());
            }
            boolean unconfirmed =
                operation.state().equals("QUIESCING") || operation.state().equals("CLOSING");
            finish(operation, unconfirmed ? "UNKNOWN" : "FAILED", "BROWSER_OPERATION_EXPIRED");
            return;
          }
          switch (operation.state()) {
            case "QUIESCING" -> {
              requireBinding(operation, session, control);
              if (operation.initiator().equals("SYSTEM")) {
                controlService.publishCleanup(
                    operation.userId(), session.id(), operation.deadline());
              } else {
                controlService.redeliverControl(operation.userId(), session.id(), "QUIESCED");
              }
            }
            case "SAVING" -> continueSave(operation, session, control);
            case "RESUMING" -> {
              if (!control.expiresAt().isAfter(Instant.now())) {
                controls.quiesceInput(session.id());
                finish(operation, "FAILED", "PROFILE_SAVED_CONTROL_EXPIRED");
              } else {
                controlService.redeliverControl(operation.userId(), session.id(), "HUMAN");
              }
            }
            case "CLOSING" -> repository.pauseTask(session.id());
            default -> throw new IllegalStateException("Unsupported pending browser operation");
          }
        });
  }

  private void continueSave(
      SessionOperation operation,
      BrowserRepository.Session session,
      ControlRepository.Lease control) {
    requireBinding(operation, session, control);
    var transfer = profiles.saveStatus(operation.userId(), operation.transferId());
    if (!transfer.state().equals("READY")) {
      if (!transfer.expiresAt().isAfter(Instant.now()) || transfer.state().equals("REVOKED")) {
        if (operation.initiator().equals("SYSTEM")) {
          requestClose(operation, "PROFILE_SAVE_EXPIRED");
        } else {
          finish(operation, "FAILED", "PROFILE_SAVE_EXPIRED");
        }
        return;
      }
      var grant = profiles.reissueSave(operation.userId(), operation.transferId());
      events.publishEvent(new ControlIntent(grant.workerId(), grant.message()));
      return;
    }
    if (operation.intent().equals("CLOSE_SAVE")) {
      requestClose(operation);
    } else {
      controls.transfer(
          session.id(), operation.controllerInstanceId(), "HUMAN", false, operation.id());
      controls.bindLogin(session.id(), operation.loginId());
      repository.phase(operation.id(), "RESUMING");
      controlService.publishControl(operation.userId(), session.id(), "HUMAN");
    }
  }

  private void requireBinding(
      SessionOperation operation,
      BrowserRepository.Session session,
      ControlRepository.Lease control) {
    boolean automatic = operation.initiator().equals("SYSTEM");
    if (!(session.state().equals("ACTIVE") || automatic && session.state().equals("STOPPING"))
        || (!session.privacy().equals("NORMAL") && !operation.intent().equals("CLOSE_DISCARD"))
        || session.allocationEpoch() != operation.allocationEpoch()
        || session.privacyEpoch() != operation.privacyEpoch()
        || control.epoch() != operation.controlEpoch()
        || !Objects.equals(control.operationId(), operation.id())
        || policies.getForExecution(operation.userId()).version() != operation.policyVersion()) {
      throw DomainException.conflict(
          "BROWSER_BOUNDARY_STALE", "Browser binding changed during the operation");
    }
  }

  private void requestClose(SessionOperation operation) {
    requestClose(operation, operation.failureCode());
  }

  private void requestClose(SessionOperation operation, String failureCode) {
    repository.pauseTask(operation.sessionId());
    controls.closeRequested(operation.sessionId());
    repository.closing(operation.id(), failureCode);
    if (failureCode != null) {
      repository.closeReason(operation.sessionId(), failureCode);
    }
    changes.changed(
        operation.userId(),
        "tasks",
        operation.sessionId(),
        browsers.owned(operation.userId(), operation.sessionId()).version());
  }

  private void finish(SessionOperation operation, String state, String code) {
    long operationVersion = repository.finish(operation, state, code);
    changes.changed(operation.userId(), "operations", operation.id(), operationVersion);
    long version = repository.advanceSession(operation.sessionId());
    changes.changed(operation.userId(), "tasks", operation.sessionId(), version);
  }

  private static void requireWorker(BrowserRepository.Session session, UUID worker, UUID boot) {
    if (!worker.equals(session.workerId()) || !boot.equals(session.workerBootId())) {
      throw new DomainException(403, "WORKER_BINDING_MISMATCH", "Worker does not own this browser");
    }
  }
}
