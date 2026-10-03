package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.artifact.api.ArtifactContracts;
import com.helmglass.artifact.application.ArtifactService;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.BrowserControlService.ControlIntent;
import com.helmglass.browser.domain.BrowserLocation;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.browser.infrastructure.repository.HumanBrowserCommandRepository;
import com.helmglass.browser.infrastructure.repository.HumanBrowserCommandRepository.HumanCommand;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

/** Explicit operations on the human-controlled Page, with one durable execution permit. */
@Service
public class HumanBrowserCommandService {
  private static final Set<String> TERMINAL = Set.of("SUCCEEDED", "FAILED", "UNKNOWN");
  private final HumanBrowserCommandRepository navigations;
  private final ArtifactService artifacts;
  private final BrowserRepository browsers;
  private final BrowserSessionService sessionOwner;
  private final ControlRepository controls;
  private final IdentityRepository identities;
  private final ConnectionRepository connections;
  private final UserPolicyService policies;
  private final OperationRepository operations;
  private final ChangeRepository changes;
  private final ApplicationEventPublisher events;
  private final JsonSupport json;
  private final WorkerProtocol protocol;
  private final TransactionTemplate transaction;

  public HumanBrowserCommandService(
      HumanBrowserCommandRepository navigations,
      ArtifactService artifacts,
      BrowserRepository browsers,
      BrowserSessionService sessionOwner,
      ControlRepository controls,
      IdentityRepository identities,
      ConnectionRepository connections,
      UserPolicyService policies,
      OperationRepository operations,
      ChangeRepository changes,
      ApplicationEventPublisher events,
      JsonSupport json,
      WorkerProtocol protocol,
      PlatformTransactionManager transactions) {
    this.navigations = navigations;
    this.artifacts = artifacts;
    this.browsers = browsers;
    this.sessionOwner = sessionOwner;
    this.controls = controls;
    this.identities = identities;
    this.connections = connections;
    this.policies = policies;
    this.operations = operations;
    this.changes = changes;
    this.events = events;
    this.json = json;
    this.protocol = protocol;
    transaction = new TransactionTemplate(transactions);
  }

  @Transactional
  public MutationReceipt navigate(
      AuthenticatedActor actor,
      UUID sessionId,
      BrowserContracts.Navigation input,
      MutationContext context) {
    boolean goTo = "GOTO".equals(input.action());
    if (goTo ? input.url() == null || input.url().isBlank() : input.url() != null) {
      throw new DomainException(422, "INVALID_NAVIGATION", "Only GOTO requires a URL");
    }
    String type = goTo ? "NAVIGATE" : input.action();
    JsonNode action =
        json.tree(goTo ? Map.of("type", type, "url", input.url()) : Map.of("type", type));
    return accept(
        actor,
        sessionId,
        new BrowserContracts.Snapshot(
            input.expectedVersion(),
            input.controlEpoch(),
            input.pageEpoch(),
            input.controllerInstanceId()),
        input,
        action,
        "browser.navigation:",
        context);
  }

  @Transactional
  public MutationReceipt snapshot(
      AuthenticatedActor actor,
      UUID sessionId,
      BrowserContracts.Snapshot input,
      MutationContext context) {
    return accept(
        actor,
        sessionId,
        input,
        input,
        json.tree(Map.of("type", "SNAPSHOT")),
        "browser.snapshot:",
        context);
  }

