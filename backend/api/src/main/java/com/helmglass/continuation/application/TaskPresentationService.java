package com.helmglass.continuation.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.task.application.TaskLifecycleService;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Owns the link-only presentation until the host correlation contract passes client acceptance. */
@Service
public class TaskPresentationService {
  private final TaskLifecycleService tasks;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final String origin;

  public TaskPresentationService(TaskLifecycleService tasks, IdentityRepository identities,
      OperationRepository operations, @Value("${helm.public-origin}") String origin) {
    this.tasks = tasks;
    this.identities = identities;
    this.operations = operations;
    this.origin = origin;
  }

  @Transactional
  public Map<String, Object> view(AuthenticatedActor actor, UUID taskId, UUID scope,
      long expectedRevision, MutationContext context) {
    actor.requireScope("browser:view");
    identities.lockActive(actor.userId());
    var task = tasks.get(actor, taskId);
    Map<String, Object> input = new HashMap<>();
    input.put("taskId", taskId);
    input.put("viewScopeId", scope);
    input.put("expectedPresentationRevision", expectedRevision);
    var receipt = operations.replay(actor, "tasks.view:" + taskId, context, input)
        .orElseGet(() -> operations.save(actor, "tasks.view:" + taskId, context, input,
            "task", taskId, task.version(), true));
    return Map.of("receipt", receipt, "presentation", presentation(taskId, task.title()));
  }

  public Map<String, Object> attach(AuthenticatedActor actor, UUID taskId) {
    actor.requireScope("browser:view");
    var task = tasks.get(actor, taskId);
    Map<String, Object> snapshot = new HashMap<>();
    snapshot.put("presentation", presentation(taskId, task.title()));
    snapshot.put("session", null);
    snapshot.put("continuation", task.continuation());
    return snapshot;
  }

  public Map<String, Object> presentation(UUID taskId, String title) {
    Map<String, Object> result = new HashMap<>();
    result.put("taskId", taskId);
    result.put("taskUrl", origin + "/tasks/" + taskId);
    result.put("summary", title);
    result.put("viewScopeId", null);
    result.put("presentationRevision", 0);
    result.put("presentationState", "LINK_ONLY");
    result.put("reason", "HOST_CORRELATION_NOT_VERIFIED");
    result.put("automaticContinuationAvailable", false);
    return result;
  }

  public Map<String, Object> prepareMessage(AuthenticatedActor actor, UUID taskId) {
    tasks.get(actor, taskId);
    throw DomainException.conflict("AUTOMATIC_CONTINUATION_UNAVAILABLE",
        "The current host conversation binding has not been verified");
  }
}
