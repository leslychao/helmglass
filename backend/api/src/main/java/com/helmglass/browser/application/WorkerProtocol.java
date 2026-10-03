package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/** Validates public commands against the versioned schema shared with the browser worker. */
@Component
public class WorkerProtocol {
  public static String originPolicy(String siteMode) {
    return switch (siteMode) {
      case "ALLOW_LIST" -> "ALLOWLIST";
      case "DENY_LIST" -> "DENYLIST";
      case "ALL" -> "PUBLIC";
      default -> throw new IllegalArgumentException("Unsupported site policy");
    };
  }

  private final Schema action;
  private final Schema inputAction;
  private final Schema artifactMetadata;
  private final Schema artifactReady;
  private final Schema enrollmentRequest;
  private final Schema assignment;
  private final Schema registration;
  private final Schema heartbeat;

  public WorkerProtocol() {
    var registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12);
    action = registry.getSchema(SchemaLocation.of("classpath:worker-protocol/action.schema.json"));
    inputAction =
        registry.getSchema(SchemaLocation.of("classpath:worker-protocol/input-action.schema.json"));
    artifactMetadata =
        registry.getSchema(
            SchemaLocation.of("classpath:worker-protocol/artifact-metadata.schema.json"));
    artifactReady =
        registry.getSchema(
            SchemaLocation.of("classpath:worker-protocol/artifact-ready.schema.json"));
    enrollmentRequest =
        registry.getSchema(
            SchemaLocation.of("classpath:worker-protocol/enrollment-request.schema.json"));
    assignment =
        registry.getSchema(SchemaLocation.of("classpath:worker-protocol/assignment.schema.json"));
    registration =
        registry.getSchema(
            SchemaLocation.of("classpath:worker-protocol/worker-registration.schema.json"));
    heartbeat =
        registry.getSchema(
            SchemaLocation.of("classpath:worker-protocol/worker-heartbeat.schema.json"));
  }

  public void validateAction(JsonNode value) {
    validate(action, value);
  }

  public void validateInputAction(JsonNode value) {
    validate(inputAction, value);
  }

  public void validateArtifactMetadata(JsonNode value) {
    validate(artifactMetadata, value);
  }

  public void validateArtifactReady(JsonNode value) {
    validate(artifactReady, value);
  }

  public void validateEnrollmentRequest(JsonNode value) {
    validate(enrollmentRequest, value);
  }

  public void validateAssignment(JsonNode value) {
    validate(assignment, value);
  }

  public void validateRegistration(JsonNode value) {
    validate(registration, value);
  }

  public void validateHeartbeat(JsonNode value) {
    validate(heartbeat, value);
  }

  private static void validate(Schema schema, JsonNode value) {
    var errors =
        schema.validate(
            value,
            context -> context.executionConfig(config -> config.formatAssertionsEnabled(true)));
    if (!errors.isEmpty()) {
      throw new DomainException(
          422, "INVALID_ACTION", "Action does not match the browser contract");
    }
  }
}
