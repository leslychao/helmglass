package com.helmglass.mcp.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.continuation.application.TaskPresentationService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.media.application.MediaAnalysisService;
import com.helmglass.operation.application.OperationService;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.task.application.ActionRequestService;
import com.helmglass.task.application.ReconciliationService;
import com.helmglass.task.application.ResultService;
import com.helmglass.task.application.TaskContextService;
import com.helmglass.task.application.TaskLifecycleService;
import jakarta.validation.Validator;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

class McpOwnerControllerTest {
  private final JsonMapper mapper = JsonMapper.builder().build();
  private final TaskLifecycleService tasks = mock(TaskLifecycleService.class);
  private final TaskPresentationService presentations = mock(TaskPresentationService.class);
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
          mock(MediaAnalysisService.class),
          mock(TaskContinuationService.class),
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
