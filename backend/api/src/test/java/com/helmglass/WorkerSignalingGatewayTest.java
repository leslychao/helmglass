package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.helmglass.api.JsonSupport;
import com.helmglass.browser.api.WorkerSignalingGateway;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpHeaders;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

class WorkerSignalingGatewayTest {
  private final JsonSupport json = new JsonSupport(JsonMapper.builder().build());
  private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
  private final WorkerSignalingGateway gateway = new WorkerSignalingGateway(json, events);
  private final UUID worker = UUID.randomUUID();
  private final UUID boot = UUID.randomUUID();

  @Test
  void physicalReceiptMustMatchTheBootAuthenticatedByMtls() throws Exception {
    var socket = socket();
    gateway.afterConnectionEstablished(socket);
    gateway.handleMessage(socket, closed(boot));
    var event = ArgumentCaptor.forClass(WorkerSignalingGateway.ViewerClosed.class);
    verify(events).publishEvent(event.capture());
    assertThat(event.getValue().binding().workerId()).isEqualTo(worker);
    assertThat(event.getValue().binding().workerBootId()).isEqualTo(boot);

    gateway.handleMessage(socket, closed(UUID.randomUUID()));
    verify(socket).close(new CloseStatus(4400, "INVALID_SIGNALING_MESSAGE"));
    verify(events, times(1)).publishEvent(any(Object.class));
  }

  @Test
  void replacedSocketCannotPublishReceiptsOrDisconnectTheCurrentWorker() throws Exception {
    var previous = socket();
    var current = socket();
    gateway.afterConnectionEstablished(previous);
    gateway.afterConnectionEstablished(current);
    gateway.handleMessage(previous, closed(boot));
    gateway.afterConnectionClosed(previous, CloseStatus.NORMAL);
    verifyNoInteractions(events);
    gateway.handleMessage(current, closed(boot));
    verify(events).publishEvent(any(WorkerSignalingGateway.ViewerClosed.class));
  }

  private WebSocketSession socket() {
    var socket = mock(WebSocketSession.class);
    var headers = new HttpHeaders();
    headers.set("x-worker-id", worker.toString());
    headers.set("x-worker-boot-id", boot.toString());
    when(socket.getId()).thenReturn(UUID.randomUUID().toString());
    when(socket.getHandshakeHeaders()).thenReturn(headers);
    when(socket.isOpen()).thenReturn(true);
    return socket;
  }

  private TextMessage closed(UUID reportedBoot) {
    return new TextMessage(
        json.write(
            Map.of(
                "schemaVersion",
                1,
                "type",
                "viewerClosed",
                "requestId",
                UUID.randomUUID(),
                "workerBootId",
                reportedBoot,
                "browserSessionId",
                UUID.randomUUID(),
                "allocationEpoch",
                1,
                "viewerId",
                UUID.randomUUID(),
                "viewGeneration",
                1,
                "code",
                "VIEW_CLOSED")));
  }
}
