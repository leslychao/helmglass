package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.domain.BrowserActivityClock;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.realtime.domain.BrowserMediaBinding;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.api.TaskContracts.Capability;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

@Service
public class BrowserSessionService {
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final IdentityRepository identities;
  private final ChannelTicketService tickets;
  private final String origin;
  private final LoginRepository logins;
  private final ChangeRepository changes;

  public BrowserSessionService(
      BrowserRepository browsers,
      ControlRepository controls,
      IdentityRepository identities,
      ChannelTicketService tickets,
      LoginRepository logins,
      ChangeRepository changes,
      @Value("${helm.public-origin}") String origin) {
    this.browsers = browsers;
    this.controls = controls;
    this.identities = identities;
    this.tickets = tickets;
    this.logins = logins;
    this.changes = changes;
    this.origin = origin;
  }

  /** Applies only a newly accepted, confirmed command receipt in its owner's transaction. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void commandCompleted(
      UUID userId, UUID workerId, UUID bootId, UUID sessionId, JsonNode receipt) {
    var control = controls.lock(sessionId);
    var session = browsers.owned(userId, sessionId);
    if (receipt.path("status").asString().equals("SUCCEEDED")
        && receipt.path("effectState").asString().equals("CONFIRMED")
        && matches(
            session,
            control,
            workerId,
            bootId,
            receipt.path("allocationEpoch").asLong(-1),
            receipt.path("controlEpoch").asLong(-1),
            receipt.path("pageEpoch").asLong(-1),
            receipt.path("privacyEpoch").asLong(-1))) {
      recordActivity(session, 0, 0);
    }
  }

  /** The first runtime-ready acknowledgement starts idle time; duplicate readiness does not. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void enteredIdle(UUID userId, UUID sessionId) {
    controls.lock(sessionId);
    recordActivity(browsers.owned(userId, sessionId), 0, 0);
  }

  /** A privacy transition changes the idle interval without manufacturing activity. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void synchronizeIdlePolicy(UUID userId, UUID sessionId) {
    controls.lock(sessionId);
    var session = browsers.owned(userId, sessionId);
    browsers.updateIdlePolicy(sessionId, idleSeconds(session)).ifPresent(changes::browserActivity);
  }

  /** Records only an applied action from the current authorized input channel. */
  @Transactional
  public Optional<BrowserActivityClock> inputApplied(
      ChannelTicketService.TicketBinding binding,
      UUID channelId,
      UUID workerId,
      UUID bootId,
      long allocationEpoch,
      long controlEpoch,
      long pageEpoch,
      long privacyEpoch,
      long inputPageEpoch,
      long sequence,
      boolean activity) {
    if (!activity || sequence < 1 || !identities.lockState(binding.userId()).equals("ACTIVE")) {
      return Optional.empty();
    }
    var control = controls.lock(binding.sessionId());
    var session = browsers.owned(binding.userId(), binding.sessionId());
    if (!matches(
            session,
            control,
            workerId,
            bootId,
            allocationEpoch,
            controlEpoch,
            pageEpoch,
            privacyEpoch)
        || !control.state().equals("ACTIVE")
        || !control.ownerKind().equals("HUMAN")
        || !control.expiresAt().isAfter(Instant.now())
        || !Objects.equals(binding.loginId(), control.loginId())
        || !Objects.equals(binding.controllerInstanceId(), control.controllerInstanceId())
        || !channelId.equals(control.inputChannelId())
        || binding.controlEpoch() != controlEpoch
        || binding.pageEpoch() != inputPageEpoch
        || inputPageEpoch > pageEpoch
        || binding.privacyEpoch() != privacyEpoch
        || !identities.authorizationActive(
            binding.userId(), binding.loginId(), null, binding.accessEpoch())) {
      return Optional.empty();
    }
    return recordActivity(session, controlEpoch, sequence);
  }

  private static boolean matches(
      BrowserRepository.Session session,
      ControlRepository.Lease control,
      UUID workerId,
      UUID bootId,
      long allocationEpoch,
      long controlEpoch,
      long pageEpoch,
      long privacyEpoch) {
    return session.state().equals("ACTIVE")
        && Objects.equals(workerId, session.workerId())
        && Objects.equals(bootId, session.workerBootId())
        && session.allocationEpoch() == allocationEpoch
        && control.epoch() == controlEpoch
        && session.pageEpoch() == pageEpoch
        && session.privacyEpoch() == privacyEpoch;
  }

