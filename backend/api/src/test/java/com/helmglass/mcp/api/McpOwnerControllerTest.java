package com.helmglass.mcp.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.artifact.application.ArtifactService.AudioSource;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.continuation.api.ContinuationContracts;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.continuation.application.TaskPresentationService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.media.application.MediaAnalysisService;
import com.helmglass.operation.application.OperationService;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.ActionRequestService;
import com.helmglass.task.application.ReconciliationService;
import com.helmglass.task.application.ResultService;
import com.helmglass.task.application.TaskContextService;
import com.helmglass.task.application.TaskLifecycleService;
import jakarta.validation.Validator;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

class McpOwnerControllerTest {
  private final JsonMapper mapper =
      JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).build();
  private final TaskLifecycleService tasks = mock(TaskLifecycleService.class);
  private final TaskPresentationService presentations = mock(TaskPresentationService.class);
  private final TaskContinuationService continuations = mock(TaskContinuationService.class);
  private final MediaAnalysisService media = mock(MediaAnalysisService.class);
  private final McpOwnerController controller =
      new McpOwnerController(
          tasks,
          mock(CommandExecutionService.class),
          mock(ConnectionService.class),
          mock(OperationService.class),
          new JsonSupport(mapper),
          mapper,
          mock(Validator.class),
          mock(ResultService.class),
          media,
          continuations,
          mock(ReconciliationService.class),
          mock(TaskContextService.class),
          presentations,
          mock(ActionRequestService.class));
  private final UUID taskId = UUID.randomUUID();
  private final UUID scopeId = UUID.randomUUID();
  private final UUID requestId = UUID.randomUUID();
  private final Instant expiresAt = Instant.parse("2026-10-03T12:05:00Z");
  private final HostConversationContext hostContext =
      new HostConversationContext("CHATGPT_WEB", "2026-10-03", "a".repeat(64));
  private final AuthenticatedActor actor =
      new AuthenticatedActor(
          UUID.randomUUID(),
          null,
          UUID.randomUUID(),
          "helm-mcp",
          "Test",
          "test@example.test",
          1,
          Set.of("tasks:read", "browser:view"),
          true);

  @Test
  void audioUsesTheExistingToolRouteAndStreamsACompleteEnvelopeWithoutConvertingFailureToSuccess()
      throws Exception {
    UUID artifactId = UUID.randomUUID();
    var bytes = ByteBuffer.allocate(60).order(ByteOrder.LITTLE_ENDIAN);
    bytes.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(52);
    bytes.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16);
    bytes.putShort((short) 1).putShort((short) 1).putInt(8000).putInt(16000);
    bytes.putShort((short) 2).putShort((short) 16);
    bytes.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(16);
    while (bytes.hasRemaining()) {
      bytes.putShort((short) 1000);
    }
    byte[] wav = bytes.array();
    var source =
        new AudioSource(artifactId, taskId, "audio/wav", wav.length, JsonSupport.sha256(wav), null);
    var metadata =
        Map.<String, Object>of(
            "artifactId",
            artifactId,
            "delivery",
            Map.of("status", "UNVERIFIED", "reason", "HOST_AUDIO_ACCESS_NOT_VERIFIED"));
    var audio = new MediaAnalysisService.InlineAudio(source, metadata);
    Instant tokenDeadline = Instant.now().plusSeconds(5);
    when(media.inline(actor, artifactId, taskId)).thenReturn(audio);
    doAnswer(
            invocation -> {
              OutputStream output = invocation.getArgument(2);
              assertThat(invocation.<Instant>getArgument(3)).isEqualTo(tokenDeadline);
              output.write(wav);
              return null;
            })
        .when(media)
        .deliver(eq(actor), eq(audio), any(), any());
    var input = payload(arguments().put("artifactId", artifactId.toString()), null);
    var response =
        MockMvcBuilders.standaloneSetup(controller)
            .build()
            .perform(
                post("/internal/mcp/tools/audio.get")
                    .requestAttr(AuthenticatedActor.class.getName(), actor)
                    .requestAttr("helm.authorizationExpiresAt", tokenDeadline)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(mapper.writeValueAsBytes(input)))
            .andReturn()
            .getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    var result = mapper.readTree(response.getContentAsByteArray());
    assertThat(result.path("content").get(0).path("type").asString()).isEqualTo("audio");
    assertThat(result.path("content").get(0).path("mimeType").asString()).isEqualTo("audio/wav");
    assertThat(Base64.getDecoder().decode(result.path("content").get(0).path("data").asString()))
        .isEqualTo(wav);
    assertThat(result.path("structuredContent").path("delivery").path("status").asString())
        .isEqualTo("UNVERIFIED");
    assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
    doAnswer(
            invocation -> {
              OutputStream output = invocation.getArgument(2);
              output.write(wav, 0, 3);
              throw new IOException("Storage interrupted");
            })
        .when(media)
        .deliver(eq(actor), eq(audio), any(), any());
    var incomplete = new MockHttpServletResponse();
    var authorized = request();
    authorized.setAttribute("helm.authorizationExpiresAt", Instant.now().plusSeconds(300));
    assertThatThrownBy(() -> controller.audio(input, authorized, incomplete))
        .isInstanceOf(IOException.class)
        .hasMessage("Storage interrupted");
    assertThatThrownBy(() -> mapper.readTree(incomplete.getContentAsByteArray()))
        .isInstanceOf(RuntimeException.class);
    var expired = request();
    expired.setAttribute("helm.authorizationExpiresAt", Instant.now().minusSeconds(1));
    assertThatThrownBy(() -> controller.audio(input, expired, new MockHttpServletResponse()))
        .isInstanceOfSatisfying(
            DomainException.class, error -> assertThat(error.getCode()).isEqualTo("TOKEN_EXPIRED"));
  }

  @Test
  void createRejectsUnknownTitleAndPassesCanonicalGoalAndHostToOwner() {
    ObjectNode args =
        mapper
            .createObjectNode()
            .put("goal", "Read public documentation")
            .put("startUrl", "https://example.test")
            .put("outputFormat", "TEXT")
            .put("confirmImportantActions", true)
            .put("browserTimeLimitSeconds", 300)
            .put("intent", "PREPARE")
            .put("idempotencyKey", "create-contract");
    args.putArray("connectionIds");
    ObjectNode unknown = args.deepCopy().put("title", "Unowned title");
    assertThatThrownBy(
            () -> controller.call("tasks.create", payload(unknown, hostContext), request()))
        .isInstanceOfSatisfying(
            DomainException.class,
            error -> {
              assertThat(error.getStatus()).isEqualTo(422);
              assertThat(error.getCode()).isEqualTo("INVALID_TOOL_ARGUMENTS");
            });
    verifyNoInteractions(tasks);

    controller.call("tasks.create", payload(args, hostContext), request());
    verify(tasks)
        .create(
            actor,
            new TaskContracts.Create(
                "Read public documentation",
                "https://example.test",
                List.of(),
                "TEXT",
                true,
                300,
                "PREPARE"),
            new MutationContext("create-contract", requestId),
            hostContext);
  }

  @Test
  void resumeAcceptsAdvertisedArgumentsWithoutAnUnrelatedBrowserConsent() {
    ObjectNode args =
        arguments().put("expectedTaskVersion", 9).put("idempotencyKey", "resume-contract");
    controller.call("tasks.resume", payload(args, hostContext), request());
    verify(tasks)
        .resume(
            actor,
            taskId,
            new TaskContracts.Resume(9L, null),
            new MutationContext("resume-contract", requestId));

    UUID resolutionId = UUID.randomUUID();
    controller.call(
        "tasks.resume",
        payload(args.put("resolutionId", resolutionId.toString()), hostContext),
        request());
    verify(tasks)
        .resume(
            actor,
            taskId,
            new TaskContracts.Resume(9L, resolutionId),
            new MutationContext("resume-contract", requestId));
  }

  @Test
  void resumeRejectsUnownedBrowserConsentWithoutWeakeningStrictDecoding() {
    ObjectNode args =
        arguments()
            .put("expectedTaskVersion", 9)
            .put("idempotencyKey", "resume-contract")
            .put("consentNewBrowser", true);
    assertThatThrownBy(() -> controller.call("tasks.resume", payload(args, hostContext), request()))
        .isInstanceOfSatisfying(
            DomainException.class,
            error -> assertThat(error.getCode()).isEqualTo("INVALID_TOOL_ARGUMENTS"));
    verifyNoInteractions(tasks);
  }

  @Test
  void viewPassesVerifiedHostContextAndAuthenticatedTokenExpiryToOwner() {
    ObjectNode args =
        arguments()
            .put("viewScopeId", scopeId.toString())
            .put("expectedPresentationRevision", 7)
            .put("idempotencyKey", "view-contract");
    var context = new MutationContext("view-contract", requestId);
    Map<String, Object> result = Map.of("presentation", Map.of("presentationRevision", 8));
    when(presentations.view(actor, taskId, scopeId, 7, context, hostContext, expiresAt))
        .thenReturn(result);

    assertThat(controller.call("tasks.view", payload(args, hostContext), request()))
        .isSameAs(result);
    verify(presentations).view(actor, taskId, scopeId, 7, context, hostContext, expiresAt);
  }

  @Test
  void attachPreservesViewerAndObservedSessionBinding() {
    UUID viewerId = UUID.randomUUID();
    UUID sessionId = UUID.randomUUID();
    ObjectNode args =
        arguments()
            .put("viewScopeId", scopeId.toString())
            .put("presentationRevision", 8)
            .put("viewerInstanceId", viewerId.toString())
            .put("observedSessionId", sessionId.toString());

    controller.call("browser.attach_view", payload(args, hostContext), request());

    verify(presentations)
        .attach(actor, taskId, scopeId, 8, viewerId, sessionId, hostContext, expiresAt);
  }

  @Test
  void attachWithoutHostMetadataCannotPromoteArgumentsIntoHostContext() {
    UUID viewerId = UUID.randomUUID();
    ObjectNode args =
        arguments()
            .put("viewScopeId", scopeId.toString())
            .put("presentationRevision", 0)
            .put("viewerInstanceId", viewerId.toString())
            .putNull("observedSessionId");
    args.set("hostContext", mapper.valueToTree(hostContext));

    controller.call("browser.attach_view", payload(args, null), request());

    verify(presentations).attach(actor, taskId, scopeId, 0, viewerId, null, null, expiresAt);
  }

  @Test
  void getUsesPresentationReadOwnerWithoutRequestingANewRevision() {
    ObjectNode result = arguments().put("version", 4);
    when(presentations.get(actor, taskId, hostContext)).thenReturn(result);

    assertThat(controller.call("tasks.get", payload(arguments(), hostContext), request()))
        .isSameAs(result);

    verify(presentations).get(actor, taskId, hostContext);
    verifyNoInteractions(tasks);
  }

  @Test
  void presentationCannotUseExpirySuppliedByCallerArguments() {
    ObjectNode args =
        arguments()
            .put("expectedPresentationRevision", 0)
            .put("idempotencyKey", "view-expiry")
            .put("authorizationExpiresAt", expiresAt.toString());
    MockHttpServletRequest request = request();
    request.removeAttribute("helm.authorizationExpiresAt");

    assertThatThrownBy(() -> controller.call("tasks.view", payload(args, hostContext), request))
        .isInstanceOfSatisfying(
            DomainException.class,
            error -> assertThat(error.getCode()).isEqualTo("INVALID_MCP_DELEGATION"));
    verifyNoInteractions(presentations);
  }

  private ObjectNode arguments() {
    return mapper.createObjectNode().put("taskId", taskId.toString());
  }

  @Test
  void deliveryToolsReachContinuationOwnerWithVerifiedConversationAndStableKey() {
    UUID continuationId = UUID.randomUUID();
    UUID viewerId = UUID.randomUUID();
    ObjectNode prepare =
        arguments()
            .put("continuationId", continuationId.toString())
            .put("viewScopeId", scopeId.toString())
            .put("presentationRevision", 8)
            .put("viewerInstanceId", viewerId.toString())
            .put("idempotencyKey", "prepare-continuation");
    controller.call("continuations.prepare_message", payload(prepare, hostContext), request());
    verify(continuations)
        .prepareMessage(
            actor,
            hostContext,
            taskId,
            new ContinuationContracts.PrepareMessage(continuationId, scopeId, 8L, viewerId),
            new MutationContext("prepare-continuation", requestId));

    UUID dispatchId = UUID.randomUUID();
    ObjectNode delivery =
        mapper
            .createObjectNode()
            .put("dispatchId", dispatchId.toString())
            .put("outcome", "UNKNOWN")
            .put("idempotencyKey", "record-continuation");
    controller.call("continuations.record_delivery", payload(delivery, hostContext), request());
    verify(continuations)
        .recordDelivery(
            actor,
            hostContext,
            new ContinuationContracts.RecordDelivery(
                dispatchId, ContinuationContracts.DeliveryOutcome.UNKNOWN),
            new MutationContext("record-continuation", requestId));
    verifyNoInteractions(presentations);
  }

  private McpOwnerController.ToolRequest payload(
      ObjectNode arguments, HostConversationContext host) {
    ObjectNode input = mapper.createObjectNode().put("requestId", requestId.toString());
    input.set("arguments", arguments);
    if (host != null) {
      input.set("hostContext", mapper.valueToTree(host));
    }
    return mapper.treeToValue(input, McpOwnerController.ToolRequest.class);
  }

  private MockHttpServletRequest request() {
    var request = new MockHttpServletRequest();
    request.setAttribute(AuthenticatedActor.class.getName(), actor);
    request.setAttribute("helm.authorizationExpiresAt", expiresAt);
    return request;
  }
}
