package com.helmglass.continuation.application;

import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.application.ChannelTicketService;
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
    ChatPresentation slot =
        realtime
            .currentPresentation(actor, host)
            .filter(value -> value.taskId().equals(taskId))
            .orElse(null);
    ObjectNode result = (ObjectNode) json.tree(task);
    result.set(
        "presentation",
        json.tree(
            presentation(
                task,
                slot,
                slot == null ? "LINK_ONLY" : "ACTIVE",
                slot == null ? "PRESENTATION_NOT_PUBLISHED" : null)));
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
    Map<String, Object> snapshot = new HashMap<>();
    Map<String, Object> reference = presentation(task, attachment.slot(), attachment.state(), attachment.reason());
    reference.put("viewScopeId", scope);
    reference.put("presentationRevision", revision);
    snapshot.put("presentation", reference);
    snapshot.put("session", browsers.currentForTask(actor, taskId).orElse(null));
    snapshot.put("continuation", task.continuation());
    snapshot.put(
        "browserContextChanged",
        observedSessionId != null && !Objects.equals(observedSessionId, sessionId(task)));
    // Host correlation does not establish actual host WebRTC or physical fence acceptance.
    snapshot.put("videoState", "UNAVAILABLE");
    snapshot.put("videoUnavailableReason", "HOST_WEBRTC_NOT_VERIFIED");
    if (attachment.state().equals("ACTIVE") && attachment.slot() != null
        && !attachment.slot().eventsConnected() && !widgetOrigin.isBlank()) {
      snapshot.put("_meta", Map.of("eventTicket", tickets.eventTicket(attachment.slot(), widgetOrigin,
          origin.replaceFirst("^http", "ws") + "/events/v1/widget/tasks/" + taskId)));
    }
    return snapshot;
  }

  private Map<String, Object> presentation(
      TaskView task, ChatPresentation slot, String state, String reason) {
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
    result.put("automaticContinuationAvailable", false);
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
