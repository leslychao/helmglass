package ru.helmglass.api.mcp;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.tasks.TaskService;

@Service
public class ChatBindings {
  private final JdbcClient jdbc;

  public ChatBindings(JdbcClient jdbc) {
    this.jdbc = jdbc;
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
  public void bind(UUID owner, UUID task, String chat) {
    lockOwner(owner);
    requireOwned(owner, task);
    var original = original(owner, task);
    if (original.isPresent()) {
      requireOriginal(owner, task, chat);
      requireCurrent(owner, task, chat);
      return;
    }
    requireAvailable(owner, task, chat);
    jdbc.sql(
            """
            INSERT INTO mcp_task_chats(task_id,owner_id,chat_id) VALUES (:task,:owner,:chat)
            ON CONFLICT (task_id) DO NOTHING
            """)
        .param("task", task)
        .param("owner", owner)
        .param("chat", chat)
        .update();
    select(owner, task, chat);
  }

  /** Reopening is an explicit domain operation, never a side effect of displaying a card. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void activate(UUID owner, UUID task) {
    lockOwner(owner);
    var original = original(owner, task);
    if (original.isPresent()) {
      requireAvailable(owner, task, original.get());
      select(owner, task, original.get());
    }
  }

  public void requireAvailable(UUID owner, UUID task, String chat) {
    var occupied = jdbc.sql("""
        SELECT t.id FROM mcp_task_chats c JOIN tasks t ON t.id=c.task_id
        WHERE c.owner_id=:owner AND c.chat_id=:chat AND t.id<>:task
          AND t.status NOT IN (:terminal) ORDER BY t.created_at,t.id LIMIT 1
        """)
        .param("owner", owner).param("chat", chat).param("task", task)
        .param("terminal", TaskService.TERMINAL).query(UUID.class).optional();
    if (occupied.isPresent()) {
      throw ApiException.chatOccupied(occupied.get());
    }
  }

  private void select(UUID owner, UUID task, String chat) {
    jdbc.sql(
            """
            INSERT INTO mcp_chats(owner_id,chat_id,task_id,generation,stream_token)
            VALUES (:owner,:chat,:task,:generation,:token)
            ON CONFLICT (owner_id,chat_id) DO UPDATE SET task_id=EXCLUDED.task_id,
              generation=EXCLUDED.generation,stream_token=EXCLUDED.stream_token,presented_at=now(),
              continuation_status='IDLE',continuation_revision=NULL,continuation_id=NULL,
              continuation_requested_at=NULL,continuation_reason=NULL,updated_at=now()
            WHERE mcp_chats.task_id<>EXCLUDED.task_id
            """)
        .param("owner", owner)
        .param("chat", chat)
        .param("task", task)
        .param("generation", UUID.randomUUID())
        .param(
            "token",
            UUID.randomUUID().toString().replace("-", "")
                + UUID.randomUUID().toString().replace("-", ""))
        .update();
  }

  @Transactional
  public State show(UUID owner, UUID task, String chat) {
    lockOwner(owner);
    requireCurrent(owner, task, chat);
    UUID generation = UUID.randomUUID();
    jdbc.sql("""
        UPDATE mcp_chats SET generation=:generation,stream_token=:token,
          presented_at=now(),updated_at=now() WHERE owner_id=:owner AND chat_id=:chat
        """)
        .param("generation", generation)
        .param("token", UUID.randomUUID().toString().replace("-", "")
            + UUID.randomUUID().toString().replace("-", ""))
        .param("owner", owner).param("chat", chat).update();
    return state(owner, task, chat, generation);
  }

  private void lockOwner(UUID owner) {
    jdbc.sql("SELECT id FROM accounts WHERE id=:owner FOR UPDATE")
        .param("owner", owner).query(UUID.class).optional().orElseThrow(ApiException::notFound);
  }

  private void requireOwned(UUID owner, UUID task) {
    jdbc.sql("SELECT id FROM tasks WHERE owner_id=:owner AND id=:task")
        .param("owner", owner).param("task", task).query(UUID.class)
        .optional().orElseThrow(ApiException::notFound);
  }

  private Optional<String> original(UUID owner, UUID task) {
    return jdbc.sql("SELECT chat_id FROM mcp_task_chats WHERE task_id=:task AND owner_id=:owner")
        .param("task", task).param("owner", owner).query(String.class).optional();
  }

  public void requireCurrent(UUID owner, UUID task, String chat) {
    requireOriginal(owner, task, chat);
    UUID current = jdbc.sql("SELECT task_id FROM mcp_chats WHERE owner_id=:owner AND chat_id=:chat")
        .param("owner", owner).param("chat", chat).query(UUID.class).optional()
        .orElseThrow(() -> ApiException.conflict("CHAT_NOT_BOUND", "Привяжите задачу через tasks.bind."));
    if (!task.equals(current)) {
      requireAvailable(owner, task, chat);
      throw ApiException.conflict("TASK_NOT_CURRENT",
          "Это история прежней задачи. Для продолжения явно возобновите её через RESUME.");
    }
  }

  public void requireOriginal(UUID owner, UUID task, String chat) {
    requireOwned(owner, task);
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
                        "CHAT_NOT_BOUND", "Сначала явно привяжите задачу через tasks.bind."));
    if (!original.equals(chat)) {
      throw ApiException.conflict(
          "ORIGINAL_CHAT_REQUIRED", "Продолжите эту задачу в исходном чате.");
    }
  }

  public State state(UUID owner, UUID task, String chat, UUID generation) {
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
                new State(
                    task,
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
    lockOwner(owner);
    state(owner, task, chat, generation);
    return jdbc.sql(
                """
                UPDATE mcp_chats SET continuation_status='SENDING',updated_at=now()
                WHERE owner_id=:owner AND chat_id=:chat AND generation=:generation
                  AND continuation_status='PENDING'
                  AND continuation_id=:continuation
                  AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=mcp_chats.task_id
                    AND t.instruction_revision=mcp_chats.continuation_revision
                    AND t.status='WAITING_CHATGPT' AND NOT t.paused_explicitly
                    AND NOT EXISTS(SELECT 1 FROM task_requests r WHERE r.task_id=t.id AND r.status='PENDING')
                    AND NOT EXISTS(SELECT 1 FROM browser_sessions b WHERE b.id=t.browser_session_id AND b.private_mode))
                """)
            .param("owner", owner)
            .param("chat", chat)
            .param("generation", generation)
            .param("continuation", continuation)
            .update()
        == 1;
  }

  @Transactional
  public State reported(
      UUID owner,
      UUID task,
      String chat,
      UUID generation,
      UUID continuation,
      boolean sent,
      String reason) {
    lockOwner(owner);
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
    requireCurrent(owner, task, chat);
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

  public record State(
      UUID taskId,
      UUID generation,
      UUID continuationId,
      String continuationStatus,
      Long continuationRevision,
      String continuationReason) {}
}
