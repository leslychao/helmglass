package com.helmglass.realtime.api;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.api.WorkerSignalingGateway;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.realtime.application.ChannelTicketService.TicketBinding;
import com.helmglass.realtime.application.IceServerService;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.domain.ViewerFence;
import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
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
import tools.jackson.databind.JsonNode;

/** Browser surfaces share admission, signaling, and durable physical-fence delivery. */
@Slf4j
@Component
public class ViewerSignalingGateway extends TextWebSocketHandler {
  private record Viewer(
      UUID workerId,
      UUID workerBootId,
      long allocationEpoch,
      TicketBinding binding,
      WebSocketSession socket) {}

  private record Pending(WebSocketSession socket, Instant expiresAt, boolean widget) {}

  private final Map<String, Pending> pending = new ConcurrentHashMap<>();
  private final Map<UUID, Viewer> viewers = new ConcurrentHashMap<>();
  private final Semaphore connectionLimit = new Semaphore(1000);
  private final Semaphore pendingLimit = new Semaphore(100);
  private final ChannelTicketService tickets;
  private final IdentityRepository identities;
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final WorkerSignalingGateway workers;
  private final RealtimeDeliveryService realtime;
  private final JsonSupport json;
  private final IceServerService ice;
  private final String origin;
  private final String widgetOrigin;

  public ViewerSignalingGateway(
      ChannelTicketService tickets,
      IdentityRepository identities,
      BrowserRepository browsers,
      ControlRepository controls,
      WorkerSignalingGateway workers,
      RealtimeDeliveryService realtime,
      JsonSupport json,
      IceServerService ice,
      @Value("${helm.public-origin}") String origin,
      @Value("${helm.widget-origin:}") String widgetOrigin) {
    this.tickets = tickets;
    this.identities = identities;
    this.browsers = browsers;
    this.controls = controls;
    this.workers = workers;
    this.realtime = realtime;
    this.json = json;
    this.ice = ice;
    this.origin = origin;
    this.widgetOrigin = widgetOrigin;
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession socket) throws IOException {
    var uri = socket.getUri();
    boolean widget = uri != null && uri.getPath().startsWith("/stream/v1/widget/signaling/");
    String expectedOrigin = widget ? widgetOrigin : origin;
    if (uri == null
        || uri.getRawQuery() != null
        || expectedOrigin.isBlank()
        || !expectedOrigin.equals(socket.getHandshakeHeaders().getOrigin())
        || widget && socket.getHandshakeHeaders().getFirst("Authorization") != null) {
      socket.close(new CloseStatus(4403, "CHANNEL_ORIGIN_REJECTED"));
      return;
    }
    if (!connectionLimit.tryAcquire()) {
      socket.close(new CloseStatus(4429, "CHANNEL_LIMIT"));
      return;
    }
    if (!pendingLimit.tryAcquire()) {
      connectionLimit.release();
      socket.close(new CloseStatus(4429, "AUTHENTICATION_LIMIT"));
      return;
    }
    socket.setTextMessageSizeLimit(65536);
    pending.put(
        socket.getId(),
        new Pending(
            new ConcurrentWebSocketSessionDecorator(socket, 3000, 262144),
            Instant.now().plusSeconds(5),
            widget));
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
    try {
      if (message.getPayloadLength() > 65536) {
        close(socket, 4400, "MESSAGE_TOO_LARGE");
        return;
      }
      JsonNode payload = json.read(message.getPayload());
      Pending admission = pending.get(socket.getId());
      if (admission != null) {
        authenticate(admission, payload);
        return;
      }
      Viewer viewer =
          viewers.values().stream()
              .filter(value -> value.socket().getId().equals(socket.getId()))
              .findFirst()
              .orElse(null);
      if (viewer == null
          || !authorized(
              viewer, browsers.owned(viewer.binding().userId(), viewer.binding().sessionId()))) {
        return;
      }
      Map<String, Object> signal = new HashMap<>(binding(viewer, UUID.randomUUID()).binding());
      signal.put("payload", payload);
      if (!workers.send(
          viewer.workerId(), WorkerGateway.envelope("signal", UUID.randomUUID(), signal))) {
        close(socket, 4503, "STREAM_UNAVAILABLE");
      }
    } catch (DomainException error) {
      close(socket, error.getStatus() == 401 ? 4401 : 4403, error.getCode());
    } catch (JacksonException | IllegalArgumentException error) {
      close(socket, 4400, "INVALID_MESSAGE");
    } catch (DataAccessException error) {
      close(socket, 4503, "AUTHORIZATION_UNAVAILABLE");
    }
  }

