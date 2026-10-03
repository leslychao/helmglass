package com.helmglass.realtime.api;

import com.helmglass.identity.domain.AuthenticatedActor;
import java.util.Map;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Component
public class ActorHandshakeInterceptor implements HandshakeInterceptor {
  @Override
  public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
      WebSocketHandler handler, Map<String, Object> attributes) {
    if (request instanceof ServletServerHttpRequest servlet) {
      Object actor = servlet.getServletRequest().getAttribute(AuthenticatedActor.class.getName());
      if (actor != null) {
        attributes.put(AuthenticatedActor.class.getName(), actor);
      }
      Object authorizationExpiry = servlet.getServletRequest()
          .getAttribute("helm.authorizationExpiresAt");
      if (authorizationExpiry != null) {
        attributes.put("helm.authorizationExpiresAt", authorizationExpiry);
      }
      Object expiry = servlet.getServletRequest().getAttribute("helm.workerCertificateExpiresAt");
      if (expiry != null) {
        attributes.put("helm.workerCertificateExpiresAt", expiry);
      }
    }
    return true;
  }

  @Override
  public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
      WebSocketHandler handler, Exception exception) {}
}
