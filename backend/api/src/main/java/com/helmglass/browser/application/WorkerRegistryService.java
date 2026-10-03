package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository.Claim;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository.CommandDisposition;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.application.TaskLifecycleService;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

@Service
public class WorkerRegistryService {
  private final WorkerRegistryRepository workers;
  private final WorkerProtocol protocol;
  private final JsonSupport json;
  private final ControlRepository controls;
  private final CommandExecutionService commands;
  private final BrowserOpenService opens;
  private final ChangeRepository changes;
  private final TaskLifecycleService tasks;
  private final ApplicationEventPublisher events;

  public WorkerRegistryService(
      WorkerRegistryRepository workers,
      WorkerProtocol protocol,
      JsonSupport json,
      ControlRepository controls,
      CommandExecutionService commands,
      BrowserOpenService opens,
      ChangeRepository changes,
      TaskLifecycleService tasks,
      ApplicationEventPublisher events) {
    this.workers = workers;
    this.protocol = protocol;
    this.json = json;
    this.controls = controls;
    this.commands = commands;
    this.opens = opens;
    this.changes = changes;
    this.tasks = tasks;
    this.events = events;
  }

  public record StoppedAllocation(UUID sessionId, long allocationEpoch, UUID runtimeGeneration) {
    public StoppedAllocation {
      if (sessionId == null || allocationEpoch <= 0) {
        throw invalidStoppedProof();
      }
    }
  }

  /** Operator evidence of a later incarnation of the exact Docker container. */
  public record StoppedWorkerProof(
      String installationId,
      UUID engineId,
      String containerId,
      Instant previousStartedAt,
      int previousRestartCount,
      Instant observedStartedAt,
      int observedRestartCount,
      UUID workerId,
      UUID bootId,
      List<StoppedAllocation> allocations) {
    public StoppedWorkerProof {
      if (installationId == null
          || !installationId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
          || engineId == null
          || containerId == null
          || !containerId.matches("[a-f0-9]{64}")
          || previousStartedAt == null
          || observedStartedAt == null
          || !observedStartedAt.isAfter(previousStartedAt)
          || previousRestartCount < 0
          || observedRestartCount <= previousRestartCount
          || workerId == null
          || bootId == null
          || allocations == null
          || allocations.isEmpty()
          || allocations.size() > 256) {
        throw invalidStoppedProof();
      }
      Set<UUID> unique = new HashSet<>();
      for (StoppedAllocation allocation : allocations) {
        if (allocation == null || !unique.add(allocation.sessionId())) {
          throw invalidStoppedProof();
        }
      }
      allocations = List.copyOf(allocations);
    }
  }

