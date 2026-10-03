package com.helmglass.realtime.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.domain.BrowserMediaBinding;
import com.helmglass.realtime.domain.ChatPresentation;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.realtime.domain.ViewerFence;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.realtime.infrastructure.repository.ChatPresentationRepository;
import com.helmglass.realtime.infrastructure.repository.OutboxRepository;
import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;

@Slf4j
@Component
public class RealtimeDeliveryService extends TextWebSocketHandler {
  private static final Set<String> ADMIN_RESOURCES =
      Set.of("users", "userTasks", "userDays", "nodes", "sessions", "audit");
  private static final Set<String> SELF_RESOURCES =
      Set.of(
          "tasks",
          "usage",
          "connections",
          "result",
          "events",
          "artifacts",
          "audio",
          "notifications",
          "sites",
          "operations",
          "browserSessions");
  private static final long SUBSCRIBE_TIMEOUT_NANOS = 5_000_000_000L;
  private static final long IDLE_TIMEOUT_NANOS = 45_000_000_000L;
  private final Map<String, Viewer> viewers = new ConcurrentHashMap<>();
  private final Semaphore connections = new Semaphore(1000);
  private final Semaphore pendingSubscriptions = new Semaphore(100);
  private final OutboxRepository outbox;
  private final IdentityRepository identities;
  private final JsonSupport json;
  private final ChatPresentationRepository presentations;
  private final OperationRepository operations;
  private final ApplicationEventPublisher events;
  private final ChangeRepository changes;


  private record Viewer(
      AuthenticatedActor actor,
      WebSocketSession socket,
      Instant expiresAt,
      long lastReceivedAt,
      Set<String> channels) {
    boolean subscribed() {
      return !channels.isEmpty();
    }
  }

  public RealtimeDeliveryService(
      OutboxRepository outbox,
      IdentityRepository identities,
      JsonSupport json,
      ChatPresentationRepository presentations,
      OperationRepository operations,
      ApplicationEventPublisher events,
      ChangeRepository changes) {
    this.outbox = outbox;
    this.identities = identities;
    this.json = json;
    this.presentations = presentations;
    this.operations = operations;
    this.events = events;
    this.changes = changes;
  }

  public record TaskInvalidation(UUID userId, UUID resourceId, List<String> resources) {}

  public boolean widgetAuthorized(ChannelTicketService.TicketBinding binding) {
    return widgetRejection(binding).isEmpty();
  }

  public Optional<String> widgetRejection(ChannelTicketService.TicketBinding binding) {
    if (!binding.viewerAuthorizationExpiresAt().isAfter(Instant.now())) {
      return Optional.of("AUTHORIZATION_EXPIRED");
    }
    if (binding.viewScopeId() == null
        || binding.grantId() == null
        || !identities.grantAuthorizationActive(
            binding.userId(), binding.grantId(), binding.grantVersion(), binding.accessEpoch())) {
      return Optional.of("GRANT_REVOKED");
    }
    Optional<ChatPresentation> current =
        presentations
            .find(binding.viewScopeId())
            .filter(
                slot ->
                    slot.retiredAt() == null
                        && slot.userId().equals(binding.userId())
                        && slot.current(binding.taskId(), binding.presentationRevision())
                        && (Objects.equals(
                                slot.activeViewerInstanceId(), binding.viewerInstanceId())
                            || slot.activeViewerInstanceId() == null
                                && presentations.currentInstance(
                                    slot.id(),
                                    binding.viewerInstanceId(),
                                    binding.presentationRevision(),
                                    binding.viewGeneration()))
                        && Objects.equals(slot.grantId(), binding.grantId())
                        && slot.grantVersion() == binding.grantVersion()
                        && slot.accessEpoch() == binding.accessEpoch());
    if (current.isEmpty()) {
      return Optional.of("PRESENTATION_SUPERSEDED");
    }
    if (current.get().viewGeneration() != binding.viewGeneration()) {
      return Optional.of("VIEW_GENERATION_CHANGED");
    }
    return current.get().viewerLeaseActive(Instant.now())
        ? Optional.empty()
        : Optional.of("VIEW_LEASE_EXPIRED");
  }

