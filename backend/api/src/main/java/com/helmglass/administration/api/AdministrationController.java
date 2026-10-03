package com.helmglass.administration.api;

import com.helmglass.account.application.AccountLifecycleService;
import com.helmglass.administration.application.AdministrationService;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.UUID;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/admin")
public class AdministrationController {
  private final AdministrationService administration;
  private final AccountLifecycleService accounts;

  public AdministrationController(
      AdministrationService administration, AccountLifecycleService accounts) {
    this.administration = administration;
    this.accounts = accounts;
  }

  @GetMapping("/overview")
  Map<String, Object> overview(HttpServletRequest request) {
    return administration.overview(Actors.current(request));
  }

  @GetMapping("/users")
  PageResult<Map<String, Object>> users(
      @RequestParam MultiValueMap<String, String> query, HttpServletRequest request) {
    return administration.users(Actors.current(request), PageQuery.from(query));
  }

  @GetMapping("/users/{id}")
  Map<String, Object> user(@PathVariable UUID id, HttpServletRequest request) {
    return administration.user(Actors.current(request), id);
  }

  @GetMapping("/users/{id}/tasks")
  PageResult<Map<String, Object>> tasks(
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      HttpServletRequest request) {
    return administration.tasks(Actors.current(request), id, PageQuery.from(query));
  }

  @GetMapping("/browsers")
  Map<String, Object> browsers(@RequestParam MultiValueMap<String, String> query, HttpServletRequest request) {
    return administration.browsers(Actors.current(request), AdminContracts.BrowserQuery.from(query));
  }

  @GetMapping("/audit")
  PageResult<Map<String, Object>> audit(
      @RequestParam MultiValueMap<String, String> query, HttpServletRequest request) {
    return administration.audit(Actors.current(request), null, PageQuery.from(query));
  }

  @GetMapping("/users/{id}/audit")
  PageResult<Map<String, Object>> userAudit(
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      HttpServletRequest request) {
    return administration.audit(Actors.current(request), id, PageQuery.from(query));
  }

  @PatchMapping("/users/{id}/limits")
  MutationReceipt limits(
      @PathVariable UUID id,
      @Valid @RequestBody AdminContracts.Limits input,
      HttpServletRequest request) {
    return administration.limits(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/users/{id}/block")
  MutationReceipt block(
      @PathVariable UUID id,
      @Valid @RequestBody AdminContracts.Reason input,
      HttpServletRequest request) {
    return accounts.change(
        Actors.current(request), id, input, MutationContext.from(request), "block");
  }

  @PostMapping("/users/{id}/unblock")
  MutationReceipt unblock(
      @PathVariable UUID id,
      @Valid @RequestBody AdminContracts.Reason input,
      HttpServletRequest request) {
    return accounts.change(
        Actors.current(request), id, input, MutationContext.from(request), "unblock");
  }

  @PostMapping("/users/{id}/deletion-requests")
  MutationReceipt deletion(
      @PathVariable UUID id,
      @Valid @RequestBody AdminContracts.Reason input,
      HttpServletRequest request) {
    return accounts.change(
        Actors.current(request), id, input, MutationContext.from(request), "delete");
  }

  @PostMapping("/deletion-requests/{id}/cancel")
  MutationReceipt restore(
      @PathVariable UUID id,
      @Valid @RequestBody AdminContracts.Reason input,
      HttpServletRequest request) {
    return accounts.restore(Actors.current(request), id, input, MutationContext.from(request));
  }

  @GetMapping("/operations/{id}")
  Map<String, Object> operation(@PathVariable UUID id, HttpServletRequest request) {
    return accounts.operation(Actors.current(request), id);
  }

  @PostMapping("/operations/{id}/retry")
  MutationReceipt retry(
      @PathVariable UUID id,
      @Valid @RequestBody AdminContracts.Reason input,
      HttpServletRequest request) {
    return accounts.retry(Actors.current(request), id, input, MutationContext.from(request));
  }

  @PostMapping("/users/{id}/stop-all")
  MutationReceipt stopAll(
      @PathVariable UUID id,
      @Valid @RequestBody AdminContracts.Stop input,
      HttpServletRequest request) {
    return administration.stopAll(
        Actors.current(request), id, input, MutationContext.from(request));
  }

  @PatchMapping("/platform/admission")
  MutationReceipt admission(
      @Valid @RequestBody AdminContracts.Admission input, HttpServletRequest request) {
    return administration.admission(Actors.current(request), input, MutationContext.from(request));
  }

  @PostMapping("/workers/{id}/drain")
  MutationReceipt drain(
      @PathVariable UUID id,
      @Valid @RequestBody AdminContracts.Reason input,
      HttpServletRequest request) {
    return administration.workerMode(
        Actors.current(request), id, input, MutationContext.from(request), true);
  }

  @PostMapping("/workers/{id}/enable")
  MutationReceipt enable(
      @PathVariable UUID id,
      @Valid @RequestBody AdminContracts.Reason input,
      HttpServletRequest request) {
    return administration.workerMode(
        Actors.current(request), id, input, MutationContext.from(request), false);
  }
}
