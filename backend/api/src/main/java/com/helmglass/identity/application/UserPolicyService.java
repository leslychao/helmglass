package com.helmglass.identity.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.identity.api.PolicyContracts;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.domain.QuotaCeiling;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.identity.infrastructure.repository.PolicyRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UserPolicyService {
  private final PolicyRepository policies;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final ChangeRepository changes;

  public UserPolicyService(
      PolicyRepository policies,
      IdentityRepository identities,
      OperationRepository operations,
      ChangeRepository changes) {
    this.policies = policies;
    this.identities = identities;
    this.operations = operations;
    this.changes = changes;
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public PolicyContracts.Policy get(AuthenticatedActor actor) {
    return policies.get(actor.userId());
  }

  public PolicyContracts.Policy getForExecution(UUID userId) {
    return policies.get(userId);
  }

  @Transactional
  public MutationReceipt update(
      AuthenticatedActor actor, PolicyContracts.Update input, MutationContext context) {
    identities.lockActive(actor.userId());
    var replay = operations.replay(actor, "policy.update", context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    var current = policies.get(actor.userId());
    DomainException.requireVersion(current.version(), input.expectedVersion());
    if (!new QuotaCeiling(current.quotas().assignedBrowserLimit(), input.maxBrowserSessions())
            .personalFitsAssignment()
        || !new QuotaCeiling(current.quotas().assignedQueuedLimit(), input.maxQueuedRuns())
            .personalFitsAssignment()) {
      throw new DomainException(
          422,
          "PERSONAL_LIMIT_EXCEEDS_ASSIGNMENT",
          "Personal limits cannot exceed assigned quotas");
    }
    for (String rule : input.origins()) {
      URI uri = URI.create(rule);
      if (uri.getHost() == null
          || !List.of("http", "https").contains(uri.getScheme())
          || uri.getUserInfo() != null
          || uri.getQuery() != null
          || uri.getFragment() != null
          || (uri.getPath() != null && !uri.getPath().isEmpty())) {
        throw new DomainException(422, "INVALID_ORIGIN", "Site rules require an exact origin");
      }
    }
    policies.update(actor.userId(), input);
    changes.changed(actor.userId(), "policy", actor.userId(), current.version() + 1);
    changes.changed(actor.userId(), "tasks", actor.userId(), current.version() + 1);
    changes.changed(actor.userId(), "users", actor.userId(), current.version() + 1);
    return operations.save(
        actor,
        "policy.update",
        context,
        input,
        "policy",
        actor.userId(),
        current.version() + 1,
        true);
  }

  public void authorize(UUID userId, String actionType, String url) {
    authorize(policies.get(userId), actionType, url);
  }

  public void authorize(PolicyContracts.Policy policy, String actionType, String url) {
    if (policy.blockedActions().contains(actionType)) {
      throw new DomainException(403, "ACTION_PROHIBITED", "Action is prohibited by user policy");
    }
    if (url == null) {
      return;
    }
    URI uri = URI.create(url);
    if (uri.getHost() == null
        || !List.of("http", "https").contains(uri.getScheme())
        || uri.getUserInfo() != null) {
      throw new DomainException(422, "INVALID_URL", "A public HTTP(S) URL is required");
    }
    String origin =
        uri.getScheme() + "://" + uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
    boolean listed = policy.origins().contains(origin);
    if ((policy.siteMode().equals("DENY_LIST") && listed)
        || (policy.siteMode().equals("ALLOW_LIST") && !listed)) {
      throw new DomainException(403, "ORIGIN_PROHIBITED", "Site is not permitted by user policy");
    }
  }

  public List<Map<String, Object>> grants(AuthenticatedActor actor) {
    return policies.grants(actor.userId());
  }

  @Transactional
  public MutationReceipt checkGrant(AuthenticatedActor actor, UUID id, MutationContext context) {
    identities.lockActive(actor.userId());
    var input = Map.of("grantId", id);
    var replay = operations.replay(actor, "grants.check:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    var grant =
        policies.grants(actor.userId()).stream()
            .filter(value -> id.equals(value.get("id")))
            .findFirst()
            .orElseThrow(DomainException::notFound);
    return operations.save(
        actor,
        "grants.check:" + id,
        context,
        input,
        "grant",
        id,
        ((Number) grant.get("version")).longValue(),
        true);
  }

  @Transactional
  public MutationReceipt revoke(AuthenticatedActor actor, UUID id, MutationContext context) {
    identities.lockActive(actor.userId());
    var input = Map.of("grantId", id);
    var replay = operations.replay(actor, "grants.revoke:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    if (!policies.revoke(actor.userId(), id)) {
      throw DomainException.notFound();
    }
    changes.changed(actor.userId(), "operations", id, System.currentTimeMillis());
    return operations.save(actor, "grants.revoke:" + id, context, input, "grant", id, 1, true);
  }
}
