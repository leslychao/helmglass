package com.helmglass.browser.api;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.browser.application.BrowserOpenService;
import com.helmglass.browser.application.BrowserSessionOperationService;
import com.helmglass.browser.application.BrowserStartupService;
import com.helmglass.browser.application.ControlDispatcher;
import com.helmglass.browser.application.HumanBrowserCommandService;
import com.helmglass.browser.application.WorkerRegistryService;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.connection.application.ConnectionLoginService;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.usage.application.UsageCheckpointService;
import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;

@Slf4j
@Component
public class WorkerGateway extends TextWebSocketHandler {
  private record WorkerChannel(UUID workerId, UUID bootId, WebSocketSession socket) {}

  private final Map<UUID, WorkerChannel> workers = new ConcurrentHashMap<>();
  private final Map<String, WorkerChannel> channels = new ConcurrentHashMap<>();
  private final WorkerRegistryService registry;
  private final BrowserStartupService startup;
  private final BrowserOpenService opens;
  private final BrowserSessionOperationService sessionOperations;
  private final BrowserProfileService profiles;
  private final HumanBrowserCommandService navigation;
  private final ControlDispatcher controlDispatcher;
  private final CommandExecutionService execution;
  private final CommandRepository commands;
  private final BrowserRepository browsers;
  private final JsonSupport json;
  private final UsageCheckpointService usage;
  private final ConnectionLoginService logins;
  private final ApplicationEventPublisher events;

  public record InputReceipt(
      UUID workerId,
      UUID bootId,
      UUID sessionId,
      long allocationEpoch,
      long controlEpoch,
      long pageEpoch,
      long privacyEpoch,
      long inputPageEpoch,
      long inputSequence,
      boolean activity) {}