  private Optional<BrowserActivityClock> recordActivity(
      BrowserRepository.Session session, long inputEpoch, long inputSequence) {
    var clock =
        browsers.recordActivity(session.id(), idleSeconds(session), inputEpoch, inputSequence);
    clock.ifPresent(changes::browserActivity);
    return clock;
  }

  /** Rejects queued projections after the runtime, privacy, account, or activity clock changes. */
  @Transactional(readOnly = true)
  public boolean deadlineCurrent(BrowserActivityClock clock) {
    if (!identities.isActive(clock.userId())) {
      return false;
    }
    var session = browsers.owned(clock.userId(), clock.sessionId());
    return session.state().equals("ACTIVE")
        && Objects.equals(session.taskId(), clock.taskId())
        && Objects.equals(session.workerId(), clock.workerId())
        && Objects.equals(session.workerBootId(), clock.workerBootId())
        && session.allocationEpoch() == clock.allocationEpoch()
        && session.privacyEpoch() == clock.privacyEpoch()
        && session.privacy().equals(clock.privacyMode())
        && Objects.equals(session.lastActivityAt(), clock.lastActivityAt())
        && Objects.equals(session.idleDeadlineAt(), clock.idleDeadlineAt())
        && Objects.equals(session.budgetDeadlineAt(), clock.budgetDeadlineAt());
  }

  /** Public clock projection shared by input acknowledgements and realtime delivery. */
  public static Map<String, Object> clockSnapshot(BrowserActivityClock clock) {
    return Map.of(
        "browserSessionId", clock.sessionId(),
        "allocationEpoch", clock.allocationEpoch(),
        "privacyEpoch", clock.privacyEpoch(),
        "lastActivityAt", clock.lastActivityAt(),
        "idleDeadlineAt", clock.idleDeadlineAt(),
        "budgetDeadlineAt", clock.budgetDeadlineAt());
  }

  private static int idleSeconds(BrowserRepository.Session session) {
    return session.privacy().equals("LOGIN_PRIVATE") ? 600 : 900;
  }

  public Map<String, Object> get(AuthenticatedActor actor, UUID id, UUID controller) {
    var session = browsers.owned(actor.userId(), id);
    return snapshot(actor, session, controller);
  }

  /**
   * Resolves the current task binding through the browser owner, never a historical widget hint.
   */
  public record TaskBrowserView(Map<String, Object> snapshot, BrowserMediaBinding media) {}

  public Optional<TaskBrowserView> currentForTask(AuthenticatedActor actor, UUID taskId) {
    actor.requireScope("browser:view");
    return browsers
        .binding(taskId)
        .filter(session -> session.userId().equals(actor.userId()))
        .map(
            session -> {
              var control = controls.get(session.id());
              String reason = null;
              if (!session.privacy().equals("NORMAL")) {
                reason = "PRIVACY_HIDDEN";
              } else if (!session.state().equals("ACTIVE") || !control.state().equals("ACTIVE")) {
                reason = "BROWSER_NOT_READY";
              }
              var media =
                  new BrowserMediaBinding(
                      session.id(),
                      session.workerId(),
                      session.workerBootId(),
                      session.allocationEpoch(),
                      control.epoch(),
                      session.pageEpoch(),
                      session.privacyEpoch(),
                      session.mediaGeneration(),
                      reason);
              return new TaskBrowserView(snapshot(actor, session, control, null), media);
            });
  }

  private Map<String, Object> snapshot(
      AuthenticatedActor actor, BrowserRepository.Session session, UUID controller) {
    return snapshot(actor, session, controls.get(session.id()), controller);
  }

