package com.helmglass.browser.application;

import com.helmglass.browser.api.WorkerGateway;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

@Component
public class ControlDispatcher {
  private final WorkerGateway workers;

  public ControlDispatcher(WorkerGateway workers) {
    this.workers = workers;
  }

  @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
  public void dispatch(BrowserControlService.ControlIntent intent) {
    workers.send(intent.workerId(), intent.message());
  }
}