  /**
   * Releases only exact bindings whose stopped process incarnation was verified by the operator.
   * The caller validates installation/engine/container evidence and revokes enrollment in this same
   * transaction. This is physical closure evidence, not evidence of any external command result.
   */
  @Transactional(propagation = Propagation.MANDATORY)
  public int confirmStopped(StoppedWorkerProof proof) {
    if (proof == null || proof.observedStartedAt().isAfter(Instant.now())) {
      throw invalidStoppedProof();
    }
    List<UUID> sessionIds = proof.allocations().stream().map(StoppedAllocation::sessionId).toList();
    List<Claim> supplied = workers.claimsBySessionIds(sessionIds);
    List<Claim> unresolved = workers.claims(proof.workerId());
    List<Claim> subjects = new ArrayList<>(supplied);
    subjects.addAll(unresolved);
    workers.lockSubjects(subjects);
    var worker = workers.lockWorker(proof.workerId()).orElseThrow(DomainException::notFound);
    if (!worker.bootId().equals(proof.bootId())
        || !worker.observedState().equals("OFFLINE")
        || worker.registeredAt().isBefore(proof.previousStartedAt())
        || !worker.registeredAt().isBefore(proof.observedStartedAt())
        || !worker.heartbeatAt().isBefore(proof.observedStartedAt())) {
      throw DomainException.conflict(
          "STOPPED_WORKER_MISMATCH", "Worker is not the stopped incarnation");
    }
    supplied = workers.claimsBySessionIds(sessionIds);
    List<Claim> current = workers.claims(proof.workerId());
    if (!unresolved.stream()
        .map(Claim::sessionId)
        .toList()
        .equals(current.stream().map(Claim::sessionId).toList())) {
      throw DomainException.conflict(
          "WORKER_INVENTORY_RETRY", "Worker claims changed during confirmation");
    }
    Map<UUID, StoppedAllocation> allocations = new HashMap<>();
    for (StoppedAllocation allocation : proof.allocations()) {
      allocations.put(allocation.sessionId(), allocation);
    }
    if (supplied.size() != sessionIds.size()
        || current.stream().anyMatch(claim -> !allocations.containsKey(claim.sessionId()))) {
      throw DomainException.conflict(
          "STOPPED_ALLOCATION_MISMATCH", "Proof must cover every unresolved binding");
    }
    for (Claim claim : supplied) {
      StoppedAllocation allocation = allocations.get(claim.sessionId());
      if (!claim.workerId().equals(proof.workerId())
          || !claim.workerBootId().equals(proof.bootId())
          || claim.allocationEpoch() != allocation.allocationEpoch()
          || !Objects.equals(claim.runtimeGeneration(), allocation.runtimeGeneration())) {
        throw DomainException.conflict(
            "STOPPED_ALLOCATION_MISMATCH", "Proof does not match the physical binding");
      }
    }
    int closed = 0;
    for (Claim claim : supplied) {
      if (!physicallyReleased(claim)) {
        closeClaim(claim);
        closed++;
      }
    }
    return closed;
  }

  private static DomainException invalidStoppedProof() {
    return new DomainException(
        422, "INVALID_STOPPED_WORKER_PROOF", "Stopped worker proof is invalid");
  }

  @Transactional
  public void register(UUID id, UUID bootId, JsonNode request) {
    protocol.validateRegistration(request);
    identity(id, bootId, request);
    List<Claim> claims = lockWorkerClaims(id);
    workers.register(
        id,
        bootId,
        request.path("capacity").asInt(),
        request.path("imageDigest").asString(),
        json.workerDigest(request.path("inventory")));
    reconcile(
        id, bootId, request.path("inventory"), request.path("state").asString(), claims, true);
  }

  @Transactional
  public void heartbeat(UUID id, UUID bootId, JsonNode request) {
    protocol.validateHeartbeat(request);
    identity(id, bootId, request);
    if (request.path("usedSlots").asInt() != request.path("activeSessions").size()) {
      throw DomainException.conflict(
          "INVENTORY_MISMATCH", "Reported occupancy disagrees with inventory");
    }
    List<Claim> claims = lockWorkerClaims(id);
    var worker = workers.lockWorker(id).orElseThrow(DomainException::notFound);
    if (!worker.bootId().equals(bootId)) {
      throw DomainException.conflict("WORKER_BOOT_STALE", "Worker boot is no longer registered");
    }
    reconcile(
        id,
        bootId,
        request.path("activeSessions"),
        request.path("state").asString(),
        claims,
        false);
  }

  private List<Claim> lockWorkerClaims(UUID workerId) {
    List<Claim> before = workers.claims(workerId);
    workers.lockSubjects(before);
    workers.lockWorker(workerId);
    List<Claim> current = workers.claims(workerId);
    if (!before.stream()
        .map(Claim::sessionId)
        .toList()
        .equals(current.stream().map(Claim::sessionId).toList())) {
      throw DomainException.conflict(
          "WORKER_INVENTORY_RETRY", "Worker claims changed during reconciliation");
    }
    return current;
  }

  private Claim lockClaim(UUID sessionId) {
    Claim before = workers.claim(sessionId);
    workers.lockSubjects(List.of(before));
    workers.lockWorker(before.workerId());
    return workers.claim(sessionId);
  }

