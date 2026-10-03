package com.helmglass.realtime.api;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.realtime.application.ChannelTicketService.TicketBinding;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.event.EventListener;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.core.JacksonException;

/** Bounded widget transport. The realtime owner alone admits and renews presentation authority. */
@Slf4j
@Component
public class WidgetEventGateway extends TextWebSocketHandler {
  private record Connection(WebSocketSession socket, Instant receivedAt, TicketBinding binding) {}

  private final Map<String, Connection> connections = new ConcurrentHashMap<>();
  private final Semaphore connectionLimit = new Semaphore(1000);
  private final Semaphore pendingLimit = new Semaphore(100);
  private final ChannelTicketService tickets;
  private final RealtimeDeliveryService realtime;
  private final JsonSupport json;
  private final String origin;

  public WidgetEventGateway(ChannelTicketService tickets, RealtimeDeliveryService realtime,
      JsonSupport json, @Value("${helm.widget-origin:}") String origin) {
    this.tickets = tickets;
    this.realtime = realtime;
    this.json = json;
    this.origin = origin;
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession socket) throws IOException {
    if (origin.isBlank() || !origin.equals(socket.getHandshakeHeaders().getOrigin())
        || socket.getUri() == null || socket.getUri().getRawQuery() != null
        || socket.getHandshakeHeaders().getFirst("Authorization") != null) {
      socket.close(new CloseStatus(4403, "CHANNEL_ORIGIN_REJECTED"));
      return;
    }
    if (!connectionLimit.tryAcquire()) {
      socket.close(new CloseStatus(4429, "CONNECTION_LIMIT"));
      return;
    }
    if (!pendingLimit.tryAcquire()) {
      connectionLimit.release();
      socket.close(new CloseStatus(4429, "AUTHENTICATION_LIMIT"));
      return;
    }
    socket.setTextMessageSizeLimit(4096);
    connections.put(socket.getId(), new Connection(
        new ConcurrentWebSocketSessionDecorator(socket, 3000, 65536), Instant.now(), null));
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message) throws IOException {
    Connection connection = connections.get(socket.getId());
    if (connection == null) {
      return;
    }
    try {
      var value = json.read(message.getPayload());
      if (!value.isObject() || message.getPayloadLength() > 4096) {
        throw new IllegalArgumentException("Invalid widget event message");
      }
      if (connection.binding() == null) {
        if (!value.path("type").asString().equals("authenticate") || value.size() != 2
            || socket.getUri() == null || !value.path("ticket").isString()) {
          close(connection, 4401, "TICKET_REQUIRED");
          return;
        }
        String path = socket.getUri().getPath();
        UUID taskId = UUID.fromString(path.substring(path.lastIndexOf('/') + 1));
        TicketBinding binding = tickets.consumeTaskEvents(value.path("ticket").asString(), taskId, origin);
        if (!realtime.connectWidgetEvents(binding)) {
          close(connection, 4412, "PRESENTATION_SUPERSEDED");
          return;
        }
        Connection authenticated = new Connection(connection.socket(), Instant.now(), binding);
        if (!connections.replace(socket.getId(), connection, authenticated)) {
          realtime.disconnectWidgetEvents(binding);
          return;
        }
        pendingLimit.release();
        authenticated.socket().sendMessage(new TextMessage("{\"type\":\"ready\"}"));
      } else if (value.path("type").asString().equals("ping") && value.size() == 1) {
        if (!realtime.renewWidget(connection.binding())) {
          close(connection, 4412, "PRESENTATION_SUPERSEDED");
          return;
        }
        connections.replace(socket.getId(), connection,
            new Connection(connection.socket(), Instant.now(), connection.binding()));
        connection.socket().sendMessage(new TextMessage("{\"type\":\"pong\"}"));
      } else {
        close(connection, 4400, "INVALID_MESSAGE");
      }
    } catch (DomainException error) {
      close(connection, error.getStatus() == 401 ? 4401 : 4403, error.getCode());
    } catch (JacksonException | IllegalArgumentException error) {
      close(connection, 4400, "INVALID_MESSAGE");
    } catch (DataAccessException error) {
      close(connection, 4503, "AUTHORIZATION_UNAVAILABLE");
    }
  }

  @Scheduled(fixedDelay = 1000)
  public void expire() {
    Instant now = Instant.now();
    for (Connection connection : connections.values()) {
      if (connection.binding() == null) {
        if (!connection.receivedAt().plusSeconds(5).isAfter(now)) {
          close(connection, 4401, "TICKET_TIMEOUT");
        }
      } else if (!connection.receivedAt().plusSeconds(45).isAfter(now)) {
        close(connection, 4503, "HEARTBEAT_TIMEOUT");
      } else {
        authorized(connection);
      }
    }
  }

  @EventListener
  public void invalidate(RealtimeDeliveryService.TaskInvalidation event) {
    for (Connection connection : connections.values()) {
      TicketBinding binding = connection.binding();
      if (binding == null || !binding.userId().equals(event.userId())
          || !binding.taskId().equals(event.resourceId()) || !event.resources().contains("tasks")
          || !authorized(connection)) {
        continue;
      }
      try {
        connection.socket().sendMessage(new TextMessage(json.write(
            Map.of("type", "invalidate", "resources", List.of("task")))));
      } catch (IOException error) {
        close(connection, 4503, "DELIVERY_FAILED");
      }
    }
  }

  private boolean authorized(Connection connection) {
    try {
      var rejection = realtime.widgetRejection(connection.binding());
      if (rejection.isEmpty()) {
        return true;
      }
      String code = rejection.get();
      int status = switch (code) {
        case "AUTHORIZATION_EXPIRED" -> 4401;
        case "VIEW_LEASE_EXPIRED" -> 4503;
        case "GRANT_REVOKED" -> 4403;
        default -> 4412;
      };
      close(connection, status, code);
    } catch (DataAccessException error) {
      close(connection, 4503, "AUTHORIZATION_UNAVAILABLE");
    }
    return false;
  }

  private void close(Connection connection, int code, String reason) {
    remove(connection.socket().getId());
    try {
      connection.socket().close(new CloseStatus(code, reason));
    } catch (IOException error) {
      log.debug("Widget event socket already disconnected; code={}", code);
    }
  }

  private void remove(String id) {
    Connection removed = connections.remove(id);
    if (removed == null) {
      return;
    }
    connectionLimit.release();
    if (removed.binding() == null) {
      pendingLimit.release();
    } else {
      try {
        realtime.disconnectWidgetEvents(removed.binding());
      } catch (DataAccessException error) {
        log.debug("Widget event detach awaits the bounded lease expiry");
      }
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    remove(socket.getId());
  }
}
