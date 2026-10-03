package com.helmglass.command.api;

import com.helmglass.api.MutationContext;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CommandController {
  private final CommandExecutionService commands;

  public CommandController(CommandExecutionService commands) {
    this.commands = commands;
  }

  @PostMapping("/api/v1/tasks/{id}/commands")
  @ResponseStatus(HttpStatus.ACCEPTED)
  MutationReceipt accept(@PathVariable UUID id, @Valid @RequestBody CommandContracts.Submit input,
      HttpServletRequest request) {
    return commands.accept(Actors.current(request), id, input, MutationContext.from(request));
  }

  @GetMapping("/api/v1/commands/{id}")
  Map<String, Object> get(@PathVariable UUID id, HttpServletRequest request) {
    return commands.get(Actors.current(request), id);
  }
}
