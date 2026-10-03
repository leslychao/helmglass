package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.BrowserControlService.ControlIntent;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository.Context;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.usage.application.UsageCheckpointService;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

/** Restores one pinned profile into an empty context before the accepted task action can run. */
@Service
public class BrowserStartupService {
  private final BrowserStartupRepository startups;
  private final BrowserRepository browsers;
  private final BrowserSessionService sessionOwner;
  private final CommandRepository commands;
  private final IdentityRepository identities;
  private final UserPolicyService policies;
  private final BrowserProfileService profiles;
  private final ApplicationEventPublisher events;
  private final JsonSupport json;
  private final TransactionTemplate transaction;
  private final BrowserOpenService opens;
  private final UsageCheckpointService usage;

  public BrowserStartupService(
      BrowserStartupRepository startups,
      BrowserRepository browsers,
      BrowserSessionService sessionOwner,
      CommandRepository commands,
      IdentityRepository identities,
      UserPolicyService policies,
      BrowserProfileService profiles,
      ApplicationEventPublisher events,
      JsonSupport json,
      PlatformTransactionManager transactions,
      BrowserOpenService opens,
      UsageCheckpointService usage) {
    this.startups = startups;
    this.browsers = browsers;
    this.sessionOwner = sessionOwner;
    this.commands = commands;
    this.identities = identities;
    this.policies = policies;
    this.profiles = profiles;
    this.events = events;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
    this.opens = opens;
    this.usage = usage;
  }

  public boolean assigned(UUID sessionId) {
    var startup = transaction.execute(status -> startups.forSession(sessionId));
    if (startup == null || startup.isEmpty()) {
      transaction.executeWithoutResult(status -> startups.ready(sessionId, null));
      return true;
    }
    if (!Boolean.TRUE.equals(transaction.execute(status -> startups.beginLoading(sessionId)))) {
      return startup.get().state().equals("READY");
    }
    var dispatch = startups.context(sessionId);
    try {
      var grant = profiles.prepareLoad(dispatch.userId(), sessionId, dispatch.connectionId());
      if (!grant.profileVersionId().equals(startup.get().profileVersionId())) {
        throw DomainException.conflict(
            "PROFILE_CHANGED", "Profile changed after browser allocation");
      }
      transaction.executeWithoutResult(
          status -> {
            startups.transfer(
                sessionId, UUID.fromString(grant.message().get("transferId").toString()));
            events.publishEvent(new ControlIntent(grant.workerId(), grant.message()));
          });
      return false;
    } catch (RuntimeException error) {
      transaction.executeWithoutResult(status -> startups.failed(sessionId, null));
      throw error;
    }
  }

  @Transactional
  public void loaded(UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt) {
    var startup = startups.forSession(sessionId).orElseThrow(DomainException::notFound);
    var dispatch = startups.context(sessionId);
    requireWorker(workerId, bootId, dispatch);
    if (!startups.loaded(
        startup,
        UUID.fromString(receipt.path("transferId").asString()),
        receipt.path("sha256").asString(),
        receipt.path("byteLength").asLong(-1))) {
      throw DomainException.conflict(
          "PROFILE_RECEIPT_STALE", "Loaded profile does not match the startup grant");
    }
    events.publishEvent(
        new ControlIntent(
            workerId,
            WorkerGateway.envelope(
                "command",
                UUID.randomUUID(),
                Map.of(
                    "command",
                    Map.of(
                        "commandId",
                        startup.navigationId(),
                        "attemptId",
                        startup.attemptId(),
                        "taskId",
                        dispatch.taskId(),
                        "browserSessionId",
                        sessionId,
                        "action",
                        json.read(startup.action()))))));
  }

  public boolean isStartupCommand(UUID commandId) {
    return startups.containsCommand(commandId);
  }

