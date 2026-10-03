package com.helmglass.task.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.api.MutationContext;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.task.api.ActionRequestContracts;
import com.helmglass.task.infrastructure.repository.ActionRequestRepository;
import java.time.Instant;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ActionRequestService {
  private final ActionRequestRepository requests;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final ConnectionService connections;
  private final ApplicationEventPublisher events;
  private final JsonSupport json;

  public ActionRequestService(ActionRequestRepository requests, IdentityRepository identities,
      OperationRepository operations, ConnectionService connections, ApplicationEventPublisher events, JsonSupport json) {
    this.requests = requests;
    this.identities = identities;
    this.operations = operations;
    this.connections = connections;
    this.events = events;
    this.json = json;
  }

  @Transactional
  public MutationReceipt answer(AuthenticatedActor actor, UUID id, ActionRequestContracts.Answer input,
      MutationContext context) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    var request = requests.lockOwned(actor.userId(), id);
    var replay = operations.replay(actor, "requests.answer:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(request.version(), input.expectedVersion());
    if (!request.status().equals("OPEN") || !request.expiresAt().isAfter(Instant.now())
        || !request.intentHash().equals(input.intentHash())) {
      throw DomainException.conflict("REQUEST_EXPIRED", "User request is no longer current");
    }
    if (request.kind().equals("CONFIRMATION") && actor.mcp()) {
      throw new DomainException(403, "HUMAN_CONFIRMATION_REQUIRED", "Agent cannot approve its own action");
    }
    if (request.kind().equals("LOGIN")) {
      throw DomainException.conflict("LOGIN_COMPLETION_REQUIRED", "Complete the private login workflow first");
    }
    var binding = json.read(request.context());
    if (binding.path("purpose").asString().equals("CONNECTION_SELECTION")) {
      if (!input.decision().equals("ANSWER") || input.selectedConnectionId() == null) {
        throw new DomainException(422, "CONNECTION_SELECTION_REQUIRED", "Choose one of the offered accounts");
      }
      boolean offered = false;
      for (var choice : binding.path("choices")) {
        if (input.selectedConnectionId().toString().equals(choice.path("id").asString())) {
          offered = true;
          break;
        }
      }
      if (!offered) {
        throw new DomainException(422, "CONNECTION_NOT_OFFERED", "The account is not part of this question");
      }
      connections.answerSelection(actor, request.taskId(), json.map(request.context()), input.selectedConnectionId());
    } else if (input.selectedConnectionId() != null) {
      throw new DomainException(422, "UNEXPECTED_CONNECTION", "This request does not select an account");
    }
    if (request.kind().equals("CONFIRMATION") && input.decision().equals("ANSWER")) {
      throw new DomainException(422, "DECISION_REQUIRED", "Approve or deny the requested action");
    }
    requests.answer(request, input);
    var receipt = operations.save(actor, "requests.answer:" + id, context, input, "actionRequest", id,
        request.version() + 1, true);
    events.publishEvent(new TaskContinuationService.Ready(request.taskId(), receipt.operationId(), null, "USER_RESPONSE"));
    return receipt;
  }
}
