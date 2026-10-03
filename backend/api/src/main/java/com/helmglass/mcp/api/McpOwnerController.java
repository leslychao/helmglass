package com.helmglass.mcp.api;

import com.helmglass.api.DomainException;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.continuation.api.ContinuationContracts;
import com.helmglass.task.application.ReconciliationService;
import com.helmglass.task.application.TaskContextService;
import com.helmglass.continuation.application.TaskPresentationService;
import com.helmglass.task.application.ActionRequestService;
import com.helmglass.task.api.ActionRequestContracts;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.command.api.CommandContracts;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.connection.api.ConnectionContracts;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.application.OperationService;
import com.helmglass.media.application.MediaAnalysisService;
import com.helmglass.task.application.ResultService;
import com.helmglass.task.api.ResultContracts;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Validator;
import java.util.Set;
import java.util.UUID;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@RestController
@RequestMapping("/internal/mcp/tools")
public class McpOwnerController {
  public record ToolRequest(JsonNode arguments, UUID requestId) {}

  private final TaskLifecycleService tasks;
  private final CommandExecutionService commands;
  private final ConnectionService connections;
  private final OperationService operations;
  private final ResultService results;
  private final MediaAnalysisService media;
  private final TaskContinuationService continuations;
  private final ReconciliationService reconciliation;
  private final TaskContextService contexts;
  private final TaskPresentationService presentations;
  private final ActionRequestService requests;
  private final JsonSupport json;
  private final ObjectMapper mapper;
  private final Validator validator;

  public McpOwnerController(TaskLifecycleService tasks, CommandExecutionService commands,
      ConnectionService connections, OperationService operations, JsonSupport json,
      ObjectMapper mapper, Validator validator, ResultService results, MediaAnalysisService media, TaskContinuationService continuations, ReconciliationService reconciliation, TaskContextService contexts, TaskPresentationService presentations, ActionRequestService requests) {
    this.tasks = tasks;
    this.commands = commands;
    this.connections = connections;
    this.operations = operations;
    this.json = json;
    this.mapper = mapper;
    this.validator = validator;
    this.results = results;
    this.media = media;
    this.continuations = continuations;
    this.reconciliation = reconciliation;
    this.contexts = contexts;
    this.presentations = presentations;
    this.requests = requests;
  }

