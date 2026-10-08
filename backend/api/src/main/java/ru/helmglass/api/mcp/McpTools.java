package ru.helmglass.api.mcp;

import io.modelcontextprotocol.common.McpTransportContext;
import io.modelcontextprotocol.server.McpStatelessServerFeatures.SyncResourceSpecification;
import io.modelcontextprotocol.server.McpStatelessServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.spec.McpSchema;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Idempotency;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.artifacts.ArtifactService;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.browsers.BrowserService;
import ru.helmglass.api.connections.ConnectionService;
import ru.helmglass.api.tasks.ActionService;
import ru.helmglass.api.tasks.TaskService;
import tools.jackson.databind.JsonNode;

@Service
public class McpTools {
  private static final Logger log = LoggerFactory.getLogger(McpTools.class);
  private static final int AUDIO_LIMIT = 8 * 1024 * 1024;
  private static final int WIDGET_LIMIT = 1024 * 1024;
  private final Identity identity;
  private final TaskService tasks;
  private final ActionService actions;
  private final BrowserService browsers;
  private final ConnectionService connections;
  private final ArtifactService artifacts;
  private final ChatBindings chats;
  private final Idempotency idempotency;
  private final JsonSupport json;
  private final JdbcClient jdbc;
  private final String publicUrl;
  private final String widgetUri;
  private final String widgetHtml;

  public McpTools(
      Identity identity,
      TaskService tasks,
      ActionService actions,
      BrowserService browsers,
      ConnectionService connections,
      ArtifactService artifacts,
      ChatBindings chats,
      Idempotency idempotency,
      JsonSupport json,
      JdbcClient jdbc,
      @Value("${helm.public-url}") String publicUrl) {
    this.identity = identity;
    this.tasks = tasks;
    this.actions = actions;
    this.browsers = browsers;
    this.connections = connections;
    this.artifacts = artifacts;
    this.chats = chats;
    this.idempotency = idempotency;
    this.json = json;
    this.jdbc = jdbc;
    this.publicUrl = publicUrl;
    try (var stream = new ClassPathResource("mcp-widget/index.html").getInputStream()) {
      byte[] bytes = stream.readNBytes(WIDGET_LIMIT + 1);
      if (bytes.length > WIDGET_LIMIT) {
        throw new IOException("Widget resource exceeds its bound");
      }
      widgetHtml = new String(bytes, StandardCharsets.UTF_8);
      String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
      // Hosts cache UI resources by URI, independently of the current tool result.
      widgetUri = "ui://helmglass/task-" + digest + ".html";
    } catch (IOException | NoSuchAlgorithmException exception) {
      throw new IllegalStateException("Widget resource unavailable", exception);
    }
  }

