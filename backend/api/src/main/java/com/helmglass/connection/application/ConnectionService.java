package com.helmglass.connection.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.browser.infrastructure.repository.BrowserCloseOutboxRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.connection.api.ConnectionContracts;
import com.helmglass.connection.api.ConnectionContracts.Resolve;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository.Deletion;
import com.helmglass.connection.infrastructure.repository.ConnectionResolutionRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionResolutionRepository.Candidate;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.application.TaskLifecycleService;
import com.helmglass.task.infrastructure.repository.TaskQueries;
import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@Service
@Slf4j
public class ConnectionService {
  private final ConnectionRepository connections;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final TaskQueries sites;
  private final ChangeRepository changes;
  private final UserPolicyService policies;
  private final ConnectionResolutionRepository resolution;
  private final JsonSupport json;
  private final BrowserProfileService profiles;
  private final ConnectionLoginService logins;
  private final ControlRepository controls;
  private final BrowserCloseOutboxRepository closeOutbox;
  private final TaskLifecycleService tasks;
  private final TransactionTemplate transaction;

  public ConnectionService(
      ConnectionRepository connections,
      IdentityRepository identities,
      OperationRepository operations,
      TaskQueries sites,
      ChangeRepository changes,
      UserPolicyService policies,
      ConnectionResolutionRepository resolution,
      JsonSupport json,
      BrowserProfileService profiles,
      ConnectionLoginService logins,
      ControlRepository controls,
      BrowserCloseOutboxRepository closeOutbox,
      TaskLifecycleService tasks,
      PlatformTransactionManager transactions) {
    this.connections = connections;
    this.identities = identities;
    this.operations = operations;
    this.sites = sites;
    this.changes = changes;
    this.policies = policies;
    this.resolution = resolution;
    this.json = json;
    this.profiles = profiles;
    this.logins = logins;
    this.controls = controls;
    this.closeOutbox = closeOutbox;
    this.tasks = tasks;
    transaction = new TransactionTemplate(transactions);
    transaction.setTimeout(10);
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public PageResult<ConnectionContracts.ConnectionView> list(
      AuthenticatedActor actor, PageQuery query) {
    actor.requireScope("tasks:read");
    return connections.list(actor.userId(), query);
  }

  public ConnectionContracts.ConnectionView get(AuthenticatedActor actor, UUID id) {
    return connections.owned(actor.userId(), id, false);
  }

  @Transactional
  public MutationReceipt create(
      AuthenticatedActor actor, ConnectionContracts.Create input, MutationContext context) {
    identities.lockActive(actor.userId());
    var replay = operations.replay(actor, "connections.create", context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    policies.authorize(actor.userId(), "NAVIGATE", input.startUrl());
    UUID siteId = sites.site(actor.userId(), input.startUrl());
    var connection = connections.create(actor.userId(), siteId, input);
    changes.changed(actor.userId(), "connections", connection.id(), connection.version());
    return operations.save(
        actor,
        "connections.create",
        context,
        input,
        "connection",
        connection.id(),
        connection.version(),
        true);
  }

  @Transactional
  public MutationReceipt rename(
      AuthenticatedActor actor,
      UUID id,
      ConnectionContracts.Rename input,
      MutationContext context) {
    identities.lockActive(actor.userId());
    var connection = connections.owned(actor.userId(), id, true);
    var replay = operations.replay(actor, "connections.rename:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(connection.version(), input.expectedVersion());
    connections.rename(id, input.displayName());
    changes.changed(actor.userId(), "connections", id, connection.version() + 1);
    return operations.save(
        actor,
        "connections.rename:" + id,
        context,
        input,
        "connection",
        id,
        connection.version() + 1,
        true);
  }

  @Transactional
  public MutationReceipt delete(AuthenticatedActor actor, UUID id, MutationContext context) {
    identities.lockActive(actor.userId());
    var connection = connections.owned(actor.userId(), id, true);
    var input = Map.of("connectionId", id);
    var replay = operations.replay(actor, "connections.delete:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    if (connection.status().equals("DELETING")) {
      UUID operationId = connections.deletionOperation(id).orElseThrow();
      if (connections.resumeDeletion(operationId)) {
        closeOutbox.resumeConnection(actor.userId(), id);
      }
      return operations.bindExisting(
          actor,
          "connections.delete:" + id,
          context,
          input,
          operationId,
          "connection",
          id,
          connection.version());
    }
    if (connection.status().equals("DELETED")) {
      return operations.save(
          actor,
          "connections.delete:" + id,
          context,
          input,
          "connection",
          id,
          connection.version(),
          true);
    }
    connections.deleting(id);
    changes.changed(actor.userId(), "connections", id, connection.version() + 1);
    var receipt =
        operations.save(
            actor,
            "connections.delete:" + id,
            context,
            input,
            "connection",
            id,
            connection.version() + 1,
            false);
    prepareDeletion(actor.userId(), id, receipt.operationId());
    return receipt;
  }

  @Scheduled(fixedDelay = 1000)
  public void advanceDeletions() {
    for (Deletion deletion : connections.dueDeletions()) {
      try {
        processDeletion(deletion);
      } catch (RuntimeException error) {
        transaction.executeWithoutResult(
            status -> connections.deferDeletion(deletion, "CONNECTION_DELETE_UNCONFIRMED", true));
        log.warn(
            "Connection deletion preparation failed; operationId={}, errorType={}",
            deletion.operationId(),
            error.getClass().getSimpleName());
      }
    }
  }

  public void processDeletion(Deletion candidate) {
    Deletion work =
        transaction.execute(
            status -> {
              identities.lockState(candidate.userId());
              var current = connections.owned(candidate.userId(), candidate.connectionId(), true);
              if (!current.status().equals("DELETING")) {
                return null;
              }
              var claimed = connections.claimDeletion(candidate.operationId());
              if (claimed.isEmpty()) {
                return null;
              }
              Deletion deletion = claimed.get();
              if (deletion.progress() < 25) {
                prepareDeletion(deletion.userId(), deletion.connectionId(), deletion.operationId());
              }
              closeConnectionBrowsers(deletion.connectionId());
              for (UUID taskId : connections.deletionTasks(deletion.operationId())) {
                tasks.connectionUnavailable(deletion.userId(), taskId);
                connections.taskDetached(deletion.operationId(), taskId);
              }
              if (!connections.deletionTasks(deletion.operationId()).isEmpty()
                  || !connections.deletionRuntimeClosed(deletion.connectionId())) {
                connections.deferDeletion(deletion, "CONNECTION_CLOSE_PENDING", false);
                return null;
              }
              if (!deletion.deadline().isAfter(Instant.now())) {
                connections.deferDeletion(deletion, "CONNECTION_DELETE_DEADLINE", false);
                return null;
              }
              connections.deletionChanged(deletion);
              return deletion;
            });
    if (work == null) {
      return;
    }
    try {
      boolean deleted = profiles.deleteConnection(work.userId(), work.connectionId());
      transaction.executeWithoutResult(
          status -> {
            identities.lockState(work.userId());
            var current = connections.owned(work.userId(), work.connectionId(), true);
            if (!current.status().equals("DELETING")) {
              return;
            }
            if (!deleted) {
              connections.deferDeletion(work, "PROFILE_DELETE_PENDING", false);
              return;
            }
            connections.deleted(work.connectionId());
            operations.completeForTarget(
                work.connectionId(), "connections.delete:" + work.connectionId());
            changes.changed(
                work.userId(), "connections", work.connectionId(), current.version() + 1);
          });
    } catch (RuntimeException error) {
      transaction.executeWithoutResult(
          status -> connections.deferDeletion(work, "PROFILE_DELETE_UNCONFIRMED", true));
      log.warn(
          "Connection deletion remains unconfirmed; operationId={}, errorType={}",
          work.operationId(),
          error.getClass().getSimpleName());
    }
  }

  private void prepareDeletion(UUID userId, UUID connectionId, UUID operationId) {
    connections.prepareDeletion(connectionId, operationId);
    profiles.revokeConnection(userId, connectionId);
    logins.connectionDeleted(userId, connectionId);
    closeConnectionBrowsers(connectionId);
  }

  private void closeConnectionBrowsers(UUID connectionId) {
    for (UUID sessionId : connections.activeSessions(connectionId)) {
      connections.discardChanges(sessionId);
      controls.closeRequested(sessionId);
    }
  }

  @Transactional
  public Map<String, Object> resolve(
      AuthenticatedActor actor, UUID taskId, Resolve input, MutationContext context) {
    actor.requireScope("tasks:write");
    identities.lockActive(actor.userId());
    var task = resolution.lockTask(actor.userId(), taskId);
    String kind = "connections.resolve:" + taskId;
    var replay = operations.replay(actor, kind, context, input);
    if (replay.isPresent()) {
      return Map.of(
          "receipt", replay.get(), "resolution", resolution.result(replay.get().operationId()));
    }
    DomainException.requireVersion(task.version(), input.expectedTaskVersion());
    if (task.instructionRevision() != input.instructionRevision()
        || task.mutationBarrier()
        || !List.of("DRAFT", "WAITING_AGENT", "WAITING_USER", "PAUSED").contains(task.state())) {
      throw DomainException.conflict(
          "TASK_NOT_READY", "Read the current task before selecting an account");
    }
    policies.authorize(actor.userId(), "NAVIGATE", input.url());
    URI url = URI.create(input.url());
    String origin =
        url.getScheme() + "://" + url.getHost() + (url.getPort() < 0 ? "" : ":" + url.getPort());
    Map<String, Object> decision =
        decide(actor.userId(), taskId, task.connectionMode(), origin, input);
    long version = resolution.lockTask(actor.userId(), taskId).version();
    var receipt = operations.save(actor, kind, context, input, "task", taskId, version, true);
    resolution.saveResult(receipt.operationId(), decision);
    changes.changed(actor.userId(), "tasks", taskId, version);
    changes.changed(actor.userId(), "connections", taskId, version);
    return Map.of("receipt", receipt, "resolution", decision);
  }

  private Map<String, Object> decide(
      UUID userId, UUID taskId, String mode, String origin, Resolve input) {
    if (mode.equals("PUBLIC_ONLY")) {
      return Map.of("state", input.loginRequired() ? "DENIED" : "PUBLIC", "reason", "PUBLIC_ONLY");
    }
    var current = resolution.current(userId, taskId, origin);
    if (current.isPresent()) {
      return selected(userId, taskId, origin, current.get(), "CURRENT_TASK", input, true);
    }
    var preferred = resolution.preferred(userId, taskId, origin);
    if (preferred.isPresent()) {
      return selected(userId, taskId, origin, preferred.get(), "TASK_PREFERENCE", input, false);
    }
    if (!input.loginRequired()) {
      return Map.of("state", "PUBLIC", "reason", "PUBLIC_READING");
    }
    if (mode.equals("EXPLICIT")) {
      return Map.of("state", "DENIED", "reason", "EXPLICIT_CONNECTION_REQUIRED");
    }
    List<Candidate> candidates = resolution.automatic(userId, taskId, origin);
    if (candidates.isEmpty()) {
      UUID siteId = sites.site(userId, input.url());
      var created =
          connections.create(
              userId,
              siteId,
              new ConnectionContracts.Create(URI.create(origin).getHost(), input.url(), "ASK"));
      Candidate candidate = resolution.lockCandidate(userId, taskId, origin, created.id());
      return selected(userId, taskId, origin, candidate, "LOGIN_REQUIRED", input, false);
    }
    Candidate first = candidates.getFirst();
    if (candidates.size() == 1
        || !Objects.equals(first.lastUsedAt(), candidates.get(1).lastUsedAt())) {
      return selected(userId, taskId, origin, first, "LAST_USED", input, false);
    }
    List<Map<String, Object>> choices = new ArrayList<>();
    for (Candidate candidate : candidates) {
      if (!Objects.equals(first.lastUsedAt(), candidate.lastUsedAt()) || choices.size() == 100) {
        break;
      }
      Map<String, Object> choice = new HashMap<>();
      choice.put("id", candidate.id());
      choice.put("label", candidate.displayName());
      choice.put("accountLabel", candidate.accountLabel());
      choices.add(choice);
    }
    Map<String, Object> binding =
        Map.of(
            "purpose",
            "CONNECTION_SELECTION",
            "origin",
            origin,
            "instructionRevision",
            input.instructionRevision(),
            "choices",
            choices,
            "hasMore",
            candidates.size() > choices.size()
                && Objects.equals(first.lastUsedAt(), candidates.get(choices.size()).lastUsedAt()));
    UUID requestId =
        resolution.request(
            taskId,
            null,
            "QUESTION",
            "Choose the account to use for this site",
            json.digest(binding),
            binding);
    return Map.of(
        "state",
        "ACCOUNT_SELECTION_REQUIRED",
        "reason",
        "ACCOUNT_SELECTION_REQUIRED",
        "requestId",
        requestId);
  }

  private Map<String, Object> selected(
      UUID userId,
      UUID taskId,
      String origin,
      Candidate initial,
      String reason,
      Resolve input,
      boolean live) {
    Candidate candidate = resolution.lockCandidate(userId, taskId, origin, initial.id());
    resolution.select(userId, taskId, candidate, reason);
    Map<String, Object> result = new HashMap<>();
    result.put("connectionId", candidate.id());
    result.put("startUrl", candidate.startUrl());
    result.put("scopeVersion", candidate.scopeVersion());
    result.put("profileVersionId", candidate.profileVersionId());
    result.put("reason", reason);
    if (List.of("DELETING", "DELETED").contains(candidate.status())) {
      result.put("state", "UNAVAILABLE");
      result.put("reason", "CONNECTION_UNAVAILABLE");
    } else if (candidate.busy()) {
      result.put("state", "WAITING_RESOURCE");
      result.put("reason", "CONNECTION_BUSY");
    } else if (!live
        && (candidate.status().equals("NEEDS_LOGIN") || candidate.profileVersionId() == null)) {
      Map<String, Object> binding =
          Map.of(
              "purpose",
              "LOGIN_REQUIRED",
              "connectionId",
              candidate.id(),
              "instructionRevision",
              input.instructionRevision(),
              "origin",
              origin);
      UUID requestId =
          resolution.request(
              taskId,
              candidate.id(),
              "LOGIN",
              "Sign in to the selected account",
              json.digest(binding),
              binding);
      result.put("state", "LOGIN_REQUIRED");
      result.put("requestId", requestId);
    } else {
      result.put("state", "READY");
    }
    return result;
  }

  public Optional<Candidate> forBrowser(UUID userId, UUID taskId, String targetUrl) {
    if (targetUrl == null
        || resolution.lockTask(userId, taskId).connectionMode().equals("PUBLIC_ONLY")) {
      return Optional.empty();
    }
    policies.authorize(userId, "NAVIGATE", targetUrl);
    URI uri = URI.create(targetUrl);
    String origin =
        uri.getScheme() + "://" + uri.getHost() + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
    var preferred = resolution.preferred(userId, taskId, origin);
    if (preferred.isEmpty()) {
      return Optional.empty();
    }
    Candidate candidate = resolution.lockCandidate(userId, taskId, origin, preferred.get().id());
    if (candidate.busy()) {
      throw DomainException.conflict(
          "CONNECTION_BUSY", "Selected account is in use by another browser");
    }
    if (List.of("DELETING", "DELETED").contains(candidate.status())) {
      throw DomainException.conflict("CONNECTION_UNAVAILABLE", "Selected account is unavailable");
    }
    if (candidate.profileVersionId() == null || candidate.status().equals("NEEDS_LOGIN")) {
      throw DomainException.conflict(
          "LOGIN_REQUIRED", "Resolve the selected account and finish login first");
    }
    policies.authorize(userId, "NAVIGATE", candidate.startUrl());
    return Optional.of(candidate);
  }

  public void answerSelection(
      AuthenticatedActor actor, UUID taskId, Map<String, Object> binding, UUID connectionId) {
    if (actor.mcp()) {
      throw new DomainException(
          403, "HUMAN_SELECTION_REQUIRED", "Account selection requires the user");
    }
    var task = resolution.lockTask(actor.userId(), taskId);
    if (!(binding.get("instructionRevision") instanceof Number revision)
        || task.instructionRevision() != revision.longValue()) {
      throw DomainException.conflict(
          "INSTRUCTION_CHANGED", "The account question belongs to older instructions");
    }
    Candidate candidate =
        resolution.lockCandidate(
            actor.userId(), taskId, Objects.toString(binding.get("origin")), connectionId);
    resolution.select(actor.userId(), taskId, candidate, "USER_SELECTED");
  }

  public Map<String, Object> suggestions(
      AuthenticatedActor actor,
      String scope,
      String query,
      int limit,
      List<UUID> selectedIds,
      List<UUID> excludedIds) {
    if (!List.of("tasks", "connections").contains(scope)
        || query.length() > 100
        || limit < 1
        || limit > 3
        || selectedIds.size() > 50
        || excludedIds.size() > 50) {
      throw new DomainException(400, "INVALID_SUGGESTION_QUERY", "Invalid suggestion query");
    }
    var rows = connections.suggestions(actor.userId(), scope, query, limit + 1, excludedIds);
    var selected = connections.selectedSites(actor.userId(), scope, selectedIds);
    return Map.of(
        "items",
        rows.stream().limit(limit).toList(),
        "hasMore",
        rows.size() > limit,
        "selected",
        selected);
  }
}
