package com.helmglass.identity.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class IdentityService {
  private final IdentityRepository repository;
  private final OperationRepository operations;

  public IdentityService(IdentityRepository repository, OperationRepository operations) {
    this.repository = repository;
    this.operations = operations;
  }

  @Transactional
  public AuthenticatedActor authenticate(Jwt jwt, boolean mcp) {
    String issuer = jwt.getIssuer().toString();
    String subject = jwt.getSubject();
    String name = jwt.getClaimAsString("name");
    String email = jwt.getClaimAsString("email");
    if (subject == null || subject.isBlank()) {
      throw new DomainException(401, "INVALID_IDENTITY", "Token has no subject");
    }
    var account =
        repository.resolve(
            issuer, subject, name == null ? subject : name, email == null ? "" : email);
    if (!account.state().equals("ACTIVE")) {
      throw new DomainException(403, "ACCOUNT_UNAVAILABLE", "Account is unavailable");
    }
    String sid = jwt.getClaimAsString("sid");
    if (sid == null || sid.isBlank()) {
      throw new DomainException(401, "SESSION_REQUIRED", "Token has no session identity");
    }
    Instant authTime = jwt.getClaimAsInstant("auth_time");
    if (authTime == null || jwt.getExpiresAt() == null) {
      throw new DomainException(401, "AUTH_TIME_REQUIRED", "Authentication time is required");
    }
    // Refresh changes token issuance time, not the authentication that crossed the account barrier.
    if (account.reauthenticationAfter() != null
        && !authTime.isAfter(account.reauthenticationAfter())) {
      throw new DomainException(401, "REAUTHENTICATION_REQUIRED", "A fresh login is required");
    }
    String clientId = jwt.getClaimAsString("azp");
    Set<String> permissions = new HashSet<>();
    String scopes = jwt.getClaimAsString("scope");
    if (scopes != null) {
      permissions.addAll(List.of(scopes.split(" ")));
    }
    Object realm = jwt.getClaims().get("realm_access");
    if (!mcp && realm instanceof Map<?, ?> access && access.get("roles") instanceof List<?> roles) {
      for (Object role : roles) {
        if (role instanceof String value && value.equals("platform_admin")) {
          permissions.add(value);
        }
      }
    }
    UUID loginId = null;
    UUID grantId = null;
    if (mcp) {
      grantId = repository.admitGrant(account.id(), clientId, sid, List.copyOf(permissions));
    } else {
      loginId = repository.admitLogin(account, issuer, sid, authTime, jwt.getExpiresAt());
    }
    return new AuthenticatedActor(
        account.id(),
        loginId,
        grantId,
        clientId,
        account.displayName(),
        account.email(),
        account.accessEpoch(),
        Set.copyOf(permissions),
        mcp);
  }

  @Transactional
  public MutationReceipt logout(AuthenticatedActor actor, MutationContext context) {
    if (actor.loginId() == null) {
      throw new DomainException(403, "WEB_LOGIN_REQUIRED", "Web login is required");
    }
    repository.lockActive(actor.userId());
    var input = Map.of("loginId", actor.loginId());
    var replay = operations.replay(actor, "auth.logout", context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    var receipt =
        operations.save(actor, "auth.logout", context, input, "login", actor.loginId(), 1, false);
    repository.revokeLogin(actor.loginId());
    return receipt;
  }

  public boolean active(UUID userId) {
    return repository.isActive(userId);
  }
}
