package com.helmglass.task.api;

import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.application.BrowserOpenService;
import com.helmglass.continuation.api.ContinuationContracts;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.task.application.ReconciliationService;
import com.helmglass.task.application.TaskLifecycleService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/tasks")
public class TaskController {
  private final TaskLifecycleService tasks;
  private final ReconciliationService reconciliation;
  private final TaskContinuationService continuations;
  private final BrowserOpenService browsers;

  public TaskController(
      TaskLifecycleService tasks,
      ReconciliationService reconciliation,
      TaskContinuationService continuations,
      BrowserOpenService browsers) {
    this.tasks = tasks;
    this.reconciliation = reconciliation;
    this.continuations = continuations;
    this.browsers = browsers;
  }

  @PostMapping("/{id}/browser-sessions")
  @ResponseStatus(HttpStatus.ACCEPTED)
  MutationReceipt openBrowser(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.Open input,
      HttpServletRequest request) {
    return browsers.open(Actors.current(request), id, input, MutationContext.from(request));
  }

  @GetMapping
  PageResult<Map<String, Object>> list(
      @RequestParam MultiValueMap<String, String> query, HttpServletRequest request) {
    return tasks.list(Actors.current(request), PageQuery.from(query));
  }

  @GetMapping("/summary")
  Map<String, Long> summary(HttpServletRequest request) {
    return tasks.summary(Actors.current(request));
  }

  @GetMapping("/{id}")
  TaskContracts.TaskView get(@PathVariable UUID id, HttpServletRequest request) {
    return tasks.get(Actors.current(request), id);
  }

  @DeleteMapping("/{id}")
  MutationReceipt delete(@PathVariable UUID id, HttpServletRequest request) {
    return tasks.delete(Actors.current(request), id, MutationContext.from(request));
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  MutationReceipt create(
      @Valid @RequestBody TaskContracts.Create input, HttpServletRequest request) {
    return tasks.create(Actors.current(request), input, MutationContext.from(request));
  }

  @PatchMapping("/{id}")
  MutationReceipt edit(
      @PathVariable UUID id,
      @Valid @RequestBody TaskContracts.Edit input,
      HttpServletRequest request) {
    return tasks.edit(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/{id}/prepare")
  MutationReceipt prepare(
      @PathVariable UUID id,
      @Valid @RequestBody TaskContracts.ExpectedVersion input,
      HttpServletRequest request) {
    return tasks.prepare(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/{id}/resume")
  MutationReceipt resume(
      @PathVariable UUID id,
      @Valid @RequestBody TaskContracts.Resume input,
      HttpServletRequest request) {
    return tasks.resume(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/{id}/clarifications")
  MutationReceipt clarify(
      @PathVariable UUID id,
      @Valid @RequestBody TaskContracts.Clarification input,
      HttpServletRequest request) {
    return tasks.clarify(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/{id}/reconcile")
  MutationReceipt reconcile(
      @PathVariable UUID id,
      @Valid @RequestBody TaskContracts.Reconcile input,
      HttpServletRequest request) {
    return reconciliation.reconcile(
        Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/{id}/continue")
  MutationReceipt continueTask(
      @PathVariable UUID id,
      @Valid @RequestBody ContinuationContracts.Claim input,
      HttpServletRequest request) {
    return continuations.claim(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/{id}/completion")
  MutationReceipt complete(
      @PathVariable UUID id,
      @Valid @RequestBody TaskContracts.Completion input,
      HttpServletRequest request) {
    return tasks.complete(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/{id}/pause")
  @ResponseStatus(HttpStatus.ACCEPTED)
  MutationReceipt pause(@PathVariable UUID id, HttpServletRequest request) {
    return tasks.pause(Actors.current(request), id, MutationContext.from(request));
  }

  @PostMapping("/{id}/stop")
  @ResponseStatus(HttpStatus.ACCEPTED)
  MutationReceipt stop(@PathVariable UUID id, HttpServletRequest request) {
    return tasks.stop(Actors.current(request), id, MutationContext.from(request));
  }

  @PostMapping("/{id}/copy")
  @ResponseStatus(HttpStatus.ACCEPTED)
  MutationReceipt copy(@PathVariable UUID id, HttpServletRequest request) {
    return tasks.copy(Actors.current(request), id, MutationContext.from(request));
  }

  @GetMapping("/{id}/clarifications")
  Map<String, Object> clarifications(
      @PathVariable UUID id,
      @RequestParam(defaultValue = "0") long afterRevision,
      @RequestParam(defaultValue = "50") int limit,
      HttpServletRequest request) {
    return tasks.clarifications(Actors.current(request), id, afterRevision, limit);
  }

  @GetMapping("/{id}/events")
  PageResult<Map<String, Object>> events(
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      HttpServletRequest request) {
    return tasks.events(Actors.current(request), id, PageQuery.from(query));
  }
}
