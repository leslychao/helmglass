package com.helmglass.continuation.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.helmglass.api.JsonSupport;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.domain.ChatPresentation;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.task.api.TaskContracts.TaskView;
import com.helmglass.task.application.TaskLifecycleService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class TaskPresentationServiceTest {
  private final TaskLifecycleService tasks = mock(TaskLifecycleService.class);
  private final RealtimeDeliveryService realtime = mock(RealtimeDeliveryService.class);
  private final TaskContinuationService continuations = mock(TaskContinuationService.class);
  private final BrowserSessionService browsers = mock(BrowserSessionService.class);
  private final ChannelTicketService tickets = mock(ChannelTicketService.class);
  private final TaskPresentationService presentations =
      new TaskPresentationService(
          tasks,
          realtime,
          continuations,
          browsers,
          new JsonSupport(JsonMapper.builder().findAndAddModules().build()),
          tickets,
          "https://helm.test",
          "https://widget.test");
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
  private final HostConversationContext host =
      new HostConversationContext("CHATGPT_WEB", "2026-10-03", "a".repeat(64));
  private final UUID taskId = UUID.randomUUID();
  private final UUID scopeId = UUID.randomUUID();

  @Test
  void anotherTaskInTheSameConversationKeepsTheScopeRevisionWithoutClaimingItsPresentation() {
    task();
    ChatPresentation slot = slot(UUID.randomUUID());
    when(realtime.currentPresentation(actor, host)).thenReturn(Optional.of(slot));

    var reference = presentations.get(actor, taskId, host).path("presentation");

    assertThat(reference.path("taskId").asString()).isEqualTo(taskId.toString());
    assertThat(reference.path("viewScopeId").asString()).isEqualTo(scopeId.toString());
    assertThat(reference.path("presentationRevision").asLong()).isEqualTo(4);
    assertThat(reference.path("taskVersion").asLong()).isEqualTo(7);
    assertThat(reference.path("presentationState").asString()).isEqualTo("LINK_ONLY");
    assertThat(reference.path("reason").asString()).isEqualTo("PRESENTATION_NOT_PUBLISHED");
    assertThat(reference.path("automaticContinuationAvailable").asBoolean()).isFalse();
    verifyNoInteractions(continuations, browsers, tickets);
  }

  @Test
  void thePublishedTaskRetainsItsActivePresentation() {
    task();
    ChatPresentation slot = slot(taskId);
    when(realtime.currentPresentation(actor, host)).thenReturn(Optional.of(slot));
    when(continuations.automaticContinuationAvailable(actor, host, taskId)).thenReturn(true);

    var reference = presentations.get(actor, taskId, host).path("presentation");

    assertThat(reference.path("viewScopeId").asString()).isEqualTo(scopeId.toString());
    assertThat(reference.path("presentationRevision").asLong()).isEqualTo(4);
    assertThat(reference.path("presentationState").asString()).isEqualTo("ACTIVE");
    assertThat(reference.path("reason").isNull()).isTrue();
    assertThat(reference.path("automaticContinuationAvailable").asBoolean()).isTrue();
    verifyNoInteractions(browsers, tickets);
  }

  @Test
  void aConversationWithoutAPresentationStartsAtZero() {
    task();
    when(realtime.currentPresentation(actor, host)).thenReturn(Optional.empty());

    var reference = presentations.get(actor, taskId, host).path("presentation");

    assertThat(reference.path("viewScopeId").isNull()).isTrue();
    assertThat(reference.path("presentationRevision").asLong()).isZero();
    assertThat(reference.path("presentationState").asString()).isEqualTo("LINK_ONLY");
    verifyNoInteractions(continuations, browsers, tickets);
  }

  private ChatPresentation slot(UUID presentedTaskId) {
    ChatPresentation slot = mock(ChatPresentation.class);
    when(slot.id()).thenReturn(scopeId);
    when(slot.taskId()).thenReturn(presentedTaskId);
    when(slot.presentationRevision()).thenReturn(4L);
    return slot;
  }

  private void task() {
    Instant created = Instant.parse("2026-10-03T14:00:00Z");
    when(tasks.get(actor, taskId))
        .thenReturn(
            new TaskView(
                taskId,
                2,
                7,
                3,
                "Read public page",
                "Read public page",
                "https://example.test",
                "TEXT",
                true,
                1800,
                "WAITING_AGENT",
                null,
                "WEB",
                null,
                null,
                false,
                created,
                created,
                List.of(),
                null,
                Map.of(),
                null,
                null,
                null,
                null,
                null,
                Map.of(),
                Map.of(),
                null));
  }
}
