package ru.helmglass.api.mcp;

import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.events.EventService;

@RestController
public class WidgetEvents {
  private final JdbcClient jdbc;
  private final EventService events;

  public WidgetEvents(JdbcClient jdbc, EventService events) {
    this.jdbc = jdbc;
    this.events = events;
  }

  @CrossOrigin(originPatterns = "https://*.oaiusercontent.com", allowCredentials = "false")
  @GetMapping(value = "/widget/events", produces = "text/event-stream")
  public SseEmitter subscribe(
      @RequestParam String ticket,
      @RequestParam(required = false) Long cursor,
      @RequestHeader(value = "Last-Event-ID", required = false) Long lastEventId) {
    if (!ticket.matches("[0-9a-f]{64}")) {
      throw ApiException.notFound();
    }
    Binding binding = binding(ticket);
    return events.subscribe(
        binding.owner(),
        lastEventId == null ? cursor : lastEventId,
        () -> valid(ticket),
        event ->
            "sync".equals(event.resource())
                || binding.task().equals(event.entityId())
                || event.entityId() != null && event.entityId().equals(binding.browser())
                || "connection".equals(event.resource())
                    && isTaskConnection(binding, event.entityId()));
  }

  private boolean isTaskConnection(Binding binding, UUID connection) {
    return connection != null && jdbc.sql("""
        SELECT EXISTS(SELECT 1 FROM tasks t JOIN browser_sessions b ON b.id=t.browser_session_id
          WHERE t.id=:task AND t.owner_id=:owner AND b.owner_id=:owner
            AND b.connection_id=:connection)
        """)
        .param("task", binding.task()).param("owner", binding.owner())
        .param("connection", connection).query(Boolean.class).single();
  }

  private boolean valid(String token) {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM mcp_chats c JOIN accounts a ON a.id=c.owner_id
            WHERE c.stream_token=:token AND a.status='ACTIVE'
              AND (a.mcp_revoked_at IS NULL OR c.presented_at>a.mcp_revoked_at)
              AND (a.access_after IS NULL OR c.presented_at>a.access_after))
            """)
        .param("token", token)
        .query(Boolean.class)
        .single();
  }

  private Binding binding(String token) {
    if (!valid(token)) {
      throw ApiException.notFound();
    }
    return jdbc.sql(
            """
            SELECT c.owner_id,c.task_id,t.browser_session_id FROM mcp_chats c
            JOIN tasks t ON t.id=c.task_id WHERE c.stream_token=:token
            """)
        .param("token", token)
        .query(
            (row, index) ->
                new Binding(
                    row.getObject("owner_id", UUID.class),
                    row.getObject("task_id", UUID.class),
                    row.getObject("browser_session_id", UUID.class)))
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  private record Binding(UUID owner, UUID task, UUID browser) {}
}
