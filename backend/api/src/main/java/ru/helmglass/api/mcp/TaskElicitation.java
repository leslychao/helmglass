package ru.helmglass.api.mcp;

import io.modelcontextprotocol.server.McpSyncServerExchange;
import io.modelcontextprotocol.spec.McpSchema;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.connections.ConnectionSite;
import ru.helmglass.api.tasks.ActionService;
import ru.helmglass.api.tasks.TaskService;

/** Receives native user answers or delegates observed operation verification to its owner. */
@Service
public class TaskElicitation {
  private final TaskService tasks;
  private final ActionService actions;
  private final JdbcClient jdbc;
  private final ConnectionSite connectionSites;

  public TaskElicitation(
      TaskService tasks, ActionService actions, JdbcClient jdbc, ConnectionSite connectionSites) {
    this.tasks = tasks;
    this.actions = actions;
    this.jdbc = jdbc;
    this.connectionSites = connectionSites;
  }

  public Contracts.Task respond(McpSyncServerExchange exchange, Actor actor, String chat,
      UUID taskId, UUID requestId, long requestVersion, String operationKey,
      Contracts.OperationVerification verification) {
    if (verification != null) {
      return actions.verifyResult(
          actor, chat, taskId, requestId, requestVersion, operationKey, verification);
    }
    Contracts.Task task = tasks.get(actor.id(), taskId);
    if (task.request() != null && "UNKNOWN_RESULT".equals(task.request().type())) {
      throw ApiException.conflict("VERIFICATION_REQUIRED",
          "Выполните observe, затем tasks.respond с verification: outcome SUCCEEDED, FAILED"
              + " или UNCONFIRMED, evidence и observationOperationId. UNCONFIRMED разрешает"
              + " безопасное продолжение без повтора действия. Ответ пользователя не нужен.");
    }
    var capability = exchange.getClientCapabilities().elicitation();
    if (capability == null || capability.form() == null && capability.url() != null) {
      throw ApiException.conflict("ELICITATION_UNAVAILABLE",
          "Этот GPT-клиент не поддерживает нативный ответ пользователя. Запрос остаётся ожидающим.");
    }
    TaskService.ElicitationClaim claim =
        tasks.claimResponse(actor, taskId, chat, requestId, requestVersion, operationKey, null);
    if (claim == null) {
      return tasks.get(actor.id(), taskId);
    }
    try {
      McpSchema.ElicitFormRequest form = form(actor.id(), claim);
      McpSchema.ElicitResult response;
      try {
        // No transaction or database lock may span this human interaction.
        response = exchange.createElicitation(form);
      } catch (RuntimeException exception) {
        throw ApiException.conflict("ELICITATION_UNAVAILABLE",
            "Ответ GPT-клиента не получен. Запрос остаётся ожидающим; автоматического повтора нет.");
      }
      if (response.action() == McpSchema.ElicitResult.Action.CANCEL) {
        throw ApiException.conflict("ELICITATION_CANCELLED", "Пользователь закрыл запрос без ответа.");
      }
      String type = claim.request().type();
      if (response.action() == McpSchema.ElicitResult.Action.DECLINE) {
        if ("CONFIRMATION".equals(type)) {
          return actions.respond(actor, chat, claim, "REJECT", null, null);
        }
        throw ApiException.conflict("ELICITATION_DECLINED", "Пользователь отказался отвечать на запрос.");
      }
      if (response.action() != McpSchema.ElicitResult.Action.ACCEPT || response.content() == null) {
        throw ApiException.invalid("response", "GPT-клиент не передал допустимый ответ.");
      }
      Map<String, Object> content = response.content();
      return switch (type) {
        case "QUESTION" -> {
          requireFields(content, Set.of("answer"));
          yield actions.respond(actor, chat, claim, "ANSWER", text(content, "answer", 20000), null);
        }
        case "ACCOUNT_CHOICE" -> {
          requireFields(content, Set.of("connectionId"));
          UUID connection;
          try {
            connection = UUID.fromString(text(content, "connectionId", 36));
          } catch (IllegalArgumentException exception) {
            throw ApiException.invalid("connectionId", "Выберите предложенное подключение.");
          }
          yield actions.respond(actor, chat, claim, "CHOOSE_CONNECTION", null, connection);
        }
        case "CONFIRMATION" -> {
          requireFields(content, Set.of("proceed"));
          if (!(content.get("proceed") instanceof Boolean proceed)) {
            throw ApiException.invalid("proceed", "Нужно явное согласие или отказ.");
          }
          yield actions.respond(actor, chat, claim, proceed ? "CONFIRM" : "REJECT", null, null);
        }
        default -> throw ApiException.conflict("STALE_REQUEST", "Запрос больше не актуален.");
      };
    } finally {
      tasks.releaseResponse(actor.id(), claim);
    }
  }