  @Transactional
  public boolean connectWidgetEvents(ChannelTicketService.TicketBinding binding) {
    identities.lockActive(binding.userId());
    return widgetAuthorized(binding) && presentations.connectEvents(binding);
  }

  @Transactional
  public boolean renewWidget(ChannelTicketService.TicketBinding binding) {
    identities.lockActive(binding.userId());
    return widgetAuthorized(binding) && presentations.renewViewer(binding);
  }

  public void disconnectWidgetEvents(ChannelTicketService.TicketBinding binding) {
    presentations.disconnectEvents(binding);
  }

  public record Publication(
      MutationReceipt receipt, ChatPresentation slot, boolean superseded, boolean replayed) {}

  public record Attachment(ChatPresentation slot, String state, String reason) {}

  public record MediaAdmission(
      ChatPresentation slot, boolean issueTicket, String unavailableReason) {}

  @Transactional
  public MediaAdmission prepareWidgetMedia(
      AuthenticatedActor actor,
      HostConversationContext host,
      ChatPresentation attached,
      BrowserMediaBinding media) {
    identities.lockActive(actor.userId());
    ChatPresentation slot =
        requireCurrentViewer(
            actor,
            host,
            attached.id(),
            attached.presentationRevision(),
            attached.activeViewerInstanceId());
    slot = presentations.lock(slot.id()).orElseThrow();
    boolean changed =
        slot.browserSessionId() != null
            && (media == null
                || !media.available()
                || !sameMedia(slot, media)
                || !slot.mediaConnected()
                    && (slot.mediaTicketExpiresAt() == null
                        || !slot.mediaTicketExpiresAt().isAfter(Instant.now())));
    if (changed) {
      presentations.releaseViewer(slot);
      slot =
          presentations.admit(
              slot,
              actor,
              slot.activeViewerInstanceId(),
              slot.grantVersion(),
              slot.viewerAuthorizationExpiresAt(),
              slot.viewerLeaseExpiresAt());
    }
    if (media == null || !media.available()) {
      return new MediaAdmission(
          slot, false, media == null ? "NO_BROWSER" : media.unavailableReason());
    }
    if (!slot.transferState().equals("ACTIVE")) {
      return new MediaAdmission(slot, false, "PRESENTATION_FENCING");
    }
    if (slot.mediaConnected()) {
      return new MediaAdmission(slot, false, null);
    }
    Instant ticketExpiry = Instant.now().plusSeconds(30);
    if (slot.viewerAuthorizationExpiresAt().isBefore(ticketExpiry)) {
      ticketExpiry = slot.viewerAuthorizationExpiresAt();
    }
    return new MediaAdmission(presentations.reserveMedia(slot, media, ticketExpiry), true, null);
  }

  public boolean widgetMediaAuthorized(ChannelTicketService.TicketBinding binding) {
    if (!widgetAuthorized(binding)) {
      return false;
    }
    return presentations
        .find(binding.viewScopeId())
        .filter(
            slot ->
                slot.transferState().equals("ACTIVE")
                    && Objects.equals(slot.browserSessionId(), binding.sessionId())
                    && slot.controlEpoch() == binding.controlEpoch()
                    && slot.pageEpoch() == binding.pageEpoch()
                    && slot.privacyEpoch() == binding.privacyEpoch()
                    && slot.mediaGeneration() == binding.mediaGeneration())
        .isPresent();
  }

  @Transactional
  public boolean connectWidgetMedia(ChannelTicketService.TicketBinding binding) {
    identities.lockActive(binding.userId());
    return widgetMediaAuthorized(binding) && presentations.connectMedia(binding);
  }

  @Transactional
  public void disconnectWidgetMedia(ChannelTicketService.TicketBinding binding) {
    identities.lockState(binding.userId());
    Optional<ChatPresentation> current = presentations.lock(binding.viewScopeId());
    if (current.isPresent()) {
      ChatPresentation slot = current.get();
      if (slot.viewGeneration() == binding.viewGeneration()
          && Objects.equals(slot.activeViewerInstanceId(), binding.viewerInstanceId())) {
        presentations.releaseViewer(slot);
      }
    }
  }

