package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.infrastructure.repository.BrowserOpenRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.usage.application.UsageProjectionService;
import com.helmglass.usage.application.UsageService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Explicit user intent to open one browser without resuming its task or taking human control. */
@Service
public class BrowserOpenService {
  private static final String KIND = "browser.open";
  private final BrowserRepository browsers;
  private final BrowserOpenRepository opens;
  private final BrowserAllocationService allocator;
  private final CommandRepository commands;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final ChangeRepository changes;
  private final UsageService usage;
  private final UsageProjectionService projections;

  public BrowserOpenService(
      BrowserRepository browsers,
      BrowserOpenRepository opens,
      BrowserAllocationService allocator,
      CommandRepository commands,
      IdentityRepository identities,
      OperationRepository operations,
      ChangeRepository changes,
      UsageService usage,
      UsageProjectionService projections) {
    this.browsers = browsers;
    this.opens = opens;
    this.allocator = allocator;
    this.commands = commands;
    this.identities = identities;
    this.operations = operations;
    this.changes = changes;
    this.usage = usage;
    this.projections = projections;
  }

  @Transactional
  public MutationReceipt open(
      AuthenticatedActor actor, UUID taskId, BrowserContracts.Open input, MutationContext context) {
    if (actor.mcp()) {
      throw new DomainException(
          403, "WEB_LOGIN_REQUIRED", "Explicit browser opening requires web login");
    }
    identities.lockActive(actor.userId());
    var task = commands.lockTask(actor.userId(), taskId);
    var payload = Map.of("taskId", taskId, "input", input);
    var replay = operations.replay(actor, KIND, context, payload);
    if (replay.isPresent()) {
      return replay.get();
    }
    var binding = browsers.binding(taskId);
    if (binding.isPresent()) {
      var session = binding.get();
      if (input.observedPreviousSessionId() != null
          && !session.id().equals(input.observedPreviousSessionId())) {
        throw DomainException.conflict("STALE_BROWSER_BINDING", "Read the current browser binding");
      }
      if (!List.of("REQUESTED", "STARTING", "ACTIVE", "RECOVERING").contains(session.state())) {
        throw DomainException.conflict(
            "BROWSER_CLEANUP_PENDING", "Previous runtime closure is not confirmed");
      }
      if (!session.savePolicy().equals(input.savePolicy())
          || task.mutationBarrier()
          || List.of("COMPLETED", "FAILED", "CANCELLED", "STOPPING").contains(task.state())) {
        throw DomainException.conflict(
            "BROWSER_OPEN_CONFLICT", "Existing browser parameters or task state differ");
      }
      var existing = opens.existingOperation(session.id());
      if (existing.isPresent()) {
        return operations.bindExisting(
            actor,
            KIND,
            context,
            payload,
            existing.get(),
            "browserSession",
            session.id(),
            session.version());
      }
      return operations.save(
          actor,
          KIND,
          context,
          payload,
          "browserSession",
          session.id(),
          session.version(),
          session.state().equals("ACTIVE"));
    }
    requireTask(task.state(), task.mutationBarrier());
    DomainException.requireVersion(task.version(), input.expectedVersion());
    var previous = opens.previousSession(taskId);
    if (previous.isPresent()
        && (!input.consentNewBrowser()
            || !Objects.equals(previous.get(), input.observedPreviousSessionId()))) {
      throw DomainException.conflict(
          "NEW_BROWSER_CONSENT_REQUIRED", "Confirm loss of the previous browser context");
    }
    if (previous.isEmpty() && input.observedPreviousSessionId() != null) {
      throw DomainException.conflict(
          "STALE_BROWSER_BINDING", "The observed browser does not belong to this task");
    }
    usage.remainingBrowserSeconds(taskId);
    UUID sessionId = UUID.randomUUID();
    Instant deadline = Instant.now().plusSeconds(120);
    var receipt =
        operations.save(actor, KIND, context, payload, "browserSession", sessionId, 1, false);
    browsers.request(sessionId, actor.userId(), taskId, "TASK", deadline);
    projections.refresh(actor.userId(), taskId);
    opens.prepare(
        sessionId, receipt.operationId(), task.instructionRevision(), deadline, input.savePolicy());
    changes.changed(actor.userId(), "tasks", taskId, task.version());
    return receipt;
  }

