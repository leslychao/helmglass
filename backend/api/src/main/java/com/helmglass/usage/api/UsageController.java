package com.helmglass.usage.api;

import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.identity.api.Actors;
import com.helmglass.usage.application.UsagePeriod;
import com.helmglass.usage.application.UsageService;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UsageController {
  private final UsageService usage;

  public UsageController(UsageService usage) {
    this.usage = usage;
  }

  @GetMapping("/api/v1/usage")
  UsageContracts.Summary summary(
      @RequestParam Instant from,
      @RequestParam Instant to,
      @RequestParam(defaultValue = "UTC") String timezone,
      @RequestParam MultiValueMap<String, String> parameters,
      HttpServletRequest request) {
    return usage.summary(Actors.current(request), UsagePeriod.from(from, to, timezone, parameters));
  }

  @GetMapping("/api/v1/tasks/{id}/usage")
  UsageContracts.TaskUsage task(
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> parameters,
      HttpServletRequest request) {
    return usage.task(Actors.current(request), id, PageQuery.from(parameters));
  }

  @GetMapping("/api/v1/admin/users/{id}/usage")
  UsageContracts.Calendar calendar(
      @PathVariable UUID id,
      @RequestParam Instant from,
      @RequestParam Instant to,
      @RequestParam(defaultValue = "UTC") String timezone,
      HttpServletRequest request) {
    return usage.calendar(
        Actors.current(request),
        id,
        new UsagePeriod(from, to, timezone, List.of(), List.of(), false));
  }

  @GetMapping("/api/v1/usage/sites")
  PageResult<UsageContracts.Site> sites(
      @RequestParam Instant from,
      @RequestParam Instant to,
      @RequestParam(defaultValue = "UTC") String timezone,
      @RequestParam MultiValueMap<String, String> parameters,
      HttpServletRequest request) {
    return usage.sites(
        Actors.current(request),
        UsagePeriod.from(from, to, timezone, parameters),
        PageQuery.from(parameters));
  }
}
