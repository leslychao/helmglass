package com.helmglass.connection.api;

import com.helmglass.api.MutationContext;
import com.helmglass.connection.application.ConnectionLoginService;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class LoginController {
  private final ConnectionLoginService logins;

  public LoginController(ConnectionLoginService logins) {
    this.logins = logins;
  }

  @PostMapping("/connections/{id}/login")
  MutationReceipt begin(@PathVariable UUID id, @Valid @RequestBody LoginContracts.Begin input,
      HttpServletRequest request) {
    return logins.begin(Actors.current(request), id, input, MutationContext.from(request));
  }

  @GetMapping("/login-operations/{id}")
  Map<String, Object> get(@PathVariable UUID id, HttpServletRequest request) {
    return logins.get(Actors.current(request), id);
  }

  @PostMapping("/login-operations/{id}/complete")
  MutationReceipt complete(@PathVariable UUID id, @Valid @RequestBody LoginContracts.Complete input,
      HttpServletRequest request) {
    return logins.complete(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/login-operations/{id}/cancel")
  MutationReceipt cancel(@PathVariable UUID id, HttpServletRequest request) {
    return logins.cancel(Actors.current(request), id, MutationContext.from(request));
  }
}
