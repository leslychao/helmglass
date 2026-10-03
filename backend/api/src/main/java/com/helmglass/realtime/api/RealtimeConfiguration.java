package com.helmglass.realtime.api;

import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.api.WorkerSignalingGateway;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class RealtimeConfiguration implements WebSocketConfigurer {
  private final WorkerGateway workers;
  private final WorkerSignalingGateway workerSignaling;
  private final ViewerSignalingGateway viewers;
  private final HumanInputGateway input;
  private final RealtimeDeliveryService realtime;
  private final ActorHandshakeInterceptor actor;
  private final String origin;
  private final String widgetOrigin;
  private final WidgetEventGateway widgetEvents;

  public RealtimeConfiguration(WorkerGateway workers, WorkerSignalingGateway workerSignaling,
      ViewerSignalingGateway viewers, HumanInputGateway input, RealtimeDeliveryService realtime, ActorHandshakeInterceptor actor,
      @Value("${helm.public-origin}") String origin,
      @Value("${helm.widget-origin:}") String widgetOrigin, WidgetEventGateway widgetEvents) {
    this.workers = workers;
    this.workerSignaling = workerSignaling;
    this.viewers = viewers;
    this.input = input;
    this.realtime = realtime;
    this.actor = actor;
    this.origin = origin;
    this.widgetOrigin = widgetOrigin;
    this.widgetEvents = widgetEvents;
  }

  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry.addHandler(workers, "/internal/worker/control").addInterceptors(actor);
    registry.addHandler(workerSignaling, "/internal/worker/signaling").addInterceptors(actor);
    registry.addHandler(realtime, "/events/v1/user").addInterceptors(actor).setAllowedOrigins(origin);
    registry.addHandler(input, "/stream/v1/input/*").setAllowedOrigins(origin);
    registry.addHandler(viewers, "/stream/v1/signaling/*")
        .addInterceptors(actor).setAllowedOrigins(origin);
    if (!widgetOrigin.isBlank()) {
      registry.addHandler(widgetEvents, "/events/v1/widget/tasks/*").setAllowedOrigins(widgetOrigin);
      registry.addHandler(viewers, "/stream/v1/widget/signaling/*").setAllowedOrigins(widgetOrigin);
    }
  }
}
