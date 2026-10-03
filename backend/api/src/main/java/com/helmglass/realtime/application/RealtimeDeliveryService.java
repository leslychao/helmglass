package com.helmglass.realtime.application;

import com.helmglass.api.JsonSupport;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.infrastructure.repository.OutboxRepository;
import java.io.IOException;
import java.time.Instant;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;

@Slf4j
@Component
public class RealtimeDeliveryService extends TextWebSocketHandler {
  private static final Set<String> ADMIN_RESOURCES =
      Set.of("users", "userTasks", "userDays", "nodes", "sessions", "audit");
  private static final Set<String> SELF_RESOURCES =
      Set.of(
          "tasks",
          "usage",
          "connections",
          "result",
          "events",
          "artifacts",
          "audio",
          "notifications",
          "sites",
          "operations",
          "browserSessions");
  private static final long SUBSCRIBE_TIMEOUT_NANOS = 5_000_000_000L;
  private static final long IDLE_TIMEOUT_NANOS = 45_000_000_000L;
  private final Map<String, Viewer> viewers = new ConcurrentHashMap<>();
  private final Semaphore connections = new Semaphore(1000);
  private final Semaphore pendingSubscriptions = new Semaphore(100);
  private final OutboxRepository outbox;
  private final IdentityRepository identities;
  private final JsonSupport json;

  private record Viewer(
      AuthenticatedActor actor,
      WebSocketSession socket,
      Instant expiresAt,
      long lastReceivedAt,
      Set<String> channels) {
    boolean subscribed() {
      return !channels.isEmpty();
    }
  }

  public RealtimeDeliveryService(
      OutboxRepository outbox, IdentityRepository identities, JsonSupport json) {
    this.outbox = outbox;
    this.identities = identities;
    this.json = json;
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession socket) throws IOException {
    Object value = socket.getAttributes().get(AuthenticatedActor.class.getName());
    Object expiry = socket.getAttributes().get("helm.authorizationExpiresAt");
    if (!(value instanceof AuthenticatedActor actor)
        || actor.mcp()
        || actor.loginId() == null
        || !(expiry instanceof Instant expiresAt)
        || !expiresAt.isAfter(Instant.now())) {
      socket.close(new CloseStatus(4401, "AUTHENTICATION_REQUIRED"));
      return;
    }
    if (!connections.tryAcquire()) {
      socket.close(new CloseStatus(4429, "CONNECTION_LIMIT"));
      return;
    }
    if (!pendingSubscriptions.tryAcquire()) {
      connections.release();
      socket.close(new CloseStatus(4429, "SUBSCRIPTION_LIMIT"));
      return;
    }
    socket.setTextMessageSizeLimit(4096);
    var bounded = new ConcurrentWebSocketSessionDecorator(socket, 5000, 65536);
    viewers.put(socket.getId(), new Viewer(actor, bounded, expiresAt, System.nanoTime(), Set.of()));
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message)
      throws IOException {
    Viewer viewer = viewers.get(socket.getId());
    if (viewer == null || !authorized(viewer)) {
      return;
    }
    if (message.getPayloadLength() > 4096) {
      close(viewer, 4400, "MESSAGE_TOO_LARGE");
      return;
    }
    JsonNode payload;
    try {
      payload = json.read(message.getPayload());
    } catch (JacksonException error) {
      close(viewer, 4400, "INVALID_MESSAGE");
      return;
    }
    String type = payload.path("type").asString();
    if (type.equals("subscribe") && payload.isObject() && payload.size() == 2) {
      subscribe(viewer, payload.path("channels"));
    } else if (type.equals("ping")
        && payload.isObject()
        && payload.size() == 1
        && viewer.subscribed()) {
      viewers.replace(
          socket.getId(),
          viewer,
          new Viewer(
              viewer.actor(),
              viewer.socket(),
              viewer.expiresAt(),
              System.nanoTime(),
              viewer.channels()));
      viewer.socket().sendMessage(new TextMessage(json.write(Map.of("type", "pong"))));
    } else {
      close(viewer, 4400, "INVALID_MESSAGE");
    }
  }

