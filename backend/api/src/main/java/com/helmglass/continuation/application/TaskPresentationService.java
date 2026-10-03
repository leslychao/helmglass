package com.helmglass.continuation.application;

import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.domain.ChatPresentation;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.task.api.TaskContracts.TaskView;
import com.helmglass.task.application.TaskLifecycleService;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.node.ObjectNode;

/** Composes the owned task snapshot with the realtime owner's conversation presentation. */
@Service
public class TaskPresentationService {
  private final TaskLifecycleService tasks;
  private final RealtimeDeliveryService realtime;
  private final TaskContinuationService continuations;
  private final BrowserSessionService browsers;
  private final JsonSupport json;
  private final String origin;
  private final String widgetOrigin;
  private final ChannelTicketService tickets;

  public TaskPresentationService(
      TaskLifecycleService tasks,
      RealtimeDeliveryService realtime,
      TaskContinuationService continuations,
      BrowserSessionService browsers,
      JsonSupport json,
      ChannelTicketService tickets,
      @Value("${helm.public-origin}") String origin,
      @Value("${helm.widget-origin:}") String widgetOrigin) {
    this.tasks = tasks;
    this.realtime = realtime;
    this.continuations = continuations;
    this.browsers = browsers;
    this.json = json;
    this.origin = origin;
    this.widgetOrigin = widgetOrigin;
    this.tickets = tickets;
  }

  public ObjectNode get(AuthenticatedActor actor, UUID taskId, HostConversationContext host) {
    TaskView task = tasks.get(actor, taskId);
    ChatPresentation slot = realtime.currentPresentation(actor, host).orElse(null);
    // The CAS revision belongs to the conversation, including when another task is displayed.
    boolean published = slot != null && slot.taskId().equals(taskId);
    ObjectNode result = (ObjectNode) json.tree(task);
    result.set(
        "presentation",
        json.tree(
            presentation(
                actor,
                host,
                task,
                slot,
                published ? "ACTIVE" : "LINK_ONLY",
                published ? null : "PRESENTATION_NOT_PUBLISHED")));
    return result;
  }

  @Transactional
  public Map<String, Object> view(
      AuthenticatedActor actor,
      UUID taskId,
      UUID scope,
      long expectedRevision,
      MutationContext context,
      HostConversationContext host,
      Instant authorizationExpiresAt) {
    TaskView task = tasks.get(actor, taskId);
    var publication =
        realtime.publishPresentation(
            actor, taskId, scope, expectedRevision, context, host, authorizationExpiresAt);
    if (publication.slot() != null && !publication.replayed() && !publication.superseded()) {
      continuations.bindDestination(actor, host, taskId);
    }
    String state =
        publication.superseded()
            ? "SUPERSEDED"
            : publication.slot() == null ? "LINK_ONLY" : "ACTIVE";
    Map<String, Object> value =
        presentation(
            actor,
            host,
            task,
            publication.slot(),
            state,
            state.equals("LINK_ONLY") ? "HOST_CORRELATION_NOT_VERIFIED" : null);
    if (publication.superseded()) {
      value.put("viewScopeId", publication.receipt().resource().id());
      value.put("presentationRevision", publication.receipt().resource().version());
    }
    return Map.of("receipt", publication.receipt(), "presentation", value);
  }

  @Transactional
  public Map<String, Object> attach(
      AuthenticatedActor actor,
      UUID taskId,
      UUID scope,
      long revision,
      UUID viewerInstanceId,
      UUID observedSessionId,
      HostConversationContext host,
      Instant authorizationExpiresAt) {
    TaskView task = tasks.get(actor, taskId);
    var attachment =
        realtime.attachPresentation(
            actor, taskId, scope, revision, viewerInstanceId, host, authorizationExpiresAt);
    var browser = browsers.currentForTask(actor, taskId);
    ChatPresentation slot = attachment.slot();
    RealtimeDeliveryService.MediaAdmission media = null;
    if (attachment.state().equals("ACTIVE") && slot != null && !widgetOrigin.isBlank()) {
      media =
          realtime.prepareWidgetMedia(
              actor,
              host,
              slot,
              browser.map(BrowserSessionService.TaskBrowserView::media).orElse(null));
      slot = media.slot();
    }
    Map<String, Object> snapshot = new HashMap<>();
    Map<String, Object> reference =
        presentation(actor, host, task, attachment.slot(), attachment.state(), attachment.reason());
    reference.put("viewScopeId", scope);
    reference.put("presentationRevision", revision);
    snapshot.put("presentation", reference);
    snapshot.put(
        "session", browser.map(BrowserSessionService.TaskBrowserView::snapshot).orElse(null));
    snapshot.put("continuation", task.continuation());
    snapshot.put(
        "browserContextChanged",
        observedSessionId != null && !Objects.equals(observedSessionId, sessionId(task)));
    String unavailable = media == null ? "PRESENTATION_UNAVAILABLE" : media.unavailableReason();
    snapshot.put(
        "videoState",
        unavailable == null || "PRESENTATION_FENCING".equals(unavailable)
            ? "CONNECTING"
            : unavailable.equals("PRIVACY_HIDDEN") ? "PRIVACY_HIDDEN" : "UNAVAILABLE");
    snapshot.put("videoUnavailableReason", unavailable);
    Map<String, Object> metadata = new HashMap<>();
    if (attachment.state().equals("ACTIVE") && slot != null && !widgetOrigin.isBlank()) {
      if (!slot.eventsConnected()) {
        metadata.put(
            "eventTicket",
            tickets.eventTicket(
                slot,
                widgetOrigin,
                origin.replaceFirst("^http", "ws") + "/events/v1/widget/tasks/" + taskId));
      }
      if (media != null && media.issueTicket()) {
        metadata.put(
            "viewTicket",
            tickets.widgetVideoTicket(
                slot,
                widgetOrigin,
                origin.replaceFirst("^http", "ws")
                    + "/stream/v1/widget/signaling/"
                    + slot.browserSessionId()));
      }
    }
    if (!metadata.isEmpty()) {
      snapshot.put("_meta", metadata);
    }
    return snapshot;
  }

  private Map<String, Object> presentation(
      AuthenticatedActor actor,
      HostConversationContext host,
      TaskView task,
      ChatPresentation slot,
      String state,
      String reason) {
    Map<String, Object> result = new HashMap<>();
    result.put("taskId", task.id());
    result.put("taskVersion", task.version());
    result.put("instructionRevision", task.instructionRevision());
    result.put("observedSessionId", sessionId(task));
    result.put("taskUrl", origin + "/tasks/" + task.id());
    result.put("summary", task.title());
    result.put("viewScopeId", slot == null ? null : slot.id());
    result.put("presentationRevision", slot == null ? 0 : slot.presentationRevision());
    result.put("presentationState", state);
    result.put("reason", reason);
    result.put(
        "automaticContinuationAvailable",
        state.equals("ACTIVE")
            && continuations.automaticContinuationAvailable(actor, host, task.id()));
    return result;
  }

  private static UUID sessionId(TaskView task) {
    if (task.currentSession() == null) {
      return null;
    }
    Object id = task.currentSession().get("id");
    return id instanceof UUID value ? value : null;
  }
}
