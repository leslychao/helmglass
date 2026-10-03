package com.helmglass;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.helmglass.api.JsonSupport;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.browser.domain.BrowserActivityClock;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.realtime.infrastructure.repository.ChatPresentationRepository;
import com.helmglass.realtime.infrastructure.repository.OutboxRepository;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.SessionLimitExceededException;
import tools.jackson.databind.json.JsonMapper;

class RealtimeDeliveryTest {
  private final IdentityRepository identities = mock(IdentityRepository.class);
  private final OutboxRepository outbox = mock(OutboxRepository.class);
  private final BrowserSessionService browsers = mock(BrowserSessionService.class);
  private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
  private final JsonSupport json = new JsonSupport(JsonMapper.builder().build());
  private final RealtimeDeliveryService realtime =
      new RealtimeDeliveryService(
          outbox,
          identities,
          json,
          mock(ChatPresentationRepository.class),
          mock(OperationRepository.class),
          events,
          mock(ChangeRepository.class),
          browsers);

  @Test
  void deadlineDeltaReachesOnlyOwnAuthorizedViewerAndNeverLeaksInternalBinding() throws Exception {
    var owner = actor(false);
    var own = socket(owner);
    var foreign = socket(actor(false));
    for (var socket : List.of(own, foreign)) {
      realtime.afterConnectionEstablished(socket);
      realtime.handleMessage(
          socket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"self\"]}"));
    }
    var now = Instant.now();
    var clock =
        new BrowserActivityClock(
            owner.userId(),
            UUID.randomUUID(),
            UUID.randomUUID(),
            UUID.randomUUID(),
            UUID.randomUUID(),
            2,
            3,
            "NORMAL",
            now,
            now.plusSeconds(900),
            now.plusSeconds(1800));
    var intent =
        new OutboxRepository.Intent(
            UUID.randomUUID(),
            owner.userId(),
            clock.sessionId(),
            "browserActivity",
            json.write(clock));
    when(outbox.due()).thenReturn(List.of(intent));
    when(browsers.deadlineCurrent(clock)).thenReturn(true);
    realtime.relay();
    var messages = ArgumentCaptor.forClass(TextMessage.class);
    verify(own, times(2)).sendMessage(messages.capture());
    var payload = json.read(messages.getAllValues().getLast().getPayload());
    assertEquals("browserActivity", payload.path("type").asString());
    assertEquals(6, payload.path("clock").size());
    assertEquals(
        clock.sessionId().toString(), payload.path("clock").path("browserSessionId").asString());
    verify(foreign).sendMessage(any(TextMessage.class));
    verify(events).publishEvent(clock);
    verify(outbox).publishedClock(intent);
    verify(outbox, never()).published(intent.id());
  }

  @Test
  void obsoleteRuntimeClockIsAcknowledgedWithoutDeliveryAndPrivateClockNeverReachesSharedChannels()
      throws Exception {
    var owner = actor(false);
    var socket = socket(owner);
    realtime.afterConnectionEstablished(socket);
    realtime.handleMessage(
        socket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"self\"]}"));
    var now = Instant.now();
    var clock =
        new BrowserActivityClock(
            owner.userId(),
            UUID.randomUUID(),
            UUID.randomUUID(),
            UUID.randomUUID(),
            UUID.randomUUID(),
            2,
            3,
            "LOGIN_PRIVATE",
            now,
            now.plusSeconds(600),
            now.plusSeconds(1800));
    var intent =
        new OutboxRepository.Intent(
            UUID.randomUUID(),
            clock.userId(),
            clock.sessionId(),
            "browserActivity",
            json.write(clock));
    when(outbox.due()).thenReturn(List.of(intent));
    when(browsers.deadlineCurrent(clock)).thenReturn(false, true);
    realtime.relay();
    realtime.relay();
    verify(events, never()).publishEvent(any(BrowserActivityClock.class));
    verify(socket).sendMessage(any(TextMessage.class));
    verify(outbox, times(2)).publishedClock(intent);
  }

  @Test
  void subscribesBeforeReadyAndOnlyReceivesOwnSafeResources() throws Exception {
    var actor = actor(false);
    var socket = socket(actor);
    realtime.afterConnectionEstablished(socket);
    verify(socket, never()).sendMessage(any());
    realtime.handleMessage(
        socket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"self\"]}"));
    UUID ownIntent = UUID.randomUUID();
    when(outbox.due())
        .thenReturn(
            List.of(
                new OutboxRepository.Intent(
                    ownIntent, actor.userId(), UUID.randomUUID(), "tasks", "{}"),
                new OutboxRepository.Intent(
                    UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), "tasks", "{}"),
                new OutboxRepository.Intent(
                    UUID.randomUUID(), actor.userId(), UUID.randomUUID(), "users", "{}")));
    realtime.relay();
    var messages = ArgumentCaptor.forClass(TextMessage.class);
    verify(socket, times(2)).sendMessage(messages.capture());
    assertEquals(
        "ready",
        json.read(messages.getAllValues().getFirst().getPayload()).path("type").asString());
    assertEquals(
        json.read("{\"type\":\"invalidate\",\"resources\":[\"tasks\"]}"),
        json.read(messages.getAllValues().getLast().getPayload()));
    verify(outbox).published(ownIntent);
  }

  @Test
  void slowClientCannotPreventDeliveryToAnotherClientOrAcknowledgingTheInvalidation()
      throws Exception {
    var owner = actor(false);
    var slow = socket(owner);
    var healthy = socket(owner);
    for (var socket : List.of(slow, healthy)) {
      realtime.afterConnectionEstablished(socket);
      realtime.handleMessage(
          socket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"self\"]}"));
    }
    doThrow(
            new SessionLimitExceededException(
                "Fixture send limit", CloseStatus.SESSION_NOT_RELIABLE))
        .when(slow)
        .sendMessage(any());
    var intent =
        new OutboxRepository.Intent(
            UUID.randomUUID(), owner.userId(), UUID.randomUUID(), "tasks", "{}");
    when(outbox.due()).thenReturn(List.of(intent));

    realtime.relay();

    verify(slow).close(new CloseStatus(4503, "DELIVERY_FAILED"));
    var messages = ArgumentCaptor.forClass(TextMessage.class);
    verify(healthy, times(2)).sendMessage(messages.capture());
    assertEquals(
        json.read("{\"type\":\"invalidate\",\"resources\":[\"tasks\"]}"),
        json.read(messages.getAllValues().getLast().getPayload()));
    verify(outbox).published(intent.id());
  }

  @Test
  void rejectsAdminSubscriptionFromAnOrdinaryLogin() throws Exception {
    var socket = socket(actor(false));
    realtime.afterConnectionEstablished(socket);
    realtime.handleMessage(
        socket,
        new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"self\",\"administration\"]}"));
    verify(socket).close(new CloseStatus(4403, "ADMIN_REQUIRED"));
    verify(socket, never()).sendMessage(any());
  }

  @Test
  void adminSubscriptionReceivesPlatformInvalidationsWithoutUserData() throws Exception {
    var socket = socket(actor(true));
    realtime.afterConnectionEstablished(socket);
    realtime.handleMessage(
        socket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"administration\"]}"));
    when(outbox.due())
        .thenReturn(
            List.of(
                new OutboxRepository.Intent(
                    UUID.randomUUID(),
                    UUID.randomUUID(),
                    UUID.randomUUID(),
                    "users",
                    "{\"private\":\"excluded\"}")));
    realtime.relay();
    var messages = ArgumentCaptor.forClass(TextMessage.class);
    verify(socket, times(2)).sendMessage(messages.capture());
    assertEquals(
        json.read("{\"type\":\"invalidate\",\"resources\":[\"users\"]}"),
        json.read(messages.getAllValues().getLast().getPayload()));
  }

  @Test
  void revocationIsCheckedBeforePongAndRejectsAnyFurtherDelivery() throws Exception {
    var actor = actor(false);
    var socket = socket(actor);
    realtime.afterConnectionEstablished(socket);
    realtime.handleMessage(
        socket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"self\"]}"));
    when(identities.authorizationActive(actor.userId(), actor.loginId(), null, actor.accessEpoch()))
        .thenReturn(false);
    realtime.handleMessage(socket, new TextMessage("{\"type\":\"ping\"}"));
    verify(socket).close(new CloseStatus(4403, "ACCESS_REVOKED"));
    verify(socket).sendMessage(any(TextMessage.class));
  }

  @Test
  void taskChangeDeliversUsageAndPartitionsAdministrativeResourcesWithoutExposingPayload()
      throws Exception {
    var owner = actor(false);
    var ownSocket = socket(owner);
    var adminSocket = socket(actor(true));
    var foreignSocket = socket(actor(false));
    for (var socket : List.of(ownSocket, adminSocket, foreignSocket)) {
      realtime.afterConnectionEstablished(socket);
    }
    realtime.handleMessage(
        ownSocket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"self\"]}"));
    realtime.handleMessage(
        foreignSocket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"self\"]}"));
    realtime.handleMessage(
        adminSocket, new TextMessage("{\"type\":\"subscribe\",\"channels\":[\"administration\"]}"));
    when(outbox.due())
        .thenReturn(
            List.of(
                new OutboxRepository.Intent(
                    UUID.randomUUID(),
                    owner.userId(),
                    UUID.randomUUID(),
                    "tasks",
                    "{\"resources\":[\"tasks\",\"usage\",\"users\",\"unknown-private-value\"],\"private\":\"excluded\"}")));
    realtime.relay();
    var own = ArgumentCaptor.forClass(TextMessage.class);
    verify(ownSocket, times(2)).sendMessage(own.capture());
    assertEquals(
        json.read("{\"type\":\"invalidate\",\"resources\":[\"tasks\",\"usage\"]}"),
        json.read(own.getAllValues().getLast().getPayload()));
    var administrative = ArgumentCaptor.forClass(TextMessage.class);
    verify(adminSocket, times(2)).sendMessage(administrative.capture());
    assertEquals(
        json.read("{\"type\":\"invalidate\",\"resources\":[\"users\"]}"),
        json.read(administrative.getAllValues().getLast().getPayload()));
    verify(foreignSocket).sendMessage(any(TextMessage.class));
  }

  private AuthenticatedActor actor(boolean admin) {
    return new AuthenticatedActor(
        UUID.randomUUID(),
        UUID.randomUUID(),
        null,
        "helm-web",
        "User",
        "user@example.test",
        1,
        admin ? Set.of("platform_admin") : Set.of(),
        false);
  }

  private WebSocketSession socket(AuthenticatedActor actor) {
    WebSocketSession socket = mock(WebSocketSession.class);
    when(socket.getId()).thenReturn(UUID.randomUUID().toString());
    when(socket.isOpen()).thenReturn(true);
    when(socket.getAttributes())
        .thenReturn(
            Map.of(
                AuthenticatedActor.class.getName(),
                actor,
                "helm.authorizationExpiresAt",
                Instant.now().plusSeconds(300)));
    when(identities.authorizationActive(actor.userId(), actor.loginId(), null, actor.accessEpoch()))
        .thenReturn(true);
    return socket;
  }
}
