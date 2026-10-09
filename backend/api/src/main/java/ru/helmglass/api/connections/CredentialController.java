package ru.helmglass.api.connections;

import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.helmglass.api.auth.Identity;

/** Credentials never enter generic task commands, request fingerprints, or model responses. */
@RestController
@RequestMapping("/api/browser-sessions/{id}/credentials")
public class CredentialController {
  private final Identity identity;
  private final ConnectionService connections;

  public CredentialController(Identity identity, ConnectionService connections) {
    this.identity = identity;
    this.connections = connections;
  }

  @GetMapping
  Object metadata(@PathVariable UUID id, @RequestParam String viewerId) {
    return connections.credentials(owner(), id, "STATUS", viewerId, Map.of());
  }

  @PostMapping
  Object consent(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String operationId,
      @RequestBody CredentialConsent input) {
    requireOperationId(operationId);
    return connections.credentials(owner(), id, "CONSENT", input.viewerId(),
        Map.of("operationId", operationId, "enabled", input.enabled(),
            "expectedCaptureRevision", input.expectedCaptureRevision()));
  }

  @DeleteMapping
  Object delete(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String operationId,
      @RequestBody CredentialDelete input) {
    requireOperationId(operationId);
    return connections.credentials(owner(), id, "DELETE", input.viewerId(),
        Map.of("operationId", operationId, "expectedRevision", input.expectedRevision()));
  }

  private UUID owner() {
    var actor = identity.current();
    if (!"WEB".equals(actor.channel())) {
      throw Identity.denied("Сохранённый пароль доступен только в защищённом входе владельца.");
    }
    return actor.id();
  }

  private static void requireOperationId(String operationId) {
    if (operationId == null || operationId.length() < 8 || operationId.length() > 128) {
      throw new IllegalArgumentException("Invalid credential operation identity");
    }
  }

  public record CredentialConsent(
      String viewerId, Boolean enabled, long expectedCaptureRevision) {
    public CredentialConsent {
      UUID.fromString(viewerId);
      if (enabled == null || expectedCaptureRevision < 0) {
        throw new IllegalArgumentException("Invalid credential consent revision");
      }
    }
  }

  public record CredentialDelete(String viewerId, long expectedRevision) {
    public CredentialDelete {
      UUID.fromString(viewerId);
      if (expectedRevision < 0) {
        throw new IllegalArgumentException("Invalid credential revision");
      }
    }
  }

}