  private Map<String, Object> snapshot(
      AuthenticatedActor actor,
      BrowserRepository.Session session,
      ControlRepository.Lease control,
      UUID controller) {
    UUID id = session.id();
    boolean humanLease =
        control.ownerKind().equals("HUMAN") && control.expiresAt().isAfter(Instant.now());
    boolean self =
        humanLease
            && !actor.mcp()
            && actor.loginId() != null
            && controller != null
            && actor.loginId().equals(control.loginId())
            && controller.equals(control.controllerInstanceId());
    String relation = "NONE";
    if (humanLease) {
      relation = self ? "SELF" : "OTHER";
    }
    boolean runtimeActive = session.state().equals("ACTIVE");
    boolean active = runtimeActive && control.state().equals("ACTIVE");
    boolean privateMode = session.privacy().equals("LOGIN_PRIVATE");
    var login = logins.forSession(id);
    var access = logins.sessionAccess(id);
    boolean web = !actor.mcp();
    boolean otherHuman = humanLease && !self;
    boolean canAcquire =
        runtimeActive
            && web
            && !self
            && !control.state().equals("TRANSFERRING")
            && !controls.sessionOperationPending(id);
    Map<String, Capability> capabilities = new HashMap<>();
    capabilities.put(
        "view",
        capability(
            active && (!privateMode || self),
            true,
            viewUnavailableReason(session.state(), control.state(), privateMode, otherHuman)));
    capabilities.put(
        "acquire",
        capability(
            canAcquire && !otherHuman,
            web && !otherHuman,
            "Управление пока недоступно. Дождитесь готовности браузера."));
    capabilities.put(
        "transfer",
        capability(canAcquire && otherHuman, otherHuman && web, "Дождитесь передачи управления."));
    capabilities.put(
        "login",
        capability(
            active && !privateMode && login.isEmpty() && access.loginRequired() && web,
            !privateMode && access.loginRequired() && web,
            "A login operation is already in progress"));
    capabilities.put(
        "continueLogin",
        capability(
            active && privateMode && self && login.isPresent(),
            login.isPresent() && web,
            "Acquire private control to continue login"));
    capabilities.put(
        "release",
        capability(
            active && self && !privateMode, self && !privateMode, "Finish private login first"));
    capabilities.put("input", capability(active && self, self, "Acquire control to interact"));
    capabilities.put(
        "close",
        capability(
            active && !privateMode && !otherHuman && web,
            web,
            "Finish private login or acquire control before closing"));
    capabilities.put(
        "save",
        capability(
            active && self && !privateMode && session.connectionId() != null,
            web && session.connectionId() != null && !privateMode,
            "Acquire control before saving"));
    capabilities.put(
        "savePolicy",
        capability(
            active && web && !privateMode && session.connectionId() != null,
            web && session.connectionId() != null && !privateMode,
            "Save preference is unavailable"));
    capabilities.put(
        "snapshot",
        capability(
            active && self && !privateMode && session.taskId() != null,
            web && !privateMode && session.taskId() != null,
            "Acquire control before taking a screenshot"));
    for (String name : List.of("back", "forward", "reload", "navigate")) {
      capabilities.put(name, capability(active && self, self, "Acquire control to navigate"));
    }
    Map<String, Object> result = new HashMap<>();
    result.put("id", id);
    result.put("taskId", session.taskId());
    result.put("version", session.version());
    result.put("state", session.state());
    result.put("privacyMode", session.privacy());
    result.put("currentUrl", privateMode && !self ? null : session.currentUrl());
    result.put("connectionId", session.connectionId());
    result.put("connectionVersion", access.connectionVersion());
    result.put("purpose", session.purpose());
    result.put("loginOperationId", login.map(LoginRepository.Login::id).orElse(null));
    result.put("siteAccess", siteAccess(session, privateMode, access));
    result.put("mediaGeneration", session.mediaGeneration());
    result.put("profileVersion", session.profileVersionId());
    result.put("currentProfileVersion", access.currentProfileVersion());
    result.put("savePolicy", session.savePolicy());
    result.put("operationId", control.operationId());
    result.put("closeReason", session.closeReason());
    result.put("controlMode", control.ownerKind());
    result.put("controlState", control.state());
    result.put("controllerRelation", relation);
    result.put("controlEpoch", control.epoch());
    result.put("pageEpoch", session.pageEpoch());
    result.put("privacyEpoch", session.privacyEpoch());
    result.put("allocationEpoch", session.allocationEpoch());
    result.put("budgetDeadlineAt", session.budgetDeadlineAt());
    result.put("lastActivityAt", !privateMode || self ? session.lastActivityAt() : null);
    result.put("idleDeadlineAt", !privateMode || self ? session.idleDeadlineAt() : null);
    result.put(
        "viewport", Map.of("width", session.viewportWidth(), "height", session.viewportHeight()));
    result.put("capabilities", capabilities);
    return result;
  }

