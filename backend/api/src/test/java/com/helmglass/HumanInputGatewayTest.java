package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.helmglass.api.JsonSupport;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.domain.BrowserActivityClock;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.api.HumanInputGateway;
import com.helmglass.realtime.application.ChannelTicketService;
import java.net.URI;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

class HumanInputGatewayTest {
  @Test
  void privateInputClockRequiresConfirmedOwnerUpdateAndCannotFallBackAfterRejection()
      throws Exception {
    UUID user = UUID.randomUUID();
    UUID sessionId = UUID.randomUUID();
    UUID login = UUID.randomUUID();
    UUID controller = UUID.randomUUID();
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    var now = Instant.now();
    var json = new JsonSupport(JsonMapper.builder().build());
    var tickets = mock(ChannelTicketService.class);
    var identities = mock(IdentityRepository.class);
    var browsers = mock(BrowserRepository.class);
    var controls = mock(ControlRepository.class);
    var workers = mock(WorkerGateway.class);
    var owner = mock(BrowserSessionService.class);
    var binding = mock(ChannelTicketService.TicketBinding.class);
    var lease = mock(ControlRepository.Lease.class);
    var session = mock(BrowserRepository.Session.class);
    var socket = mock(WebSocketSession.class);
    when(socket.getId()).thenReturn("input-fixture");
    when(socket.isOpen()).thenReturn(true);
    when(socket.getUri()).thenReturn(URI.create("wss://helm.example/stream/v1/input/" + sessionId));
    when(tickets.consume("fixture", "HUMAN_INPUT", sessionId)).thenReturn(binding);
    when(binding.userId()).thenReturn(user);
    when(binding.sessionId()).thenReturn(sessionId);
    when(binding.loginId()).thenReturn(login);
    when(binding.controllerInstanceId()).thenReturn(controller);
    when(binding.accessEpoch()).thenReturn(1L);
    when(binding.controlEpoch()).thenReturn(1L);
    when(binding.pageEpoch()).thenReturn(1L);
    when(binding.privacyEpoch()).thenReturn(1L);
    when(identities.authorizationActive(user, login, null, 1)).thenReturn(true);
    when(controls.get(sessionId)).thenReturn(lease);
    when(lease.loginId()).thenReturn(login);
    when(lease.controllerInstanceId()).thenReturn(controller);
    when(lease.state()).thenReturn("ACTIVE");
    when(lease.ownerKind()).thenReturn("HUMAN");
    when(lease.epoch()).thenReturn(1L);
    when(lease.expiresAt()).thenReturn(now.plusSeconds(30));
    when(controls.claimInput(eq(sessionId), eq(1L), eq(controller), eq(login), any()))
        .thenReturn(true);
    when(browsers.owned(user, sessionId)).thenReturn(session);
    when(session.workerId()).thenReturn(worker);
    when(session.workerBootId()).thenReturn(boot);
    when(session.userId()).thenReturn(user);
    when(session.id()).thenReturn(sessionId);
    when(session.allocationEpoch()).thenReturn(1L);
    when(session.privacyEpoch()).thenReturn(1L);
    when(session.privacy()).thenReturn("LOGIN_PRIVATE");
    when(session.lastActivityAt()).thenReturn(now);
    when(session.idleDeadlineAt()).thenReturn(now.plusSeconds(600));
    when(session.budgetDeadlineAt()).thenReturn(now.plusSeconds(1800));
    when(workers.send(eq(worker), any())).thenReturn(true);
    var clock =
        new BrowserActivityClock(
            user,
            null,
            sessionId,
            worker,
            boot,
            1,
            1,
            "LOGIN_PRIVATE",
            now.plusSeconds(1),
            now.plusSeconds(601),
            now.plusSeconds(1800));
    when(owner.inputApplied(
            eq(binding),
            any(),
            eq(worker),
            eq(boot),
            anyLong(),
            anyLong(),
            anyLong(),
            anyLong(),
            anyLong(),
            anyLong(),
            anyBoolean()))
        .thenReturn(Optional.empty())
        .thenReturn(Optional.of(clock));
    var gateway =
        new HumanInputGateway(
            tickets,
            identities,
            browsers,
            controls,
            workers,
            json,
            mock(WorkerProtocol.class),
            mock(BrowserControlService.class),
            owner);
    gateway.afterConnectionEstablished(socket);
    gateway.handleMessage(
        socket, new TextMessage("{\"type\":\"authenticate\",\"ticket\":\"fixture\"}"));
    for (long sequence = 1; sequence <= 2; sequence++) {
      gateway.handleMessage(
          socket,
          new TextMessage(
              json.write(
                  Map.of(
                      "type",
                      "input",
                      "schemaVersion",
                      1,
                      "browserSessionId",
                      sessionId,
                      "controlEpoch",
                      1,
                      "pageEpoch",
                      1,
                      "inputSequence",
                      sequence,
                      "action",
                      Map.of("type", "keyDown", "key", "Enter")))));
      gateway.acknowledge(
          new WorkerGateway.InputReceipt(worker, boot, sessionId, 1, 1, 1, 1, 1, sequence, true));
    }
    var messages = ArgumentCaptor.forClass(TextMessage.class);
    verify(socket, times(3)).sendMessage(messages.capture());
    var rejected = json.read(messages.getAllValues().get(1).getPayload());
    assertThat(rejected.path("type").asString()).isEqualTo("inputAck");
    assertThat(rejected.has("clock")).isFalse();
    var confirmed = json.read(messages.getAllValues().get(2).getPayload()).path("clock");
    assertThat(confirmed.size()).isEqualTo(6);
    assertThat(confirmed.path("lastActivityAt").asString())
        .isEqualTo(clock.lastActivityAt().toString());
    assertThat(confirmed.path("browserSessionId").asString()).isEqualTo(sessionId.toString());
  }
}