  public List<SyncToolSpecification> specifications() {
    Map<String, Object> task = Map.of("taskId", uuid());
    Map<String, Object> presentation = Map.of("taskId", uuid(), "generation", uuid());
    List<SyncToolSpecification> result = new ArrayList<>();
    result.add(
        tool(
            "tasks.list",
            "Список собственных задач с точным количеством и страницей.",
            listSchema(),
            true,
            false));
    result.add(
        tool(
            "connections.list",
            "Собственные подключения сайтов. Секреты не возвращаются.",
            listSchema(),
            true,
            false));
    result.add(
        tool(
            "connections.select",
            "Выбрать собственное подключение для задачи. Смена в открытом браузере требует"
                + " отдельного согласия пользователя на утрату незавершённой страницы.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "connectionId",
                    uuid(),
                    "operationKey",
                    key(),
                    "instructionRevision",
                    Map.of("type", "integer", "minimum", 1)),
                "taskId",
                "connectionId",
                "operationKey",
                "instructionRevision"),
            false,
            false));
    result.add(
        tool(
            "tasks.get",
            "Актуальное поручение, состояние, вопросы и результаты собственной задачи.",
            object(task, "taskId"),
            true,
            false));
    result.add(
        tool(
            "artifacts.list",
            "Сохранённые файлы собственной задачи: готовность, целостность, точное количество и"
                + " страница.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "page",
                    Map.of("type", "integer", "minimum", 1),
                    "pageSize",
                    Map.of("type", "integer", "enum", List.of(10, 20, 50))),
                "taskId"),
            true,
            false));
    result.add(
        tool(
            "tasks.create",
            "Создать порученную пользователем задачу и связать её с исходным чатом.",
            object(
                Map.of(
                    "operationKey",
                    key(),
                    "task",
                    object(
                        Map.of(
                            "title",
                            text(200),
                            "goal",
                            text(20000),
                            "startUrl",
                            text(4096),
                            "outputFormat",
                            choice("TEXT", "TABLE", "REPORT"),
                            "requireConfirmation",
                            bool(),
                            "preferredConnectionIds",
                            array(uuid(), 50),
                            "prepare",
                            bool()),
                        "title",
                        "goal")),
                "operationKey",
                "task"),
            false,
            false));
    result.add(
        tool(
            "tasks.view",
            "Показать актуальный виджет задачи в исходном чате. Не запускает браузер.",
            object(Map.of("taskId", uuid(), "operationKey", key()), "taskId", "operationKey"),
            false,
            false));
    result.add(
        tool(
            "tasks.command",
            "Изменить поручение, подготовить, приостановить, продолжить, остановить или завершить"
                + " по просьбе пользователя. Подтверждение действия выполняется в защищённом"
                + " кабинете.",
            object(
                Map.of("taskId", uuid(), "operationKey", key(), "command", commandSchema()),
                "taskId",
                "operationKey",
                "command"),
            false,
            false));
    result.add(
        tool(
            "tasks.ask",
            "Запросить недостающие сведения у пользователя, сохранив ожидание у задачи.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "operationKey",
                    key(),
                    "prompt",
                    text(20000),
                    "instructionRevision",
                    Map.of("type", "integer", "minimum", 1)),
                "taskId",
                "operationKey",
                "prompt",
                "instructionRevision"),
            false,
            false));
    result.add(
        tool(
            "browser.execute",
            "Выполнить один шаг Playwright. operationId сохраняется при повторе; при потере ответа"
                + " запрашивать operations.get. Не передавать пароли и коды: вход выполняется в"
                + " кабинете. captureAudio требует sourceId из listMedia, sourceRef и"
                + " sourceContext с идентификатором задания, точной инструкцией и вопросами.",
            object(Map.of("taskId", uuid(), "action", actionSchema()), "taskId", "action"),
            false,
            true));
    result.add(
        tool(
            "operations.get",
            "Проверить исход ранее отправленной операции без её повторения.",
            object(Map.of("operationId", uuid()), "operationId"),
            true,
            false));
    result.add(
        tool(
            "audio.get",
            "Получить сохранённый оригинал аудио как MCP AudioContent. Максимум 8 MiB без"
                + " обрезания. Если host не анализирует звук, сообщить ограничение; не заменять"
                + " анализ расшифровкой.",
            object(Map.of("taskId", uuid(), "artifactId", uuid()), "taskId", "artifactId"),
            true,
            false));
    result.add(
        tool(
            "results.publish",
            "Сохранить вывод, источники, файлы и строки таблицы порцией до 100. Частичный результат"
                + " явно описывает ограничения; не завершает задачу.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "operationKey",
                    key(),
                    "result",
                    resultSchema(),
                    "instructionRevision",
                    Map.of("type", "integer", "minimum", 1),
                    "rows",
                    array(Map.of("type", "object", "maxProperties", 100), 100)),
                "taskId",
                "operationKey",
                "result",
                "instructionRevision"),
            false,
            false));
    result.add(
        tool(
            "widget.state",
            "Прочитать состояние текущего поколения. Для устаревшего поколения возвращается"
                + " только {code: STALE_WIDGET, message}, без данных задачи и нового поколения.",
            object(presentation, "taskId", "generation"),
            true,
            false));
    result.add(
        tool(
            "widget.claim",
            "Однократно получить право отправить запрос продолжения исходному host.",
            object(
                Map.of("taskId", uuid(), "generation", uuid(), "continuationId", uuid()),
                "taskId",
                "generation",
                "continuationId"),
            false,
            false));
    result.add(
        tool(
            "widget.browser",
            "Получить билет просмотра прежнего браузера. Ручной ввод доступен в кабинете.",
            object(
                Map.of("taskId", uuid(), "generation", uuid(), "viewerId", uuid()),
                "taskId",
                "generation",
                "viewerId"),
            false,
            false));
    result.add(
        tool(
            "widget.continuation",
            "Зафиксировать ответ host на запрос продолжения. Отправка не означает принятия"
                + " следующего шага.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "generation",
                    uuid(),
                    "continuationId",
                    uuid(),
                    "sent",
                    bool(),
                    "reason",
                    text(500)),
                "taskId",
                "generation",
                "continuationId",
                "sent"),
            false,
            false));
    return List.copyOf(result);
  }

  private SyncToolSpecification tool(
      String name,
      String description,
      Map<String, Object> schema,
      boolean readOnly,
      boolean openWorld) {
    Map<String, Object> metadata = new LinkedHashMap<>();
    metadata.put(
        "securitySchemes",
        List.of(Map.of("type", "oauth2", "scopes", List.of("openid", "offline_access"))));
    if (Set.of("tasks.view", "tasks.create").contains(name)) {
      metadata.put("ui", Map.of("resourceUri", widgetUri));
    } else if (name.startsWith("widget.")) {
      metadata.put("ui", Map.of("visibility", List.of("app")));
    }
    var builder =
        McpSchema.Tool.builder(name, schema)
            .description(description)
            .annotations(
                McpSchema.ToolAnnotations.builder()
                    .readOnlyHint(readOnly)
                    .destructiveHint(name.equals("browser.execute") || name.equals("tasks.command"))
                    .openWorldHint(openWorld)
                    .idempotentHint(true)
                    .build())
            .meta(metadata);
    if ("widget.state".equals(name)) {
      builder.outputSchema(McpSchemas.widgetState());
    } else if (Set.of("tasks.create", "tasks.view", "widget.continuation").contains(name)) {
      builder.outputSchema(McpSchemas.presentation());
    }
    return new SyncToolSpecification(builder.build(), (context, request) -> call(context, request));
  }

  private McpSchema.CallToolResult call(
      McpTransportContext context, McpSchema.CallToolRequest request) {
    try {
      Actor actor = actor(context);
      Map<String, Object> arguments = request.arguments() == null ? Map.of() : request.arguments();
      JsonNode input = json.tree(arguments);
      UUID owner = actor.id();
      String name = request.name();
      if ("tasks.list".equals(name)) {
        return textResult(tasks.list(owner, listQuery(arguments)));
      }
      if ("connections.list".equals(name)) {
        return textResult(connections.list(owner, listQuery(arguments)));
      }
      if ("operations.get".equals(name)) {
        return operation(owner, uuid(input, "operationId"));
      }
      if ("tasks.get".equals(name)) {
        return textResult(tasks.get(owner, uuid(input, "taskId")));
      }
      if ("artifacts.list".equals(name)) {
        return textResult(artifacts.list(owner, uuid(input, "taskId"), listQuery(arguments)));
      }
      String chat = ChatBindings.chatId(request.meta());
      if ("tasks.create".equals(name)) {
        var created =
            idempotency.execute(
                owner,
                string(input, "operationKey"),
                name,
                Map.of("arguments", arguments, "chatId", chat),
                ChatBindings.Presentation.class,
                () -> {
                  Contracts.TaskInput requested =
                      json.convert(input.path("task"), Contracts.TaskInput.class);
                  Contracts.Task task =
                      tasks.create(
                          owner,
                          new Contracts.TaskInput(
                              requested.title(),
                              requested.goal(),
                              requested.startUrl(),
                              requested.outputFormat(),
                              requested.requireConfirmation(),
                              requested.preferredConnectionIds(),
                              requested.prepare() == null || requested.prepare()),
                          "MCP");
                  return chats.show(owner, task.id(), chat);
                });
        return presentation(created);
      }
      UUID taskId = uuid(input, "taskId");
      if ("tasks.view".equals(name)) {
        return presentation(
            idempotency.execute(
                owner,
                string(input, "operationKey"),
                name,
                Map.of("arguments", arguments, "chatId", chat),
                ChatBindings.Presentation.class,
                () -> chats.show(owner, taskId, chat)));
      }
      chats.requireOriginal(owner, taskId, chat);
      return switch (name) {
        case "connections.select" ->
            textResult(
                idempotency.execute(
                    owner,
                    string(input, "operationKey"),
                    name,
                    arguments,
                    Contracts.Task.class,
                    () -> {
                      chats.acceptCommand(owner, taskId, chat);
                      return actions.selectConnection(
                          owner,
                          taskId,
                          input.path("instructionRevision").asLong(),
                          uuid(input, "connectionId"));
                    }));
        case "tasks.command" ->
            textResult(
                idempotency.execute(
                    owner,
                    string(input, "operationKey"),
                    name,
                    arguments,
                    Contracts.Task.class,
                    () -> {
                      chats.acceptCommand(owner, taskId, chat);
                      return tasks.command(
                          owner,
                          taskId,
                          json.convert(input.path("command"), Contracts.TaskCommand.class));
                    }));
        case "tasks.ask" ->
            textResult(
                idempotency.execute(
                    owner,
                    string(input, "operationKey"),
                    name,
                    arguments,
                    Contracts.Task.class,
                    () -> {
                      chats.acceptCommand(owner, taskId, chat);
                      tasks.ask(
                          owner,
                          taskId,
                          input.path("instructionRevision").asLong(),
                          string(input, "prompt"),
                          null);
                      return tasks.get(owner, taskId);
                    }));
        case "browser.execute" -> execute(owner, taskId, chat, input.path("action"));
        case "audio.get" -> audio(owner, taskId, uuid(input, "artifactId"));
        case "results.publish" ->
            textResult(
                idempotency.execute(
                    owner,
                    string(input, "operationKey"),
                    name,
                    arguments,
                    Contracts.Task.class,
                    () -> {
                      chats.acceptCommand(owner, taskId, chat);
                      List<JsonNode> rows = new ArrayList<>();
                      input.path("rows").forEach(rows::add);
                      actions.saveResult(
                          owner,
                          taskId,
                          input.path("instructionRevision").asLong(),
                          input.path("result"),
                          rows);
                      return tasks.get(owner, taskId);
                    }));
        case "widget.state" ->
            presentation(chats.state(owner, taskId, chat, uuid(input, "generation")));
        case "widget.claim" ->
            textResult(
                Map.of(
                    "claimed",
                    chats.claim(
                        owner,
                        taskId,
                        chat,
                        uuid(input, "generation"),
                        uuid(input, "continuationId"))));
        case "widget.browser" -> {
          var state = chats.state(owner, taskId, chat, uuid(input, "generation"));
          if (state.task().browser() == null) {
            throw ApiException.conflict("NO_BROWSER", "Браузер ещё не открыт.");
          }
          yield textResult(
              browsers.ticket(
                  actor,
                  state.task().browser().id(),
                  new Contracts.TicketInput("VIEWER", string(input, "viewerId"))));
        }
        case "widget.continuation" ->
            presentation(
                chats.reported(
                    owner,
                    taskId,
                    chat,
                    uuid(input, "generation"),
                    uuid(input, "continuationId"),
                    input.path("sent").asBoolean(),
                    input.path("reason").asString(null)));
        default -> throw ApiException.invalid("name", "Неизвестный инструмент.");
      };
    } catch (ApiException exception) {
      Map<String, String> failure =
          Map.of("code", exception.code(), "message", exception.getMessage());
      if ("widget.state".equals(request.name()) && "STALE_WIDGET".equals(exception.code())) {
        return McpSchema.CallToolResult.builder()
            .isError(false)
            .structuredContent(failure)
            .addTextContent(json.write(failure))
            .build();
      }
      return McpSchema.CallToolResult.builder()
          .isError(true)
          .addTextContent(json.write(failure))
          .build();
    } catch (IllegalArgumentException exception) {
      return McpSchema.CallToolResult.builder()
          .isError(true)
          .addTextContent("Некорректный запрос инструмента.")
          .build();
    } catch (RuntimeException exception) {
      // The SDK logs propagated messages; database and transport errors may contain private data.
      log.error("MCP tool failed: {}", exception.getClass().getSimpleName());
      return McpSchema.CallToolResult.builder()
          .isError(true)
          .addTextContent(
              json.write(
                  Map.of(
                      "code", "SERVICE_ERROR",
                      "message", "Не удалось выполнить запрос. Проверьте сохранённое состояние.")))
          .build();
    }
  }

  private Actor actor(McpTransportContext context) {
    if (!(context.get("jwt") instanceof Jwt jwt)) {
      throw Identity.denied("Требуется OAuth-доступ ChatGPT.");
    }
    Actor actor = identity.authenticate(jwt);
    if (!"MCP".equals(actor.channel())) {
      throw Identity.denied("Требуется независимый OAuth-доступ ChatGPT.");
    }
    return actor;
  }

  private McpSchema.CallToolResult execute(UUID owner, UUID task, String chat, JsonNode input) {
    Contracts.BrowserAction action = json.convert(input, Contracts.BrowserAction.class);
    Contracts.Operation result = actions.submit(owner, task, action);
    if (Set.of("ACCEPTED", "DISPATCHED", "SUCCEEDED").contains(result.status())) {
      chats.accepted(owner, task, chat, action.instructionRevision(), action.operationId());
    }
    return textResult(result);
  }

  private McpSchema.CallToolResult operation(UUID owner, UUID id) {
    Contracts.Operation operation = actions.result(owner, id);
    JsonNode result = operation.result();
    if ("screenshot".equals(operation.type())
        && "SUCCEEDED".equals(operation.status())
        && result != null
        && result.path("artifact").path("id").isString()) {
      UUID artifactId = UUID.fromString(result.path("artifact").path("id").asString());
      Contracts.Artifact artifact = artifacts.getReady(owner, artifactId);
      return McpSchema.CallToolResult.builder()
          .addTextContent(json.write(Map.of("operationId", id, "status", operation.status())))
          .addContent(
              McpSchema.ImageContent.builder(
                      Base64.getEncoder().encodeToString(originalBytes(owner, artifact)),
                      artifact.mimeType())
                  .build())
          .build();
    }
    return textResult(operation);
  }

  private McpSchema.CallToolResult audio(UUID owner, UUID task, UUID id) {
    tasks.get(owner, task);
    boolean belongs =
        jdbc.sql(
                "SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=:id AND owner_id=:owner AND"
                    + " task_id=:task)")
            .param("id", id)
            .param("owner", owner)
            .param("task", task)
            .query(Boolean.class)
            .single();
    if (!belongs) {
      throw ApiException.notFound();
    }
    Contracts.Artifact artifact = artifacts.getReady(owner, id);
    if (!artifact.mimeType().startsWith("audio/")) {
      throw ApiException.conflict(
          "AUDIO_MIME_UNCONFIRMED", "Формат исходника не подтверждён как аудио.");
    }
    if (artifact.sizeBytes() > AUDIO_LIMIT) {
      throw ApiException.conflict(
          "AUDIO_INLINE_LIMIT",
          "Оригинал сохранён без обрезания, но превышает предел передачи ChatGPT 8 MiB.");
    }
    return McpSchema.CallToolResult.builder()
        .addTextContent(
            json.write(
                Map.of(
                    "artifact",
                    artifact,
                    "instructionContext",
                    artifacts.audioContext(owner, id),
                    "originalBytes",
                    true)))
        .addContent(
            McpSchema.AudioContent.builder(
                    Base64.getEncoder().encodeToString(originalBytes(owner, artifact)),
                    artifact.mimeType())
                .build())
        .build();
  }

  private byte[] originalBytes(UUID owner, Contracts.Artifact artifact) {
    if (artifact.sizeBytes() > AUDIO_LIMIT) {
      throw ApiException.conflict(
          "CONTENT_INLINE_LIMIT",
          "Оригинал сохранён без обрезания, но превышает предел передачи 8 MiB.");
    }
    try (var stream = artifacts.openOwnerArtifact(owner, artifact.id())) {
      byte[] bytes = stream.readNBytes(AUDIO_LIMIT + 1);
      String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
      if (bytes.length != artifact.sizeBytes() || !hash.equals(artifact.sha256())) {
        throw ApiException.conflict(
            "CONTENT_INTEGRITY", "Контроль целостности оригинала не пройден.");
      }
      return bytes;
    } catch (IOException exception) {
      throw ApiException.conflict(
          "CONTENT_UNAVAILABLE", "Не удалось прочитать сохранённый оригинал.");
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException("SHA-256 is unavailable", exception);
    }
  }

  private McpSchema.CallToolResult presentation(ChatBindings.Presentation state) {
    String token =
        jdbc.sql("SELECT stream_token FROM mcp_chats WHERE generation=:generation")
            .param("generation", state.generation())
            .query(String.class)
            .optional()
            .orElse("");
    return McpSchema.CallToolResult.builder()
        .structuredContent(state)
        .addTextContent("Задача «" + state.task().title() + "»: " + state.task().status())
        .meta(
            Map.of(
                "publicUrl",
                publicUrl,
                "taskUrl",
                publicUrl + "/tasks/" + state.task().id(),
                "eventsUrl",
                publicUrl + "/widget/events?ticket=" + token))
        .build();
  }

  private McpSchema.CallToolResult textResult(Object value) {
    return McpSchema.CallToolResult.builder().addTextContent(json.write(value)).build();
  }

  public List<SyncResourceSpecification> resources() {
    var resource =
        McpSchema.Resource.builder(widgetUri, "Helm Glass task")
            .mimeType("text/html;profile=mcp-app")
            .build();
    return List.of(
        new SyncResourceSpecification(
            resource,
            (context, request) -> {
              actor(context);
              Map<String, Object> csp =
                  Map.of(
                      "connectDomains",
                      List.of(publicUrl),
                      "resourceDomains",
                      List.of(publicUrl),
                      "frameDomains",
                      List.of(publicUrl));
              var contents =
                  McpSchema.TextResourceContents.builder(widgetUri, widgetHtml)
                      .mimeType("text/html;profile=mcp-app")
                      .meta(
                          Map.of(
                              "ui",
                              Map.of("prefersBorder", true, "csp", csp),
                              "openai/widgetCSP",
                              Map.of("redirect_domains", List.of(publicUrl)),
                              "openai/widgetDescription",
                              "Исходная задача Helm Glass и просмотр того же браузера."))
                      .build();
              return McpSchema.ReadResourceResult.builder(List.of(contents)).build();
            }));
  }

  private static String string(JsonNode input, String name) {
    return input.path(name).asString();
  }

  private static UUID uuid(JsonNode input, String name) {
    return UUID.fromString(string(input, name));
  }

  private static Map<String, Object> text(int maximum) {
    return Map.of("type", "string", "maxLength", maximum);
  }

  private static Map<String, Object> uuid() {
    return Map.of("type", "string", "format", "uuid");
  }

  private static Map<String, Object> key() {
    return Map.of("type", "string", "minLength", 8, "maxLength", 128);
  }

  private static Map<String, Object> bool() {
    return Map.of("type", "boolean");
  }

  private static Map<String, Object> choice(String... values) {
    return Map.of("type", "string", "enum", List.of(values));
  }

  private static Map<String, Object> array(Map<String, Object> items, int maximum) {
    return Map.of("type", "array", "items", items, "maxItems", maximum);
  }

  private static Map<String, Object> object(Map<String, Object> properties, String... required) {
    return Map.of(
        "type",
        "object",
        "properties",
        properties,
        "required",
        List.of(required),
        "additionalProperties",
        false);
  }

  private static Map<String, Object> listSchema() {
    return object(
        Map.of(
            "search",
            text(300),
            "status",
            array(text(40), 50),
            "site",
            array(text(253), 50),
            "page",
            Map.of("type", "integer", "minimum", 1),
            "pageSize",
            Map.of("type", "integer", "enum", List.of(10, 20, 50)),
            "sort",
            text(40),
            "direction",
            choice("asc", "desc")));
  }

  private static ListQuery listQuery(Map<String, Object> input) {
    var values = new LinkedMultiValueMap<String, String>();
    input.forEach(
        (key, value) -> {
          if (value instanceof List<?> items) {
            items.forEach(item -> values.add(key, String.valueOf(item)));
          } else {
            values.add(key, String.valueOf(value));
          }
        });
    return ListQuery.from(values);
  }

  private static Map<String, Object> commandSchema() {
    return object(
        Map.ofEntries(
            Map.entry("type", choice("PREPARE", "AMEND", "PAUSE", "RESUME", "STOP", "FINISH")),
            Map.entry("expectedVersion", Map.of("type", "integer", "minimum", 1)),
            Map.entry("title", text(200)),
            Map.entry("goal", text(20000)),
            Map.entry("startUrl", text(4096)),
            Map.entry("outputFormat", choice("TEXT", "TABLE", "REPORT")),
            Map.entry("requireConfirmation", bool()),
            Map.entry("preferredConnectionIds", array(uuid(), 50)),
            Map.entry("confirmBrowserLoss", bool()),
            Map.entry("text", text(20000)),
            Map.entry("outcome", choice("SUCCEEDED", "PARTIAL", "NOT_ACHIEVED"))),
        "type",
        "expectedVersion");
  }

  private static Map<String, Object> actionSchema() {
    return object(
        Map.of(
            "operationId",
            uuid(),
            "type",
            choice(
                "navigate",
                "click",
                "fill",
                "press",
                "selectOption",
                "check",
                "scroll",
                "goBack",
                "reload",
                "newTab",
                "selectTab",
                "closeTab",
                "observe",
                "screenshot",
                "listMedia",
                "captureAudio",
                "waitFor"),
            "instructionRevision",
            Map.of("type", "integer", "minimum", 1),
            "controlEpoch",
            Map.of("type", "integer", "minimum", 0),
            "arguments",
            object(
                Map.ofEntries(
                    Map.entry("url", text(8192)),
                    Map.entry("selector", text(2000)),
                    Map.entry("text", text(20000)),
                    Map.entry("key", text(100)),
                    Map.entry("values", array(text(1000), 100)),
                    Map.entry("checked", bool()),
                    Map.entry("x", Map.of("type", "number")),
                    Map.entry("y", Map.of("type", "number")),
                    Map.entry("tabId", uuid()),
                    Map.entry("sourceId", uuid()),
                    Map.entry("sourceRef", text(1000)),
                    Map.entry(
                        "sourceContext",
                        object(
                            Map.of(
                                "assignmentId",
                                text(1000),
                                "instruction",
                                text(20000),
                                "questions",
                                array(text(4000), 100)),
                            "assignmentId",
                            "instruction",
                            "questions")),
                    Map.entry("name", text(240)),
                    Map.entry("state", choice("visible", "hidden", "attached", "detached"))))),
        "operationId",
        "type",
        "instructionRevision",
        "arguments");
  }

  private static Map<String, Object> resultSchema() {
    return object(
        Map.of(
            "summary",
            text(20000),
            "limitations",
            array(text(4000), 100),
            "sources",
            array(object(Map.of("title", text(500), "url", text(4096)), "title", "url"), 100),
            "columns",
            array(
                object(
                    Map.of(
                        "key", Map.of("type", "string", "pattern", "^[A-Za-z_][A-Za-z0-9_]{0,63}$"),
                        "label", text(200),
                        "type", choice("string", "number", "boolean", "date", "url")),
                    "key",
                    "label",
                    "type"),
                100)),
        "summary");
  }
}