  @Transactional
  public void acknowledgeReady(UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt) {
    var session =
        startups.readyCandidate(
            workerId, bootId, sessionId, receipt.path("allocationEpoch").asLong(-1));
    identities.lockActive(session.userId());
    if (session.taskId() != null) {
      commands.lockTask(session.userId(), session.taskId());
    }
    JsonNode checkpoint = receipt.path("usage");
    if (checkpoint.path("neverReady").asBoolean()
        || checkpoint.path("browserComplete").asBoolean()) {
      throw new DomainException(
          422, "INVALID_READY_USAGE", "Readiness requires an active runtime measurement");
    }
    usage.record(workerId, bootId, sessionId, checkpoint);
    if (startups.acknowledgeReady(
        sessionId, Instant.parse(checkpoint.path("sourceStartedAt").asString()))) {
      sessionOwner.enteredIdle(session.userId(), sessionId);
    }
  }

  @Scheduled(fixedDelay = 1000)
  public void expire() {
    for (UUID sessionId : startups.expired()) {
      transaction.executeWithoutResult(
          status -> {
            var startup = startups.forSession(sessionId).orElseThrow(DomainException::notFound);
            if (!List.of("READY", "FAILED", "UNKNOWN").contains(startup.state())
                && !startup.deadline().isAfter(Instant.now())) {
              startups.failed(sessionId, null);
            }
          });
    }
  }

  @Transactional
  public Map<String, Object> permit(UUID workerId, UUID bootId, JsonNode request) {
    var startup =
        startups
            .forCommand(UUID.fromString(request.path("commandId").asString()))
            .orElseThrow(DomainException::notFound);
    var dispatch = startups.context(startup.sessionId());
    identities.lockActive(dispatch.userId());
    var task = commands.lockTask(dispatch.userId(), dispatch.taskId());
    requireWorker(workerId, bootId, dispatch);
    var scope = scope(dispatch);
    for (String field :
        List.of(
            "allocationEpoch",
            "controlEpoch",
            "pageEpoch",
            "privacyEpoch",
            "policyVersion",
            "instructionRevision")) {
      if (!request.path(field).isIntegralNumber()
          || !request.path(field).asString().equals(scope.get(field).toString())) {
        throw DomainException.conflict("STARTUP_FENCED", "Browser startup scope has changed");
      }
    }
    if (!authorized(startup, dispatch, task)
        || !startup.deadline().isAfter(Instant.now())
        || !request.path("browserSessionId").asString().equals(startup.sessionId().toString())
        || !request.path("attemptId").asString().equals(startup.attemptId().toString())
        || !request.path("actionDigest").asString().equals(startup.actionDigest())) {
      throw DomainException.conflict("STARTUP_FENCED", "Browser startup authorization changed");
    }
    policies.authorize(
        dispatch.userId(), "NAVIGATE", json.read(startup.action()).path("url").asString());
    UUID permitId = UUID.randomUUID();
    startups.started(startup.sessionId(), permitId);
    scope.put("permitId", permitId);
    scope.put("commandId", startup.navigationId());
    scope.put("attemptId", startup.attemptId());
    scope.put("actionDigest", startup.actionDigest());
    scope.put("deadline", startup.deadline());
    return scope;
  }

