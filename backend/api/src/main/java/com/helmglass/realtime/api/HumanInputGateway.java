package com.helmglass.realtime.api;

import com.helmglass.api.JsonSupport;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.application.ChannelTicketService;
import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class HumanInputGateway extends TextWebSocketHandler {
  private record Controller(
      ChannelTicketService.TicketBinding binding,
      WebSocketSession socket,
      UUID channelId,
      AtomicLong sequence) {}

  private final Map<String, Controller> controllers = new ConcurrentHashMap<>();
  private final Map<String, WebSocketSession> pending = new ConcurrentHashMap<>();
  private final Map<String, Instant> deadlines = new ConcurrentHashMap<>();
  private final ChannelTicketService tickets;
  private final IdentityRepository identities;
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final WorkerGateway workers;
  private final JsonSupport json;
  private final WorkerProtocol protocol;
  private final BrowserControlService controlOwner;
  private final BrowserSessionService sessionOwner;

  public HumanInputGateway(
      ChannelTicketService tickets,
      IdentityRepository identities,
      BrowserRepository browsers,
      ControlRepository controls,
      WorkerGateway workers,
      JsonSupport json,
      WorkerProtocol protocol,
      BrowserControlService controlOwner,
      BrowserSessionService sessionOwner) {
    this.tickets = tickets;
    this.identities = identities;
    this.browsers = browsers;
    this.controls = controls;
    this.workers = workers;
    this.json = json;
    this.protocol = protocol;
    this.controlOwner = controlOwner;
    this.sessionOwner = sessionOwner;
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession socket) throws IOException {
    if (pending.size() >= 100) {
      socket.close(new CloseStatus(4429, "CHANNEL_LIMIT"));
      return;
    }
    socket.setTextMessageSizeLimit(20000);
    pending.put(socket.getId(), new ConcurrentWebSocketSessionDecorator(socket, 1000, 65536));
    deadlines.put(socket.getId(), Instant.now().plusSeconds(5));
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message)
      throws IOException {
    var payload = json.read(message.getPayload());
    Controller controller = controllers.get(socket.getId());
    if (controller == null) {
      if (!payload.path("type").asString().equals("authenticate") || socket.getUri() == null) {
        socket.close(new CloseStatus(4401, "TICKET_REQUIRED"));
        return;
      }
      String path = socket.getUri().getPath();
      UUID sessionId = UUID.fromString(path.substring(path.lastIndexOf('/') + 1));
      var binding = tickets.consume(payload.path("ticket").asString(), "HUMAN_INPUT", sessionId);
      controller =
          new Controller(
              binding, pending.remove(socket.getId()), UUID.randomUUID(), new AtomicLong());
      deadlines.remove(socket.getId());
      if (!authorized(controller)) {
        socket.close(new CloseStatus(4403, "CONTROL_REVOKED"));
        return;
      }
      if (!controls.claimInput(
          sessionId,
          binding.controlEpoch(),
          binding.controllerInstanceId(),
          binding.loginId(),
          controller.channelId())) {
        socket.close(new CloseStatus(4409, "INPUT_CHANNEL_FENCE_REQUIRED"));
        return;
      }
      controllers.put(socket.getId(), controller);
      controller
          .socket()
          .sendMessage(
              new TextMessage(
                  json.write(Map.of("type", "ready", "schemaVersion", 1, "nextInputSequence", 1))));
      return;
    }
    if (!authorized(controller) || !payload.path("type").asString().equals("input")) {
      socket.close(new CloseStatus(4409, "INPUT_FENCED"));
      return;
    }
    var binding = controller.binding();
    if (!payload.path("browserSessionId").asString().equals(binding.sessionId().toString())
        || payload.path("controlEpoch").asLong() != binding.controlEpoch()
        || payload.path("pageEpoch").asLong() != binding.pageEpoch()) {
      socket.close(new CloseStatus(4409, "INPUT_FENCED"));
      return;
    }
    protocol.validateInputAction(payload.path("action"));
    long sequence = payload.path("inputSequence").asLong(-1);
    if (payload.path("schemaVersion").asInt() != 1
        || sequence < 1
        || sequence > 9007199254740991L
        || sequence <= controller.sequence().get()) {
      socket.close(new CloseStatus(4409, "INPUT_SEQUENCE_INVALID"));
      return;
    }
    controller.sequence().set(sequence);
    Map<String, Object> input = new HashMap<>();
    input.put("browserSessionId", binding.sessionId());
    input.put("controlEpoch", binding.controlEpoch());
    input.put("pageEpoch", binding.pageEpoch());
    input.put("controllerInstance", binding.controllerInstanceId());
    input.put("inputSequence", payload.path("inputSequence").asLong());
    input.put("action", payload.path("action"));
    var session = browsers.owned(binding.userId(), binding.sessionId());
    if (!workers.send(
        session.workerId(), WorkerGateway.envelope("input", UUID.randomUUID(), input))) {
      socket.close(new CloseStatus(4503, "INPUT_UNAVAILABLE"));
    }
  }

  private boolean authorized(Controller controller) {
    var binding = controller.binding();
    if (binding.loginId() == null
        || !identities.authorizationActive(
            binding.userId(), binding.loginId(), null, binding.accessEpoch())) {
      return false;
    }
    var lease = controls.get(binding.sessionId());
    return (lease.inputChannelId() == null || controller.channelId().equals(lease.inputChannelId()))
        && binding.loginId().equals(lease.loginId())
        && lease.state().equals("ACTIVE")
        && lease.ownerKind().equals("HUMAN")
        && binding.controllerInstanceId().equals(lease.controllerInstanceId())
        && binding.controlEpoch() == lease.epoch()
        && lease.expiresAt().isAfter(Instant.now());
  }

  @EventListener
  public void acknowledge(WorkerGateway.InputReceipt receipt) throws IOException {
    for (Controller controller : controllers.values()) {
      var binding = controller.binding();
      if (!binding.sessionId().equals(receipt.sessionId())
          || binding.controlEpoch() != receipt.controlEpoch()
          || receipt.inputSequence() < 1
          || receipt.inputSequence() > controller.sequence().get()) {
        continue;
      }
      var session = browsers.owned(binding.userId(), binding.sessionId());
      if (!receipt.workerId().equals(session.workerId())
          || !receipt.bootId().equals(session.workerBootId())
          || !authorized(controller)) {
        return;
      }
      var activity =
          sessionOwner.inputApplied(
              binding,
              controller.channelId(),
              receipt.workerId(),
              receipt.bootId(),
              receipt.allocationEpoch(),
              receipt.controlEpoch(),
              receipt.pageEpoch(),
              receipt.privacyEpoch(),
              receipt.inputPageEpoch(),
              receipt.inputSequence(),
              receipt.activity());
      Map<String, Object> acknowledgement = new HashMap<>();
      acknowledgement.put("type", "inputAck");
      acknowledgement.put("schemaVersion", 1);
      acknowledgement.put("controlEpoch", receipt.controlEpoch());
      acknowledgement.put("inputSequence", receipt.inputSequence());
      activity.ifPresent(
          clock -> acknowledgement.put("clock", BrowserSessionService.clockSnapshot(clock)));
      controller.socket().sendMessage(new TextMessage(json.write(acknowledgement)));
    }
  }

  @Scheduled(fixedDelay = 1000)
  public void expire() throws IOException {
    for (var entry : deadlines.entrySet()) {
      if (!entry.getValue().isAfter(Instant.now())) {
        WebSocketSession socket = pending.get(entry.getKey());
        if (socket != null) {
          socket.close(new CloseStatus(4401, "TICKET_TIMEOUT"));
        }
      }
    }
    for (Controller controller : controllers.values()) {
      if (!authorized(controller)) {
        controller.socket().close(new CloseStatus(4403, "CONTROL_REVOKED"));
      }
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    Controller controller = controllers.remove(socket.getId());
    if (controller != null) {
      controlOwner.inputDisconnected(
          controller.binding().userId(), controller.binding().sessionId(), controller.channelId());
    }
    pending.remove(socket.getId());
    deadlines.remove(socket.getId());
  }
}