  private McpSchema.ElicitFormRequest form(UUID owner, TaskService.ElicitationClaim claim) {
    Contracts.InteractionRequest request = claim.request();
    String message = request.prompt();
    Map<String, Object> properties;
    switch (request.type()) {
      case "QUESTION" -> properties = Map.of("answer",
          Map.of("type", "string", "title", "Ваш ответ", "minLength", 1, "maxLength", 20000));
      case "ACCOUNT_CHOICE" -> {
        List<Map<String, Object>> options = new ArrayList<>();
        request.options().forEach(option -> options.add(Map.of(
            "const", option.path("id").asString(), "title", option.path("label").asString())));
        if (options.isEmpty()) {
          String site = jdbc.sql("SELECT site FROM tasks WHERE id=:task AND owner_id=:owner")
              .param("task", claim.taskId()).param("owner", owner).query(String.class).single();
          for (Map<String, String> option : connectionSites.choices(owner, site, List.of())) {
            options.add(Map.of("const", option.get("id"), "title", option.get("label")));
          }
        }
        if (options.isEmpty()) {
          throw ApiException.conflict("NO_AVAILABLE_CONNECTION", "Подходящих подключений больше нет.");
        }
        properties = Map.of("connectionId",
            Map.of("type", "string", "title", "Аккаунт сайта", "oneOf", options));
      }
      case "CONFIRMATION" -> {
        String operation = jdbc.sql("""
            SELECT type || E'\n' || arguments::text FROM operations
            WHERE id=:operation AND owner_id=:owner AND task_id=:task
              AND status='AWAITING_CONFIRMATION' AND instruction_revision=:revision
            """).param("operation", request.operationId()).param("owner", owner)
            .param("task", claim.taskId()).param("revision", request.instructionRevision())
            .query(String.class).optional().orElseThrow(() ->
                ApiException.conflict("STALE_REQUEST", "Операция больше не ожидает подтверждения."));
        message += "\n\nКонкретное действие и его параметры:\n" + operation;
        properties = Map.of("proceed", Map.of("type", "boolean", "title", "Разрешить это действие"));
      }
      default -> throw ApiException.conflict("HOST_RESPONSE_UNAVAILABLE", "Нативный ответ недоступен.");
    }
    return McpSchema.ElicitFormRequest.builder(message, Map.of("type", "object",
        "properties", properties, "required", List.copyOf(properties.keySet()),
        "additionalProperties", false)).build();
  }

  private static void requireFields(Map<String, Object> content, Set<String> fields) {
    if (!fields.equals(content.keySet())) {
      throw ApiException.invalid("response", "Поля ответа не соответствуют показанному запросу.");
    }
  }

  private static String text(Map<String, Object> content, String field, int limit) {
    if (!(content.get(field) instanceof String value)) {
      throw ApiException.invalid(field, "Ответ должен содержать текст.");
    }
    return TaskService.required(value, field, limit);
  }
}