  private void reconcile(
      UUID id,
      UUID bootId,
      JsonNode inventory,
      String reportedState,
      List<Claim> claims,
      boolean authoritative) {
    Map<UUID, JsonNode> observed = new HashMap<>();
    for (JsonNode item : inventory) {
      UUID sessionId = UUID.fromString(item.path("browserSessionId").asString());
      if (observed.put(sessionId, item) != null
          || authoritative
              && (item.has("state") || !item.path("mode").asString().equals("QUIESCED"))) {
        throw DomainException.conflict(
            "INVENTORY_MISMATCH", "Inventory is not an authoritative runtime snapshot");
      }
    }
    boolean mismatch = false;
    for (Claim claim : claims) {
      JsonNode item = observed.remove(claim.sessionId());
      if (!claim.workerBootId().equals(bootId)) {
        workers.recovering(claim.sessionId());
        mismatch = true;
        continue;
      }
      if (item == null) {
        if (authoritative) {
          // The worker waits for pending launches and fencing before this snapshot.
          closeClaim(claim);
        } else if (claim.runtimeGeneration() != null) {
          workers.recovering(claim.sessionId());
          mismatch = true;
        }
        continue;
      }
      if (item.path("allocationEpoch").asLong(-1) != claim.allocationEpoch()) {
        workers.recovering(claim.sessionId());
        mismatch = true;
        continue;
      }
      if (item.has("state")) {
        if (!Set.of("RESERVED", "ASSIGNED").contains(claim.state())) {
          mismatch = true;
        }
        continue;
      }
      UUID generation = UUID.fromString(item.path("runtimeGeneration").asString());
      if (claim.startPermitId() == null
          || !claim.startPermitId().toString().equals(item.path("startPermitId").asString())
          || claim.runtimeGeneration() != null && !claim.runtimeGeneration().equals(generation)
          || claim.sessionState().equals("LOST")
          || item.path("pageEpoch").asLong(-1) < claim.pageEpoch()
          || item.path("privacyEpoch").asLong(-1) > claim.privacyEpoch()
          || item.path("controlEpoch").asLong(-1) > claim.controlEpoch()) {
        workers.recovering(claim.sessionId());
        mismatch = true;
        continue;
      }
      if (item.path("closed").asBoolean()) {
        closeClaim(claim);
        continue;
      }
      if (claim.runtimeGeneration() == null) {
        workers.assigned(claim.sessionId(), generation, item.path("pageEpoch").asLong());
      }
      if (item.path("unknown").asBoolean()) {
        workers.interrupt(claim.sessionId());
      }
      if (item.path("mode").asString().equals("QUIESCED")
          && controls.expireHuman(claim.sessionId(), item.path("controlEpoch").asLong(-1))) {
        workers.recoveryInputCheckpoint(
            claim.sessionId(),
            item.path("lastAcceptedInputSequence").asLong(),
            item.path("lastAppliedInputSequence").asLong());
      }
      if (authoritative || claim.sessionState().equals("RECOVERING")) {
        long accepted = item.path("lastAcceptedInputSequence").asLong(-1);
        long applied = item.path("lastAppliedInputSequence").asLong(-1);
        boolean unknown = item.path("unknown").asBoolean() || applied != accepted;
        if (unknown) {
          workers.interrupt(claim.sessionId());
        }
        if (!claim.recoveryControlPending()) {
          workers.recoveryInputCheckpoint(claim.sessionId(), accepted, applied);
          workers.recovering(claim.sessionId());
          boolean agent =
              claim.ownerKind().equals("AGENT")
                  && claim.privacy().equals("NORMAL")
                  && claim.accountState().equals("ACTIVE")
                  && !unknown
                  && claim.budgetDeadlineAt().isAfter(Instant.now());
          workers.beginRecovery(
              claim.sessionId(), agent ? "AGENT" : "QUIESCED", item.path("pageEpoch").asLong());
        }
      }
    }
    mismatch |= !observed.isEmpty();
    workers.observed(
        id,
        bootId,
        mismatch ? "QUARANTINED" : reportedState,
        json.workerDigest(inventory),
        !mismatch && authoritative);
  }

