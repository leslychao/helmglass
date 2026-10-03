package com.helmglass.browser.application;

import com.helmglass.api.DomainException;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.task.api.TaskContracts.Capability;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class BrowserSessionService {
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final IdentityRepository identities;
  private final ChannelTicketService tickets;
  private final String origin;
  private final LoginRepository logins;

  public BrowserSessionService(
      BrowserRepository browsers,
      ControlRepository controls,
      IdentityRepository identities,
      ChannelTicketService tickets,
      LoginRepository logins,
      @Value("${helm.public-origin}") String origin) {
    this.browsers = browsers;
    this.controls = controls;
    this.identities = identities;
    this.tickets = tickets;
    this.logins = logins;
    this.origin = origin;
  }

  public Map<String, Object> get(AuthenticatedActor actor, UUID id, UUID controller) {
    var session = browsers.owned(actor.userId(), id);
    var control = controls.get(id);
    boolean self =
        !actor.mcp()
            && actor.loginId() != null
            && controller != null
            && actor.loginId().equals(control.loginId())
            && controller.equals(control.controllerInstanceId())
            && control.expiresAt().isAfter(Instant.now());
    String relation = "NONE";
    if (control.ownerKind().equals("HUMAN")) {
      relation = self ? "SELF" : "OTHER";
    }
    boolean active = session.state().equals("ACTIVE") && control.state().equals("ACTIVE");
    boolean privateMode = session.privacy().equals("LOGIN_PRIVATE");
    var login = logins.forSession(id);
    var access = logins.sessionAccess(id);
    boolean web = !actor.mcp();
    boolean otherHuman =
        control.ownerKind().equals("HUMAN") && !self && control.expiresAt().isAfter(Instant.now());
    Map<String, Capability> capabilities = new HashMap<>();
    capabilities.put(
        "view", capability(active && (!privateMode || self), true, "Browser is unavailable"));
    capabilities.put(
        "acquire",
        capability(
            active && !self && !otherHuman && web, web && !otherHuman, "Control is unavailable"));
    capabilities.put(
        "transfer",
        capability(active && otherHuman && web, otherHuman && web, "Control is unavailable"));
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
        "release", capability(active && self && !privateMode, self, "Finish private login first"));
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
    result.put("budgetDeadlineAt", session.budgetDeadlineAt());
    result.put("idleDeadlineAt", session.idleDeadlineAt());
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
        Instant.now().plusSeconds(300));
  }
}
