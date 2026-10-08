package ru.helmglass.api.browsers;

import java.util.Map;
import java.util.UUID;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import ru.helmglass.api.auth.WorkerAuthentication;
import tools.jackson.databind.JsonNode;

@RestController
@RequestMapping("/internal/worker")
public class InternalController {
  private final WorkerAuthentication authentication;
  private final BrowserService browsers;
  private final AdmissionService admission;

  public InternalController(
      WorkerAuthentication authentication, BrowserService browsers, AdmissionService admission) {
    this.authentication = authentication;
    this.browsers = browsers;
    this.admission = admission;
  }

  @PostMapping("/sessions/{id}/events")
  Object event(
      @RequestHeader(value = "X-Worker-Token", required = false) String token,
      @PathVariable UUID id,
      @RequestBody JsonNode event) {
    authentication.verify(token);
    browsers.reconcile(id, event);
    return Map.of("accepted", true);
  }

  @PostMapping("/drain")
  @Transactional
  Object drain(
      @RequestHeader(value = "X-Worker-Token", required = false) String token,
      @RequestBody DrainRequest request) {
    authentication.verify(token);
    admission.drain(request.drain());
    return admission.drainState();
  }

  @GetMapping("/drain")
  Object drain(@RequestHeader(value = "X-Worker-Token", required = false) String token) {
    authentication.verify(token);
    return admission.drainState();
  }

  public record DrainRequest(boolean drain) {}
}