  @Transactional
  public JsonNode assignment(UUID workerId, JsonNode input) {
    if (!(input instanceof ObjectNode object)) {
      throw new DomainException(422, "INVALID_ASSIGNMENT", "Assignment must be an object");
    }
    ObjectNode assignment = object.deepCopy();
    Claim claim = lockClaim(UUID.fromString(assignment.path("browserSessionId").asString()));
    assignment.put("purpose", claim.purpose());
    if (!assignment.has("viewport")) {
      assignment.set("viewport", json.read("{\"width\":1280,\"height\":720}"));
    }
    protocol.validateAssignment(assignment);
    validateAssignment(claim, workerId, assignment);
    String digest = json.workerDigest(assignment);
    if (claim.assignmentDigest() != null && !claim.assignmentDigest().equals(digest)) {
      throw DomainException.conflict(
          "ASSIGNMENT_CHANGED", "An allocated runtime cannot change its assignment");
    }
    workers.assignment(claim.sessionId(), json.write(assignment), digest);
    return assignment;
  }

  @Transactional
  public Map<String, Object> launchPermit(UUID workerId, UUID bootId, JsonNode request) {
    Claim claim = lockClaim(UUID.fromString(request.path("browserSessionId").asString()));
    var worker = workers.lockWorker(workerId).orElseThrow(DomainException::notFound);
    if (!claim.workerId().equals(workerId)
        || !claim.workerBootId().equals(bootId)
        || !worker.bootId().equals(bootId)
        || !worker.observedState().equals("READY")
        || !worker.desiredMode().equals("ENABLED")
        || claim.assignment() == null
        || request.path("allocationEpoch").asLong(-1) != claim.allocationEpoch()
        || !Objects.equals(claim.assignmentDigest(), request.path("assignmentDigest").asString())) {
      throw DomainException.conflict(
          "LAUNCH_PERMIT_DENIED", "Runtime launch authorization is stale");
    }
    validateAssignment(claim, workerId, json.read(claim.assignment()));
    UUID permitId = claim.startPermitId();
    Instant deadline = claim.startPermitExpiresAt();
    if (permitId == null) {
      permitId = UUID.randomUUID();
      deadline = Instant.now().plusSeconds(30).truncatedTo(ChronoUnit.MICROS);
      if (deadline.isAfter(claim.budgetDeadlineAt())) {
        deadline = claim.budgetDeadlineAt();
      }
      workers.permit(claim.sessionId(), permitId, deadline);
    } else if (deadline == null || !deadline.isAfter(Instant.now())) {
      throw DomainException.conflict(
          "LAUNCH_PERMIT_EXPIRED", "Expired launch requires physical closure evidence");
    }
    return Map.of(
        "permitId",
        permitId,
        "browserSessionId",
        claim.sessionId(),
        "workerBootId",
        bootId,
        "allocationEpoch",
        claim.allocationEpoch(),
        "assignmentDigest",
        claim.assignmentDigest(),
        "deadline",
        deadline);
  }

  private void validateAssignment(Claim claim, UUID workerId, JsonNode assignment) {
    if (!claim.workerId().equals(workerId)
        || !claim.accountState().equals("ACTIVE")
        || !Set.of("RESERVED", "ASSIGNED").contains(claim.state())
        || !claim.sessionState().equals("STARTING")
        || !claim.budgetDeadlineAt().isAfter(Instant.now())
        || !claim.workerBootId().toString().equals(assignment.path("workerBootId").asString())
        || !claim.userId().toString().equals(assignment.path("userId").asString())
        || claim.taskId() != null
            && !claim.taskId().toString().equals(assignment.path("taskId").asString())
        || claim.taskId() == null && !assignment.path("taskId").isNull()
        || claim.taskId() != null && !opens.launchAuthorized(claim.sessionId(), claim.taskState())
        || claim.allocationEpoch() != assignment.path("allocationEpoch").asLong(-1)
        || claim.controlEpoch() != assignment.path("controlEpoch").asLong(-1)
        || claim.pageEpoch() != assignment.path("pageEpoch").asLong(-1)
        || claim.privacyEpoch() != assignment.path("privacyEpoch").asLong(-1)
        || claim.policyVersion() != assignment.path("policyVersion").asLong(-1)
        || claim.instructionRevision() != assignment.path("instructionRevision").asLong(-1)
        || Instant.parse(assignment.path("deadline").asString())
            .isAfter(claim.budgetDeadlineAt())) {
      throw DomainException.conflict(
          "ASSIGNMENT_FENCED", "Assignment no longer matches its owners");
    }
  }

