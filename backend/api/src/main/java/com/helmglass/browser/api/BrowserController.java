package com.helmglass.browser.api;

import com.helmglass.api.MutationContext;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserSessionOperationService;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.browser.application.HumanBrowserCommandService;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
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
@RequestMapping("/api/v1/browser-sessions/{id}")
public class BrowserController {
  private final BrowserSessionService sessions;
  private final BrowserControlService controls;
  private final HumanBrowserCommandService navigation;
  private final BrowserSessionOperationService sessionOperations;

  public BrowserController(
      BrowserSessionService sessions,
      BrowserControlService controls,
      HumanBrowserCommandService navigation,
      BrowserSessionOperationService sessionOperations) {
    this.sessions = sessions;
    this.controls = controls;
    this.navigation = navigation;
    this.sessionOperations = sessionOperations;
  }

  @PostMapping("/navigation")
  @ResponseStatus(HttpStatus.ACCEPTED)
  MutationReceipt navigate(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.Navigation input,
      HttpServletRequest request) {
    return navigation.navigate(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/snapshots")
  @ResponseStatus(HttpStatus.ACCEPTED)
  MutationReceipt snapshot(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.Snapshot input,
      HttpServletRequest request) {
    return navigation.snapshot(Actors.current(request), id, input, MutationContext.from(request));
  }

  @GetMapping
  Map<String, Object> get(
      @PathVariable UUID id,
      @RequestParam(required = false) UUID controllerInstanceId,
      HttpServletRequest request) {
    return sessions.get(Actors.current(request), id, controllerInstanceId);
  }

  @PostMapping("/view-tickets")
  Map<String, Object> view(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.View input,
      HttpServletRequest request) {
    return sessions.viewTicket(Actors.current(request), id, input);
  }

  @PostMapping("/control/acquire")
  MutationReceipt acquire(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.TakeControl input,
      HttpServletRequest request) {
    return controls.acquire(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/control/release")
  MutationReceipt release(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.ReleaseControl input,
      HttpServletRequest request) {
    return controls.release(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/control/renew")
  Map<String, Object> renew(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.Renew input,
      HttpServletRequest request) {
    return controls.renew(Actors.current(request), id, input);
  }

  @PostMapping("/control/input-tickets")
  Map<String, Object> input(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.InputTicket input,
      HttpServletRequest request) {
    return sessions.inputTicket(Actors.current(request), id, input);
  }

  @PostMapping("/close")
  @ResponseStatus(HttpStatus.ACCEPTED)
  MutationReceipt close(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.Close input,
      HttpServletRequest request) {
    return sessionOperations.close(
        Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/save")
  @ResponseStatus(HttpStatus.ACCEPTED)
  MutationReceipt save(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.Save input,
      HttpServletRequest request) {
    return sessionOperations.save(
        Actors.current(request), id, input, MutationContext.from(request));
  }

  @PatchMapping("/save-policy")
  MutationReceipt savePolicy(
      @PathVariable UUID id,
      @Valid @RequestBody BrowserContracts.SavePolicy input,
      HttpServletRequest request) {
    return sessionOperations.savePolicy(
        Actors.current(request), id, input, MutationContext.from(request));
  }
}
