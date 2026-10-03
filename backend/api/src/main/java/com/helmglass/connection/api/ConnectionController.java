package com.helmglass.connection.api;

import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ConnectionController {
  private final ConnectionService connections;

  public ConnectionController(ConnectionService connections) {
    this.connections = connections;
  }

  @GetMapping("/api/v1/connections")
  PageResult<ConnectionContracts.ConnectionView> list(
      @RequestParam MultiValueMap<String, String> query, HttpServletRequest request) {
    return connections.list(Actors.current(request), PageQuery.from(query));
  }

  @GetMapping("/api/v1/connections/{id}")
  ConnectionContracts.ConnectionView get(@PathVariable UUID id, HttpServletRequest request) {
    return connections.get(Actors.current(request), id);
  }

  @PostMapping("/api/v1/connections")
  MutationReceipt create(
      @Valid @RequestBody ConnectionContracts.Create input, HttpServletRequest request) {
    return connections.create(Actors.current(request), input, MutationContext.from(request));
  }

  @PatchMapping("/api/v1/connections/{id}")
  MutationReceipt rename(
      @PathVariable UUID id,
      @Valid @RequestBody ConnectionContracts.Rename input,
      HttpServletRequest request) {
    return connections.rename(Actors.current(request), id, input, MutationContext.from(request));
  }

  @DeleteMapping("/api/v1/connections/{id}")
  MutationReceipt delete(@PathVariable UUID id, HttpServletRequest request) {
    return connections.delete(Actors.current(request), id, MutationContext.from(request));
  }

  @PostMapping("/api/v1/tasks/{id}/connection-resolution")
  Map<String, Object> resolve(
      @PathVariable UUID id,
      @Valid @RequestBody ConnectionContracts.Resolve input,
      HttpServletRequest request) {
    return connections.resolve(Actors.current(request), id, input, MutationContext.from(request));
  }

  @GetMapping("/api/v1/sites/suggestions")
  Map<String, Object> suggestions(
      @RequestParam String scope,
      @RequestParam(defaultValue = "") String q,
      @RequestParam(defaultValue = "3") int limit,
      @RequestParam(defaultValue = "") List<UUID> selectedId,
      @RequestParam(defaultValue = "") List<UUID> excludeId,
      HttpServletRequest request) {
    return connections.suggestions(Actors.current(request), scope, q, limit, selectedId, excludeId);
  }
}