  @Transactional
  public Map<String, Object> viewTicket(
      AuthenticatedActor actor, UUID id, BrowserContracts.View input) {
    actor.requireScope("browser:view");
    identities.lockActive(actor.userId());
    var session = browsers.owned(actor.userId(), id);
    var control = controls.get(id);
    DomainException.requireVersion(session.version(), input.expectedVersion());
    if (!Objects.equals(input.taskId(), session.taskId())) {
      throw DomainException.notFound();
    }
    boolean privateMode = !session.privacy().equals("NORMAL");
    boolean privateAuthorized =
        !actor.mcp()
            && input.controllerInstanceId() != null
            && input.controllerInstanceId().equals(control.controllerInstanceId())
            && actor.loginId().equals(control.loginId())
            && control.ownerKind().equals("HUMAN")
            && control.expiresAt().isAfter(Instant.now());
    if (!session.state().equals("ACTIVE")
        || !control.state().equals("ACTIVE")
        || (privateMode && !privateAuthorized)) {
      throw DomainException.conflict("VIDEO_UNAVAILABLE", "Browser video is not available");
    }
    var binding =
        binding(
            actor,
            session,
            control,
            input.viewerInstanceId(),
            privateMode ? input.controllerInstanceId() : null,
            privateMode ? "PRIVATE_VIDEO" : "NORMAL_VIDEO");
    return tickets.issue(
        binding, "signalingUrl", origin.replaceFirst("^http", "ws") + "/stream/v1/signaling/" + id);
  }

  @Transactional
  public Map<String, Object> inputTicket(
      AuthenticatedActor actor, UUID id, BrowserContracts.InputTicket input) {
    if (actor.mcp()) {
      throw new DomainException(403, "WEB_LOGIN_REQUIRED", "Human input requires web login");
    }
    identities.lockActive(actor.userId());
    var session = browsers.owned(actor.userId(), id);
    var control = controls.get(id);
    if (!actor.loginId().equals(control.loginId())
        || !control.state().equals("ACTIVE")
        || !control.ownerKind().equals("HUMAN")
        || !input.controllerInstanceId().equals(control.controllerInstanceId())
        || control.epoch() != input.controlEpoch()
        || !control.expiresAt().isAfter(Instant.now())) {
      throw DomainException.conflict(
          "STALE_CONTROL_EPOCH", "Control authorization is no longer valid");
    }
    return tickets.issue(
        binding(actor, session, control, null, input.controllerInstanceId(), "HUMAN_INPUT"),
        "inputUrl",
        origin.replaceFirst("^http", "ws") + "/stream/v1/input/" + id);
  }

  private static Capability capability(boolean allowed, boolean visible, String reason) {
    return new Capability(allowed, visible, allowed ? null : reason);
  }

  private static String viewUnavailableReason(
      String sessionState, String controlState, boolean privateMode, boolean otherHuman) {
    if (!sessionState.equals("ACTIVE")) {
      return switch (sessionState) {
        case "CLOSED" -> "Браузер закрыт. Вернитесь к подключению или задаче.";
        case "STOPPING" -> "Браузер закрывается.";
        case "LOST" -> "Связь с браузером потеряна.";
        case "RECOVERING" -> "Восстанавливается связь с браузером. Дождитесь подключения.";
        default -> "Браузер ещё не готов. Дождитесь завершения запуска.";
      };
    }
    if (controlState.equals("TRANSFERRING") || controlState.equals("QUIESCING")) {
      return "Подготавливаем безопасную передачу управления. Дождитесь её завершения.";
    }
    if (privateMode && otherHuman) {
      return "Приватный браузер открыт в другой вкладке. Перенесите управление сюда.";
    }
    return privateMode
        ? "Сеанс управления прерван. Нажмите «Восстановить управление», чтобы продолжить вход."
        : "Сеанс управления прерван. Нажмите «Взять управление», чтобы продолжить работу.";
  }

  private static String siteAccess(
      BrowserRepository.Session session,
      boolean privateMode,
      LoginRepository.SessionAccess access) {
    if (privateMode) {
      return "PRIVATE_LOGIN";
    }
    if (access.temporaryLogin()) {
      return "SESSION_ONLY";
    }
    return session.connectionId() == null ? "PUBLIC" : "CONNECTED";
  }

  private ChannelTicketService.TicketBinding binding(
      AuthenticatedActor actor,
      BrowserRepository.Session session,
      ControlRepository.Lease control,
      UUID viewer,
      UUID controller,
      String purpose) {
    return new ChannelTicketService.TicketBinding(
        actor.userId(),
        actor.loginId(),
        actor.grantId(),
        actor.accessEpoch(),
        session.taskId(),
        session.id(),
        viewer,
        controller,
        control.epoch(),
        session.pageEpoch(),
        session.privacyEpoch(),
        session.mediaGeneration(),
        viewer == null ? 1 : tickets.nextViewGeneration(actor.userId(), session.id(), viewer),
        purpose,
        Instant.now().plusSeconds(30),
        Instant.now().plusSeconds(300),
        null,
        0,
        0,
        origin);
  }
}
