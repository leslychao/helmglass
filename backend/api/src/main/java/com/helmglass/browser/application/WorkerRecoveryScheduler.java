package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.infrastructure.repository.SchedulerLeadership;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import java.util.Map;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Retries message delivery only while the owner still proves that no command started. */
@Slf4j
@Component
public class WorkerRecoveryScheduler {
  private final WorkerRegistryService registry;
  private final WorkerRegistryRepository workers;
  private final CommandRepository commands;
  private final WorkerGateway gateway;
  private final SchedulerLeadership leadership;

  public WorkerRecoveryScheduler(
      WorkerRegistryService registry,
      WorkerRegistryRepository workers,
      CommandRepository commands,
      WorkerGateway gateway,
      SchedulerLeadership leadership) {
    this.registry = registry;
    this.workers = workers;
    this.commands = commands;
    this.gateway = gateway;
    this.leadership = leadership;
  }

  @Scheduled(fixedDelay = 1000)
  public void reconcile() {
    if (!leadership.acquired()) {
      return;
    }
    for (UUID id : workers.staleWorkers()) {
      run(id, () -> registry.expireWorker(id));
    }
    for (UUID id : workers.expiredRecoveries()) {
      run(id, () -> registry.expireRecovery(id));
    }
    for (UUID id : workers.assignmentsDue()) {
      run(id, () -> deliverAssignment(id));
    }
    for (var worker : workers.recoveryWorkers()) {
      run(worker.id(), () -> deliverRecovery(worker.id(), worker.bootId()));
    }
    for (UUID id : workers.commandsDue()) {
      run(id, () -> deliverCommand(id));
    }
  }

  private void deliverAssignment(UUID id) {
    var delivery = registry.assignmentDelivery(id);
    try {
      gateway.send(
          delivery.workerId(),
          WorkerGateway.envelope(
              "assign", UUID.randomUUID(), Map.of("assignment", delivery.assignment())));
    } catch (DomainException error) {
      if (!error.getCode().equals("WORKER_INVENTORY_RETRY")) {
        registry.rejectAssignment(id);
      }
      throw error;
    }
  }

  private void deliverRecovery(UUID workerId, UUID bootId) {
    for (var intent : registry.recoveryIntents(workerId, bootId)) {
      gateway.send(workerId, intent);
    }
  }

  private void deliverCommand(UUID id) {
    if (registry.claimCommandDelivery(id)) {
      gateway.sendCommand(commands.dispatch(id));
    }
  }

  private static void run(UUID id, Runnable action) {
    try {
      action.run();
    } catch (RuntimeException error) {
      log.warn(
          "Worker recovery deferred; resourceId={}, errorType={}",
          id,
          error.getClass().getSimpleName());
    }
  }
}