  private static boolean sameMedia(ChatPresentation slot, BrowserMediaBinding media) {
    return Objects.equals(slot.browserSessionId(), media.sessionId())
        && Objects.equals(slot.workerId(), media.workerId())
        && Objects.equals(slot.workerBootId(), media.workerBootId())
        && slot.allocationEpoch() == media.allocationEpoch()
        && slot.controlEpoch() == media.controlEpoch()
        && slot.pageEpoch() == media.pageEpoch()
        && slot.privacyEpoch() == media.privacyEpoch()
        && slot.mediaGeneration() == media.mediaGeneration();
  }

  /** Reads the current reference without publishing, extending a lease, or changing a revision. */
  public Optional<ChatPresentation> currentPresentation(
      AuthenticatedActor actor, HostConversationContext host) {
    if (!supportedHost(actor, host)) {
      return Optional.empty();
    }
    return presentations.find(actor, host.storageKey()).filter(slot -> slot.retiredAt() == null);
  }

  /** Locks and checks the current destination without requiring an iframe to be mounted. */
  @Transactional
  public Optional<ChatPresentation> lockCurrentPresentation(
      AuthenticatedActor actor, HostConversationContext host) {
    if (!supportedHost(actor, host)) {
      return Optional.empty();
    }
    identities.lockActive(actor.userId());
    long grantVersion = identities.activeGrantVersion(actor);
    return presentations
        .lock(actor, host.storageKey())
        .filter(
            slot ->
                slot.retiredAt() == null
                    && actor.grantId().equals(slot.grantId())
                    && grantVersion == slot.grantVersion()
                    && actor.accessEpoch() == slot.accessEpoch());
  }

  @Transactional
  public Publication publishPresentation(
      AuthenticatedActor actor,
      UUID taskId,
      UUID scope,
      long expectedRevision,
      MutationContext context,
      HostConversationContext host,
      Instant authorizationExpiresAt) {
    actor.requireScope("tasks:read");
    actor.requireScope("browser:view");
    identities.lockActive(actor.userId());
    Map<String, Object> input = new HashMap<>();
    input.put("taskId", taskId);
    input.put("viewScopeId", scope);
    input.put("expectedPresentationRevision", expectedRevision);
    input.put("hostCorrelation", supportedHost(actor, host) ? host.storageKey() : null);
    String operation = "tasks.view:" + taskId;
    Optional<MutationReceipt> replay = operations.replay(actor, operation, context, input);
    if (!supportedHost(actor, host)) {
      MutationReceipt receipt =
          replay.orElseGet(
              () -> operations.save(actor, operation, context, input, "task", taskId, 0, true));
      return new Publication(receipt, null, false, replay.isPresent());
    }
    requireAuthorizationExpiry(authorizationExpiresAt);
    long grantVersion = identities.activeGrantVersion(actor);
    Optional<ChatPresentation> current = presentations.lock(actor, host.storageKey());
    if (replay.isPresent()) {
      MutationReceipt receipt = replay.get();
      ChatPresentation slot = current.orElse(null);
      boolean superseded =
          slot == null
              || slot.retiredAt() != null
              || !slot.id().equals(receipt.resource().id())
              || !slot.current(taskId, receipt.resource().version());
      return new Publication(receipt, slot, superseded, true);
    }
    ChatPresentation slot;
    if (current.isEmpty()) {
      if (scope != null || expectedRevision != 0) {
        throw stalePresentation();
      }
      slot = presentations.create(actor, host.storageKey(), taskId, grantVersion);
    } else {
      ChatPresentation previous = current.get();
      if (previous.retiredAt() != null
          || !previous.id().equals(scope)
          || previous.presentationRevision() != expectedRevision) {
        throw stalePresentation();
      }
      presentations.retireViewer(previous);
      slot = presentations.publish(previous, actor, taskId, grantVersion);
    }
    MutationReceipt receipt =
        operations.save(
            actor,
            operation,
            context,
            input,
            "chatViewSlot",
            slot.id(),
            slot.presentationRevision(),
            true);
    return new Publication(receipt, slot, false, false);
  }

