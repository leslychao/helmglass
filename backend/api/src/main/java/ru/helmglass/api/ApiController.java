package ru.helmglass.api;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.multipart.MultipartHttpServletRequest;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import ru.helmglass.api.accounts.ProfileImage;
import ru.helmglass.api.artifacts.ArtifactService;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.browsers.BrowserService;
import ru.helmglass.api.connections.ConnectionService;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.events.NotificationService;
import ru.helmglass.api.tasks.TaskService;
import ru.helmglass.api.tasks.TaskStepService;
import ru.helmglass.api.usage.UsageService;
import tools.jackson.databind.JsonNode;

@RestController
@RequestMapping("/api")
public class ApiController {
  private final Identity identity;
  private final TaskService tasks;
  private final TaskStepService steps;
  private final BrowserService browsers;
  private final ConnectionService connections;
  private final NotificationService notifications;
  private final UsageService usage;
  private final EventService events;
  private final ArtifactService artifacts;
  private final Idempotency idempotency;
  private final JsonSupport json;
  private final ru.helmglass.api.tasks.TaskQueries taskQueries;
  private final ru.helmglass.api.accounts.AccountService accounts;
  private final String publicUrl;
  private final ProfileImage profileImages;

  public ApiController(
      Identity identity,
      TaskService tasks,
      TaskStepService steps,
      BrowserService browsers,
      ConnectionService connections,
      NotificationService notifications,
      UsageService usage,
      EventService events,
      ArtifactService artifacts,
      Idempotency idempotency,
      JsonSupport json,
      ru.helmglass.api.tasks.TaskQueries taskQueries,
      ru.helmglass.api.accounts.AccountService accounts,
      ProfileImage profileImages,
      @Value("${helm.public-url}") String publicUrl) {
    this.identity = identity;
    this.tasks = tasks;
    this.steps = steps;
    this.browsers = browsers;
    this.connections = connections;
    this.notifications = notifications;
    this.usage = usage;
    this.events = events;
    this.artifacts = artifacts;
    this.idempotency = idempotency;
    this.json = json;
    this.taskQueries = taskQueries;
    this.accounts = accounts;
    this.publicUrl = publicUrl;
    this.profileImages = profileImages;
  }

  @GetMapping("/me")
  Object me(HttpServletRequest request) {
    Actor actor = web();
    Object token = request.getAttribute(CsrfToken.class.getName());
    if (token instanceof CsrfToken csrf) {
      csrf.getToken();
    }
    return accounts.me(actor);
  }