  private MutationReceipt accept(
      AuthenticatedActor actor,
      UUID sessionId,
      BrowserContracts.Snapshot binding,
      Object input,
      JsonNode action,
      String operationKind,
      MutationContext context) {
    if (actor.mcp() || actor.loginId() == null) {
      throw new DomainException(
          403, "WEB_LOGIN_REQUIRED", "Human browser operations require a web login");
    }
    identities.lockActive(actor.userId());
    var session = browsers.owned(actor.userId(), sessionId);
    var replay = operations.replay(actor, operationKind + sessionId, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    var control = controls.lock(sessionId);
    requireController(session, control, actor.loginId(), binding.controllerInstanceId());
    DomainException.requireVersion(session.version(), binding.expectedVersion());
    DomainException.requireVersion(session.pageEpoch(), binding.pageEpoch());
    DomainException.requireVersion(control.epoch(), binding.controlEpoch());
    String type = action.path("type").asString();
    if (type.equals("SNAPSHOT")
        && (!session.privacy().equals("NORMAL") || session.taskId() == null)) {
      throw DomainException.conflict(
          "SCREENSHOT_UNAVAILABLE", "Screenshots require an ordinary task browser");
    }
    protocol.validateAction(action);
    var policy = policies.getForExecution(actor.userId());
    policies.authorize(
        policy, type, action.has("url") ? action.path("url").asString() : session.currentUrl());
    var receipt =
        operations.save(
            actor,
            operationKind + sessionId,
            context,
            input,
            "browserSession",
            sessionId,
            session.version(),
            false);
    var command =
        navigations.create(
            receipt.operationId(),
            actor.userId(),
            sessionId,
            actor.loginId(),
            binding.controllerInstanceId(),
            action,
            scope(session, control, policy.version()),
            session.privacy().equals("LOGIN_PRIVATE") ? "HUMAN_PRIVATE" : "HUMAN",
            earlier(Instant.now().plusSeconds(30), session.budgetDeadlineAt()));
    dispatch(command, session);
    return receipt;
  }

  public boolean contains(UUID id) {
    return navigations.contains(id);
  }

  @Transactional
  public Map<String, Object> permit(UUID workerId, UUID bootId, JsonNode request) {
    UUID id = UUID.fromString(request.path("commandId").asString());
    identities.lockActive(navigations.owner(id));
    var navigation = navigations.lock(id);
    var session = browsers.owned(navigation.userId(), navigation.sessionId());
    requireWorker(session, workerId, bootId);
    var control = controls.lock(session.id());
    requireController(session, control, navigation.loginId(), navigation.controllerInstanceId());
    var policy = policies.getForExecution(navigation.userId());
    Map<String, Object> currentScope = scope(session, control, policy.version());
    JsonNode originalScope = json.read(navigation.scope());
    if (!navigation.state().equals("ACCEPTED")
        || !navigation.deadline().isAfter(Instant.now())
        || !request.path("attemptId").asString().equals(navigation.attemptId().toString())
        || !request.path("actionDigest").asString().equals(navigation.actionDigest())
        || !request.path("browserSessionId").asString().equals(session.id().toString())
        || !json.workerDigest(originalScope).equals(json.workerDigest(json.tree(currentScope)))) {
      throw DomainException.conflict("START_PERMIT_DENIED", "Navigation binding has changed");
    }
    for (String field :
        List.of(
            "allocationEpoch",
            "controlEpoch",
            "pageEpoch",
            "privacyEpoch",
            "policyVersion",
            "instructionRevision")) {
      if (!request.path(field).isIntegralNumber()
          || request.path(field).asLong(-1) != originalScope.path(field).asLong(-2)) {
        throw DomainException.conflict("START_PERMIT_DENIED", "Runtime binding has changed");
      }
    }
    JsonNode action = json.read(navigation.action());
    policies.authorize(
        policy,
        action.path("type").asString(),
        action.has("url") ? action.path("url").asString() : session.currentUrl());
    UUID permitId = UUID.randomUUID();
    navigations.started(id, permitId);
    currentScope.put("permitId", permitId);
    currentScope.put("commandId", id);
    currentScope.put("attemptId", navigation.attemptId());
    currentScope.put("actionDigest", navigation.actionDigest());
    currentScope.put("executionMode", navigation.executionMode());
    currentScope.put("controllerInstance", navigation.controllerInstanceId());
    currentScope.put("deadline", earlier(navigation.deadline(), control.expiresAt()));
    return currentScope;
  }

  @Transactional
  public void result(UUID workerId, UUID bootId, JsonNode result) {
    UUID id = UUID.fromString(result.path("commandId").asString());
    identities.lockState(navigations.owner(id));
    var navigation = navigations.lock(id);
    var session = browsers.owned(navigation.userId(), navigation.sessionId());
    requireWorker(session, workerId, bootId);
    JsonNode binding = json.read(navigation.scope());
    boolean snapshot = isSnapshot(navigation);
    Set<String> fields =
        Set.of(
            "schemaVersion",
            "commandId",
            "attemptId",
            "taskId",
            "browserSessionId",
            "allocationEpoch",
            "controlEpoch",
            "pageEpoch",
            "privacyEpoch",
            "status",
            "effectState",
            "code",
            "digest",
            "safeUrl",
            "artifact");
    if (result.path("schemaVersion").asInt(-1) != 1
        || !result.path("code").asString().matches("[A-Z][A-Z0-9_]{0,79}")
        || navigation.executionMode().equals("HUMAN_PRIVATE")
            && (result.has("safeUrl") || result.has("artifact"))
        || !snapshot && result.has("artifact")
        || result.properties().stream().anyMatch(field -> !fields.contains(field.getKey()))) {
      throw new DomainException(
          422, "INVALID_RECEIPT", "Human navigation receipt has invalid fields");
    }
    if (!result.path("attemptId").asString().equals(navigation.attemptId().toString())
        || !result.path("browserSessionId").asString().equals(session.id().toString())
        || !Objects.equals(result.get("taskId"), binding.get("taskId"))
        || result.has("observation")) {
      throw new DomainException(
          422, "INVALID_RECEIPT", "Human navigation receipt has invalid fields");
    }
    for (String field : List.of("allocationEpoch", "controlEpoch", "privacyEpoch")) {
      if (!result.path(field).isIntegralNumber()
          || result.path(field).asLong(-1) != binding.path(field).asLong(-2)) {
        throw DomainException.conflict(
            "RECEIPT_BINDING_MISMATCH", "Navigation receipt has stale epochs");
      }
    }
    if (!result.path("pageEpoch").isIntegralNumber()
        || result.path("pageEpoch").asLong(-1) < binding.path("pageEpoch").asLong()
        || snapshot && result.path("pageEpoch").asLong(-1) != binding.path("pageEpoch").asLong()) {
      throw DomainException.conflict(
          "RECEIPT_BINDING_MISMATCH", "Navigation page epoch is invalid");
    }
    json.verifyWorkerReceipt(result);
    String digest = result.path("digest").asString();
    if (navigation.resultDigest() != null) {
      if (!navigation.resultDigest().equals(digest)) {
        throw DomainException.conflict(
            "RESULT_DIGEST_CONFLICT", "Navigation already has a receipt");
      }
      return;
    }
    String status = result.path("status").asString();
    String effect = result.path("effectState").asString();
    boolean notStarted = status.equals("FAILED") && effect.equals("NOT_STARTED");
    if (!(notStarted
            || status.equals("SUCCEEDED") && effect.equals("CONFIRMED")
            || status.equals("UNKNOWN") && effect.equals("UNKNOWN"))
        || !notStarted && navigation.permitId() == null) {
      throw new DomainException(422, "INVALID_RECEIPT", "Navigation disposition is inconsistent");
    }
    if (snapshot && status.equals("SUCCEEDED")) {
      protocol.validateArtifactReady(result.path("artifact"));
      var committed =
          artifacts.requireReadyScreenshot(
              navigation.id(),
              navigation.attemptId(),
              json.convert(result.path("artifact"), ArtifactContracts.Receipt.class));
      navigations.artifactTarget(navigation.id(), committed.artifactId());
    } else if (result.has("artifact")) {
      throw new DomainException(
          422, "INVALID_RECEIPT", "Only a confirmed screenshot has an artifact receipt");
    }
    if (TERMINAL.contains(navigation.state())
        && !(snapshot && status.equals("SUCCEEDED") && navigation.state().equals("UNKNOWN"))) {
      // Late evidence never silently removes a reconciliation barrier or reopens a closed
      // operation.
      navigations.recordLateReceipt(id, digest);
      return;
    }
    browsers.runtimeEpochs(workerId, bootId, session.id(), result);
    if (result.has("safeUrl")) {
      browsers.observedLocation(
          workerId,
          bootId,
          session.id(),
          result,
          BrowserLocation.safe(result.path("safeUrl").asString()));
    }
    sessionOwner.commandCompleted(navigation.userId(), workerId, bootId, session.id(), result);
    complete(
        navigation,
        session,
        status,
        effect,
        digest,
        result.has("code") ? result.path("code").asString() : null);
  }

  @Scheduled(fixedDelay = 1000)
  public void reconcile() {
    for (UUID id : navigations.expired()) {
      transaction.executeWithoutResult(
          status -> {
            identities.lockState(navigations.owner(id));
            var navigation = navigations.lock(id);
            if (!TERMINAL.contains(navigation.state())
                && !navigation.deadline().isAfter(Instant.now())) {
              var session = browsers.owned(navigation.userId(), navigation.sessionId());
              if (isSnapshot(navigation)) {
                var ready = artifacts.readyScreenshot(navigation.id(), navigation.attemptId());
                if (ready.isPresent()) {
                  navigations.artifactTarget(navigation.id(), ready.get().artifactId());
                  complete(
                      navigation, session, "SUCCEEDED", "CONFIRMED", null, "SCREENSHOT_PUBLISHED");
                  return;
                }
              }
              boolean unknown = navigation.permitId() != null;
              complete(
                  navigation,
                  session,
                  unknown ? "UNKNOWN" : "FAILED",
                  unknown ? "UNKNOWN" : "NOT_STARTED",
                  null,
                  "NAVIGATION_DEADLINE_EXCEEDED");
            }
          });
    }
    for (UUID id : navigations.pending()) {
      transaction.executeWithoutResult(
          status -> {
            String accountState = identities.lockState(navigations.owner(id));
            var navigation = navigations.lock(id);
            if (!navigation.state().equals("ACCEPTED")) {
              return;
            }
            var session = browsers.owned(navigation.userId(), navigation.sessionId());
            if (!accountState.equals("ACTIVE")
                || !session.state().equals("ACTIVE")
                || !identities.loginActive(navigation.userId(), navigation.loginId())) {
              complete(
                  navigation,
                  session,
                  "FAILED",
                  "NOT_STARTED",
                  null,
                  "NAVIGATION_AUTHORIZATION_REVOKED");
              return;
            }
            dispatch(navigation, session);
          });
    }
  }

  private void complete(
      HumanCommand navigation,
      BrowserRepository.Session session,
      String state,
      String effect,
      String digest,
      String code) {
    long version = navigations.finish(navigation.id(), state, effect, digest, code);
    if (state.equals("UNKNOWN") && !isSnapshot(navigation)) {
      navigations.interruptTask(session.id());
    }
    changes.changed(navigation.userId(), "operations", navigation.id(), version);
    changes.changed(navigation.userId(), "browserSessions", session.id(), session.version());
    if (session.taskId() != null) {
      changes.changed(navigation.userId(), "tasks", session.taskId(), session.version());
    }
  }

  private boolean isSnapshot(HumanCommand command) {
    return json.read(command.action()).path("type").asString().equals("SNAPSHOT");
  }

  private void dispatch(HumanCommand navigation, BrowserRepository.Session session) {
    Map<String, Object> body = new HashMap<>();
    body.put("commandId", navigation.id());
    body.put("attemptId", navigation.attemptId());
    body.put("taskId", session.taskId());
    body.put("browserSessionId", session.id());
    body.put(
        "instructionRevision", json.read(navigation.scope()).path("instructionRevision").asLong());
    body.put("executionMode", navigation.executionMode());
    body.put("controllerInstance", navigation.controllerInstanceId());
    body.put("action", json.read(navigation.action()));
    events.publishEvent(
        new ControlIntent(
            session.workerId(),
            WorkerGateway.envelope("command", UUID.randomUUID(), Map.of("command", body))));
  }

  private void requireController(
      BrowserRepository.Session session,
      ControlRepository.Lease control,
      UUID loginId,
      UUID controller) {
    if (!session.state().equals("ACTIVE")
        || !control.state().equals("ACTIVE")
        || !control.ownerKind().equals("HUMAN")
        || !controller.equals(control.controllerInstanceId())
        || !loginId.equals(control.loginId())
        || !control.expiresAt().isAfter(Instant.now())
        || !session.budgetDeadlineAt().isAfter(Instant.now())
        || !identities.loginActive(session.userId(), loginId)) {
      throw DomainException.conflict(
          "CONTROL_CONFLICT", "This web session no longer controls the browser");
    }
    if (!navigations.effectsKnown(session.id())) {
      throw DomainException.conflict(
          "UNKNOWN_EFFECT_BARRIER", "Resolve the previous effect before navigating");
    }
  }

  private Map<String, Object> scope(
      BrowserRepository.Session session, ControlRepository.Lease control, long policyVersion) {
    Map<String, Object> binding = new HashMap<>();
    binding.put("taskId", session.taskId());
    binding.put("userId", session.userId());
    binding.put("browserSessionId", session.id());
    binding.put("workerBootId", session.workerBootId());
    binding.put("allocationEpoch", session.allocationEpoch());
    binding.put("controlEpoch", control.epoch());
    binding.put("pageEpoch", session.pageEpoch());
    binding.put("privacyEpoch", session.privacyEpoch());
    binding.put("policyVersion", policyVersion);
    binding.put("instructionRevision", connections.instructionRevision(session.taskId()));
    if (session.connectionId() != null) {
      binding.put("connectionId", session.connectionId());
      binding.put(
          "scopeVersion",
          connections.owned(session.userId(), session.connectionId(), false).scopeVersion());
    }
    return binding;
  }

  private static void requireWorker(BrowserRepository.Session session, UUID worker, UUID boot) {
    if (!worker.equals(session.workerId()) || !boot.equals(session.workerBootId())) {
      throw new DomainException(
          403, "WORKER_BINDING_MISMATCH", "Worker does not own this navigation");
    }
  }

  private static Instant earlier(Instant first, Instant second) {
    return first.isBefore(second) ? first : second;
  }
}