  public WorkerGateway(
      WorkerRegistryService registry,
      CommandExecutionService execution,
      CommandRepository commands,
      BrowserRepository browsers,
      JsonSupport json,
      UsageCheckpointService usage,
      ConnectionLoginService logins,
      ApplicationEventPublisher events,
      BrowserStartupService startup,
      HumanBrowserCommandService navigation,
      BrowserSessionOperationService sessionOperations,
      BrowserProfileService profiles,
      BrowserOpenService opens,
      ControlDispatcher controlDispatcher) {
    this.registry = registry;
    this.startup = startup;
    this.sessionOperations = sessionOperations;
    this.profiles = profiles;
    this.opens = opens;
    this.navigation = navigation;
    this.controlDispatcher = controlDispatcher;
    this.execution = execution;
    this.commands = commands;
    this.browsers = browsers;
    this.json = json;
    this.usage = usage;
    this.logins = logins;
    this.events = events;
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession session) {
    session.setTextMessageSizeLimit(1048576);
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message)
      throws IOException {
    JsonNode payload = json.read(message.getPayload());
    if (payload.path("schemaVersion").asInt() != 1) {
      socket.close(new CloseStatus(4400, "PROTOCOL_MISMATCH"));
      return;
    }
    UUID requestId = UUID.fromString(payload.path("requestId").asString());
    String type = payload.path("type").asString();
    if (type.equals("register")) {
      UUID workerId = UUID.fromString(payload.path("workerId").asString());
      UUID bootId = UUID.fromString(payload.path("bootId").asString());
      if (!workerId.toString().equals(socket.getHandshakeHeaders().getFirst("x-worker-id"))
          || !bootId.toString().equals(socket.getHandshakeHeaders().getFirst("x-worker-boot-id"))) {
        socket.close(new CloseStatus(4403, "IDENTITY_MISMATCH"));
        return;
      }
      registry.register(workerId, bootId, payload);
      var channel =
          new WorkerChannel(
              workerId, bootId, new ConcurrentWebSocketSessionDecorator(socket, 5000, 1048576));
      var previous = workers.put(workerId, channel);
      channels.put(socket.getId(), channel);
      if (previous != null && previous.socket().isOpen()) {
        previous.socket().close(new CloseStatus(4409, "WORKER_REPLACED"));
      }
      send(
          workerId,
          envelope("registered", requestId, Map.of("workerId", workerId, "bootId", bootId)));
      for (var intent : registry.recoveryIntents(workerId, bootId)) {
        send(workerId, intent);
      }
      return;
    }
    WorkerChannel channel = channels.get(socket.getId());
    if (channel == null) {
      socket.close(new CloseStatus(4403, "REGISTRATION_REQUIRED"));
      return;
    }
    switch (type) {
      case "heartbeat" -> {
        registry.heartbeat(channel.workerId(), channel.bootId(), payload);
        for (JsonNode session : payload.path("activeSessions")) {
          if (session.has("usage")) {
            usage.record(
                channel.workerId(),
                channel.bootId(),
                UUID.fromString(session.path("browserSessionId").asString()),
                session.path("usage"));
          }
        }
      }
      case "assigned" -> {
        UUID sessionId = UUID.fromString(payload.path("browserSessionId").asString());
        registry.assigned(channel.workerId(), channel.bootId(), sessionId, payload);
        onRuntimeReady(channel, sessionId);
      }
      case "launchPermitRequest" -> {
        try {
          var permit = registry.launchPermit(channel.workerId(), channel.bootId(), payload);
          send(channel.workerId(), envelope("launchPermit", requestId, Map.of("permit", permit)));
        } catch (DomainException error) {
          send(
              channel.workerId(),
              envelope("launchPermitDenied", requestId, Map.of("code", error.getCode())));
        }
      }
      case "startPermitRequest" -> {
        try {
          UUID commandId = UUID.fromString(payload.path("commandId").asString());
          Map<String, Object> permit;
          if (navigation.contains(commandId)) {
            permit = navigation.permit(channel.workerId(), channel.bootId(), payload);
          } else if (startup.isStartupCommand(commandId)) {
            permit = startup.permit(channel.workerId(), channel.bootId(), payload);
          } else if (logins.isSessionCommand(commandId)) {
            permit = logins.permit(channel.workerId(), channel.bootId(), payload);
          } else {
            permit = execution.start(channel.workerId(), channel.bootId(), payload);
          }
          send(channel.workerId(), envelope("startPermit", requestId, Map.of("permit", permit)));
        } catch (DomainException error) {
          send(
              channel.workerId(),
              envelope("permitDenied", requestId, Map.of("code", error.getCode())));
        }
      }
      case "commandResult" -> {
        JsonNode result = payload.path("result");
        if (navigation.contains(UUID.fromString(result.path("commandId").asString()))) {
          navigation.result(channel.workerId(), channel.bootId(), result);
        } else if (startup.isStartupCommand(UUID.fromString(result.path("commandId").asString()))) {
          startup.result(channel.workerId(), channel.bootId(), result);
          onRuntimeReady(channel, UUID.fromString(result.path("browserSessionId").asString()));
        } else if (logins.isSessionCommand(UUID.fromString(result.path("commandId").asString()))) {
          logins.result(channel.workerId(), channel.bootId(), result);
        } else {
          execution.acceptResult(channel.workerId(), channel.bootId(), result);
        }
        send(
            channel.workerId(),
            envelope(
                "resultAck",
                requestId,
                Map.of(
                    "attemptId",
                    result.path("attemptId").asString(),
                    "digest",
                    result.path("digest").asString())));
      }
      case "inputAck" -> {
        if (!payload.path("activity").isBoolean()
            || !payload.path("inputPageEpoch").isIntegralNumber()
            || payload.path("inputPageEpoch").asLong(-1) < 1) {
          throw new DomainException(
              422, "INVALID_INPUT_RECEIPT", "Input receipt requires activity disposition");
        }
        UUID sessionId = UUID.fromString(payload.path("browserSessionId").asString());
        browsers.runtimeEpochs(channel.workerId(), channel.bootId(), sessionId, payload);
        events.publishEvent(
            new InputReceipt(
                channel.workerId(),
                channel.bootId(),
                sessionId,
                payload.path("allocationEpoch").asLong(-1),
                payload.path("controlEpoch").asLong(-1),
                payload.path("pageEpoch").asLong(-1),
                payload.path("privacyEpoch").asLong(-1),
                payload.path("inputPageEpoch").asLong(-1),
                payload.path("inputSequence").asLong(-1),
                payload.path("activity").asBoolean()));
      }
      case "controlAck" -> {
        UUID sessionId = UUID.fromString(payload.path("browserSessionId").asString());
        if (controlDispatcher.acknowledge(channel.workerId(), channel.bootId(), payload)) {
          onRuntimeReady(channel, sessionId);
        }
      }
      case "profileChecked" ->
          logins.checked(
              channel.workerId(),
              channel.bootId(),
              UUID.fromString(payload.path("browserSessionId").asString()),
              payload);
      case "profileLoaded" ->
          startup.loaded(
              channel.workerId(),
              channel.bootId(),
              UUID.fromString(payload.path("browserSessionId").asString()),
              payload);
      case "profileSaved" -> {
        UUID sessionId = UUID.fromString(payload.path("browserSessionId").asString());
        Map<String, Object> acknowledgement =
            profiles.confirmSaved(
                channel.workerId(),
                channel.bootId(),
                sessionId,
                UUID.fromString(payload.path("transferId").asString()),
                payload.path("sha256").asString(),
                payload.path("byteLength").asLong(-1));
        send(channel.workerId(), envelope("profileTransferAck", requestId, acknowledgement));
        if (!sessionOperations.saved(channel.workerId(), channel.bootId(), sessionId)) {
          logins.saved(channel.workerId(), channel.bootId(), sessionId);
        }
      }
      case "closed" -> {
        UUID sessionId = UUID.fromString(payload.path("browserSessionId").asString());
        if (payload.has("usage")) {
          usage.record(channel.workerId(), channel.bootId(), sessionId, payload.path("usage"));
        }
        registry.closed(channel.workerId(), channel.bootId(), sessionId, payload);
        logins.exited(channel.workerId(), channel.bootId(), sessionId, true);
        send(
            channel.workerId(),
            envelope(
                "closedAck",
                requestId,
                Map.of(
                    "browserSessionId",
                    sessionId,
                    "allocationEpoch",
                    payload.path("allocationEpoch").asLong(),
                    "receiptId",
                    payload.path("receiptId").asString())));
      }
      case "runtimeReadyAck" -> {
        UUID sessionId = UUID.fromString(payload.path("browserSessionId").asString());
        startup.acknowledgeReady(channel.workerId(), channel.bootId(), sessionId, payload);
        logins.assigned(channel.workerId(), channel.bootId(), sessionId);
        opens.ready(sessionId);
        UUID commandId = browsers.dispatchedForSession(sessionId);
        if (commandId != null) {
          sendCommand(commands.dispatch(commandId));
        }
      }
      case "rejected" ->
          log.warn(
              "Worker request rejected; workerId={}, requestId={}, code={}",
              channel.workerId(),
              requestId,
              payload.path("code").asString());
      default ->
          log.debug("Worker control receipt; workerId={}, type={}", channel.workerId(), type);
    }
  }