  @Transactional
  public Attachment attachPresentation(
      AuthenticatedActor actor,
      UUID taskId,
      UUID scope,
      long revision,
      UUID viewer,
      HostConversationContext host,
      Instant authorizationExpiresAt) {
    actor.requireScope("tasks:read");
    actor.requireScope("browser:view");
    if (!supportedHost(actor, host)) {
      return new Attachment(null, "LINK_ONLY", "HOST_CORRELATION_NOT_VERIFIED");
    }
    identities.lockActive(actor.userId());
    requireAuthorizationExpiry(authorizationExpiresAt);
    long grantVersion = identities.activeGrantVersion(actor);
    ChatPresentation slot = presentations.lock(actor, host.storageKey()).orElse(null);
    if (slot == null || !slot.id().equals(scope)) {
      return new Attachment(null, "LINK_ONLY", "PRESENTATION_NOT_FOUND");
    }
    if (!slot.current(taskId, revision)
        || viewer == null
        || presentations.retiredInstance(scope, viewer)) {
      return new Attachment(slot, "SUPERSEDED", "PRESENTATION_SUPERSEDED");
    }
    Instant now = Instant.now();
    if (slot.activeViewerInstanceId() != null) {
      boolean sameGrant =
          actor.grantId().equals(slot.grantId())
              && grantVersion == slot.grantVersion()
              && actor.accessEpoch() == slot.accessEpoch();
      if (slot.viewerLeaseActive(now) && sameGrant) {
        if (!slot.activeViewerInstanceId().equals(viewer)) {
          throw DomainException.conflict(
              "VIEW_ALREADY_ATTACHED", "This presentation is already open");
        }
        boolean renewAuthorization =
            !slot.viewerAuthorizationExpiresAt().isAfter(now.plusSeconds(15))
                && authorizationExpiresAt.isAfter(slot.viewerAuthorizationExpiresAt());
        if (!renewAuthorization) {
          return new Attachment(slot, "ACTIVE", null);
        }
      }
      presentations.releaseViewer(slot);
      slot = presentations.lock(actor, host.storageKey()).orElseThrow();
    }
    Instant maximum = now.plusSeconds(300);
    Instant expiresAt = authorizationExpiresAt.isBefore(maximum) ? authorizationExpiresAt : maximum;
    Instant leaseExpiresAt = now.plusSeconds(45);
    if (expiresAt.isBefore(leaseExpiresAt)) {
      leaseExpiresAt = expiresAt;
    }
    return new Attachment(
        presentations.admit(slot, actor, viewer, grantVersion, expiresAt, leaseExpiresAt),
        "ACTIVE",
        null);
  }

  /**
   * Shared authority for widget delivery and continuation; callers cannot assert a verified scope.
   */
  public ChatPresentation requireCurrentViewer(
      AuthenticatedActor actor,
      HostConversationContext host,
      UUID scope,
      long revision,
      UUID viewer) {
    long grantVersion = identities.activeGrantVersion(actor);
    ChatPresentation slot =
        currentPresentation(actor, host).orElseThrow(RealtimeDeliveryService::stalePresentation);
    if (!slot.id().equals(scope)
        || slot.presentationRevision() != revision
        || !Objects.equals(slot.activeViewerInstanceId(), viewer)
        || !slot.viewerLeaseActive(Instant.now())
        || !actor.grantId().equals(slot.grantId())
        || grantVersion != slot.grantVersion()
        || actor.accessEpoch() != slot.accessEpoch()) {
      throw stalePresentation();
    }
    return slot;
  }

  @Scheduled(fixedDelay = 1000)
  @Transactional
  public void expirePresentations() {
    for (ChatPresentation slot : presentations.expiredViewers()) {
      presentations.releaseViewer(slot);
    }
  }

