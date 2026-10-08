package ru.helmglass.api.accounts;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Idempotency;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.auth.Identity;
import tools.jackson.databind.JsonNode;

@RestController
@RequestMapping("/api/admin")
public class AdminController {
  private final Identity identity;
  private final AccountService accounts;
  private final NodeService nodes;
  private final Idempotency idempotency;
  private final JsonSupport json;

  public AdminController(
      Identity identity,
      AccountService accounts,
      NodeService nodes,
      Idempotency idempotency,
      JsonSupport json) {
    this.identity = identity;
    this.accounts = accounts;
    this.nodes = nodes;
    this.idempotency = idempotency;
    this.json = json;
  }

  @GetMapping("/users")
  Object users(@RequestParam MultiValueMap<String, String> query) {
    identity.administrator();
    return accounts.users(ListQuery.from(query), query.getOrDefault("flag", List.of()));
  }

  @GetMapping("/users/{id}")
  Object user(
      @PathVariable UUID id,
      @RequestParam(defaultValue = "1") int taskPage,
      @RequestParam(defaultValue = "1") int auditPage,
      @RequestParam(defaultValue = "20") int taskPageSize,
      @RequestParam(defaultValue = "20") int auditPageSize,
      @RequestParam(required = false) String timezone) {
    identity.administrator();
    return accounts.detail(id, taskPage, auditPage, taskPageSize, auditPageSize, timezone);
  }

  @PostMapping("/users/{id}/commands")
  Object command(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String key,
      @RequestBody Contracts.AdminCommand input) {
    Actor actor = identity.administrator();
    return idempotency.execute(
        actor.id(),
        key,
        "admin:user:" + id,
        input,
        JsonNode.class,
        () -> json.tree(accounts.command(actor, id, input)));
  }

  @GetMapping("/audit")
  Object audit(
      @RequestParam MultiValueMap<String, String> query,
      @RequestParam(required = false) UUID user) {
    identity.administrator();
    return accounts.audit(user, ListQuery.from(query), ListQuery.list(query, "action"));
  }

  @GetMapping("/nodes")
  Object nodes() {
    identity.administrator();
    return nodes.list();
  }

  @PostMapping("/nodes/{id}/commands")
  Object nodeCommand(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String key,
      @RequestBody Contracts.NodeCommand input) {
    Actor actor = identity.administrator();
    return idempotency.execute(
        actor.id(),
        key,
        "admin:node:" + id,
        input,
        JsonNode.class,
        () -> json.tree(nodes.command(actor, id, input)));
  }

  @PostMapping("/browsers/{id}/stop")
  Object stop(@PathVariable UUID id, @RequestHeader("Idempotency-Key") String key) {
    Actor actor = identity.administrator();
    return idempotency.execute(
        actor.id(),
        key,
        "admin:browser:stop:" + id,
        Map.of(),
        JsonNode.class,
        () -> json.tree(accounts.stopTaskBrowser(actor, id)));
  }
}
