package com.helmglass.browser.application;

import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.infrastructure.repository.BrowserCloseOutboxRepository;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/** Delivers committed CLOSE intents without treating a socket write as physical closure. */
@Service
@Slf4j
public class BrowserCloseDeliveryService {
  private final BrowserCloseOutboxRepository outbox;
  private final WorkerGateway gateway;

  public BrowserCloseDeliveryService(BrowserCloseOutboxRepository outbox, WorkerGateway gateway) {
    this.outbox = outbox;
    this.gateway = gateway;
  }

  public void dispatch() {
    outbox.enqueueDue();
    for (var intent : outbox.due()) {
      try {
        if (outbox.deliverable(intent.id())
            && !gateway.send(
                intent.workerId(),
                intent.workerBootId(),
                WorkerGateway.envelope(
                    "close",
                    intent.id(),
                    Map.of(
                        "browserSessionId", intent.sessionId(),
                        "allocationEpoch", intent.allocationEpoch())))) {
          outbox.transportFailed(intent.id());
        }
      } catch (RuntimeException error) {
        outbox.transportFailed(intent.id());
        log.warn("Browser closure delivery deferred; messageId={}, errorType={}",
            intent.id(), error.getClass().getSimpleName());
      }
    }
  }
}