  @PostMapping("/{name}")
  Object call(@PathVariable String name, @RequestBody ToolRequest input, HttpServletRequest request) {
    var actor = Actors.current(request);
    if (!actor.mcp() || input.requestId() == null || input.arguments() == null) {
      throw new DomainException(400, "INVALID_MCP_DELEGATION", "MCP delegation is invalid");
    }
    JsonNode args = input.arguments();
    UUID taskId = args.has("taskId") ? UUID.fromString(args.get("taskId").asString()) : null;
    MutationContext context = args.has("idempotencyKey")
        ? new MutationContext(args.get("idempotencyKey").asString(), input.requestId()) : null;
    return switch (name) {
      case "tasks.create" -> tasks.create(actor, decode(args, TaskContracts.Create.class,
          Set.of("idempotencyKey", "title")), required(context));
      case "tasks.get" -> tasks.get(actor, required(taskId));
      case "tasks.context" -> contexts.get(actor, required(taskId), args.path("section").asString(),
          args.has("contextRef") ? args.path("contextRef").asString() : null,
          args.has("cursor") ? args.path("cursor").asString() : null, args.path("limit").asInt(20));
      case "tasks.list" -> tasks.list(actor, page(args, true));
      case "tasks.clarify" -> tasks.clarify(actor, required(taskId),
          decode(args, TaskContracts.Clarification.class, Set.of("taskId", "idempotencyKey")), required(context));
      case "tasks.resume" -> tasks.resume(actor, required(taskId),
          decode(args, TaskContracts.Resume.class, Set.of("taskId", "idempotencyKey")), required(context));
      case "tasks.view" -> presentations.view(actor, required(taskId), args.has("viewScopeId")
          ? UUID.fromString(args.path("viewScopeId").asString()) : null,
          args.path("expectedPresentationRevision").asLong(), required(context));
      case "browser.attach_view" -> presentations.attach(actor, required(taskId));
      case "continuations.prepare_message" -> presentations.prepareMessage(actor, required(taskId));
      case "continuations.record_delivery" -> throw DomainException.notFound();
      case "tasks.answer" -> requests.answer(actor, UUID.fromString(args.path("requestId").asString()),
          decode(args, ActionRequestContracts.Answer.class, Set.of("taskId", "idempotencyKey", "requestId")),
          required(context));
      case "tasks.continue" -> continuations.claim(actor, required(taskId),
          decode(args, ContinuationContracts.Claim.class, Set.of("taskId", "idempotencyKey")), required(context));
      case "tasks.reconcile" -> reconciliation.reconcile(actor, required(taskId),
          decode(args, TaskContracts.Reconcile.class, Set.of("taskId", "idempotencyKey")), required(context));
      case "tasks.stop" -> tasks.stop(actor, required(taskId), required(context));
      case "tasks.complete" -> tasks.complete(actor, required(taskId),
          decode(args, TaskContracts.Completion.class,
              Set.of("taskId", "idempotencyKey")), required(context));
      case "browser.observe", "browser.execute" -> {
        ObjectNode command = copy(args, Set.of("taskId", "idempotencyKey", "depth"));
        if (name.equals("browser.observe")) {
          ObjectNode action = mapper.createObjectNode().put("type", "OBSERVE");
          if (args.has("depth")) {
            action.set("depth", args.get("depth"));
          }
          command.set("action", action);
        }
        yield commands.accept(actor, required(taskId), decode(command, CommandContracts.Submit.class, Set.of()),
            required(context));
      }
      case "media.capture" -> {
        ObjectNode command = copy(args, Set.of("taskId", "idempotencyKey", "observationId", "mediaRef",
            "maxDurationSeconds", "maxBytes", "coverage", "startSeconds", "endSeconds"));
        ObjectNode action = mapper.createObjectNode().put("type", "READ_MEDIA");
        for (String field : Set.of("observationId", "mediaRef", "maxDurationSeconds", "maxBytes",
            "coverage", "startSeconds", "endSeconds")) {
          if (args.has(field)) {
            action.set(field, args.get(field));
          }
        }
        command.set("action", action);
        yield commands.accept(actor, required(taskId), decode(command, CommandContracts.Submit.class,
            Set.of()), required(context));
      }
      case "audio.get" -> media.get(actor, UUID.fromString(args.path("artifactId").asString()), required(taskId));
      case "audio.segments" -> media.segments(actor, UUID.fromString(args.path("artifactId").asString()),
          required(taskId), args.path("component").asString(), args.has("cursor") ? args.path("cursor").asString() : null,
          args.path("limit").asInt(100));
      case "results.publish" -> results.publish(actor, required(taskId),
          decode(args, ResultContracts.Publish.class, Set.of("taskId", "idempotencyKey")),
          required(context));
      case "commands.get" -> commands.get(actor, UUID.fromString(args.path("commandId").asString()));
      case "operations.get" -> operations.get(actor, UUID.fromString(args.path("operationId").asString()));
      case "operations.lookup" -> operations.lookup(actor, args.path("operationKind").asString(),
          args.path("idempotencyKey").asString());
      case "connections.list" -> connections.list(actor, page(args, false));
      case "connections.resolve" -> connections.resolve(actor, required(taskId),
          decode(args, ConnectionContracts.Resolve.class, Set.of("taskId", "idempotencyKey")), required(context));
      default -> throw new DomainException(422, "UNKNOWN_TOOL", "Tool is not supported by this API contract");
    };
  }

  private <T> T decode(JsonNode node, Class<T> type, Set<String> removed) {
    T value = json.convert(copy(node, removed), type);
    if (!validator.validate(value).isEmpty()) {
      throw new DomainException(422, "INVALID_TOOL_ARGUMENTS", "Tool arguments fail validation");
    }
    return value;
  }

  private ObjectNode copy(JsonNode node, Set<String> removed) {
    ObjectNode result = mapper.createObjectNode();
    node.properties().forEach(entry -> {
      if (!removed.contains(entry.getKey())) {
        result.set(entry.getKey(), entry.getValue());
      }
    });
    return result;
  }

  private static PageQuery page(JsonNode args, boolean tasks) {
    var query = new LinkedMultiValueMap<String, String>();
    for (String key : Set.of("page", "pageSize", "sort", "direction", "snapshot", "state", "status", "q")) {
      if (args.has(key)) {
        query.add(key, args.get(key).asString());
      }
    }
    if (args.has("search")) {
      query.set("q", args.path("search").asString());
    }
    if (args.has("snapshotToken")) {
      query.set("snapshot", args.path("snapshotToken").asString());
    }
    if (tasks && args.has("status")) {
      query.remove("status");
      query.set("state", args.path("status").asString());
    }
    return PageQuery.from(query);
  }

  private static <T> T required(T value) {
    if (value == null) {
      throw new DomainException(400, "MISSING_TOOL_ARGUMENT", "Required tool argument is missing");
    }
    return value;
  }
}
