package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.infrastructure.repository.ControlOutboxRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.connection.application.ConnectionLoginService;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import tools.jackson.databind.JsonNode;

@Component
@Slf4j
public class ControlDispatcher {
  private final ObjectProvider<WorkerGateway> workers;
  private final ControlOutboxRepository outbox;
  private final JsonSupport json;
  private final WorkerRegistryService registry;
  private final BrowserSessionOperationService sessionOperations;
  private final BrowserControlService controls;
  private final ControlRepository leases;
  private final ConnectionLoginService logins;
  private final IdentityRepository identities;

  public ControlDispatcher(
      ObjectProvider<WorkerGateway> workers,
      ControlOutboxRepository outbox,
      JsonSupport json,
      WorkerRegistryService registry,
      BrowserSessionOperationService sessionOperations,
      BrowserControlService controls,
      ControlRepository leases,
      ConnectionLoginService logins,
      IdentityRepository identities) {
    this.workers = workers;
    this.outbox = outbox;
    this.json = json;
    this.registry = registry;
    this.sessionOperations = sessionOperations;
    this.controls = controls;
    this.leases = leases;
    this.logins = logins;
    this.identities = identities;
  }

  @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
  public void persistControl(BrowserControlService.ControlIntent intent) {
    if ("control".equals(intent.message().get("type"))) {
      outbox.enqueue(intent.workerId(), intent.message());
    }
  }

  @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
  public void dispatch(BrowserControlService.ControlIntent intent) {
    if (!"control".equals(intent.message().get("type"))) {
      workers.getObject().send(intent.workerId(), intent.message());
    }
  }

  @Scheduled(fixedDelay = 500)
  public void deliverControls() {
    for (var delivery : outbox.due()) {
      try {
        if (outbox.deliverable(delivery.id())
            && !workers
                .getObject()
                .send(delivery.workerId(), delivery.workerBootId(), json.map(delivery.message()))) {
          outbox.transportFailed(delivery.id());
        }
      } catch (RuntimeException error) {
        outbox.transportFailed(delivery.id());
        log.warn(
            "Control delivery deferred; messageId={}, errorType={}",
            delivery.id(),
            error.getClass().getSimpleName());
      }
    }
  }

  /** Applies the physical receipt and publishes its delivery atomically with domain state. */
  @Transactional
  public boolean acknowledge(UUID workerId, UUID bootId, JsonNode payload) {
    UUID sessionId = UUID.fromString(payload.path("browserSessionId").asString());
    var receipt = outbox.receipt(workerId, bootId, payload);
    if (receipt.isEmpty()) {
      if (registry.acknowledgeRecovery(workerId, bootId, sessionId, payload)) {
        controls.acknowledgeRecoveredClaim(sessionId);
        return true;
      }
      throw DomainException.conflict(
          "CONTROL_ACK_FENCED", "Control receipt has no committed intent");
    }
    var delivery = receipt.get();
    identities.lockState(delivery.userId());
    leases.lock(sessionId);
    if (outbox.published(delivery.id())) {
      return false;
    }
    if (!outbox.deliverable(delivery.id())) {
      throw DomainException.conflict(
          "CONTROL_ACK_FENCED", "Control transition is no longer current");
    }
    if (!sessionOperations.acknowledge(workerId, bootId, sessionId, payload)
        && !controls.acknowledgeInputFence(workerId, bootId, sessionId, payload)) {
      controls.acknowledge(workerId, bootId, sessionId, payload.path("controlEpoch").asLong());
      logins.exited(workerId, bootId, sessionId, false);
    }
    outbox.confirmed(delivery.id());
    return false;
  }
}
