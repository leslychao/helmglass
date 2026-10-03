package com.helmglass.task.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.domain.TaskAggregate;
import com.helmglass.task.domain.TaskState;
import com.helmglass.task.infrastructure.repository.JpaTaskRepository;
import com.helmglass.task.infrastructure.repository.TaskQueries;
import com.helmglass.usage.application.UsageProjectionService;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TaskLifecycleService {
  private final JpaTaskRepository tasks;
  private final TaskQueries queries;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final ChangeRepository changes;
  private final TaskContinuationService continuations;
  private final ApplicationEventPublisher events;
  private final UsageProjectionService usage;

  public TaskLifecycleService(
      JpaTaskRepository tasks,
      TaskQueries queries,
      IdentityRepository identities,
      OperationRepository operations,
      ChangeRepository changes,
      TaskContinuationService continuations,
      ApplicationEventPublisher events,
      UsageProjectionService usage) {
    this.tasks = tasks;
    this.queries = queries;
    this.identities = identities;
    this.operations = operations;
    this.changes = changes;
    this.continuations = continuations;
    this.events = events;
    this.usage = usage;
  }

  @Transactional
  public MutationReceipt create(
      AuthenticatedActor actor,
      TaskContracts.Create input,
      MutationContext context,
      HostConversationContext host) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    var replay = operations.replay(actor, "tasks.create", context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    MutationReceipt receipt = createTask(actor, input, context, "tasks.create", input);
    continuations.registerOrigin(actor, host, receipt.resource().id());
    return receipt;
  }

  private MutationReceipt createTask(
      AuthenticatedActor actor,
      TaskContracts.Create input,
      MutationContext context,
      String kind,
      Object payload) {
    TaskAggregate task =
        new TaskAggregate(
            actor.userId(),
            queries.nextDisplayNumber(),
            input.goal(),
            input.startUrl(),
            queries.site(actor.userId(), input.startUrl()),
            input.outputFormat(),
            input.confirmImportantActions(),
            input.browserTimeLimitSeconds(),
            actor.mcp() ? "MCP" : "ANGULAR");
    if (input.intent().equals("PREPARE")) {
      queries.checkQueueAdmission(actor.userId());
      task.prepare();
    }
    tasks.saveAndFlush(task);
    queries.setConnections(actor.userId(), task.getId(), input.connectionIds());
    usage.refresh(actor.userId(), task.getId());
    return changed(actor, task, kind, payload, context, true, "Task created");
  }

  @Transactional(readOnly = true)
  public TaskContracts.TaskView get(AuthenticatedActor actor, UUID id) {
    actor.requireScope("tasks:read");
    return queries.view(owned(actor, id));
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public PageResult<Map<String, Object>> list(AuthenticatedActor actor, PageQuery query) {
    actor.requireScope("tasks:read");
    return queries.list(actor.userId(), query);
  }

  @Transactional(readOnly = true)
  public Map<String, Long> summary(AuthenticatedActor actor) {
    return queries.summary(actor.userId());
  }

  @Transactional
  public MutationReceipt edit(
      AuthenticatedActor actor, UUID id, TaskContracts.Edit input, MutationContext context) {
    TaskAggregate task = lock(actor, id);
    var replay = operations.replay(actor, "tasks.edit:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(task.getVersion(), input.expectedVersion());
    task.edit(
        input.goal(),
        input.startUrl(),
        queries.site(actor.userId(), input.startUrl()),
        input.outputFormat(),
        input.confirmImportantActions(),
        input.browserTimeLimitSeconds());
    queries.setConnections(actor.userId(), id, input.connectionIds());
    return changed(actor, task, "tasks.edit:" + id, input, context, true, "Draft updated");
  }

  @Transactional
  public MutationReceipt prepare(
      AuthenticatedActor actor,
      UUID id,
      TaskContracts.ExpectedVersion input,
      MutationContext context) {
    TaskAggregate task = lock(actor, id);
    var replay = operations.replay(actor, "tasks.prepare:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(task.getVersion(), input.expectedVersion());
    queries.checkQueueAdmission(actor.userId());
    task.prepare();
    return changed(actor, task, "tasks.prepare:" + id, input, context, true, "Waiting for ChatGPT");
  }

  @Transactional
  public MutationReceipt pause(AuthenticatedActor actor, UUID id, MutationContext context) {
    TaskAggregate task = lock(actor, id);
    var input = Map.of("taskId", id);
    var replay = operations.replay(actor, "tasks.pause:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    boolean outstanding = queries.outstanding(id);
    continuations.cancel(id);
    task.pause(outstanding);
    events.publishEvent(new TaskContinuationService.Consent(id, false));
    return changed(
        actor, task, "tasks.pause:" + id, input, context, !outstanding, "Pause requested");
  }

  @Transactional
  public MutationReceipt resume(
      AuthenticatedActor actor, UUID id, TaskContracts.Resume input, MutationContext context) {
    TaskAggregate task = lock(actor, id);
    var replay = operations.replay(actor, "tasks.resume:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(task.getVersion(), input.expectedTaskVersion());
    if (queries.outstanding(id)) {
      throw DomainException.conflict("COMMAND_OUTSTANDING", "A command is still outstanding");
    }
    task.resume(queries.resolved(id, input.resolutionId()));
    var receipt = changed(actor, task, "tasks.resume:" + id, input, context, true, "Task resumed");
    events.publishEvent(new TaskContinuationService.Consent(id, true));
    events.publishEvent(
        new TaskContinuationService.Ready(id, receipt.operationId(), null, "EXPLICIT_RESUME"));
    return receipt;
  }

  @Transactional
  public MutationReceipt stop(AuthenticatedActor actor, UUID id, MutationContext context) {
    TaskAggregate task = lock(actor, id);
    var input = Map.of("taskId", id);
    var replay = operations.replay(actor, "tasks.stop:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    boolean resources = queries.resources(id);
    queries.cancelUnstarted(id, "TASK_STOPPED");
    continuations.cancel(id);
    task.stop(resources);
    return changed(actor, task, "tasks.stop:" + id, input, context, !resources, "Stop requested");
  }

  @Transactional
  public MutationReceipt clarify(
      AuthenticatedActor actor,
      UUID id,
      TaskContracts.Clarification input,
      MutationContext context) {
    TaskAggregate task = lock(actor, id);
    var replay = operations.replay(actor, "tasks.clarify:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(task.getVersion(), input.expectedTaskVersion());
    DomainException.requireVersion(
        task.getInstructionRevision(), input.expectedInstructionRevision());
    UUID started = queries.startedCommand(id);
    continuations.cancel(id);
    queries.cancelUnstarted(id, "INSTRUCTION_SUPERSEDED");
    task.clarify();
    String disposition;
    if (task.isMutationBarrier()) {
      disposition = "REQUIRES_RECONCILIATION";
    } else {
      disposition = started == null ? "READY" : "AFTER_COMMAND";
    }
    queries.clarification(task, input.clarificationId(), input.text(), started, disposition);
    return changed(
        actor, task, "tasks.clarify:" + id, input, context, true, "Clarification accepted");
  }

  @Transactional
  public MutationReceipt complete(
      AuthenticatedActor actor, UUID id, TaskContracts.Completion input, MutationContext context) {
    actor.requireScope("results:write");
    TaskAggregate task = lock(actor, id);
    var replay = operations.replay(actor, "tasks.complete:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(task.getVersion(), input.expectedTaskVersion());
    if (queries.outstanding(id)) {
      throw DomainException.conflict("COMMAND_OUTSTANDING", "A command is still outstanding");
    }
    DomainException.requireVersion(task.getInstructionRevision(), input.instructionRevision());
    continuations.consume(actor, id, task.getInstructionRevision(), input.continuationClaimId());
    queries.verifyFinalResult(id, input.resultId(), input.resultRevision());
    task.complete(input.outcome());
    return changed(actor, task, "tasks.complete:" + id, input, context, true, "Task completed");
  }

  @Transactional(readOnly = true)
  public Map<String, Object> clarifications(
      AuthenticatedActor actor, UUID id, long after, int limit) {
    TaskAggregate task = owned(actor, id);
    if (limit < 1 || limit > 100) {
      throw new DomainException(400, "INVALID_LIMIT", "Limit must be between 1 and 100");
    }
    List<Map<String, Object>> rows = queries.clarifications(id, after, limit + 1);
    return Map.of(
        "items",
        rows.stream().limit(limit).toList(),
        "hasMore",
        rows.size() > limit,
        "currentInstructionRevision",
        task.getInstructionRevision());
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public PageResult<Map<String, Object>> events(
      AuthenticatedActor actor, UUID id, PageQuery query) {
    owned(actor, id);
    return queries.events(actor.userId(), id, query);
  }

  @Transactional
  public MutationReceipt delete(AuthenticatedActor actor, UUID id, MutationContext context) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    var input = Map.of("taskId", id);
    var replay = operations.replay(actor, "tasks.delete:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    var task = lock(actor, id);
    task.requireState(TaskState.DRAFT);
    queries.deleteDraft(id);
    tasks.delete(task);
    tasks.flush();
    changes.changed(actor.userId(), "tasks", id, task.getVersion() + 1);
    return operations.save(
        actor, "tasks.delete:" + id, context, input, "task", id, task.getVersion() + 1, true);
  }

  @Transactional
  public MutationReceipt copy(AuthenticatedActor actor, UUID id, MutationContext context) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    var input = Map.of("sourceTaskId", id);
    var replay = operations.replay(actor, "tasks.copy:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    TaskAggregate source = owned(actor, id);
    return createTask(
        actor,
        new TaskContracts.Create(
            source.getGoal(),
            source.getStartUrl(),
            queries.connections(id),
            source.getOutputFormat(),
            source.isConfirmImportantActions(),
            source.getBrowserTimeLimitSeconds(),
            "DRAFT"),
        context,
        "tasks.copy:" + id,
        input);
  }

  @Transactional
  public void scheduleAccountStop(UUID userId, UUID operationId) {
    queries.enqueueStops(userId, operationId);
  }

  public List<TaskQueries.StopTarget> pendingStops() {
    return queries.pendingStops();
  }

  @Transactional
  public void processStop(TaskQueries.StopTarget target) {
    var task =
        tasks.lockOwned(target.taskId(), target.userId()).orElseThrow(DomainException::notFound);
    queries.cancelUnstarted(task.getId(), "ADMIN_STOP");
    task.stop(queries.resources(task.getId()));
    tasks.flush();
    queries.stopRequested(target);
    changes.changed(target.userId(), "tasks", target.taskId(), task.getVersion());
  }

  private TaskAggregate owned(AuthenticatedActor actor, UUID id) {
    return tasks.findByIdAndUserId(id, actor.userId()).orElseThrow(DomainException::notFound);
  }

  private TaskAggregate lock(AuthenticatedActor actor, UUID id) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    return tasks.lockOwned(id, actor.userId()).orElseThrow(DomainException::notFound);
  }

  private MutationReceipt changed(
      AuthenticatedActor actor,
      TaskAggregate task,
      String kind,
      Object input,
      MutationContext context,
      boolean complete,
      String summary) {
    tasks.flush();
    int separator = kind.indexOf(':');
    queries.event(task, "SYSTEM", separator < 0 ? kind : kind.substring(0, separator), summary);
    changes.changed(actor.userId(), "tasks", task.getId(), task.getVersion());
    return operations.save(
        actor, kind, context, input, "task", task.getId(), task.getVersion(), complete);
  }
}