  private void onRuntimeReady(WorkerChannel channel, UUID sessionId) {
    if (!startup.assigned(sessionId)) {
      return;
    }
    send(
        channel.workerId(),
        envelope(
            "runtimeReady",
            UUID.randomUUID(),
            Map.of(
                "browserSessionId",
                sessionId,
                "allocationEpoch",
                registry.readyEpoch(channel.workerId(), channel.bootId(), sessionId))));
  }

  public void sendCommand(CommandRepository.Dispatch dispatch) {
    send(
        dispatch.workerId(),
        envelope(
            "command",
            UUID.randomUUID(),
            Map.of(
                "command",
                Map.of(
                    "commandId",
                    dispatch.commandId(),
                    "attemptId",
                    dispatch.attemptId(),
                    "taskId",
                    dispatch.taskId(),
                    "browserSessionId",
                    dispatch.sessionId(),
                    "action",
                    json.read(dispatch.payload())))));
  }

  public boolean send(UUID workerId, Map<String, Object> message) {
    return send(workerId, null, message);
  }

  public boolean send(UUID workerId, UUID expectedBootId, Map<String, Object> message) {
    if ("assign".equals(message.get("type"))) {
      JsonNode assignment =
          registry.assignment(workerId, json.read(json.write(message.get("assignment"))));
      message = new LinkedHashMap<>(message);
      message.put("assignment", assignment);
    }
    WorkerChannel channel = workers.get(workerId);
    if (channel == null
        || !channel.socket().isOpen()
        || expectedBootId != null && !expectedBootId.equals(channel.bootId())) {
      return false;
    }
    try {
      channel.socket().sendMessage(new TextMessage(json.write(message)));
      return true;
    } catch (IOException error) {
      log.warn("Worker tunnel write failed; workerId={}", workerId);
      return false;
    }
  }

  public static Map<String, Object> envelope(String type, UUID requestId, Map<String, ?> body) {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("schemaVersion", 1);
    result.put("type", type);
    result.put("requestId", requestId);
    result.putAll(body);
    return result;
  }

  @Scheduled(fixedDelay = 1000)
  public void expireCertificates() throws IOException {
    for (WorkerChannel channel : workers.values()) {
      Object value = channel.socket().getAttributes().get("helm.workerCertificateExpiresAt");
      if (!(value instanceof Instant expiry) || !expiry.isAfter(Instant.now())) {
        channel.socket().close(new CloseStatus(4403, "WORKER_CERTIFICATE_EXPIRED"));
      }
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    WorkerChannel channel = channels.remove(socket.getId());
    if (channel != null) {
      workers.remove(channel.workerId(), channel);
    }
  }
}
