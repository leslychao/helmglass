package com.helmglass.realtime.application;

import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.api.WorkerSignalingGateway;
import com.helmglass.realtime.infrastructure.repository.ChatPresentationRepository;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Delivers committed fence intents. A socket write never acknowledges physical media closure. */
@Component
public class PresentationFenceRelay {
  private final ChatPresentationRepository presentations;
  private final RealtimeDeliveryService realtime;
  private final WorkerSignalingGateway workers;

  public PresentationFenceRelay(
      ChatPresentationRepository presentations,
      RealtimeDeliveryService realtime,
      WorkerSignalingGateway workers) {
    this.presentations = presentations;
    this.realtime = realtime;
    this.workers = workers;
  }

  @Scheduled(fixedDelay = 500)
  public void deliver() {
    realtime.reconcileClosedViewers();
    for (var fence : presentations.dueFences()) {
      if (!workers.send(
          fence.workerId(),
          WorkerGateway.envelope("viewClose", fence.requestId(), fence.binding()))) {
        presentations.fenceTransportFailed(fence.requestId());
      }
    }
  }

  @EventListener
  public void confirmed(WorkerSignalingGateway.ViewerClosed event) {
    var fence = event.binding();
    // Calling the transactional owner through its proxy returns only after the database commits.
    if (realtime.confirmViewerFence(fence)) {
      workers.send(
          fence.workerId(),
          WorkerGateway.envelope("viewerClosedAck", fence.requestId(), fence.binding()));
    }
  }
}