  @PostMapping(value = "/me", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  Object saveProfile(
      @RequestHeader("Idempotency-Key") String key,
      @RequestParam String name,
      @RequestParam Long expectedVersion,
      @RequestPart(required = false) MultipartFile avatar,
      MultipartHttpServletRequest request)
      throws IOException {
    Actor actor = web();
    if (!java.util.Set.of("name", "expectedVersion").containsAll(request.getParameterMap().keySet())
        || !java.util.Set.of("avatar").containsAll(request.getMultiFileMap().keySet())
        || request.getParameterMap().values().stream().anyMatch(values -> values.length != 1)
        || request.getMultiFileMap().values().stream().anyMatch(values -> values.size() != 1)) {
      throw ApiException.invalid(
          "profile", "В запросе профиля есть неизвестные или повторяющиеся поля.");
    }
    Contracts.ProfileInput input = new Contracts.ProfileInput(name, expectedVersion);
    if (avatar == null) {
      return command(
          actor.id(),
          key,
          "profile:save",
          new ProfileSave(input, null, null, null),
          () -> accounts.updateProfile(actor, input, null));
    }
    try (var stream = avatar.getInputStream();
        var image =
            profileImages.validate(actor.id(), stream, avatar.getSize(), avatar.getContentType())) {
      return command(
          actor.id(),
          key,
          "profile:save",
          new ProfileSave(input, image.sha256(), image.contentType(), image.sizeBytes()),
          () -> accounts.updateProfile(actor, input, image));
    }
  }

  @GetMapping("/me/avatar")
  ResponseEntity<InputStreamResource> avatar(@RequestParam(required = false) UUID v) {
    var avatar = accounts.avatar(web(), v);
    return ResponseEntity.ok()
        .contentType(MediaType.parseMediaType(avatar.contentType()))
        .contentLength(avatar.sizeBytes())
        .cacheControl(CacheControl.noStore())
        .header("X-Content-Type-Options", "nosniff")
        .body(new InputStreamResource(avatar.content()));
  }

  private record ProfileSave(
      Contracts.ProfileInput profile, String sha256, String contentType, Integer sizeBytes) {}

  @PostMapping("/auth/logout")
  Object logout() {
    var receipt = identity.logout();
    return new Logout(
        receipt.status(),
        "COMPLETED".equals(receipt.status()) ? "/oauth2/sign_out?rd=/sign-in" : null,
        receipt.message());
  }

  @GetMapping("/tasks")
  Object tasks(@RequestParam MultiValueMap<String, String> query) {
    return tasks.list(web().id(), ListQuery.from(query));
  }

  @GetMapping("/tasks/summary")
  Object summary(@RequestParam MultiValueMap<String, String> query) {
    return taskQueries.summary(web().id(), ListQuery.from(query));
  }

  @PostMapping("/tasks")
  Object create(
      @RequestHeader("Idempotency-Key") String key, @RequestBody Contracts.TaskInput input) {
    UUID owner = web().id();
    return command(owner, key, "tasks:create", input, () -> tasks.create(owner, input, "WEB"));
  }

  @GetMapping("/tasks/{id}")
  Object task(@PathVariable UUID id) {
    return tasks.get(web().id(), id);
  }

  @PostMapping("/tasks/{id}/commands")
  Object taskCommand(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String key,
      @RequestBody Contracts.TaskCommand input) {
    Actor actor = web();
    UUID owner = actor.id();
    return command(
        owner,
        key,
        "tasks:" + id,
        input,
        () -> {
          if ("OPEN_BROWSER".equals(input.type())) {
            return browsers.openTaskBrowser(owner, id, input.expectedVersion());
          }
          if (input.type() != null
              && List.of("TAKE_CONTROL", "RETURN_CONTROL", "BEGIN_LOGIN", "FINISH_LOGIN")
                  .contains(input.type())) {
            Contracts.Task task = tasks.get(owner, id);
            if (input.expectedVersion() == null || input.expectedVersion() != task.version()) {
              throw ApiException.conflict("STALE_VERSION", "Задача изменилась.");
            }
            if (task.browser() == null) {
              throw ApiException.conflict(
                  "BROWSER_REQUIRED", "Сначала ChatGPT должен начать задачу.");
            }
            String type =
                switch (input.type()) {
                  case "TAKE_CONTROL" -> "TAKE";
                  case "RETURN_CONTROL" -> "RETURN";
                  default -> input.type();
                };
            var control =
                new Contracts.ControlInput(
                    type,
                    input.viewerId(),
                    input.resume(),
                    input.saveConnection(),
                    input.connectionId(),
                    input.accountLabel(),
                    input.accountSubject());
            if ("FINISH_LOGIN".equals(type)) {
              connections.finishTaskLogin(owner, task.browser().id(), control);
            } else {
              browsers.control(owner, task.browser().id(), control);
            }
            return tasks.get(owner, id);
          }
          return tasks.command(actor, id, input);
        });
  }

  @DeleteMapping("/tasks/{id}")
  Object deleteDraft(@PathVariable UUID id, @RequestHeader("Idempotency-Key") String key) {
    UUID owner = web().id();
    return command(owner, key, "tasks:delete:" + id, Map.of(), () -> tasks.deleteDraft(owner, id));
  }

  @GetMapping("/tasks/{id}/steps")
  Object steps(@PathVariable UUID id, @RequestParam MultiValueMap<String, String> values) {
    return steps.list(web().id(), id, values);
  }

  @GetMapping("/tasks/{id}/history")
  Object history(@PathVariable UUID id, @RequestParam MultiValueMap<String, String> values) {
    return taskQueries.history(web().id(), id, values);
  }

  @GetMapping("/tasks/sites")
  Object taskSites(@RequestParam MultiValueMap<String, String> values) {
    return taskQueries.sites(web().id(), ListQuery.from(values));
  }

  @GetMapping("/tasks/{id}/result/rows")
  Object rows(@PathVariable UUID id, @RequestParam MultiValueMap<String, String> values) {
    return taskQueries.rows(web().id(), id, values);
  }

  @GetMapping("/tasks/{id}/artifacts")
  Object artifacts(@PathVariable UUID id, @RequestParam MultiValueMap<String, String> values) {
    return artifacts.list(web().id(), id, ListQuery.from(values));
  }

  @GetMapping("/connections")
  Object connections(@RequestParam MultiValueMap<String, String> query) {
    return connections.list(web().id(), ListQuery.from(query));
  }

  @GetMapping("/connections/sites")
  Object connectionSites(@RequestParam MultiValueMap<String, String> values) {
    return connections.sites(web().id(), ListQuery.from(values));
  }

  @PostMapping("/connections")
  Object createConnection(
      @RequestHeader("Idempotency-Key") String key, @RequestBody Contracts.ConnectionInput input) {
    UUID owner = web().id();
    return command(owner, key, "connections:create", input, () -> connections.create(owner, input));
  }

  @GetMapping("/connections/{id}")
  Object connection(@PathVariable UUID id) {
    return connections.get(web().id(), id);
  }

  @PatchMapping("/connections/{id}")
  Object rename(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String key,
      @RequestBody Contracts.RenameInput input) {
    UUID owner = web().id();
    return command(
        owner, key, "connections:rename:" + id, input, () -> connections.rename(owner, id, input));
  }

  @DeleteMapping("/connections/{id}")
  Object deleteConnection(@PathVariable UUID id, @RequestHeader("Idempotency-Key") String key) {
    UUID owner = web().id();
    return command(
        owner,
        key,
        "connections:delete:" + id,
        Map.of(),
        () -> {
          connections.delete(owner, id);
          return Map.of("deleted", true);
        });
  }

  @PostMapping("/connections/{id}/login")
  Object login(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String key,
      @RequestBody Contracts.LoginInput input) {
    UUID owner = web().id();
    return command(
        owner, key, "connections:login:" + id, input, () -> connections.login(owner, id, input));
  }

  @PostMapping("/browser-sessions/{id}/ticket")
  Object ticket(@PathVariable UUID id, @RequestBody Contracts.TicketInput input) {
    return browsers.ticket(web(), id, input);
  }

  @PostMapping("/browser-sessions/{id}/control")
  Object control(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String key,
      @RequestBody Contracts.ControlInput input) {
    UUID owner = web().id();
    return command(
        owner, key, "browsers:control:" + id, input, () -> browsers.control(owner, id, input));
  }

  @PostMapping("/browser-sessions/{id}/login")
  Object browserLogin(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String key,
      @RequestBody Contracts.ControlInput input) {
    UUID owner = web().id();
    return command(owner, key, "browsers:login:" + id, input,
        () -> connections.sessionLogin(owner, id, input));
  }

  @GetMapping("/artifacts/{id}/download")
  ResponseEntity<StreamingResponseBody> download(@PathVariable UUID id) {
    UUID owner = web().id();
    Contracts.Artifact artifact = artifacts.getReady(owner, id);
    StreamingResponseBody body =
        output -> {
          try (var input = artifacts.openOwnerArtifact(owner, id)) {
            input.transferTo(output);
          }
        };
    return ResponseEntity.ok()
        .header(
            HttpHeaders.CONTENT_DISPOSITION,
            ContentDisposition.attachment()
                .filename(artifact.name(), java.nio.charset.StandardCharsets.UTF_8)
                .build()
                .toString())
        .header(HttpHeaders.CACHE_CONTROL, "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .contentType(MediaType.parseMediaType(artifact.mimeType()))
        .body(body);
  }

  @GetMapping("/notifications")
  Object notifications() {
    return notifications.list(web().id());
  }

  @PostMapping("/notifications/read")
  Object readNotifications(
      @RequestHeader("Idempotency-Key") String key,
      @RequestBody Contracts.ReadNotifications input) {
    UUID owner = web().id();
    return command(owner, key, "notifications:read", input, () -> notifications.read(owner, input));
  }

  @GetMapping("/usage")
  Object usage(
      @RequestParam MultiValueMap<String, String> query,
      @RequestParam(defaultValue = "1") int daysPage,
      @RequestParam(defaultValue = "1") int sitesPage,
      @RequestParam(defaultValue = "10") int pageSize) {
    ListQuery filter = ListQuery.from(query);
    return usage.report(
        web().id(),
        filter.from(),
        filter.to(),
        false,
        query.getFirst("timezone"),
        daysPage,
        sitesPage,
        pageSize,
        query.getFirst("sitesPageSize") == null ? pageSize : Integer.parseInt(query.getFirst("sitesPageSize")),
        query.getFirst("sitesSort"),
        !"desc".equals(query.getFirst("sitesDirection")));
  }

  @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  SseEmitter events(
      @RequestHeader(value = "Last-Event-ID", required = false) String last,
      @RequestParam(required = false) Long cursor,
      @org.springframework.security.core.annotation.AuthenticationPrincipal
          org.springframework.security.oauth2.jwt.Jwt jwt) {
    return events.subscribe(
        web().id(),
        last == null || last.isBlank() ? cursor : Long.valueOf(last),
        () -> identity.authorized(jwt),
        change -> true);
  }

  @GetMapping("/integrations/chatgpt")
  Object integration() {
    return accounts.integration(web().id(), publicUrl);
  }

  @PostMapping("/integrations/chatgpt/revoke")
  Object revokeMcp(@RequestHeader("Idempotency-Key") String key) {
    UUID owner = web().id();
    return command(
        owner,
        key,
        "mcp:revoke",
        Map.of(),
        () -> {
          return accounts.revokeMcp(owner);
        });
  }

  record Logout(String status, String redirectUrl, String message) {}

  private Actor web() {
    Actor actor = identity.current();
    if (!"WEB".equals(actor.channel())) {
      throw Identity.denied("Используйте разрешённые инструменты MCP.");
    }
    return actor;
  }

  private JsonNode command(
      UUID owner, String key, String scope, Object request, Supplier<?> action) {
    return idempotency.execute(
        owner, key, scope, request, JsonNode.class, () -> json.tree(action.get()));
  }
}
