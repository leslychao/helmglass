package com.helmglass.identity.api;

import com.helmglass.api.MutationContext;
import com.helmglass.identity.application.IdentityService;
import com.helmglass.identity.application.LogoutService;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.bind.annotation.CookieValue;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.operation.domain.MutationReceipt;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProfileController {
  private final UserPolicyService policies;
  private final IdentityService identities;
  private final LogoutService logout;

  public ProfileController(UserPolicyService policies, IdentityService identities, LogoutService logout) {
    this.policies = policies;
    this.identities = identities;
    this.logout = logout;
  }

  @GetMapping("/api/v1/me")
  Map<String, Object> me(HttpServletRequest request, HttpServletResponse response, CsrfToken csrf) {
    var actor = Actors.current(request);
    SessionCsrfTokenRepository.expose(csrf, response);
    return Map.of("id", actor.userId(), "displayName", actor.displayName(), "email", actor.email(),
        "accountState", "ACTIVE", "permissions", actor.permissions(), "policy", policies.get(actor),
        "serverTime", Instant.now());
  }

  @GetMapping("/api/v1/me/policy")
  PolicyContracts.Policy policy(HttpServletRequest request) {
    return policies.get(Actors.current(request));
  }

  @PatchMapping("/api/v1/me/policy")
  MutationReceipt update(@Valid @RequestBody PolicyContracts.Update input, HttpServletRequest request) {
    return policies.update(Actors.current(request), input, MutationContext.from(request));
  }

  @GetMapping("/api/v1/me/client-grants")
  List<Map<String, Object>> grants(HttpServletRequest request) {
    return policies.grants(Actors.current(request));
  }

  @PostMapping("/api/v1/me/client-grants/{id}/revoke")
  MutationReceipt revoke(@PathVariable UUID id, HttpServletRequest request) {
    return policies.revoke(Actors.current(request), id, MutationContext.from(request));
  }

  @PostMapping("/api/v1/me/client-grants/{id}/check")
  MutationReceipt check(@PathVariable UUID id, HttpServletRequest request) {
    return policies.checkGrant(Actors.current(request), id, MutationContext.from(request));
  }

  @PostMapping("/api/v1/auth/logout")
  Map<String, Object> logout(HttpServletRequest request, HttpServletResponse response,
      @CookieValue(name = "__Host-helm_session", required = false) String ticket) {
    var receipt = identities.logout(Actors.current(request), MutationContext.from(request));
    for (String cookie : logout.clearProxySession(ticket)) {
      response.addHeader("Set-Cookie", cookie);
    }
    return Map.of("receipt", receipt, "redirect", "/sign-in");
  }
}
