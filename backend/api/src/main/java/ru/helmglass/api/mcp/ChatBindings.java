package ru.helmglass.api.mcp;

import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.tasks.TaskService;

@Service
public class ChatBindings {
  private final JdbcClient jdbc;
  private final TaskService tasks;

  public ChatBindings(JdbcClient jdbc, TaskService tasks) {
    this.jdbc = jdbc;
    this.tasks = tasks;
  }

  public static String chatId(Map<String, Object> metadata) {
    Object value = metadata == null ? null : metadata.get("openai/session");
    if (!(value instanceof String chat) || chat.isBlank() || chat.length() > 256) {
      throw ApiException.conflict(
          "CHAT_CONTEXT_UNAVAILABLE",
          "ChatGPT не передал идентификатор исходного чата. Откройте задачу в кабинете.");
    }
    return chat;
  }

  @Transactional
  public Presentation show(UUID owner, UUID task, String chat) {
    tasks.lockOwner(owner);
    tasks.get(owner, task);
    jdbc.sql(
            """
            INSERT INTO mcp_task_chats(task_id,owner_id,chat_id) VALUES (:task,:owner,:chat)
            ON CONFLICT (task_id) DO NOTHING
            """)
        .param("task", task)
        .param("owner", owner)
        .param("chat", chat)
        .update();
    requireOriginal(owner, task, chat);
    UUID generation = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO mcp_chats(owner_id,chat_id,task_id,generation,stream_token)
            VALUES (:owner,:chat,:task,:generation,:token)
            ON CONFLICT (owner_id,chat_id) DO UPDATE SET task_id=EXCLUDED.task_id,
              generation=EXCLUDED.generation,stream_token=EXCLUDED.stream_token,presented_at=now(),
              continuation_status=CASE WHEN mcp_chats.task_id=EXCLUDED.task_id
                THEN mcp_chats.continuation_status ELSE 'IDLE' END,
              continuation_revision=CASE WHEN mcp_chats.task_id=EXCLUDED.task_id
                THEN mcp_chats.continuation_revision ELSE NULL END,
              continuation_id=CASE WHEN mcp_chats.task_id=EXCLUDED.task_id
                THEN mcp_chats.continuation_id ELSE NULL END,
              continuation_requested_at=CASE WHEN mcp_chats.task_id=EXCLUDED.task_id
                THEN mcp_chats.continuation_requested_at ELSE NULL END,
              continuation_reason=NULL,updated_at=now()
            """)
        .param("owner", owner)
        .param("chat", chat)
        .param("task", task)
        .param("generation", generation)
        .param(
            "token",
            UUID.randomUUID().toString().replace("-", "")
                + UUID.randomUUID().toString().replace("-", ""))
        .update();
    return state(owner, task, chat, generation);
  }

  public void requireOriginal(UUID owner, UUID task, String chat) {
    String original =
        jdbc.sql(
                """
                SELECT chat_id FROM mcp_task_chats WHERE task_id=:task AND owner_id=:owner
                """)
            .param("task", task)
            .param("owner", owner)
            .query(String.class)
            .optional()
            .orElseThrow(
                () ->
                    ApiException.conflict(
                        "CHAT_NOT_BOUND", "Сначала откройте задачу через tasks.view."));
    if (!original.equals(chat)) {
      throw ApiException.conflict(
          "ORIGINAL_CHAT_REQUIRED", "Продолжите эту задачу в исходном чате.");
    }
  }

  public Presentation state(UUID owner, UUID task, String chat, UUID generation) {
    requireOriginal(owner, task, chat);
    return jdbc.sql(
            """
            SELECT continuation_status,continuation_revision,continuation_reason,continuation_id
            FROM mcp_chats WHERE owner_id=:owner AND chat_id=:chat
              AND task_id=:task AND generation=:generation
            """)
        .param("owner", owner)
        .param("chat", chat)
        .param("task", task)
        .param("generation", generation)
        .query(
            (row, index) ->
                new Presentation(
                    tasks.get(owner, task),
                    generation,
                    row.getObject("continuation_id", UUID.class),
                    row.getString("continuation_status"),
                    row.getObject("continuation_revision", Long.class),
                    row.getString("continuation_reason")))
        .optional()
        .orElseThrow(
            () ->
                ApiException.conflict(
                    "STALE_WIDGET",
                    "В этом чате уже открыт более новый виджет. Откройте актуальную задачу."));
  }

  @Transactional
  public boolean claim(UUID owner, UUID task, String chat, UUID generation, UUID continuation) {
    tasks.lockOwner(owner);
    Presentation current = state(owner, task, chat, generation);
    if (!"WAITING_CHATGPT".equals(current.task().status())
        || current.task().request() != null
        || current.task().browser() != null && current.task().browser().privateMode()) {
      return false;
    }
    return jdbc.sql(
                """
                UPDATE mcp_chats SET continuation_status='SENDING',updated_at=now()
                WHERE owner_id=:owner AND chat_id=:chat AND generation=:generation
                  AND continuation_status='PENDING' AND continuation_revision=:revision
                  AND continuation_id=:continuation
                """)
            .param("owner", owner)
            .param("chat", chat)
            .param("generation", generation)
            .param("continuation", continuation)
            .param("revision", current.task().instructionRevision())
            .update()
        == 1;
  }

  @Transactional
  public Presentation reported(
      UUID owner,
      UUID task,
      String chat,
      UUID generation,
      UUID continuation,
      boolean sent,
      String reason) {
    state(owner, task, chat, generation);
    if (reason != null && reason.length() > 500) {
      throw ApiException.invalid("reason", "Слишком длинное описание ограничения.");
    }
    jdbc.sql(
            """
UPDATE mcp_chats SET continuation_status=:status,continuation_reason=:reason,updated_at=now()
WHERE owner_id=:owner AND chat_id=:chat AND generation=:generation
  AND continuation_status='SENDING'
  AND continuation_id=:continuation
""")
        .param("status", sent ? "MESSAGE_SENT" : "UNAVAILABLE")
        .param("reason", reason)
        .param("owner", owner)
        .param("chat", chat)
        .param("generation", generation)
        .param("continuation", continuation)
        .update();
    return state(owner, task, chat, generation);
  }

  /** A rejected domain command must roll back this acknowledgement and its idempotency receipt. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void acceptCommand(UUID owner, UUID task, String chat) {
    requireOriginal(owner, task, chat);
    jdbc.sql(
            """
            UPDATE mcp_chats c SET continuation_status='ACCEPTED',continuation_reason=NULL,
              updated_at=now() FROM tasks t
            WHERE c.owner_id=:owner AND c.chat_id=:chat AND c.task_id=:task AND t.id=c.task_id
              AND c.continuation_revision=t.instruction_revision
              AND c.continuation_status IN ('PENDING','SENDING','MESSAGE_SENT','UNAVAILABLE')
            """)
        .param("owner", owner)
        .param("chat", chat)
        .param("task", task)
        .update();
  }

  @Transactional
  public void accepted(UUID owner, UUID task, String chat, long revision, UUID operation) {
    requireOriginal(owner, task, chat);
    jdbc.sql(
            """
UPDATE mcp_chats SET continuation_status='ACCEPTED',continuation_reason=NULL,updated_at=now()
WHERE owner_id=:owner AND chat_id=:chat AND task_id=:task
  AND continuation_revision=:revision
  AND continuation_status IN ('PENDING','SENDING','MESSAGE_SENT','UNAVAILABLE')
  AND EXISTS(SELECT 1 FROM operations o WHERE o.id=:operation AND o.owner_id=:owner
    AND o.task_id=:task AND o.created_at>=mcp_chats.continuation_requested_at)
""")
        .param("owner", owner)
        .param("chat", chat)
        .param("task", task)
        .param("revision", revision)
        .param("operation", operation)
        .update();
  }

  public record Presentation(
      Contracts.Task task,
      UUID generation,
      UUID continuationId,
      String continuationStatus,
      Long continuationRevision,
      String continuationReason) {}
}
