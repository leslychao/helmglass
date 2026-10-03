package com.helmglass.artifact.api;

import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.artifact.application.ArtifactService;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ContentDisposition;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

@RestController
public class ArtifactController {
  public record Delete(@NotNull Long expectedVersion) {}

  private final ArtifactService artifacts;
  private final WorkerProtocol protocol;
  private final JsonSupport json;

  public ArtifactController(ArtifactService artifacts, WorkerProtocol protocol, JsonSupport json) {
    this.artifacts = artifacts;
    this.protocol = protocol;
    this.json = json;
  }

  @PostMapping("/internal/worker/artifact-transfers/allocate")
  public ArtifactContracts.Allocation allocate(
      @RequestBody JsonNode input,
      @RequestHeader("X-Worker-Id") UUID workerId,
      @RequestHeader("X-Worker-Boot-Id") UUID bootId,
      HttpServletResponse response) {
    response.setHeader("Cache-Control", "no-store");
    protocol.validateArtifactMetadata(input);
    ArtifactContracts.CaptureMetadata metadata =
        input.path("kind").asString().equals("SCREENSHOT")
            ? json.convert(input, ArtifactContracts.ScreenshotMetadata.class)
            : json.convert(input, ArtifactContracts.Metadata.class);
    return artifacts.allocate(workerId, bootId, metadata);
  }

  @PutMapping(
      value = "/internal/worker/artifact-transfers/{id}",
      consumes = "application/octet-stream")
  public ArtifactContracts.Receipt upload(
      @PathVariable UUID id,
      @RequestHeader("X-Worker-Id") UUID workerId,
      @RequestHeader("X-Worker-Boot-Id") UUID bootId,
      @RequestHeader("X-Transfer-Token") String token,
      @RequestHeader("X-Content-SHA256") String checksum,
      HttpServletRequest request,
      HttpServletResponse response)
      throws IOException {
    response.setHeader("Cache-Control", "no-store");
    return artifacts.upload(
        id,
        token,
        workerId,
        bootId,
        request.getContentLengthLong(),
        checksum,
        request.getInputStream());
  }

  @GetMapping("/api/v1/artifacts/{id}")
  public Map<String, Object> metadata(@PathVariable UUID id, HttpServletRequest request) {
    return artifacts.metadata(Actors.current(request), id);
  }

  @GetMapping("/api/v1/artifacts/{id}/content")
  public void download(
      @PathVariable UUID id,
      @RequestHeader(value = "Range", required = false) String range,
      HttpServletRequest request,
      HttpServletResponse response)
      throws IOException {
    var actor = Actors.current(request);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Accept-Ranges", "bytes");
    ArtifactService.Content content = artifacts.content(actor, id, range);
    response.setContentType(content.mime());
    response.setContentLengthLong(content.range().length());
    response.setHeader(
        "Content-Disposition",
        ContentDisposition.attachment()
            .filename(content.filename(), StandardCharsets.UTF_8)
            .build()
            .toString());
    if (content.range().partial()) {
      response.setStatus(206);
      response.setHeader("Content-Range", content.range().responseHeader());
    }
    artifacts.download(
        actor, id, content, response.getOutputStream(), Instant.now().plusSeconds(120));
  }

  @DeleteMapping("/api/v1/artifacts/{id}")
  public MutationReceipt delete(
      @PathVariable UUID id, @Valid @RequestBody Delete input, HttpServletRequest request) {
    return artifacts.delete(
        Actors.current(request), id, input.expectedVersion(), MutationContext.from(request));
  }
}
