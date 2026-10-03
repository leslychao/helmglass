package com.helmglass.command.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.domain.BrowserLocation;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.command.api.CommandContracts;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.application.ReconciliationService;
import com.helmglass.usage.application.UsageProjectionService;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

@Service
public class CommandExecutionService {
  private static final Set<String> READ_ONLY = Set.of("OBSERVE", "WAIT_FOR", "READ_MEDIA");
  private final CommandRepository commands;
  private final IdentityRepository identities;
  private final UserPolicyService policies;
  private final OperationRepository operations;
  private final ChangeRepository changes;
  private final JsonSupport json;
  private final WorkerProtocol protocol;
  private final TaskContinuationService continuations;
  private final ApplicationEventPublisher events;
  private final ReconciliationService reconciliation;
  private final BrowserRepository browsers;
  private final ConnectionService connections;
  private final UsageProjectionService usage;

  public CommandExecutionService(
      CommandRepository commands,
      IdentityRepository identities,
      UserPolicyService policies,
      OperationRepository operations,
      ChangeRepository changes,
      JsonSupport json,
      WorkerProtocol protocol,
      TaskContinuationService continuations,
      ApplicationEventPublisher events,
      ReconciliationService reconciliation,
      BrowserRepository browsers,
      ConnectionService connections,
      UsageProjectionService usage) {
    this.commands = commands;
    this.identities = identities;
    this.policies = policies;
    this.operations = operations;
    this.changes = changes;
    this.json = json;
    this.protocol = protocol;
    this.continuations = continuations;
    this.events = events;
    this.reconciliation = reconciliation;
    this.browsers = browsers;
    this.connections = connections;
    this.usage = usage;
  }

