package com.helmglass.identity.api;

import com.helmglass.api.DomainException;
import com.helmglass.identity.application.IdentityService;
import com.helmglass.identity.infrastructure.ProxySessionIndex;
import com.helmglass.enrollment.application.WorkerEnrollmentService;
import java.time.Instant;
import java.util.UUID;
import com.helmglass.identity.domain.AuthenticatedActor;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.cert.X509Certificate;
import java.util.List;
import java.util.Collections;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import javax.security.auth.x500.X500Principal;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

public class IdentityFilter extends OncePerRequestFilter {
  private final IdentityService identities;
  private final JwtDecoder decoder;
  private final WorkerEnrollmentService enrollment;
  private final String origin;
  private final List<String> mcpClients;
  private final ProxySessionIndex sessions;

  public IdentityFilter(IdentityService identities, JwtDecoder decoder, WorkerEnrollmentService enrollment, ProxySessionIndex sessions, String origin, List<String> mcpClients) {
    this.identities = identities;
    this.decoder = decoder;
    this.enrollment = enrollment;
    this.origin = origin;
    this.mcpClients = List.copyOf(mcpClients);
    this.sessions = sessions;
  }

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
      FilterChain chain) throws ServletException, IOException {
    String path = request.getRequestURI();
    boolean mcp = path.startsWith("/internal/mcp/");
    if (path.equals("/internal/worker/enroll") && request.getMethod().equals("POST")
        && request.getLocalPort() == 8444) {
      chain.doFilter(request, response);
      return;
    }
    if (path.startsWith("/internal/")) {
      int expectedPort = mcp ? 8446 : 8444;
      Object certificate = request.getAttribute("jakarta.servlet.request.X509Certificate");
      if (request.getLocalPort() != expectedPort
          || !(certificate instanceof X509Certificate[] certificates)
          || certificates.length == 0 || !peerAllowed(certificates[0], mcp)) {
        reject(response, 403, "ACCESS_DENIED");
        return;
      }
      if (!mcp) {
        try {
          String workerHeader = request.getHeader("x-worker-id");
          String bootHeader = request.getHeader("x-worker-boot-id");
          if (workerHeader == null || bootHeader == null) {
            reject(response, 403, "ACCESS_DENIED");
            return;
          }
          UUID workerId = UUID.fromString(workerHeader);
          UUID bootId = UUID.fromString(bootHeader);
          Instant expiry = enrollment.authenticate(certificates[0], workerId, bootId);
          request.setAttribute("helm.workerCertificateExpiresAt", expiry);
        } catch (DomainException | IllegalArgumentException error) {
          reject(response, 403, "ACCESS_DENIED");
          return;
        }
      }
    } else if (request.getLocalPort() == 8444 || request.getLocalPort() == 8446) {
      reject(response, 403, "ACCESS_DENIED");
      return;
    }
    Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication == null && !path.startsWith("/internal/worker/")
        && !path.startsWith("/actuator/health")) {
      String authorization = request.getHeader("Authorization");
      if (authorization == null || !authorization.startsWith("Bearer ")) {
        reject(response, 401, "AUTHENTICATION_REQUIRED");
        return;
      }
      try {
        authentication = new JwtAuthenticationToken(decoder.decode(authorization.substring(7)), List.of());
        SecurityContextHolder.getContext().setAuthentication(authentication);
      } catch (JwtException error) {
        reject(response, 401, "AUTHENTICATION_REQUIRED");
        return;
      }
    }
    if (authentication instanceof JwtAuthenticationToken token) {
      String audience = mcp ? "helm-mcp" : "helm-api-web";
      String client = token.getToken().getClaimAsString("azp");
      if (!token.getToken().getAudience().contains(audience)
          || (!mcp && !"helm-web".equals(client)) || (mcp && !mcpClients.contains(client))) {
        reject(response, 403, "ACCESS_DENIED");
        return;
      }
      try {
        AuthenticatedActor actor = identities.authenticate(token.getToken(), mcp);
        if (!mcp) {
          sessions.track(actor, token.getToken(), Collections.list(request.getHeaders("Cookie")));
        }
        request.setAttribute(AuthenticatedActor.class.getName(), actor);
        request.setAttribute("helm.authorizationExpiresAt", token.getToken().getExpiresAt());
      } catch (DomainException error) {
        response.setStatus(error.getStatus());
        response.setContentType("application/problem+json");
        response.getWriter().write("{\"status\":" + error.getStatus()
            + ",\"code\":\"" + error.getCode() + "\"}");
        return;
      }
    }
    if ((path.startsWith("/api/") && !List.of("GET", "HEAD", "OPTIONS").contains(request.getMethod()))
        || path.equals("/events/v1/user")) {
      String fetchSite = request.getHeader("Sec-Fetch-Site");
      if (!origin.equals(request.getHeader("Origin"))
          || (fetchSite != null && !List.of("same-origin", "none").contains(fetchSite))) {
        reject(response, 403, "ACCESS_DENIED");
        return;
      }
    }
    chain.doFilter(request, response);
  }

  private static void reject(HttpServletResponse response, int status, String code) throws IOException {
    response.setStatus(status);
    response.setContentType("application/problem+json");
    response.getWriter().write("{\"status\":" + status + ",\"code\":\"" + code + "\"}");
  }

  private static boolean peerAllowed(X509Certificate certificate, boolean mcp) {
    String subject = certificate.getSubjectX500Principal().getName(X500Principal.RFC2253);
    return mcp ? subject.equals("CN=mcp-adapter") : subject.startsWith("CN=browser-worker-");
  }
}