  @Transactional
  public boolean confirmViewerFence(ViewerFence fence) {
    var confirmed = presentations.confirmFence(fence);
    confirmed
        .flatMap(presentations::find)
        .ifPresent(
            slot ->
                changes.changed(
                    slot.userId(),
                    "tasks",
                    slot.taskId(),
                    slot.id(),
                    slot.version(),
                    Instant.now()));
    return confirmed.isPresent();
  }

  @Transactional
  public void requestViewerFence(UUID userId, ViewerFence fence) {
    presentations.requestWebFence(userId, fence);
  }

  @Transactional
  public void reconcileClosedViewers() {
    for (ViewerFence fence : presentations.physicallyClosedFences()) {
      confirmViewerFence(fence);
    }
  }

  private static boolean supportedHost(AuthenticatedActor actor, HostConversationContext host) {
    return actor.mcp() && host != null && host.supported();
  }

  private static void requireAuthorizationExpiry(Instant expiry) {
    if (expiry == null || !expiry.isAfter(Instant.now())) {
      throw new DomainException(401, "AUTHORIZATION_EXPIRED", "MCP authorization has expired");
    }
  }

  private static DomainException stalePresentation() {
    return DomainException.conflict("STALE_PRESENTATION", "The current presentation has changed");
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession socket) throws IOException {
    Object value = socket.getAttributes().get(AuthenticatedActor.class.getName());
    Object expiry = socket.getAttributes().get("helm.authorizationExpiresAt");
    if (!(value instanceof AuthenticatedActor actor)
        || actor.mcp()
        || actor.loginId() == null
        || !(expiry instanceof Instant expiresAt)
        || !expiresAt.isAfter(Instant.now())) {
      socket.close(new CloseStatus(4401, "AUTHENTICATION_REQUIRED"));
      return;
    }
    if (!connections.tryAcquire()) {
      socket.close(new CloseStatus(4429, "CONNECTION_LIMIT"));
      return;
    }
    if (!pendingSubscriptions.tryAcquire()) {
      connections.release();
      socket.close(new CloseStatus(4429, "SUBSCRIPTION_LIMIT"));
      return;
    }
    socket.setTextMessageSizeLimit(4096);
    var bounded = new ConcurrentWebSocketSessionDecorator(socket, 5000, 65536);
    viewers.put(socket.getId(), new Viewer(actor, bounded, expiresAt, System.nanoTime(), Set.of()));
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message)
      throws IOException {
    Viewer viewer = viewers.get(socket.getId());
    if (viewer == null || !authorized(viewer)) {
      return;
    }
    if (message.getPayloadLength() > 4096) {
      close(viewer, 4400, "MESSAGE_TOO_LARGE");
      return;
    }
    JsonNode payload;
    try {
      payload = json.read(message.getPayload());
    } catch (JacksonException error) {
      close(viewer, 4400, "INVALID_MESSAGE");
      return;
    }
    String type = payload.path("type").asString();
    if (type.equals("subscribe") && payload.isObject() && payload.size() == 2) {
      subscribe(viewer, payload.path("channels"));
    } else if (type.equals("ping")
        && payload.isObject()
        && payload.size() == 1
        && viewer.subscribed()) {
      viewers.replace(
          socket.getId(),
          viewer,
          new Viewer(
              viewer.actor(),
              viewer.socket(),
              viewer.expiresAt(),
              System.nanoTime(),
              viewer.channels()));
      viewer.socket().sendMessage(new TextMessage(json.write(Map.of("type", "pong"))));
    } else {
      close(viewer, 4400, "INVALID_MESSAGE");
    }
  }

