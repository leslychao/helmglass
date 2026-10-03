package com.helmglass.browser.api;

import com.helmglass.api.JsonSupport;
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
import tools.jackson.databind.JsonNode;

@Component
public class WorkerSignalingGateway extends TextWebSocketHandler {
  public record ViewerMessage(UUID workerId, UUID viewerId, JsonNode payload, String code) {}
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
    var previous = workers.put(id, new ConcurrentWebSocketSessionDecorator(socket, 3000, 524288));
    if (previous != null) {
      previous.close(new CloseStatus(4409, "WORKER_REPLACED"));
    }
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
    var value = json.read(message.getPayload());
    UUID workerId = UUID.fromString(socket.getHandshakeHeaders().getFirst("x-worker-id"));
    String type = value.path("type").asString();
    if (type.equals("viewerMessage") || type.equals("viewerClosed")) {
      events.publishEvent(new ViewerMessage(workerId, UUID.fromString(value.path("viewerId").asString()),
          value.get("payload"), value.path("code").asString()));
    }
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
    workers.computeIfPresent(id, (key, value) -> value.getId().equals(socket.getId()) ? null : value);
    events.publishEvent(new WorkerDisconnected(id));
  }
}