  @Transactional
  public UUID result(UUID workerId, UUID bootId, JsonNode result) {
    var startup =
        startups
            .forCommand(UUID.fromString(result.path("commandId").asString()))
            .orElseThrow(DomainException::notFound);
    var dispatch = startups.context(startup.sessionId());
    var task = commands.lockTask(dispatch.userId(), dispatch.taskId());
    requireWorker(workerId, bootId, dispatch);
    if (!result.path("attemptId").asString().equals(startup.attemptId().toString())
        || !result.path("browserSessionId").asString().equals(startup.sessionId().toString())) {
      throw new DomainException(403, "STARTUP_ATTEMPT_MISMATCH", "Startup attempt does not match");
    }
    json.verifyWorkerReceipt(result);
    String digest = result.path("digest").asString();
    if (startup.resultDigest() != null) {
      if (!Objects.equals(startup.resultDigest(), digest)) {
        throw DomainException.conflict(
            "RESULT_DIGEST_CONFLICT", "Startup already has a different receipt");
      }
      return null;
    }
    String status = result.path("status").asString();
    String effect = result.path("effectState").asString();
    if (!List.of("SUCCEEDED", "FAILED", "UNKNOWN").contains(status)
        || !List.of("NOT_STARTED", "CONFIRMED", "UNKNOWN").contains(effect)
        || status.equals("UNKNOWN") != effect.equals("UNKNOWN")) {
      throw new DomainException(422, "INVALID_RECEIPT", "Invalid startup receipt disposition");
    }
    if (!startup.state().equals("STARTED")
        || startup.permitId() == null
        || !status.equals("SUCCEEDED")
        || !effect.equals("CONFIRMED")
        || !identities.isActive(dispatch.userId())
        || !authorized(startup, dispatch, task)
        || !startup.deadline().isAfter(Instant.now())
        || result.path("allocationEpoch").asLong(-1) != dispatch.allocationEpoch()
        || result.path("controlEpoch").asLong(-1) != dispatch.controlEpoch()
        || result.path("privacyEpoch").asLong(-1) != dispatch.privacyEpoch()
        || result.path("pageEpoch").asLong(-1) < dispatch.pageEpoch()) {
      startups.failed(startup.sessionId(), digest);
      return null;
    }
    browsers.runtimeEpochs(workerId, bootId, startup.sessionId(), result);
    startups.ready(startup.sessionId(), digest);
    return startup.commandId();
  }

  private boolean authorized(
      BrowserStartupRepository.Startup startup,
      Context dispatch,
      CommandRepository.TaskAdmission task) {
    Instant now = Instant.now();
    boolean intent;
    if (startup.commandId() == null) {
      intent = opens.allocationAuthorized(startup.sessionId());
    } else {
      var command = commands.dispatch(startup.commandId());
      intent =
          List.of("STARTING", "QUEUED").contains(task.state())
              && !task.mutationBarrier()
              && task.instructionRevision() == command.instructionRevision()
              && commands.commandState(command.commandId()).equals("DISPATCHED")
              && commands.startAuthorization(command.commandId()).grantActive();
    }
    return intent
        && dispatch.sessionState().equals("STARTING")
        && dispatch.privacy().equals("NORMAL")
        && dispatch.controlOwner().equals("AGENT")
        && dispatch.controlState().equals("ACTIVE")
        && dispatch.leaseExpiresAt().isAfter(now)
        && dispatch.budgetDeadlineAt().isAfter(now);
  }

  private static void requireWorker(UUID workerId, UUID bootId, Context dispatch) {
    if (!workerId.equals(dispatch.workerId()) || !bootId.equals(dispatch.workerBootId())) {
      throw new DomainException(
          403, "WORKER_BINDING_MISMATCH", "Worker does not own this browser startup");
    }
  }

  public static Map<String, Object> scope(Context context) {
    Map<String, Object> scope = new LinkedHashMap<>();
    scope.put("taskId", context.taskId());
    scope.put("userId", context.userId());
    scope.put("browserSessionId", context.sessionId());
    scope.put("workerBootId", context.workerBootId());
    if (context.connectionId() != null) {
      scope.put("connectionId", context.connectionId());
      scope.put("scopeVersion", context.scopeVersion());
    }
    scope.put("allocationEpoch", context.allocationEpoch());
    scope.put("controlEpoch", context.controlEpoch());
    scope.put("pageEpoch", context.pageEpoch());
    scope.put("privacyEpoch", context.privacyEpoch());
    scope.put("policyVersion", context.policyVersion());
    scope.put("instructionRevision", context.instructionRevision());
    return scope;
  }
}