  public List<UUID> pending() {
    return opens.due();
  }

  @Transactional
  public Optional<BrowserAllocationService.OpenAllocation> advance(UUID sessionId) {
    var intent = opens.request(sessionId);
    if (intent.isEmpty()) {
      reconcileReuse(sessionId);
      return Optional.empty();
    }
    var request = intent.get();
    boolean active = identities.lockState(request.userId()).equals("ACTIVE");
    var task = commands.lockTask(request.userId(), request.taskId());
    if (!List.of("PENDING", "RUNNING").contains(request.operationState())) {
      return Optional.empty();
    }
    var session = browsers.owned(request.userId(), sessionId);
    if (active && session.state().equals("ACTIVE")) {
      ready(sessionId);
      return Optional.empty();
    }
    if (!active
        || !request.deadline().isAfter(Instant.now())
        || !canOpen(task.state(), task.mutationBarrier())
        || task.instructionRevision() != request.instructionRevision()
        || !List.of("REQUESTED", "STARTING", "RECOVERING").contains(session.state())) {
      opens.finish(sessionId, "FAILED", "BROWSER_OPEN_FENCED");
      changes.changed(request.userId(), "tasks", request.taskId(), task.version());
      return Optional.empty();
    }
    opens.waitForResource(sessionId, null);
    if (!session.state().equals("REQUESTED")) {
      return Optional.empty();
    }
    return allocator.allocateOpen(session, task.startUrl(), request.deadline());
  }

  private void reconcileReuse(UUID sessionId) {
    var pending = opens.pendingReuse(sessionId);
    if (pending.isEmpty()) {
      return;
    }
    var request = pending.get();
    boolean active = identities.lockState(request.userId()).equals("ACTIVE");
    commands.lockTask(request.userId(), request.taskId());
    var session = browsers.owned(request.userId(), sessionId);
    if (active && session.state().equals("ACTIVE")) {
      ready(sessionId);
    } else if (!active
        || !List.of("STARTING", "RECOVERING").contains(session.state())
        || !request.deadline().isAfter(Instant.now())) {
      opens.failReuse(sessionId, "BROWSER_OPEN_UNAVAILABLE");
      changes.changed(request.userId(), "tasks", request.taskId(), session.version());
    } else {
      opens.waitForResource(sessionId, null);
    }
  }

  @Transactional
  public void ready(UUID sessionId) {
    var session = opens.activeSession(sessionId);
    if (session.isEmpty()) {
      return;
    }
    opens.finish(sessionId, "SUCCEEDED", null);
    operations.completeForTarget(sessionId, KIND);
    changes.changed(
        session.get().userId(), "tasks", session.get().taskId(), session.get().version());
  }

  public boolean allocationAuthorized(UUID sessionId) {
    var request = opens.request(sessionId);
    return request.isPresent() && allocationAuthorized(request.get());
  }

  public boolean launchAuthorized(UUID sessionId, String taskState) {
    var request = opens.request(sessionId);
    return request.isPresent()
        ? allocationAuthorized(request.get())
        : List.of("QUEUED", "STARTING").contains(taskState);
  }

  private boolean allocationAuthorized(BrowserOpenRepository.Request intent) {
    var task = commands.lockTask(intent.userId(), intent.taskId());
    return List.of("PENDING", "RUNNING").contains(intent.operationState())
        && intent.deadline().isAfter(Instant.now())
        && intent.instructionRevision() == task.instructionRevision()
        && canOpen(task.state(), task.mutationBarrier());
  }

  private static boolean canOpen(String state, boolean barrier) {
    return !barrier && List.of("QUEUED", "WAITING_AGENT", "WAITING_USER", "PAUSED").contains(state);
  }

  private static void requireTask(String state, boolean barrier) {
    if (!canOpen(state, barrier)) {
      throw DomainException.conflict(
          "BROWSER_OPEN_UNAVAILABLE", "Resolve the task state before opening a browser");
    }
  }
}