  private void subscribe(Viewer viewer, JsonNode requested) throws IOException {
    if (!requested.isArray() || requested.isEmpty() || requested.size() > 2) {
      close(viewer, 4400, "INVALID_CHANNELS");
      return;
    }
    Set<String> channels = new HashSet<>();
    for (JsonNode item : requested) {
      if (!item.isString()
          || !Set.of("self", "administration").contains(item.asString())
          || !channels.add(item.asString())) {
        close(viewer, 4400, "INVALID_CHANNELS");
        return;
      }
    }
    if (channels.contains("administration")
        && !viewer.actor().permissions().contains("platform_admin")) {
      close(viewer, 4403, "ADMIN_REQUIRED");
      return;
    }
    var subscribed =
        new Viewer(
            viewer.actor(),
            viewer.socket(),
            viewer.expiresAt(),
            System.nanoTime(),
            Set.copyOf(channels));
    if (viewers.replace(viewer.socket().getId(), viewer, subscribed)) {
      if (!viewer.subscribed()) {
        pendingSubscriptions.release();
      }
      viewer.socket().sendMessage(new TextMessage(json.write(Map.of("type", "ready"))));
    }
  }

  @Scheduled(fixedDelay = 500)
  public void relay() {
    for (Viewer viewer : viewers.values()) {
      authorized(viewer);
    }
    for (var intent : outbox.due()) {
      List<String> resources = resources(intent);
      for (Viewer viewer : viewers.values()) {
        boolean own =
            viewer.channels().contains("self") && viewer.actor().userId().equals(intent.userId());
        boolean administration = viewer.channels().contains("administration");
        List<String> visible =
            resources.stream()
                .filter(resource -> ADMIN_RESOURCES.contains(resource) ? administration : own)
                .toList();
        if (visible.isEmpty() || !authorized(viewer)) {
          continue;
        }
        try {
          viewer
              .socket()
              .sendMessage(
                  new TextMessage(json.write(Map.of("type", "invalidate", "resources", visible))));
        } catch (IOException error) {
          close(viewer, 4503, "DELIVERY_FAILED");
        }
      }
      outbox.published(intent.id());
    }
  }

  private List<String> resources(OutboxRepository.Intent intent) {
    Set<String> resources = new LinkedHashSet<>();
    if (SELF_RESOURCES.contains(intent.eventType())
        || ADMIN_RESOURCES.contains(intent.eventType())) {
      resources.add(intent.eventType());
    }
    JsonNode declared = json.read(intent.payload()).path("resources");
    if (declared.isArray()) {
      for (JsonNode value : declared) {
        if (value.isString()
            && (SELF_RESOURCES.contains(value.asString())
                || ADMIN_RESOURCES.contains(value.asString()))) {
          resources.add(value.asString());
        }
      }
    }
    return List.copyOf(resources);
  }

  private boolean authorized(Viewer viewer) {
    long timeout = viewer.subscribed() ? IDLE_TIMEOUT_NANOS : SUBSCRIBE_TIMEOUT_NANOS;
    if (System.nanoTime() - viewer.lastReceivedAt() >= timeout) {
      close(viewer, 4401, viewer.subscribed() ? "HEARTBEAT_TIMEOUT" : "SUBSCRIBE_TIMEOUT");
      return false;
    }
    if (!viewer.expiresAt().isAfter(Instant.now())) {
      close(viewer, 4401, "AUTHORIZATION_EXPIRED");
      return false;
    }
    var actor = viewer.actor();
    try {
      if (identities.authorizationActive(
          actor.userId(), actor.loginId(), null, actor.accessEpoch())) {
        return true;
      }
      close(viewer, 4403, "ACCESS_REVOKED");
    } catch (DataAccessException error) {
      close(viewer, 4503, "AUTHORIZATION_UNAVAILABLE");
    }
    return false;
  }

  private void close(Viewer viewer, int code, String reason) {
    remove(viewer.socket().getId());
    try {
      viewer.socket().close(new CloseStatus(code, reason));
    } catch (IOException error) {
      log.debug("Realtime socket already disconnected; code={}", code);
    }
  }

  private void remove(String id) {
    Viewer removed = viewers.remove(id);
    if (removed != null) {
      connections.release();
      if (!removed.subscribed()) {
        pendingSubscriptions.release();
      }
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    remove(socket.getId());
  }
}