  @Transactional
  public void assigned(UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt) {
    Claim claim = lockClaim(sessionId);
    UUID generation = UUID.fromString(receipt.path("runtimeGeneration").asString());
    requireBinding(claim, workerId, bootId, receipt);
    if (claim.startPermitId() == null
        || !claim.startPermitId().toString().equals(receipt.path("startPermitId").asString())
        || !claim.state().equals("ASSIGNED")
        || claim.runtimeGeneration() != null && !claim.runtimeGeneration().equals(generation)
        || !Set.of("STARTING", "ACTIVE").contains(claim.sessionState())
        || receipt.path("controlEpoch").asLong(-1) != claim.controlEpoch()
        || receipt.path("privacyEpoch").asLong(-1) != claim.privacyEpoch()
        || receipt.path("pageEpoch").asLong(-1) < claim.pageEpoch()) {
      throw DomainException.conflict(
          "SESSION_ASSIGNMENT_STALE", "Runtime receipt does not match its launch permit");
    }
    workers.assigned(sessionId, generation, receipt.path("pageEpoch").asLong(-1));
  }

  @Transactional
  public void closed(UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt) {
    Claim claim = lockClaim(sessionId);
    requireBinding(claim, workerId, bootId, receipt);
    closeClaim(claim);
  }

  @Transactional(readOnly = true)
  public long readyEpoch(UUID workerId, UUID bootId, UUID sessionId) {
    Claim claim = workers.claim(sessionId);
    if (!claim.workerId().equals(workerId)
        || !claim.workerBootId().equals(bootId)
        || !Set.of("STARTING", "ACTIVE").contains(claim.sessionState())) {
      throw DomainException.conflict(
          "RUNTIME_READY_FENCED", "Runtime readiness belongs to another allocation");
    }
    return claim.allocationEpoch();
  }

  private static void requireBinding(Claim claim, UUID workerId, UUID bootId, JsonNode receipt) {
    if (!claim.workerId().equals(workerId)
        || !claim.workerBootId().equals(bootId)
        || receipt.path("allocationEpoch").asLong(-1) != claim.allocationEpoch()) {
      throw DomainException.conflict(
          "WORKER_BINDING_MISMATCH", "Receipt does not match the physical slot");
    }
  }

  public List<Map<String, Object>> recoveryIntents(UUID workerId, UUID bootId) {
    List<Map<String, Object>> intents = new ArrayList<>();
    for (Claim claim : workers.claims(workerId)) {
      if (!claim.workerBootId().equals(bootId) || !claim.recoveryControlPending()) {
        continue;
      }
      Map<String, Object> intent = new LinkedHashMap<>();
      intent.put("schemaVersion", 1);
      intent.put("type", "control");
      intent.put("requestId", UUID.randomUUID());
      intent.put("browserSessionId", claim.sessionId());
      intent.put("allocationEpoch", claim.allocationEpoch());
      intent.put("controlEpoch", claim.controlEpoch());
      intent.put("pageEpoch", claim.pageEpoch());
      intent.put("privacyEpoch", claim.privacyEpoch());
      intent.put("policyVersion", claim.policyVersion());
      intent.put("mode", claim.recoveryMode());
      intent.put(
          "leaseExpiresAt",
          claim.recoveryMode().equals("AGENT") ? claim.budgetDeadlineAt() : Instant.EPOCH);
      intents.add(intent);
    }
    return List.copyOf(intents);
  }

