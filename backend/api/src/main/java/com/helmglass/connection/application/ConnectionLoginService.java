package com.helmglass.connection.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserControlService.ControlIntent;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.connection.api.LoginContracts;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository.Login;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

@Service
@Slf4j
public class ConnectionLoginService {
  private final LoginRepository logins;
  private final ConnectionRepository connections;
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final BrowserControlService controlOwner;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final UserPolicyService policies;
  private final BrowserProfileService profiles;
  private final ChangeRepository changes;
  private final ApplicationEventPublisher events;
  private final JsonSupport json;
  private final TransactionTemplate transaction;

  public ConnectionLoginService(
      LoginRepository logins,
      ConnectionRepository connections,
      BrowserRepository browsers,
      ControlRepository controls,
      BrowserControlService controlOwner,
      IdentityRepository identities,
      OperationRepository operations,
      UserPolicyService policies,
      BrowserProfileService profiles,
      ChangeRepository changes,
      ApplicationEventPublisher events,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.logins = logins;
    this.connections = connections;
    this.browsers = browsers;
    this.controls = controls;
    this.controlOwner = controlOwner;
    this.identities = identities;
    this.operations = operations;
    this.policies = policies;
    this.profiles = profiles;
    this.changes = changes;
    this.events = events;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
    transaction.setTimeout(5);
  }

