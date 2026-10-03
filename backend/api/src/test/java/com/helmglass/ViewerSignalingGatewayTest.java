package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.helmglass.api.JsonSupport;
import com.helmglass.browser.api.WorkerSignalingGateway;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.api.ViewerSignalingGateway;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.realtime.application.ChannelTicketService.TicketBinding;
import com.helmglass.realtime.application.IceServerService;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.domain.ViewerFence;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpHeaders;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class ViewerSignalingGatewayTest {
  private static final String WEB_ORIGIN = "https://helm.example.test";
  private static final String WIDGET_ORIGIN = "https://widget.example.test";
  private static final String TOKEN = "test-channel-ticket";
  private static final long ALLOCATION = 7;
  private static final long CONTROL = 11;
  private static final long PAGE = 13;
  private static final long PRIVACY = 17;
  private static final long MEDIA = 19;
  private static final long VIEW = 23;

  private enum Surface {
    WEB,
    PRIVATE,
    WIDGET
  }

  private final UUID userId = UUID.randomUUID();
  private final UUID sessionId = UUID.randomUUID();
  private final UUID workerId = UUID.randomUUID();
  private final UUID bootId = UUID.randomUUID();
  private final UUID viewerId = UUID.randomUUID();
  private final UUID controllerId = UUID.randomUUID();
  private final UUID loginId = UUID.randomUUID();
  private final ChannelTicketService tickets = mock(ChannelTicketService.class);
  private final IdentityRepository identities = mock(IdentityRepository.class);
  private final BrowserRepository browsers = mock(BrowserRepository.class);
  private final ControlRepository controls = mock(ControlRepository.class);
  private final WorkerSignalingGateway workers = mock(WorkerSignalingGateway.class);
  private final RealtimeDeliveryService realtime = mock(RealtimeDeliveryService.class);
  private final IceServerService ice = mock(IceServerService.class);
  private final BrowserRepository.Session session = mock(BrowserRepository.Session.class);
  private final ControlRepository.Lease control = mock(ControlRepository.Lease.class);
  private final JsonSupport json = new JsonSupport(JsonMapper.builder().build());
  private final ViewerSignalingGateway gateway =
      new ViewerSignalingGateway(
          tickets,
          identities,
          browsers,
          controls,
          workers,
          realtime,
          json,
          ice,
          WEB_ORIGIN,
          WIDGET_ORIGIN);

  ViewerSignalingGatewayTest() {
    when(browsers.owned(userId, sessionId)).thenReturn(session);
    when(controls.get(sessionId)).thenReturn(control);
    when(session.workerId()).thenReturn(workerId);
    when(session.workerBootId()).thenReturn(bootId);
    when(session.allocationEpoch()).thenReturn(ALLOCATION);
    when(session.pageEpoch()).thenReturn(PAGE);
    when(session.privacyEpoch()).thenReturn(PRIVACY);
    when(session.mediaGeneration()).thenReturn(MEDIA);
    when(session.state()).thenReturn("ACTIVE");
    when(session.privacy()).thenReturn("NORMAL");
    when(control.state()).thenReturn("ACTIVE");
    when(control.ownerKind()).thenReturn("AGENT");
    when(control.epoch()).thenReturn(CONTROL);
    when(control.expiresAt()).thenReturn(Instant.now().plusSeconds(60));
    when(identities.authorizationActive(userId, loginId, null, 1)).thenReturn(true);
    when(workers.send(eq(workerId), any())).thenReturn(true);
    when(ice.forViewer(eq(userId), eq(viewerId), any())).thenReturn(List.of());
    when(ice.forProducer(eq(userId), eq(viewerId), any())).thenReturn(Map.of());
    when(ice.mediaProxy()).thenReturn(Map.of());
  }

  @Test
  void rejectsForeignOriginQueryAndBearerBeforeConsumingATicket() throws Exception {
    var foreign = socket(Surface.WEB);
    foreign.getHandshakeHeaders().setOrigin(WIDGET_ORIGIN);
    var query = socket(Surface.WEB);
    when(query.getUri()).thenReturn(URI.create(webPath() + "?ticket=not-allowed"));
    var bearer = socket(Surface.WIDGET);
    bearer.getHandshakeHeaders().setBearerAuth("not-allowed");

    for (var socket : List.of(foreign, query, bearer)) {
      gateway.afterConnectionEstablished(socket);
      verify(socket).close(new CloseStatus(4403, "CHANNEL_ORIGIN_REJECTED"));
    }
    verifyNoInteractions(tickets, workers);
  }

  @Test
  void rejectsWebTicketsOnWidgetRouteAndWidgetTicketsOnWebRoute() throws Exception {
    var widgetRoute = socket(Surface.WIDGET);
    authenticate(widgetRoute, ticket(Surface.WEB));
    var webRoute = socket(Surface.WEB);
    authenticate(webRoute, ticket(Surface.WIDGET));

    verify(widgetRoute).close(new CloseStatus(4403, "TICKET_BINDING_MISMATCH"));
    verify(webRoute).close(new CloseStatus(4403, "TICKET_BINDING_MISMATCH"));
    verifyNoInteractions(browsers, workers);
  }

  @Test
  void distinguishesUnavailableWidgetMediaFromSupersededPresentation() throws Exception {
    TicketBinding binding = ticket(Surface.WIDGET);
    when(realtime.widgetMediaAuthorized(binding)).thenReturn(false);
    when(realtime.widgetRejection(binding)).thenReturn(Optional.empty());
    var unavailable = socket(Surface.WIDGET);
    authenticate(unavailable, binding);
    verify(unavailable).close(new CloseStatus(4503, "MEDIA_BINDING_CHANGED"));

    when(realtime.widgetRejection(binding)).thenReturn(Optional.of("PRESENTATION_SUPERSEDED"));
    var superseded = socket(Surface.WIDGET);
    authenticate(superseded, binding);
    verify(superseded).close(new CloseStatus(4412, "PRESENTATION_SUPERSEDED"));
    verify(realtime, never()).connectWidgetMedia(any());
    verifyNoInteractions(workers);
  }

  @Test
  void forwardsOnlyExactWorkerGenerationAndUsesThatBindingForSignalsAndClose() throws Exception {
    var socket = socket(Surface.WEB);
    authenticate(socket, ticket(Surface.WEB));
    JsonNode payload = json.read("{\"type\":\"peer\",\"sdp\":{\"type\":\"answer\"}}");
    List<ViewerFence> stale =
        List.of(
            fence(UUID.randomUUID(), bootId, sessionId, ALLOCATION, VIEW),
            fence(workerId, UUID.randomUUID(), sessionId, ALLOCATION, VIEW),
            fence(workerId, bootId, UUID.randomUUID(), ALLOCATION, VIEW),
            fence(workerId, bootId, sessionId, ALLOCATION - 1, VIEW),
            fence(workerId, bootId, sessionId, ALLOCATION, VIEW - 1));
    for (ViewerFence binding : stale) {
      gateway.message(new WorkerSignalingGateway.ViewerMessage(binding, payload, ""));
      gateway.physicallyClosed(new WorkerSignalingGateway.ViewerClosed(binding));
    }
    verify(socket, never()).sendMessage(any());
    verify(socket, never()).close(any());

    ViewerFence current = fence(workerId, bootId, sessionId, ALLOCATION, VIEW);
    gateway.message(new WorkerSignalingGateway.ViewerMessage(current, payload, ""));
    verify(socket).sendMessage(new TextMessage(json.write(payload)));
    gateway.handleMessage(socket, new TextMessage("{\"type\":\"peer\"}"));
    ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.captor();
    verify(workers, times(2)).send(eq(workerId), sent.capture());
    for (Map<String, Object> message : sent.getAllValues()) {
      assertThat(message)
          .containsEntry("workerBootId", bootId)
          .containsEntry("browserSessionId", sessionId)
          .containsEntry("allocationEpoch", ALLOCATION)
          .containsEntry("viewerId", viewerId)
          .containsEntry("viewGeneration", VIEW);
    }
    assertThat(sent.getAllValues().getFirst()).containsEntry("type", "viewOpen");
    assertThat(sent.getAllValues().getLast()).containsEntry("type", "signal");

    gateway.physicallyClosed(new WorkerSignalingGateway.ViewerClosed(current));
    verify(socket).close(new CloseStatus(4503, "STREAM_CLOSED"));
    ArgumentCaptor<ViewerFence> close = ArgumentCaptor.forClass(ViewerFence.class);
    verify(realtime).requestViewerFence(eq(userId), close.capture());
    assertThat(close.getValue().binding()).isEqualTo(current.binding());
  }

  @Test
  void revocationStopsForwardingAndPersistsTheExactWebFence() throws Exception {
    var socket = socket(Surface.WEB);
    authenticate(socket, ticket(Surface.WEB));
    when(identities.authorizationActive(userId, loginId, null, 1)).thenReturn(false);

    gateway.message(
        new WorkerSignalingGateway.ViewerMessage(
            fence(workerId, bootId, sessionId, ALLOCATION, VIEW), json.read("{}"), ""));
    gateway.renew();

    verify(socket).close(new CloseStatus(4403, "VIEW_REVOKED"));
    verify(socket, never()).sendMessage(any());
    verify(workers).send(eq(workerId), any());
    ArgumentCaptor<ViewerFence> close = ArgumentCaptor.forClass(ViewerFence.class);
    verify(realtime).requestViewerFence(eq(userId), close.capture());
    assertThat(close.getValue().binding())
        .isEqualTo(fence(workerId, bootId, sessionId, ALLOCATION, VIEW).binding());
  }

  @Test
  void privateVideoRequiresTheLiveHumanControllerAndCannotUseNormalTickets() throws Exception {
    when(session.privacy()).thenReturn("LOGIN_PRIVATE");
    when(control.ownerKind()).thenReturn("HUMAN");
    when(control.controllerInstanceId()).thenReturn(controllerId);
    var normal = socket(Surface.WEB);
    authenticate(normal, ticket(Surface.WEB));
    verify(normal).close(new CloseStatus(4503, "MEDIA_BINDING_CHANGED"));

    var privateViewer = socket(Surface.PRIVATE);
    authenticate(privateViewer, ticket(Surface.PRIVATE));
    verify(privateViewer, never()).close(any());
    ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.captor();
    verify(workers).send(eq(workerId), sent.capture());
    assertThat(sent.getValue()).containsEntry("controllerInstance", controllerId);

    when(control.controllerInstanceId()).thenReturn(UUID.randomUUID());
    gateway.renew();
    verify(privateViewer).close(new CloseStatus(4503, "MEDIA_BINDING_CHANGED"));
    verify(workers).send(eq(workerId), any());
    verify(realtime).requestViewerFence(eq(userId), any());
  }

  @Test
  void widgetConnectionUsesTheCanonicalMediaOwnerAndDisconnectsWithoutWebFence() throws Exception {
    TicketBinding binding = ticket(Surface.WIDGET);
    when(realtime.widgetMediaAuthorized(binding)).thenReturn(true);
    when(realtime.connectWidgetMedia(binding)).thenReturn(true);
    var socket = socket(Surface.WIDGET);
    authenticate(socket, binding);

    verify(realtime).connectWidgetMedia(binding);
    ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.captor();
    verify(workers).send(eq(workerId), sent.capture());
    assertThat(sent.getValue()).containsEntry("surface", "WIDGET");
    gateway.afterConnectionClosed(socket, CloseStatus.NORMAL);
    gateway.afterConnectionClosed(socket, CloseStatus.NORMAL);
    verify(realtime).disconnectWidgetMedia(binding);
    verify(realtime, never()).requestViewerFence(any(), any());
  }

  private void authenticate(WebSocketSession socket, TicketBinding binding) throws Exception {
    when(tickets.consume(TOKEN, "VIDEO", sessionId)).thenReturn(binding);
    gateway.afterConnectionEstablished(socket);
    gateway.handleMessage(
        socket, new TextMessage(json.write(Map.of("type", "authenticate", "ticket", TOKEN))));
  }

  private TicketBinding ticket(Surface surface) {
    boolean widget = surface == Surface.WIDGET;
    return new TicketBinding(
        userId,
        widget ? null : loginId,
        widget ? UUID.randomUUID() : null,
        1,
        UUID.randomUUID(),
        sessionId,
        viewerId,
        surface == Surface.PRIVATE ? controllerId : null,
        CONTROL,
        PAGE,
        PRIVACY,
        MEDIA,
        VIEW,
        surface == Surface.PRIVATE ? "PRIVATE_VIDEO" : "NORMAL_VIDEO",
        Instant.now().plusSeconds(30),
        Instant.now().plusSeconds(120),
        widget ? UUID.randomUUID() : null,
        1,
        widget ? 1 : 0,
        widget ? WIDGET_ORIGIN : WEB_ORIGIN);
  }

  private WebSocketSession socket(Surface surface) {
    WebSocketSession socket = mock(WebSocketSession.class);
    HttpHeaders headers = new HttpHeaders();
    headers.setOrigin(surface == Surface.WIDGET ? WIDGET_ORIGIN : WEB_ORIGIN);
    when(socket.getId()).thenReturn(UUID.randomUUID().toString());
    when(socket.getUri())
        .thenReturn(
            URI.create(
                surface == Surface.WIDGET
                    ? "wss://helm.example.test/stream/v1/widget/signaling/" + sessionId
                    : webPath()));
    when(socket.getHandshakeHeaders()).thenReturn(headers);
    when(socket.isOpen()).thenReturn(true);
    return socket;
  }

  private String webPath() {
    return "wss://helm.example.test/stream/v1/signaling/" + sessionId;
  }

  private ViewerFence fence(
      UUID worker, UUID boot, UUID session, long allocation, long generation) {
    return new ViewerFence(
        UUID.randomUUID(), worker, boot, session, allocation, viewerId, generation);
  }
}
