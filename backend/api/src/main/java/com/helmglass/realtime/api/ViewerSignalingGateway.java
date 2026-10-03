package com.helmglass.realtime.api;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.api.WorkerSignalingGateway;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.realtime.application.IceServerService;
import com.helmglass.realtime.domain.ViewerFence;
import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class ViewerSignalingGateway extends TextWebSocketHandler {
  private record Viewer(
      UUID viewerId,
      UUID workerId,
      UUID workerBootId,
      long allocationEpoch,
      ChannelTicketService.TicketBinding binding,
      WebSocketSession socket,
      Instant authorizationExpiresAt) {}

  private final Map<String, Instant> pending = new ConcurrentHashMap<>();
  private final Map<String, WebSocketSession> sockets = new ConcurrentHashMap<>();
  private final Map<UUID, Viewer> viewers = new ConcurrentHashMap<>();
  private final Map<UUID, ViewerFence> pendingWebFences = new ConcurrentHashMap<>();
  private final ChannelTicketService tickets;
  private final IdentityRepository identities;
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final WorkerSignalingGateway workers;
  private final JsonSupport json;
  private final IceServerService ice;

  public ViewerSignalingGateway(
      ChannelTicketService tickets,
      IdentityRepository identities,
      BrowserRepository browsers,
      ControlRepository controls,
      WorkerSignalingGateway workers,
      JsonSupport json,
      IceServerService ice) {
    this.tickets = tickets;
    this.identities = identities;
    this.browsers = browsers;
    this.controls = controls;
    this.workers = workers;
    this.json = json;
    this.ice = ice;
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession socket) throws IOException {
    if (pending.size() >= 100) {
      socket.close(new CloseStatus(4429, "CHANNEL_LIMIT"));
      return;
    }
    socket.setTextMessageSizeLimit(65536);
    sockets.put(socket.getId(), new ConcurrentWebSocketSessionDecorator(socket, 3000, 262144));
    pending.put(socket.getId(), Instant.now().plusSeconds(5));
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message)
      throws IOException {
    var payload = json.read(message.getPayload());
    if (pending.containsKey(socket.getId())) {
      if (!payload.path("type").asString().equals("authenticate") || socket.getUri() == null) {
        socket.close(new CloseStatus(4401, "TICKET_REQUIRED"));
        return;
      }
      String path = socket.getUri().getPath();
      UUID sessionId = UUID.fromString(path.substring(path.lastIndexOf('/') + 1));
      try {
        var binding = tickets.consume(payload.path("ticket").asString(), "VIDEO", sessionId);
        var session = browsers.owned(binding.userId(), sessionId);
        UUID viewerId = binding.viewerInstanceId();
        synchronized (viewers) {
          long count =
              viewers.values().stream()
                  .filter(viewer -> viewer.binding().sessionId().equals(sessionId))
                  .count();
          if (count >= 2 || viewers.containsKey(viewerId)) {
            throw DomainException.conflict(
                "VIEWER_LIMIT", "Browser already has the maximum viewers");
          }
          var viewer =
              new Viewer(
                  viewerId,
                  session.workerId(),
                  session.workerBootId(),
                  session.allocationEpoch(),
                  binding,
                  sockets.get(socket.getId()),
                  binding.viewerAuthorizationExpiresAt());
          if (!authorized(viewer)) {
            throw new DomainException(403, "VIEW_REVOKED", "Browser view authorization changed");
          }
          viewers.put(viewerId, viewer);
          pending.remove(socket.getId());
          if (!workers.send(viewer.workerId(), leaseMessage(viewer, "viewOpen"))) {
            viewers.remove(viewerId);
            socket.close(new CloseStatus(4503, "STREAM_UNAVAILABLE"));
          }
        }
      } catch (DomainException error) {
        socket.close(new CloseStatus(error.getStatus() == 401 ? 4401 : 4403, error.getCode()));
      }
      return;
    }
    var viewer =
        viewers.values().stream()
            .filter(value -> value.socket().getId().equals(socket.getId()))
            .findFirst()
            .orElse(null);
    if (viewer == null || !authorized(viewer)) {
      socket.close(new CloseStatus(4403, "VIEW_REVOKED"));
      return;
    }
    Map<String, Object> signal = new HashMap<>(binding(viewer, UUID.randomUUID()).binding());
    signal.put("payload", payload);
    workers.send(viewer.workerId(), WorkerGateway.envelope("signal", UUID.randomUUID(), signal));
  }

  private boolean authorized(Viewer viewer) {
    var binding = viewer.binding();
    if (!viewer.authorizationExpiresAt().isAfter(Instant.now())
        || !identities.authorizationActive(
            binding.userId(), binding.loginId(), binding.grantId(), binding.accessEpoch())) {
      return false;
    }
    var session = browsers.owned(binding.userId(), binding.sessionId());
    var control = controls.get(binding.sessionId());
    if (!viewer.workerId().equals(session.workerId())
        || !viewer.workerBootId().equals(session.workerBootId())
        || viewer.allocationEpoch() != session.allocationEpoch()) {
      return false;
    }
    boolean privateAuthorized =
        binding.purpose().equals("PRIVATE_VIDEO")
            && binding.loginId() != null
            && binding.controllerInstanceId() != null
            && binding.controllerInstanceId().equals(control.controllerInstanceId())
            && control.ownerKind().equals("HUMAN")
            && control.expiresAt().isAfter(Instant.now());
    return session.state().equals("ACTIVE")
        && (session.privacy().equals("NORMAL") || privateAuthorized)
        && session.privacyEpoch() == binding.privacyEpoch()
        && control.state().equals("ACTIVE")
        && session.mediaGeneration() == binding.mediaGeneration()
        && control.epoch() == binding.controlEpoch();
  }

  private Map<String, Object> leaseMessage(Viewer viewer, String type) {
    var binding = viewer.binding();
    var session = browsers.owned(binding.userId(), binding.sessionId());
    Map<String, Object> message = new HashMap<>();
    message.put("viewerId", viewer.viewerId());
    message.put("workerBootId", viewer.workerBootId());
    message.put("browserSessionId", session.id());
    message.put("allocationEpoch", session.allocationEpoch());
    message.put("controlEpoch", controls.get(session.id()).epoch());
    message.put("pageEpoch", session.pageEpoch());
    message.put("privacyEpoch", session.privacyEpoch());
    message.put("mediaGeneration", binding.mediaGeneration());
    message.put("viewGeneration", binding.viewGeneration());

    message.put("leaseExpiresAt", Instant.now().plusSeconds(5));
    if (type.equals("viewOpen")) {
      message.put("surface", binding.grantId() == null ? "WEB" : "WIDGET");
      message.put("controllerInstance", binding.controllerInstanceId());
      if (binding.controllerInstanceId() == null) {
        message.remove("controllerInstance");
      }
      message.put(
          "iceServers",
          ice.forViewer(binding.userId(), viewer.viewerId(), viewer.authorizationExpiresAt()));
      message.put(
          "producerIceServer",
          ice.forProducer(binding.userId(), viewer.viewerId(), viewer.authorizationExpiresAt()));
      message.put("mediaProxy", ice.mediaProxy());
    }
    return WorkerGateway.envelope(type, UUID.randomUUID(), message);
  }

  @Scheduled(fixedDelay = 1000)
  public void renew() {
    for (var entry : pending.entrySet()) {
      if (!entry.getValue().isAfter(Instant.now())) {
        close(sockets.get(entry.getKey()), 4401, "TICKET_TIMEOUT");
      }
    }
    for (Viewer viewer : viewers.values()) {
      try {
        if (!authorized(viewer)
            || !workers.send(viewer.workerId(), leaseMessage(viewer, "viewRenew"))) {
          close(viewer.socket(), 4403, "VIEW_REVOKED");
        }
      } catch (RuntimeException error) {
        close(viewer.socket(), 4503, "AUTHORIZATION_UNAVAILABLE");
      }
    }
  }

  @EventListener
  public void message(WorkerSignalingGateway.ViewerMessage event) {
    Viewer viewer = viewers.get(event.binding().viewerId());
    if (viewer == null || !sameBinding(viewer, event.binding())) {
      return;
    }
    try {
      if (!authorized(viewer)) {
        close(viewer.socket(), 4403, "VIEW_REVOKED");
      } else if (event.payload() != null) {
        viewer.socket().sendMessage(new TextMessage(json.write(event.payload())));
      } else {
        close(viewer.socket(), 4503, event.code());
      }
    } catch (IOException error) {
      close(viewer.socket(), 4503, "STREAM_UNAVAILABLE");
    }
  }

  @EventListener
  public void physicallyClosed(WorkerSignalingGateway.ViewerClosed event) {
    ViewerFence expected = pendingWebFences.get(event.binding().requestId());
    if (expected != null && expected.equals(event.binding())) {
      workers.send(
          expected.workerId(),
          WorkerGateway.envelope("viewerClosedAck", expected.requestId(), expected.binding()));
      pendingWebFences.remove(expected.requestId(), expected);
    }
    Viewer viewer = viewers.get(event.binding().viewerId());
    if (viewer != null && sameBinding(viewer, event.binding())) {
      close(viewer.socket(), 4412, "PRESENTATION_SUPERSEDED");
    }
  }

  @EventListener
  public void disconnected(WorkerSignalingGateway.WorkerDisconnected event) {
    viewers.values().stream()
        .filter(viewer -> viewer.workerId().equals(event.workerId()))
        .forEach(viewer -> close(viewer.socket(), 4503, "WORKER_DISCONNECTED"));
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    pending.remove(socket.getId());
    sockets.remove(socket.getId());
    for (Viewer viewer : viewers.values()) {
      if (viewer.socket().getId().equals(socket.getId())
          && viewers.remove(viewer.viewerId(), viewer)) {
        ViewerFence fence = binding(viewer, UUID.randomUUID());
        if (pendingWebFences.size() < 1000) {
          pendingWebFences.put(fence.requestId(), fence);
          workers.send(
              viewer.workerId(),
              WorkerGateway.envelope("viewClose", fence.requestId(), fence.binding()));
        }
      }
    }
  }

  private static ViewerFence binding(Viewer viewer, UUID requestId) {
    return new ViewerFence(
        requestId,
        viewer.workerId(),
        viewer.workerBootId(),
        viewer.binding().sessionId(),
        viewer.allocationEpoch(),
        viewer.viewerId(),
        viewer.binding().viewGeneration());
  }

  private static boolean sameBinding(Viewer viewer, ViewerFence value) {
    return binding(viewer, value.requestId()).equals(value);
  }

  private static void close(WebSocketSession socket, int code, String reason) {
    if (socket == null) {
      return;
    }
    try {
      socket.close(new CloseStatus(code, reason));
    } catch (IOException error) {
      // The socket is already unusable; media authorization still expires at the worker.
    }
  }
}