  @Transactional
  public MutationReceipt begin(
      AuthenticatedActor actor,
      UUID connectionId,
      LoginContracts.Begin input,
      MutationContext context) {
    requireWeb(actor);
    identities.lockActive(actor.userId());
    var connection = connections.owned(actor.userId(), connectionId, true);
    var replay = operations.replay(actor, "connections.login:" + connectionId, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    if (List.of("DELETING", "DELETED").contains(connection.status())) {
      throw DomainException.conflict("CONNECTION_UNAVAILABLE", "Connection is not available");
    }
    policies.authorize(actor.userId(), "NAVIGATE", connection.startUrl());
    UUID id = UUID.randomUUID();
    var receipt =
        operations.saveWithId(
            id,
            actor,
            "connections.login:" + connectionId,
            context,
            input,
            "loginOperation",
            id,
            1,
            false);
    logins.insert(
        id,
        actor.userId(),
        actor.loginId(),
        connectionId,
        input.taskId(),
        input.controllerInstanceId(),
        connection.origin(),
        "LOGIN");
    if (input.taskId() != null) {
      var binding = browsers.binding(input.taskId());
      if (binding.isPresent()) {
        var session = browsers.owned(actor.userId(), binding.get().id());
        connections.bind(connectionId, session.id());
        session = browsers.owned(actor.userId(), session.id());
        logins.assigned(id, session.id());
        var lease = controls.get(session.id());
        controlOwner.acquire(
            actor,
            session.id(),
            new BrowserContracts.TakeControl(
                session.version(), lease.epoch(), input.controllerInstanceId(), true, false),
            new MutationContext(context.key() + ":control", context.requestId()));
        logins.state(id, "WAITING_USER");
      }
    }
    changes.changed(actor.userId(), "connections", connectionId, connection.version());
    return receipt;
  }

  public Map<String, Object> get(AuthenticatedActor actor, UUID id) {
    Login login = logins.owned(actor.userId(), id, false);
    Map<String, Object> view = new HashMap<>();
    view.put("id", id);
    view.put("connectionId", login.connectionId());
    view.put("taskId", login.taskId());
    view.put("sessionId", login.sessionId());
    view.put("version", login.version());
    view.put("state", login.state());
    view.put("verification", login.verificationResult());
    view.put("origins", List.of(login.expectedOrigin()));
    view.put("expiresAt", login.expiresAt());
    view.put(
        "capabilities",
        Map.of(
            "complete",
            Map.of("allowed", login.state().equals("WAITING_USER")),
            "cancel",
            Map.of(
                "allowed", !List.of("SUCCEEDED", "FAILED", "CANCELLED").contains(login.state()))));
    return view;
  }

  public List<UUID> pending() {
    return logins.pending();
  }

  @Transactional
  public Optional<ControlIntent> allocate(UUID id) {
    Login initial = logins.get(id);
    identities.lockActive(initial.userId());
    Login login = logins.owned(initial.userId(), id, true);
    connections.owned(login.userId(), login.connectionId(), true);
    if (!login.state().equals("WAITING_RESOURCE")) {
      return Optional.empty();
    }
    if (!identities.loginActive(login.userId(), login.loginId())
        || !login.expiresAt().isAfter(Instant.now())) {
      logins.fail(login.id(), "LOGIN_AUTHORIZATION_EXPIRED");
      return Optional.empty();
    }
    browsers.checkBrowserLimit(login.userId());
    var worker = browsers.freeWorker();
    if (worker.isEmpty()) {
      return Optional.empty();
    }
    var session =
        browsers.reserve(
            login.userId(),
            login.taskId(),
            login.connectionId(),
            login.taskId() == null ? "CONNECTION_LOGIN" : "TASK",
            worker.get(),
            600);
    logins.assigned(id, session.id());
    controls.bindLogin(session.id(), login.loginId());
    Map<String, Object> assignment = scope(session);
    var policy = policies.getForExecution(login.userId());
    assignment.put("purpose", session.purpose());
    assignment.put("originPolicy", WorkerProtocol.originPolicy(policy.siteMode()));
    assignment.put(
        "allowedOrigins", policy.siteMode().equals("ALLOW_LIST") ? policy.origins() : List.of());
    if (policy.siteMode().equals("DENY_LIST")) {
      assignment.put("deniedOrigins", policy.origins());
    }
    assignment.put("deadline", session.budgetDeadlineAt());
    assignment.put(
        "viewport", Map.of("width", session.viewportWidth(), "height", session.viewportHeight()));
    return Optional.of(
        new ControlIntent(
            session.workerId(),
            WorkerGateway.envelope("assign", UUID.randomUUID(), Map.of("assignment", assignment))));
  }

  @Transactional
  public void assigned(UUID workerId, UUID bootId, UUID sessionId) {
    var found = logins.forSession(sessionId);
    if (found.isEmpty()) {
      return;
    }
    Login login = found.get();
    var session = requireWorker(login, workerId, bootId);
    if (!login.state().equals("STARTING")) {
      return;
    }
    var connection = connections.owned(login.userId(), login.connectionId(), false);
    var command = logins.navigation(login, connection.startUrl());
    Map<String, Object> body = new HashMap<>();
    body.put("commandId", command.id());
    body.put("attemptId", command.attemptId());
    body.put("taskId", session.taskId());
    body.put("browserSessionId", sessionId);
    body.put("action", json.read(command.action()));
    send(session.workerId(), "command", Map.of("command", body));
  }

  public boolean isSessionCommand(UUID id) {
    return logins.isSessionCommand(id);
  }

  @Transactional
  public Map<String, Object> permit(UUID workerId, UUID bootId, JsonNode request) {
    var command = logins.command(UUID.fromString(request.path("commandId").asString()));
    identities.lockActive(command.userId());
    Login login = logins.owned(command.userId(), command.operationId(), true);
    var session = requireWorker(login, workerId, bootId);
    var currentScope = scope(session);
    for (String field :
        List.of(
            "allocationEpoch",
            "controlEpoch",
            "pageEpoch",
            "privacyEpoch",
            "policyVersion",
            "instructionRevision")) {
      if (!request.path(field).isIntegralNumber()
          || !request.path(field).asString().equals(currentScope.get(field).toString())) {
        throw DomainException.conflict(
            "START_PERMIT_DENIED", "Login navigation binding has changed");
      }
    }
    if (!login.state().equals("STARTING")
        || !session.state().equals("ACTIVE")
        || !identities.loginActive(login.userId(), login.loginId())
        || !command.deadline().isAfter(Instant.now())
        || !request.path("attemptId").asString().equals(command.attemptId().toString())
        || !request.path("actionDigest").asString().equals(command.actionDigest())
        || !request.path("browserSessionId").asString().equals(session.id().toString())) {
      throw DomainException.conflict(
          "START_PERMIT_DENIED", "Login navigation is no longer allowed");
    }
    policies.authorize(
        login.userId(), "NAVIGATE", json.read(command.action()).path("url").asString());
    UUID permitId = UUID.randomUUID();
    logins.started(command.id(), permitId);
    var result = scope(session);
    result.put("permitId", permitId);
    result.put("commandId", command.id());
    result.put("attemptId", command.attemptId());
    result.put("actionDigest", command.actionDigest());
    result.put("deadline", command.deadline());
    return result;
  }

  @Transactional
  public void result(UUID workerId, UUID bootId, JsonNode result) {
    var command = logins.command(UUID.fromString(result.path("commandId").asString()));
    Login login = logins.owned(command.userId(), command.operationId(), true);
    var session = requireWorker(login, workerId, bootId);
    if (!result.path("attemptId").asString().equals(command.attemptId().toString())) {
      throw new DomainException(403, "ATTEMPT_MISMATCH", "Receipt does not match login navigation");
    }
    json.verifyWorkerReceipt(result);
    String digest = result.path("digest").asString();
    if (command.resultDigest() != null) {
      if (!command.resultDigest().equals(digest)) {
        throw DomainException.conflict(
            "RESULT_DIGEST_CONFLICT", "Navigation already has a receipt");
      }
      return;
    }
    String status = result.path("status").asString();
    browsers.runtimeEpochs(workerId, bootId, session.id(), result);
    logins.result(command.id(), digest, status, result.path("effectState").asString());
    if (!status.equals("SUCCEEDED")) {
      logins.state(login.id(), "FAILED");
      controls.closeRequested(session.id());
      return;
    }
    controls.transfer(session.id(), login.controllerInstanceId(), "HUMAN", true, login.id());
    sendControl(login.userId(), session.id(), "HUMAN_PRIVATE");
    logins.state(login.id(), "WAITING_USER");
  }

  @Transactional
  public MutationReceipt complete(
      AuthenticatedActor actor, UUID id, LoginContracts.Complete input, MutationContext context) {
    requireWeb(actor);
    identities.lockActive(actor.userId());
    Login login = logins.owned(actor.userId(), id, true);
    var replay = operations.replay(actor, "login.complete:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(login.version(), input.expectedVersion());
    var session = browsers.owned(actor.userId(), login.sessionId());
    var control = controls.lock(session.id());
    DomainException.requireVersion(control.epoch(), input.controlEpoch());
    DomainException.requireVersion(session.pageEpoch(), input.pageEpoch());
    if (!login.state().equals("WAITING_USER")
        || !control.state().equals("ACTIVE")
        || !control.ownerKind().equals("HUMAN")
        || !control.expiresAt().isAfter(Instant.now())
        || !actor.loginId().equals(control.loginId())
        || !input.controllerInstanceId().equals(control.controllerInstanceId())
        || !identities.loginActive(actor.userId(), actor.loginId())
        || !session.state().equals("ACTIVE")
        || !session.privacy().equals("LOGIN_PRIVATE")
        || !input.userAsserted()
        || !input.confirmedOrigins().equals(List.of(login.expectedOrigin()))) {
      throw DomainException.conflict(
          "LOGIN_NOT_READY", "Confirm the account and safe post-login page first");
    }
    profiles.requireCurrentVersion(
        actor.userId(), login.connectionId(), input.expectedProfileVersion());
    var receipt =
        operations.save(
            actor,
            "login.complete:" + id,
            context,
            input,
            "loginOperation",
            id,
            login.version() + 1,
            false);
    logins.completeRequested(id, receipt.operationId(), input);
    controls.quiesceInput(session.id());
    Map<String, Object> message = scope(session);
    for (String key :
        List.of(
            "taskId",
            "userId",
            "workerBootId",
            "instructionRevision",
            "connectionId",
            "scopeVersion",
            "pageEpoch")) {
      message.remove(key);
    }
    message.put("expectedOrigin", login.expectedOrigin());
    message.put("userAsserted", true);
    send(session.workerId(), "profileCheck", message);
    return receipt;
  }

  public void checked(UUID workerId, UUID bootId, UUID sessionId, JsonNode response) {
    transaction.executeWithoutResult(
        status -> {
          Login current = logins.forSession(sessionId).orElseThrow(DomainException::notFound);
          identities.lockActive(current.userId());
          current = logins.owned(current.userId(), current.id(), true);
          var session = requireWorker(current, workerId, bootId);
          var control = controls.lock(sessionId);
          if (!List.of("VERIFYING", "SAVED_VERIFYING").contains(current.state())) {
            throw DomainException.conflict(
                "LOGIN_OPERATION_STALE", "Login is no longer being verified");
          }
          if (!session.privacy().equals("LOGIN_PRIVATE")
              || !control.state().equals("QUIESCED")
              || response.path("allocationEpoch").asLong(-1) != session.allocationEpoch()
              || response.path("controlEpoch").asLong(-1) != control.epoch()
              || response.path("privacyEpoch").asLong(-1) != session.privacyEpoch()
              || response.path("pageEpoch").asLong(-1) < session.pageEpoch()
              || response.path("policyVersion").asLong(-1)
                  != policies.getForExecution(current.userId()).version()
              || !identities.loginActive(current.userId(), control.loginId())) {
            throw DomainException.conflict(
                "LOGIN_VERIFICATION_STALE", "Login verifier receipt has stale authorization");
          }
          browsers.runtimeEpochs(workerId, bootId, sessionId, response);
          if (response.path("status").asString().equals("SAFE")
              && !List.of("AUTHENTICATED", "USER_ASSERTED")
                  .contains(response.path("verification").asString())) {
            throw new DomainException(
                422,
                "LOGIN_VERIFICATION_INVALID",
                "Safe login requires verified or user-asserted evidence");
          }
          logins.verification(current.id(), response.path("verification").asString("UNKNOWN"));
          if (!response.path("status").asString().equals("SAFE")) {
            logins.verificationRejected(current.id());
            controls.transfer(
                sessionId, control.controllerInstanceId(), "HUMAN", true, current.id());
            sendControl(current.userId(), sessionId, "HUMAN_PRIVATE");
            return;
          }
          if (current.state().equals("SAVED_VERIFYING")) {
            finish(current);
          } else if (current.saveMode().equals("SAVE_PROFILE")) {
            var grant =
                profiles.prepareSave(current.userId(), sessionId, current.connectionId(), true);
            logins.profileVersion(current.id(), grant.profileVersionId());
            logins.state(current.id(), "SAVING");
            events.publishEvent(new ControlIntent(grant.workerId(), grant.message()));
          } else {
            finish(current);
          }
        });
  }

  @Transactional
  public void saved(UUID workerId, UUID bootId, UUID sessionId) {
    var found = logins.forSession(sessionId);
    if (found.isEmpty() || !found.get().state().equals("SAVING")) {
      return;
    }
    Login login = found.get();
    identities.lockActive(login.userId());
    login = logins.owned(login.userId(), login.id(), true);
    if (!login.state().equals("SAVING")) {
      return;
    }
    requireWorker(login, workerId, bootId);
    if (!connections.profileReady(login.connectionId(), login.profileVersionId())) {
      throw DomainException.conflict(
          "PROFILE_NOT_PUBLISHED", "Encrypted profile publication is not confirmed");
    }
    logins.state(login.id(), "SAVED_VERIFYING");
    var session = browsers.owned(login.userId(), sessionId);
    Map<String, Object> check = new HashMap<>();
    check.put("browserSessionId", sessionId);
    check.put("allocationEpoch", session.allocationEpoch());
    check.put("controlEpoch", controls.get(sessionId).epoch());
    check.put("privacyEpoch", session.privacyEpoch());
    check.put("policyVersion", policies.getForExecution(login.userId()).version());
    check.put("expectedOrigin", login.expectedOrigin());
    check.put("userAsserted", login.userAsserted());
    send(session.workerId(), "profileCheck", check);
  }

  @Scheduled(fixedDelay = 5000)
  public void reconcileProfileSaves() {
    for (Login candidate : logins.saving()) {
      try {
        transaction.executeWithoutResult(
            status -> {
              identities.lockActive(candidate.userId());
              Login current = logins.owned(candidate.userId(), candidate.id(), true);
              if (!current.state().equals("SAVING")) {
                return;
              }
              var session = browsers.owned(current.userId(), current.sessionId());
              if (!current.expiresAt().isAfter(Instant.now())) {
                saveFailed(current, "PROFILE_SAVE_EXPIRED");
              } else if (connections.profileReady(
                  current.connectionId(), current.profileVersionId())) {
                saved(session.workerId(), session.workerBootId(), session.id());
              } else {
                var grant =
                    profiles.reissueSavedVersion(current.userId(), current.profileVersionId());
                events.publishEvent(new ControlIntent(grant.workerId(), grant.message()));
              }
            });
      } catch (DomainException error) {
        if (List.of("PROFILE_TRANSFER_DENIED", "PROFILE_TRANSFER_STALE", "PROFILE_ASSIGNMENT_STALE")
            .contains(error.getCode())) {
          transaction.executeWithoutResult(
              status -> {
                identities.lockActive(candidate.userId());
                Login current = logins.owned(candidate.userId(), candidate.id(), true);
                if (current.state().equals("SAVING")) {
                  saveFailed(current, error.getCode());
                }
              });
        } else {
          log.warn(
              "Login profile delivery deferred; operationId={}, code={}",
              candidate.id(),
              error.getCode());
        }
      } catch (RuntimeException error) {
        log.warn(
            "Login profile delivery deferred; operationId={}, errorType={}",
            candidate.id(),
            error.getClass().getSimpleName());
      }
    }
  }

  private void saveFailed(Login login, String code) {
    logins.completionFailed(login.id(), code);
    var session = browsers.owned(login.userId(), login.sessionId());
    var control = controls.lock(session.id());
    if (session.state().equals("ACTIVE")
        && session.privacy().equals("LOGIN_PRIVATE")
        && session.budgetDeadlineAt().isAfter(Instant.now())
        && control.state().equals("QUIESCED")
        && identities.loginActive(login.userId(), control.loginId())) {
      controls.transfer(session.id(), control.controllerInstanceId(), "HUMAN", true, login.id());
      sendControl(login.userId(), session.id(), "HUMAN_PRIVATE");
    }
    changes.changed(login.userId(), "connections", login.connectionId(), login.version() + 1);
  }

  private void finish(Login login) {
    var session = browsers.owned(login.userId(), login.sessionId());
    if (session.taskId() == null && "SAVE_PROFILE".equals(login.saveMode())) {
      controls.closeRequested(session.id());
      logins.state(login.id(), "CLOSING");
    } else {
      if ("SESSION_ONLY".equals(login.saveMode())) {
        connections.discardChanges(session.id());
      }
      controls.transfer(session.id(), null, "AGENT", false, login.completeOperationId());
      sendControl(login.userId(), session.id(), "AGENT");
      logins.state(login.id(), "EXITING_PRIVATE");
    }
  }

  @Transactional
  public void exited(UUID workerId, UUID bootId, UUID sessionId, boolean closed) {
    var found = logins.forSession(sessionId);
    if (found.isEmpty()) {
      return;
    }
    Login login = found.get();
    requireWorker(login, workerId, bootId);
    if (!(closed && login.state().equals("CLOSING"))
        && !(!closed && login.state().equals("EXITING_PRIVATE"))) {
      return;
    }
    logins.successful(login);
    connections.resumeTask(login.taskId(), login.continuationIntent());
    if (login.taskId() != null) {
      events.publishEvent(
          new TaskContinuationService.Ready(login.taskId(), login.id(), null, "LOGIN_COMPLETED"));
    }
    changes.changed(login.userId(), "connections", login.connectionId(), login.version() + 1);
  }

  @Transactional
  public MutationReceipt cancel(AuthenticatedActor actor, UUID id, MutationContext context) {
    requireWeb(actor);
    identities.lockActive(actor.userId());
    Login login = logins.owned(actor.userId(), id, true);
    var input = Map.of("loginOperationId", id);
    var replay = operations.replay(actor, "login.cancel:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    if (login.sessionId() != null) {
      controls.closeRequested(login.sessionId());
    }
    logins.state(id, "CANCELLED");
    return operations.save(
        actor,
        "login.cancel:" + id,
        context,
        input,
        "loginOperation",
        id,
        login.version() + 1,
        login.sessionId() == null);
  }

  private BrowserRepository.Session requireWorker(Login login, UUID workerId, UUID bootId) {
    var session = browsers.owned(login.userId(), login.sessionId());
    if (!workerId.equals(session.workerId()) || !bootId.equals(session.workerBootId())) {
      throw new DomainException(403, "WORKER_BINDING_MISMATCH", "Worker does not own this login");
    }
    return session;
  }

  private Map<String, Object> scope(BrowserRepository.Session session) {
    var scope = new HashMap<String, Object>();
    scope.put("taskId", session.taskId());
    scope.put("userId", session.userId());
    scope.put("browserSessionId", session.id());
    scope.put("workerBootId", session.workerBootId());
    scope.put("allocationEpoch", session.allocationEpoch());
    scope.put("controlEpoch", controls.get(session.id()).epoch());
    scope.put("pageEpoch", session.pageEpoch());
    scope.put("privacyEpoch", session.privacyEpoch());
    scope.put("policyVersion", policies.getForExecution(session.userId()).version());
    scope.put("instructionRevision", connections.instructionRevision(session.taskId()));
    if (session.connectionId() != null) {
      scope.put("connectionId", session.connectionId());
      scope.put(
          "scopeVersion",
          connections.owned(session.userId(), session.connectionId(), false).scopeVersion());
    }
    return scope;
  }

  private void sendControl(UUID userId, UUID sessionId, String mode) {
    var session = browsers.owned(userId, sessionId);
    var control = controls.get(sessionId);
    Map<String, Object> message = new HashMap<>();
    message.put("browserSessionId", sessionId);
    message.put("allocationEpoch", session.allocationEpoch());
    message.put("controlEpoch", control.epoch());
    message.put("pageEpoch", session.pageEpoch());
    message.put("privacyEpoch", session.privacyEpoch());
    message.put("policyVersion", policies.getForExecution(userId).version());
    if (session.connectionId() != null) {
      message.put("connectionId", session.connectionId());
      message.put(
          "scopeVersion", connections.owned(userId, session.connectionId(), false).scopeVersion());
    }
    message.put("mode", mode);
    message.put("leaseExpiresAt", control.expiresAt());
    if (control.controllerInstanceId() != null) {
      message.put("controllerInstance", control.controllerInstanceId());
    }
    send(session.workerId(), "control", message);
  }

  private void send(UUID workerId, String type, Map<String, ?> message) {
    events.publishEvent(
        new ControlIntent(workerId, WorkerGateway.envelope(type, UUID.randomUUID(), message)));
  }

  private static void requireWeb(AuthenticatedActor actor) {
    if (actor.mcp()) {
      throw new DomainException(
          403, "WEB_LOGIN_REQUIRED", "Login requires an authenticated web session");
    }
  }
}
