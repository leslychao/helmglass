package com.helmglass.browser.api;

import com.helmglass.api.JsonSupport;
import com.helmglass.realtime.domain.ViewerFence;
import java.io.IOException;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;

@Component
public class WorkerSignalingGateway extends TextWebSocketHandler {
  public record ViewerMessage(ViewerFence binding, JsonNode payload, String code) {}

  public record ViewerClosed(ViewerFence binding) {}

  public record WorkerDisconnected(UUID workerId) {}

  private final Map<UUID, WebSocketSession> workers = new ConcurrentHashMap<>();
  private final JsonSupport json;
  private final ApplicationEventPublisher events;

  public WorkerSignalingGateway(JsonSupport json, ApplicationEventPublisher events) {
    this.json = json;
    this.events = events;
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession socket) throws IOException {
    UUID id = UUID.fromString(socket.getHandshakeHeaders().getFirst("x-worker-id"));
    socket.setTextMessageSizeLimit(65536);
    var previous = workers.put(id, new ConcurrentWebSocketSessionDecorator(socket, 3000, 524288));
    if (previous != null) {
      previous.close(new CloseStatus(4409, "WORKER_REPLACED"));
    }
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message)
      throws IOException {
    UUID workerId = UUID.fromString(socket.getHandshakeHeaders().getFirst("x-worker-id"));
    WebSocketSession current = workers.get(workerId);
    if (current == null || !current.getId().equals(socket.getId())) {
      socket.close(new CloseStatus(4409, "WORKER_REPLACED"));
      return;
    }
    try {
      JsonNode value = json.read(message.getPayload());
      String type = value.path("type").asString();
      if (!type.equals("viewerMessage")
          && !type.equals("viewerEnded")
          && !type.equals("viewerClosed")) {
        return;
      }
      if (value.path("schemaVersion").asInt() != 1 || message.getPayloadLength() > 65536) {
        throw new IllegalArgumentException("Invalid worker signaling envelope");
      }
      ViewerFence binding =
          new ViewerFence(
              uuid(value, "requestId"),
              workerId,
              uuid(value, "workerBootId"),
              uuid(value, "browserSessionId"),
              positive(value, "allocationEpoch"),
              uuid(value, "viewerId"),
              positive(value, "viewGeneration"));
      if (!binding
          .workerBootId()
          .toString()
          .equals(socket.getHandshakeHeaders().getFirst("x-worker-boot-id"))) {
        throw new IllegalArgumentException(
            "Signaling boot does not match the authenticated worker");
      }
      if (type.equals("viewerClosed")) {
        if (!value.path("code").asString().equals("VIEW_CLOSED")) {
          throw new IllegalArgumentException("Invalid physical fence receipt");
        }
        events.publishEvent(new ViewerClosed(binding));
      } else {
        String code = value.path("code").asString();
        if (code.length() > 80) {
          throw new IllegalArgumentException("Invalid viewer termination code");
        }
        events.publishEvent(
            new ViewerMessage(
                binding, type.equals("viewerMessage") ? value.get("payload") : null, code));
      }
    } catch (JacksonException | IllegalArgumentException error) {
      socket.close(new CloseStatus(4400, "INVALID_SIGNALING_MESSAGE"));
    }
  }

  private static UUID uuid(JsonNode value, String name) {
    String text = value.path(name).asString();
    if (!text.matches(
        "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")) {
      throw new IllegalArgumentException("Invalid binding identifier");
    }
    return UUID.fromString(text);
  }

  private static long positive(JsonNode value, String name) {
    JsonNode number = value.path(name);
    if (!number.isIntegralNumber() || !number.canConvertToLong() || number.asLong() <= 0) {
      throw new IllegalArgumentException("Invalid binding generation");
    }
    return number.asLong();
  }

  public boolean send(UUID workerId, Map<String, Object> message) {
    var socket = workers.get(workerId);
    if (socket == null || !socket.isOpen()) {
      return false;
    }
    try {
      socket.sendMessage(new TextMessage(json.write(message)));
      return true;
    } catch (IOException error) {
      return false;
    }
  }

  @Scheduled(fixedDelay = 1000)
  public void expire() throws IOException {
    for (var socket : workers.values()) {
      if (!(socket.getAttributes().get("helm.workerCertificateExpiresAt") instanceof Instant expiry)
          || !expiry.isAfter(Instant.now())) {
        socket.close(new CloseStatus(4403, "WORKER_CERTIFICATE_EXPIRED"));
      }
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    UUID id = UUID.fromString(socket.getHandshakeHeaders().getFirst("x-worker-id"));
    WebSocketSession current = workers.get(id);
    if (current != null && current.getId().equals(socket.getId()) && workers.remove(id, current)) {
      events.publishEvent(new WorkerDisconnected(id));
    }
  }
}