  private void authenticate(Pending admission, JsonNode payload) {
    var socket = admission.socket();
    var uri = socket.getUri();
    if (!admission.expiresAt().isAfter(Instant.now())) {
      close(socket, 4401, "TICKET_TIMEOUT");
      return;
    }
    if (!payload.isObject()
        || payload.size() != 2
        || !payload.path("type").asString().equals("authenticate")
        || !payload.path("ticket").isString()
        || uri == null) {
      close(socket, 4401, "TICKET_REQUIRED");
      return;
    }
    String path = uri.getPath();
    UUID sessionId = UUID.fromString(path.substring(path.lastIndexOf('/') + 1));
    TicketBinding ticket = tickets.consume(payload.path("ticket").asString(), "VIDEO", sessionId);
    boolean widgetTicket =
        ticket.viewScopeId() != null
            && ticket.grantId() != null
            && ticket.loginId() == null
            && ticket.purpose().equals("NORMAL_VIDEO");
    boolean webTicket =
        ticket.viewScopeId() == null && ticket.grantId() == null && ticket.loginId() != null;
    if (!(admission.widget() ? widgetTicket : webTicket)
        || !Objects.equals(ticket.origin(), admission.widget() ? widgetOrigin : origin)) {
      close(socket, 4403, "TICKET_BINDING_MISMATCH");
      return;
    }
    if (!admission.widget()) {
      Object identity = socket.getAttributes().get(AuthenticatedActor.class.getName());
      if (!(identity instanceof AuthenticatedActor actor)
          || actor.mcp()
          || !ticket.userId().equals(actor.userId())
          || !Objects.equals(ticket.loginId(), actor.loginId())
          || ticket.accessEpoch() != actor.accessEpoch()) {
        close(socket, 4403, "TICKET_BINDING_MISMATCH");
        return;
      }
    }
    var session = browsers.owned(ticket.userId(), sessionId);
    var viewer =
        new Viewer(
            session.workerId(), session.workerBootId(), session.allocationEpoch(), ticket, socket);
    if (!authorized(viewer, session)) {
      return;
    }
    synchronized (viewers) {
      long count =
          viewers.values().stream()
              .filter(value -> value.binding().sessionId().equals(sessionId))
              .count();
      if (count >= 2 || viewers.containsKey(ticket.viewerInstanceId())) {
        close(socket, 4503, "VIEWER_LIMIT");
        return;
      }
      if (admission.widget() && !realtime.connectWidgetMedia(ticket)) {
        rejectWidget(viewer, "VIEW_ALREADY_ATTACHED");
        return;
      }
      if (!pending.remove(socket.getId(), admission)) {
        if (admission.widget()) {
          realtime.disconnectWidgetMedia(ticket);
        }
        return;
      }
      pendingLimit.release();
      viewers.put(ticket.viewerInstanceId(), viewer);
    }
    if (!workers.send(viewer.workerId(), leaseMessage(viewer, "viewOpen", session.pageEpoch()))) {
      close(socket, 4503, "STREAM_UNAVAILABLE");
    }
  }

  private boolean authorized(Viewer viewer, BrowserRepository.Session session) {
    TicketBinding ticket = viewer.binding();
    if (!ticket.viewerAuthorizationExpiresAt().isAfter(Instant.now())) {
      close(viewer.socket(), 4401, "AUTHORIZATION_EXPIRED");
      return false;
    }
    if (ticket.viewScopeId() != null) {
      if (!realtime.widgetMediaAuthorized(ticket)) {
        rejectWidget(viewer, "MEDIA_BINDING_CHANGED");
        return false;
      }
    } else if (!identities.authorizationActive(
        ticket.userId(), ticket.loginId(), null, ticket.accessEpoch())) {
      close(viewer.socket(), 4403, "VIEW_REVOKED");
      return false;
    }
    var control = controls.get(ticket.sessionId());
    boolean privateAuthorized =
        ticket.purpose().equals("PRIVATE_VIDEO")
            && ticket.loginId() != null
            && ticket.controllerInstanceId() != null
            && ticket.controllerInstanceId().equals(control.controllerInstanceId())
            && control.ownerKind().equals("HUMAN")
            && control.expiresAt().isAfter(Instant.now());
    boolean current =
        Objects.equals(viewer.workerId(), session.workerId())
            && Objects.equals(viewer.workerBootId(), session.workerBootId())
            && viewer.allocationEpoch() == session.allocationEpoch()
            && session.state().equals("ACTIVE")
            && (session.privacy().equals("NORMAL") || privateAuthorized)
            && session.privacyEpoch() == ticket.privacyEpoch()
            && control.state().equals("ACTIVE")
            && session.mediaGeneration() == ticket.mediaGeneration()
            && control.epoch() == ticket.controlEpoch();
    if (!current) {
      close(viewer.socket(), 4503, "MEDIA_BINDING_CHANGED");
    }
    return current;
  }

  private void rejectWidget(Viewer viewer, String fallback) {
    String reason = realtime.widgetRejection(viewer.binding()).orElse(fallback);
    int status =
        switch (reason) {
          case "AUTHORIZATION_EXPIRED" -> 4401;
          case "GRANT_REVOKED" -> 4403;
          case "PRESENTATION_SUPERSEDED" -> 4412;
          default -> 4503;
        };
    close(viewer.socket(), status, reason);
  }

