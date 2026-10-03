package com.helmglass.connection.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.connection.api.ConnectionContracts;
import com.helmglass.connection.api.ConnectionContracts.Resolve;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionResolutionRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionResolutionRepository.Candidate;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.infrastructure.repository.TaskQueries;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ConnectionService {
  private final ConnectionRepository connections;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final TaskQueries sites;
  private final ChangeRepository changes;
  private final UserPolicyService policies;
  private final ConnectionResolutionRepository resolution;
  private final JsonSupport json;

  public ConnectionService(
      ConnectionRepository connections,
      IdentityRepository identities,
      OperationRepository operations,
      TaskQueries sites,
      ChangeRepository changes,
      UserPolicyService policies,
      ConnectionResolutionRepository resolution,
      JsonSupport json) {
    this.connections = connections;
    this.identities = identities;
    this.operations = operations;
    this.sites = sites;
    this.changes = changes;
    this.policies = policies;
    this.resolution = resolution;
    this.json = json;
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
    connections.deleting(id);
    changes.changed(actor.userId(), "connections", id, connection.version() + 1);
    return operations.save(
        actor,
        "connections.delete:" + id,
        context,
        input,
        "connection",
        id,
        connection.version() + 1,
        false);
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
