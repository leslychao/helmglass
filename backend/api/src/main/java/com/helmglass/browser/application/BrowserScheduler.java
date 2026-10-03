package com.helmglass.browser.application;

import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository;
import com.helmglass.browser.infrastructure.repository.SchedulerLeadership;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.connection.application.ConnectionLoginService;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.task.application.TaskLifecycleService;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Slf4j
@Component
public class BrowserScheduler {
  private final BrowserAllocationService allocator;
  private final SchedulerLeadership leadership;
  private final TaskLifecycleService tasks;
  private final ConnectionLoginService logins;
  private final CommandRepository commands;
  private final BrowserRepository browsers;
  private final WorkerGateway gateway;
  private final UserPolicyService policies;
  private final BrowserOpenService opens;
  private final BrowserStartupRepository startups;
  private final BrowserSessionOperationService sessionOperations;
  private final BrowserCloseDeliveryService closures;

  public BrowserScheduler(
      BrowserAllocationService allocator,
      CommandRepository commands,
      BrowserRepository browsers,
      WorkerGateway gateway,
      UserPolicyService policies,
      SchedulerLeadership leadership,
      TaskLifecycleService tasks,
      ConnectionLoginService logins,
      BrowserOpenService opens,
      BrowserStartupRepository startups,
      BrowserSessionOperationService sessionOperations,
      BrowserCloseDeliveryService closures) {
    this.allocator = allocator;
    this.leadership = leadership;
    this.tasks = tasks;
    this.logins = logins;
    this.commands = commands;
    this.browsers = browsers;
    this.gateway = gateway;
    this.policies = policies;
    this.opens = opens;
    this.startups = startups;
    this.sessionOperations = sessionOperations;
    this.closures = closures;
  }

  @Scheduled(fixedDelay = 500)
  public void dispatch() {
    if (!leadership.acquired()) {
      return;
    }
    for (var target : tasks.pendingStops()) {
      tasks.processStop(target);
    }
    for (var target : tasks.uncompletedStops()) {
      tasks.confirmStopped(target.userId(), target.taskId());
    }
    for (UUID id : logins.pending()) {
      try {
        logins.allocate(id).ifPresent(intent -> gateway.send(intent.workerId(), intent.message()));
      } catch (RuntimeException error) {
        log.warn(
            "Login allocation deferred; operationId={}, errorType={}",
            id,
            error.getClass().getSimpleName());
      }
    }
    for (UUID id : opens.pending()) {
      try {
        opens
            .advance(id)
            .ifPresent(
                allocation -> {
                  var session = allocation.session();
                  var policy = policies.getForExecution(session.userId());
                  Map<String, Object> assignment =
                      BrowserStartupService.scope(startups.context(id));
                  assignment.put("deadline", session.budgetDeadlineAt());
                  assignment.put("originPolicy", WorkerProtocol.originPolicy(policy.siteMode()));
                  assignment.put(
                      "allowedOrigins",
                      policy.siteMode().equals("ALLOW_LIST") ? policy.origins() : List.of());
                  if (policy.siteMode().equals("DENY_LIST")) {
                    assignment.put("deniedOrigins", policy.origins());
                  }
                  assignment.put(
                      "viewport",
                      Map.of("width", session.viewportWidth(), "height", session.viewportHeight()));
                  gateway.send(
                      session.workerId(),
                      WorkerGateway.envelope(
                          "assign", UUID.randomUUID(), Map.of("assignment", assignment)));
                });
      } catch (RuntimeException error) {
        log.warn(
            "Browser opening deferred; sessionId={}, errorType={}",
            id,
            error.getClass().getSimpleName());
      }
    }
    for (UUID id : commands.due()) {
      try {
        var allocation = allocator.allocate(id);
        if (allocation.isEmpty()) {
          continue;
        }
        var dispatch = allocation.get().dispatch();
        if (allocation.get().newBrowser()) {
          var policy = policies.getForExecution(dispatch.userId());
          Map<String, Object> assignment = CommandExecutionService.scope(dispatch);
          assignment.put(
              "deadline",
              browsers.owned(dispatch.userId(), dispatch.sessionId()).budgetDeadlineAt());
          assignment.put("originPolicy", WorkerProtocol.originPolicy(policy.siteMode()));
          assignment.put(
              "allowedOrigins",
              policy.siteMode().equals("ALLOW_LIST") ? policy.origins() : List.of());
          if (policy.siteMode().equals("DENY_LIST")) {
            assignment.put("deniedOrigins", policy.origins());
          }
          assignment.put("viewport", Map.of("width", 1280, "height", 720));
          gateway.send(
              dispatch.workerId(),
              WorkerGateway.envelope(
                  "assign", UUID.randomUUID(), Map.of("assignment", assignment)));
        } else {
          gateway.sendCommand(dispatch);
        }
      } catch (RuntimeException error) {
        log.warn(
            "Command dispatch deferred; commandId={}, errorType={}",
            id,
            error.getClass().getSimpleName());
      }
    }
    sessionOperations.prepareDueClosures();
    closures.dispatch();
  }
}