  @Transactional
  public MutationReceipt accept(
      AuthenticatedActor actor,
      UUID taskId,
      CommandContracts.Submit input,
      MutationContext context,
      HostConversationContext host) {
    actor.requireScope("browser:execute");
    identities.lockActive(actor.userId());
    var task = commands.lockTask(actor.userId(), taskId);
    var replay = operations.replay(actor, "commands.accept:" + taskId, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(task.version(), input.expectedTaskVersion());
    DomainException.requireVersion(task.instructionRevision(), input.instructionRevision());
    String kind = input.action().path("type").asString();
    protocol.validateAction(input.action());
    boolean readOnly = READ_ONLY.contains(kind);
    if ((!task.state().equals("WAITING_AGENT") && !(task.state().equals("INTERRUPTED") && readOnly))
        || (task.mutationBarrier() && !readOnly)) {
      throw DomainException.conflict("TASK_NOT_READY", "Task does not permit this command");
    }
    if (commands.outstanding(taskId)) {
      throw DomainException.conflict("COMMAND_OUTSTANDING", "Another command is outstanding");
    }
    commands.verifyBinding(taskId, input, readOnly);
    policies.authorize(
        actor.userId(),
        kind,
        input.action().has("url") ? input.action().get("url").asString() : null);
    if (browsers.binding(taskId).isEmpty()) {
      connections.forBrowser(
          actor.userId(),
          taskId,
          input.action().has("url") ? input.action().path("url").asString() : task.startUrl());
    }
    String digest = json.workerDigest(input.action());
    boolean confirmationNeeded =
        !readOnly
            && (task.confirmImportantActions()
                || policies.getForExecution(actor.userId()).requireConfirmationBeforeChanges())
            && Set.of("CLICK", "FILL", "SELECT", "PRESS").contains(kind)
            && !commands.hasApproval(taskId, input.intentId(), digest);
    Instant deadline = input.deadline() == null ? Instant.now().plusSeconds(60) : input.deadline();
    if (!deadline.isAfter(Instant.now()) || deadline.isAfter(Instant.now().plusSeconds(300))) {
      throw new DomainException(
          422, "INVALID_DEADLINE", "Command deadline must be within five minutes");
    }
    continuations.consume(actor, taskId, task.instructionRevision(), input.continuationClaimId());
    continuations.admitExecution(actor, host, taskId);
    commands.insert(actor, taskId, input, kind, digest, deadline);
    continuations.waitForResult(taskId, null, input.commandId(), "ASYNC_RESULT_READY");
    usage.refresh(actor.userId(), taskId);
    if (confirmationNeeded) {
      commands.requireConfirmation(taskId, input.commandId(), digest);
    }
    changes.changed(actor.userId(), "tasks", taskId, task.version() + 1);
    return operations.save(
        actor, "commands.accept:" + taskId, context, input, "command", input.commandId(), 1, false);
  }

  public Map<String, Object> get(AuthenticatedActor actor, UUID id) {
    actor.requireScope("tasks:read");
    return commands.get(actor.userId(), id);
  }

  @Transactional
  public Map<String, Object> start(UUID workerId, UUID bootId, JsonNode request) {
    UUID commandId = UUID.fromString(request.path("commandId").asString());
    var dispatch = commands.dispatch(commandId);
    identities.lockActive(dispatch.userId());
    var task = commands.lockTask(dispatch.userId(), dispatch.taskId());
    String state = commands.commandState(commandId);
    if (!workerId.equals(dispatch.workerId())
        || !bootId.equals(dispatch.workerBootId())
        || !request.path("attemptId").asString().equals(dispatch.attemptId().toString())
        || !request.path("actionDigest").asString().equals(dispatch.payloadHash())
        || !dispatch.deadline().isAfter(Instant.now())
        || task.instructionRevision() != dispatch.instructionRevision()
        || !List.of("QUEUED", "STARTING").contains(task.state())
        || !state.equals("DISPATCHED")) {
      throw DomainException.conflict("START_PERMIT_DENIED", "Execution permit is no longer valid");
    }
    var authorization = commands.startAuthorization(commandId);
    if (!authorization.controlOwner().equals("AGENT")
        || !authorization.controlState().equals("ACTIVE")
        || !authorization.sessionState().equals("ACTIVE")
        || !authorization.privacy().equals("NORMAL")
        || !authorization.leaseExpiresAt().isAfter(Instant.now())
        || !authorization.budgetDeadlineAt().isAfter(Instant.now())
        || !authorization.grantActive()
        || request.path("allocationEpoch").asLong(-1) != dispatch.allocationEpoch()
        || request.path("controlEpoch").asLong(-1) != dispatch.controlEpoch()
        || request.path("pageEpoch").asLong(-1) != dispatch.pageEpoch()
        || request.path("privacyEpoch").asLong(-1) != dispatch.privacyEpoch()
        || request.path("policyVersion").asLong(-1) != dispatch.policyVersion()
        || !request.path("browserSessionId").asString().equals(dispatch.sessionId().toString())) {
      throw DomainException.conflict(
          "START_PERMIT_DENIED", "Execution authorization changed before start");
    }
    JsonNode action = json.read(dispatch.payload());
    if (task.mutationBarrier() && !READ_ONLY.contains(action.path("type").asString())) {
      throw DomainException.conflict(
          "UNKNOWN_EFFECT", "Resolve the previous effect before mutation");
    }
    if (authorization.commandLimit() != null
            && authorization.startedCommands() >= authorization.commandLimit()
        || authorization.executionLimit() != null
            && authorization.executionMs() >= authorization.executionLimit() * 1000L) {
      throw DomainException.conflict(
          "TASK_LIMIT_REACHED", "The configured task execution limit is reached");
    }
    policies.authorize(
        dispatch.userId(),
        action.path("type").asString(),
        action.has("url") ? action.path("url").asString() : null);
    UUID permitId = UUID.randomUUID();
    commands.started(commandId, dispatch.attemptId(), permitId);
    Map<String, Object> permit = scope(dispatch);
    permit.put("permitId", permitId);
    permit.put("commandId", commandId);
    permit.put("attemptId", dispatch.attemptId());
    permit.put("actionDigest", dispatch.payloadHash());
    permit.put("deadline", dispatch.deadline());
    return permit;
  }

  @Transactional
  public void acceptResult(UUID workerId, UUID bootId, JsonNode result) {
    UUID commandId = UUID.fromString(result.path("commandId").asString());
    var dispatch = commands.dispatch(commandId);
    commands.lockTask(dispatch.userId(), dispatch.taskId());
    if (!workerId.equals(dispatch.workerId())
        || !bootId.equals(dispatch.workerBootId())
        || !result.path("attemptId").asString().equals(dispatch.attemptId().toString())) {
      throw new DomainException(403, "WORKER_BINDING_MISMATCH", "Worker does not own the attempt");
    }
    json.verifyWorkerReceipt(result);
    String digest = result.path("digest").asString();
    String existing = commands.resultDigest(dispatch.attemptId());
    if (existing != null) {
      if (!existing.equals(digest)) {
        throw DomainException.conflict(
            "RESULT_DIGEST_CONFLICT", "Attempt already has another receipt");
      }
      return;
    }
    String status = result.path("status").asString();
    String effect = result.path("effectState").asString();
    if (!Set.of("SUCCEEDED", "FAILED", "UNKNOWN").contains(status)
        || !Set.of("CONFIRMED", "NOT_STARTED", "UNKNOWN").contains(effect)
        || (status.equals("UNKNOWN") != effect.equals("UNKNOWN"))) {
      throw new DomainException(422, "INVALID_RECEIPT", "Invalid attempt disposition");
    }
    browsers.runtimeEpochs(workerId, bootId, dispatch.sessionId(), result);
    if (result.has("observation")) {
      String url = observedLocation(result);
      browsers.observedLocation(workerId, bootId, dispatch.sessionId(), result, url);
    }
    commands.result(dispatch, status, effect, digest, result);
    dispositionChanged(dispatch.userId(), dispatch.taskId(), commandId);
  }

  /** Publishes a durable terminal command disposition, including recovery without a receipt. */
  @Transactional
  public void dispositionChanged(UUID userId, UUID taskId, UUID commandId) {
    var task = commands.lockTask(userId, taskId);
    String status = commands.commandState(commandId);
    String operationState =
        switch (status) {
          case "SUCCEEDED" -> "SUCCEEDED";
          case "FAILED" -> "FAILED";
          case "UNKNOWN" -> "NEEDS_ATTENTION";
          default ->
              throw DomainException.conflict(
                  "COMMAND_NOT_TERMINAL", "Command disposition is not final");
        };
    if (status.equals("UNKNOWN")) {
      reconciliation.unknownCommand(userId, taskId, commandId);
    }
    changes.changed(userId, "tasks", taskId, task.version());
    operations.completeCommandTarget(commandId, "commands.accept:" + taskId, operationState);
    events.publishEvent(
        new TaskContinuationService.Ready(taskId, null, commandId, "ASYNC_RESULT_READY"));
  }

  public static Map<String, Object> scope(CommandRepository.Dispatch dispatch) {
    Map<String, Object> scope = new LinkedHashMap<>();
    scope.put("taskId", dispatch.taskId());
    scope.put("userId", dispatch.userId());
    scope.put("browserSessionId", dispatch.sessionId());
    scope.put("workerBootId", dispatch.workerBootId());
    if (dispatch.connectionId() != null) {
      scope.put("connectionId", dispatch.connectionId());
      scope.put("scopeVersion", dispatch.scopeVersion());
    }
    scope.put("allocationEpoch", dispatch.allocationEpoch());
    scope.put("controlEpoch", dispatch.controlEpoch());
    scope.put("pageEpoch", dispatch.pageEpoch());
    scope.put("privacyEpoch", dispatch.privacyEpoch());
    scope.put("policyVersion", dispatch.policyVersion());
    scope.put("instructionRevision", dispatch.instructionRevision());
    return scope;
  }

  private static String observedLocation(JsonNode result) {
    JsonNode observation = result.path("observation");
    for (String field :
        List.of("taskId", "browserSessionId", "pageEpoch", "controlEpoch", "privacyEpoch")) {
      if (!observation.path(field).equals(result.path(field))) {
        throw new DomainException(
            422, "OBSERVATION_BINDING_MISMATCH", "Observation belongs to another runtime state");
      }
    }
    return BrowserLocation.safe(observation.path("url").asString());
  }
}