  private void subscribe(Viewer viewer, JsonNode requested) throws IOException {
    if (!requested.isArray() || requested.isEmpty() || requested.size() > 2) {
      close(viewer, 4400, "INVALID_CHANNELS");
      return;
    }
    Set<String> channels = new HashSet<>();
    for (JsonNode item : requested) {
      if (!item.isString()
          || !Set.of("self", "administration").contains(item.asString())
          || !channels.add(item.asString())) {
        close(viewer, 4400, "INVALID_CHANNELS");
        return;
      }
    }
    if (channels.contains("administration")
        && !viewer.actor().permissions().contains("platform_admin")) {
      close(viewer, 4403, "ADMIN_REQUIRED");
      return;
    }
    var subscribed =
        new Viewer(
            viewer.actor(),
            viewer.socket(),
            viewer.expiresAt(),
            System.nanoTime(),
            Set.copyOf(channels));
    if (viewers.replace(viewer.socket().getId(), viewer, subscribed)) {
      if (!viewer.subscribed()) {
        pendingSubscriptions.release();
      }
      viewer.socket().sendMessage(new TextMessage(json.write(Map.of("type", "ready"))));
    }
  }

  @Scheduled(fixedDelay = 500)
  public void relay() {
    for (Viewer viewer : viewers.values()) {
      authorized(viewer);
    }
    for (var intent : outbox.due()) {
      JsonNode payload = json.read(intent.payload());
      List<String> resources = resources(intent, payload);
      String resourceId = payload.path("resourceId").asString();
      if (resourceId.matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")) {
        events.publishEvent(new TaskInvalidation(intent.userId(), UUID.fromString(resourceId), resources));
      }
      for (Viewer viewer : viewers.values()) {
        boolean own = viewer.channels().contains("self") && viewer.actor().userId().equals(intent.userId());
        boolean administration = viewer.channels().contains("administration");
        List<String> visible = resources.stream()
            .filter(resource -> ADMIN_RESOURCES.contains(resource) ? administration : own).toList();
        if (visible.isEmpty() || !authorized(viewer)) {
          continue;
        }
        try {
          viewer.socket().sendMessage(new TextMessage(json.write(Map.of("type", "invalidate", "resources", visible))));
        } catch (IOException error) {
          close(viewer, 4503, "DELIVERY_FAILED");
        }
      }
      outbox.published(intent.id());
    }
  }

  private List<String> resources(OutboxRepository.Intent intent, JsonNode payload) {
    Set<String> resources = new LinkedHashSet<>();
    if (SELF_RESOURCES.contains(intent.eventType())
        || ADMIN_RESOURCES.contains(intent.eventType())) {
      resources.add(intent.eventType());
    }
    JsonNode declared = payload.path("resources");
    if (declared.isArray()) {
      for (JsonNode value : declared) {
        if (value.isString()
            && (SELF_RESOURCES.contains(value.asString())
                || ADMIN_RESOURCES.contains(value.asString()))) {
          resources.add(value.asString());
        }
      }
    }
    return List.copyOf(resources);
  }

  private boolean authorized(Viewer viewer) {
    long timeout = viewer.subscribed() ? IDLE_TIMEOUT_NANOS : SUBSCRIBE_TIMEOUT_NANOS;
    if (System.nanoTime() - viewer.lastReceivedAt() >= timeout) {
      close(viewer, 4401, viewer.subscribed() ? "HEARTBEAT_TIMEOUT" : "SUBSCRIBE_TIMEOUT");
      return false;
    }
    if (!viewer.expiresAt().isAfter(Instant.now())) {
      close(viewer, 4401, "AUTHORIZATION_EXPIRED");
      return false;
    }
    var actor = viewer.actor();
    try {
      if (identities.authorizationActive(
          actor.userId(), actor.loginId(), null, actor.accessEpoch())) {
        return true;
      }
      close(viewer, 4403, "ACCESS_REVOKED");
    } catch (DataAccessException error) {
      close(viewer, 4503, "AUTHORIZATION_UNAVAILABLE");
    }
    return false;
  }

  private void close(Viewer viewer, int code, String reason) {
    remove(viewer.socket().getId());
    try {
      viewer.socket().close(new CloseStatus(code, reason));
    } catch (IOException error) {
      log.debug("Realtime socket already disconnected; code={}", code);
    }
  }

  private void remove(String id) {
    Viewer removed = viewers.remove(id);
    if (removed != null) {
      connections.release();
      if (!removed.subscribed()) {
        pendingSubscriptions.release();
      }
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    remove(socket.getId());
  }
}
