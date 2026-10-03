package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.browser.infrastructure.repository.BrowserOpenRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.usage.application.UsageProjectionService;
import com.helmglass.usage.application.UsageService;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class BrowserAllocationService {
  private final BrowserRepository browsers;
  private final IdentityRepository identities;
  private final CommandRepository commands;
  private final ConnectionService connections;
  private final BrowserStartupRepository startups;
  private final BrowserOpenRepository opens;
  private final UsageService usage;
  private final UsageProjectionService projections;

  public BrowserAllocationService(
      BrowserRepository browsers,
      IdentityRepository identities,
      CommandRepository commands,
      ConnectionService connections,
      BrowserStartupRepository startups,
      BrowserOpenRepository opens,
      UsageService usage,
      UsageProjectionService projections) {
    this.browsers = browsers;
    this.identities = identities;
    this.commands = commands;
    this.connections = connections;
    this.startups = startups;
    this.opens = opens;
    this.usage = usage;
    this.projections = projections;
  }

  public record Allocation(CommandRepository.Dispatch dispatch, boolean newBrowser) {}

  @Transactional
  public Optional<Allocation> allocate(UUID commandId) {
    var candidate = browsers.candidate(commandId);
    identities.lockActive(candidate.userId());
    var task = commands.lockTask(candidate.userId(), candidate.taskId());
    if (!task.state().equals("QUEUED")
        || !List.of("ACCEPTED", "WAITING_RESOURCE").contains(commands.commandState(commandId))) {
      return Optional.empty();
    }
    var existing = browsers.binding(candidate.taskId());
    boolean newBrowser = existing.isEmpty();
    BrowserRepository.Session session;
    if (existing.isPresent()) {
      session = existing.get();
      if (!session.state().equals("ACTIVE")) {
        browsers.waitForResource(commandId, "BROWSER_NOT_READY");
        return Optional.empty();
      }
    } else {
      try {
        browsers.checkBrowserLimit(candidate.userId());
      } catch (DomainException error) {
        browsers.waitForResource(commandId, error.getCode());
        return Optional.empty();
      }
      var worker = browsers.freeWorker();
      if (worker.isEmpty()) {
        browsers.waitForResource(commandId, "PLATFORM_CAPACITY");
        return Optional.empty();
      }
      var connection =
          connections.forBrowser(candidate.userId(), candidate.taskId(), candidate.startUrl());
      session =
          browsers.reserve(
              candidate.userId(),
              candidate.taskId(),
              connection.map(value -> value.id()).orElse(null),
              "TASK",
              worker.get(),
              usage.remainingBrowserSeconds(candidate.taskId()));
      projections.refresh(candidate.userId(), candidate.taskId());
      if (connection.isPresent()) {
        var selected = connection.get();
        startups.prepare(
            session.id(),
            commandId,
            selected.profileVersionId(),
            selected.startUrl(),
            candidate.deadline());
      }
    }
    browsers.dispatch(candidate, session);
    return Optional.of(new Allocation(commands.dispatch(commandId), newBrowser));
  }

  public record OpenAllocation(BrowserRepository.Session session) {}

  /** Called inside the explicit-open owner's user/task transaction. */
  public Optional<OpenAllocation> allocateOpen(
      BrowserRepository.Session requested, String startUrl, Instant deadline) {
    try {
      browsers.checkBrowserLimit(requested.userId());
      var worker = browsers.freeWorker();
      if (worker.isEmpty()) {
        opens.waitForResource(requested.id(), "PLATFORM_CAPACITY");
        return Optional.empty();
      }
      var connection = connections.forBrowser(requested.userId(), requested.taskId(), startUrl);
      if (requested.savePolicy().equals("SAVE_ON_CLOSE") && connection.isEmpty()) {
        throw DomainException.conflict(
            "PROFILE_CONNECTION_REQUIRED",
            "Select a connection before requesting profile persistence");
      }
      var session =
          browsers.allocate(
              requested,
              connection.map(value -> value.id()).orElse(null),
              worker.get(),
              usage.remainingBrowserSeconds(requested.taskId()));
      if (connection.isPresent()) {
        var selected = connection.get();
        startups.prepare(
            session.id(), null, selected.profileVersionId(), selected.startUrl(), deadline);
      }
      return Optional.of(new OpenAllocation(session));
    } catch (DomainException error) {
      if (List.of("USER_BROWSER_LIMIT", "CONNECTION_BUSY").contains(error.getCode())) {
        opens.waitForResource(requested.id(), error.getCode());
      } else {
        opens.finish(requested.id(), "FAILED", error.getCode());
      }
      return Optional.empty();
    }
  }
}