  @Transactional
  public boolean acknowledgeRecovery(UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt) {
    Claim claim = lockClaim(sessionId);
    if (!claim.recoveryControlPending()) {
      return false;
    }
    requireBinding(claim, workerId, bootId, receipt);
    if (!claim.sessionState().equals("RECOVERING")
        || claim.recoveryStartedAt() == null
        || !claim.recoveryStartedAt().plusSeconds(30).isAfter(Instant.now())
        || receipt.path("controlEpoch").asLong(-1) != claim.controlEpoch()
        || !claim.recoveryMode().equals(receipt.path("mode").asString())) {
      throw DomainException.conflict(
          "RECOVERY_CONTROL_STALE", "Recovery needs its new control epoch receipt");
    }
    workers.recovered(sessionId, claim.recoveryMode());
    if (claim.taskId() != null && claim.recoveryMode().equals("AGENT")) {
      events.publishEvent(
          new TaskContinuationService.RuntimeRecovered(
              claim.userId(), claim.taskId(), sessionId, claim.controlEpoch()));
    }
    return true;
  }

  @Transactional
  public void expireWorker(UUID workerId) {
    List<Claim> claims = lockWorkerClaims(workerId);
    if (!workers.heartbeatExpired(workerId)) {
      return;
    }
    for (Claim claim : claims) {
      workers.recovering(claim.sessionId());
    }
    workers.offline(workerId);
  }

  @Transactional
  public boolean claimCommandDelivery(UUID commandId) {
    return workers.claimCommandDelivery(commandId);
  }

  public record AssignmentDelivery(UUID workerId, JsonNode assignment) {}

  public AssignmentDelivery assignmentDelivery(UUID sessionId) {
    Claim claim = workers.claim(sessionId);
    return new AssignmentDelivery(claim.workerId(), json.read(claim.assignment()));
  }

  @Transactional
  public void rejectAssignment(UUID sessionId) {
    lockClaim(sessionId);
    workers.requestClose(sessionId);
  }

  @Transactional
  public void expireRecovery(UUID sessionId) {
    Claim claim = lockClaim(sessionId);
    if (claim.sessionState().equals("RECOVERING")
        && claim.recoveryStartedAt() != null
        && claim.recoveryStartedAt().plusSeconds(30).isBefore(Instant.now())) {
      dispositionsChanged(workers.lost(sessionId));
      lifecycleChanged(claim);
    }
  }

  private static boolean physicallyReleased(Claim claim) {
    return claim.sessionState().equals("CLOSED")
        && claim.state().equals("RELEASED")
        && claim.bindingReleasedAt() != null;
  }

  private void closeClaim(Claim claim) {
    if (physicallyReleased(claim)) {
      return;
    }
    dispositionsChanged(workers.closed(claim.sessionId()));
    if (claim.taskId() != null) {
      tasks.confirmStopped(claim.userId(), claim.taskId());
    }
    lifecycleChanged(claim);
  }

  private void lifecycleChanged(Claim before) {
    Claim after = workers.claim(before.sessionId());
    if (after.sessionVersion() != before.sessionVersion()) {
      changes.changed(after.userId(), "sessions", after.sessionId(), after.sessionVersion());
    }
    if (after.taskId() != null
        && after.taskVersion() != null
        && !after.taskVersion().equals(before.taskVersion())) {
      changes.changed(after.userId(), "tasks", after.taskId(), after.taskVersion());
    } else if (after.taskId() != null && after.sessionVersion() != before.sessionVersion()) {
      changes.changed(
          after.userId(),
          "tasks",
          after.taskId(),
          after.sessionId(),
          after.sessionVersion(),
          Instant.now());
    }
  }

  private void dispositionsChanged(List<CommandDisposition> dispositions) {
    for (CommandDisposition disposition : dispositions) {
      commands.dispositionChanged(
          disposition.userId(), disposition.taskId(), disposition.commandId());
    }
  }

  private static void identity(UUID id, UUID bootId, JsonNode request) {
    if (!id.toString().equals(request.path("workerId").asString())
        || !bootId.toString().equals(request.path("bootId").asString())) {
      throw new DomainException(
          403, "WORKER_BINDING_MISMATCH", "Worker identity does not match its channel");
    }
  }
}