  private Map<String, Object> leaseMessage(Viewer viewer, String type, long pageEpoch) {
    TicketBinding ticket = viewer.binding();
    Map<String, Object> message = new HashMap<>(binding(viewer, UUID.randomUUID()).binding());
    message.put("controlEpoch", ticket.controlEpoch());
    message.put("pageEpoch", pageEpoch);
    message.put("privacyEpoch", ticket.privacyEpoch());
    message.put("mediaGeneration", ticket.mediaGeneration());
    Instant deadline = Instant.now().plusSeconds(5);
    message.put(
        "leaseExpiresAt",
        deadline.isBefore(ticket.viewerAuthorizationExpiresAt())
            ? deadline
            : ticket.viewerAuthorizationExpiresAt());
    if (type.equals("viewOpen")) {
      message.put("surface", ticket.viewScopeId() == null ? "WEB" : "WIDGET");
      if (ticket.controllerInstanceId() != null) {
        message.put("controllerInstance", ticket.controllerInstanceId());
      }
      message.put(
          "iceServers",
          ice.forViewer(
              ticket.userId(), ticket.viewerInstanceId(), ticket.viewerAuthorizationExpiresAt()));
      message.put(
          "producerIceServer",
          ice.forProducer(
              ticket.userId(), ticket.viewerInstanceId(), ticket.viewerAuthorizationExpiresAt()));
      message.put("mediaProxy", ice.mediaProxy());
    }
    return WorkerGateway.envelope(type, UUID.randomUUID(), message);
  }

  @Scheduled(fixedDelay = 1000)
  public void renew() {
    for (Pending admission : pending.values()) {
      if (!admission.expiresAt().isAfter(Instant.now())) {
        close(admission.socket(), 4401, "TICKET_TIMEOUT");
      }
    }
    for (Viewer viewer : viewers.values()) {
      try {
        var session = browsers.owned(viewer.binding().userId(), viewer.binding().sessionId());
        if (authorized(viewer, session)
            && !workers.send(
                viewer.workerId(), leaseMessage(viewer, "viewRenew", session.pageEpoch()))) {
          close(viewer.socket(), 4503, "STREAM_UNAVAILABLE");
        }
      } catch (DomainException | DataAccessException error) {
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
      if (!authorized(
          viewer, browsers.owned(viewer.binding().userId(), viewer.binding().sessionId()))) {
        return;
      }
      if (event.payload() != null) {
        viewer.socket().sendMessage(new TextMessage(json.write(event.payload())));
      } else {
        close(viewer.socket(), 4503, event.code());
      }
    } catch (IOException | DataAccessException | DomainException error) {
      close(viewer.socket(), 4503, "STREAM_UNAVAILABLE");
    }
  }

  @EventListener
  public void physicallyClosed(WorkerSignalingGateway.ViewerClosed event) {
    Viewer viewer = viewers.get(event.binding().viewerId());
    if (viewer != null && sameBinding(viewer, event.binding())) {
      if (viewer.binding().viewScopeId() != null) {
        rejectWidget(viewer, "VIEW_LEASE_EXPIRED");
      } else {
        close(viewer.socket(), 4503, "STREAM_CLOSED");
      }
    }
  }

  @EventListener
  public void disconnected(WorkerSignalingGateway.WorkerDisconnected event) {
    for (Viewer viewer : viewers.values()) {
      if (viewer.workerId().equals(event.workerId())) {
        close(viewer.socket(), 4503, "WORKER_DISCONNECTED");
      }
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    remove(socket.getId());
  }

  private void remove(String socketId) {
    if (pending.remove(socketId) != null) {
      pendingLimit.release();
      connectionLimit.release();
    }
    for (Viewer viewer : viewers.values()) {
      if (!viewer.socket().getId().equals(socketId)
          || !viewers.remove(viewer.binding().viewerInstanceId(), viewer)) {
        continue;
      }
      connectionLimit.release();
      try {
        if (viewer.binding().viewScopeId() != null) {
          realtime.disconnectWidgetMedia(viewer.binding());
        } else {
          realtime.requestViewerFence(
              viewer.binding().userId(), binding(viewer, UUID.randomUUID()));
        }
      } catch (DataAccessException error) {
        // No further lease is sent. Native consumers independently expire within five seconds.
        log.warn("Viewer detach storage unavailable; worker lease will expire");
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
        viewer.binding().viewerInstanceId(),
        viewer.binding().viewGeneration());
  }

  private static boolean sameBinding(Viewer viewer, ViewerFence value) {
    return binding(viewer, value.requestId()).equals(value);
  }

  private void close(WebSocketSession socket, int code, String reason) {
    remove(socket.getId());
    try {
      socket.close(new CloseStatus(code, reason));
    } catch (IOException error) {
      log.debug("Viewer socket already disconnected; code={}", code);
    }
  }
}
