package com.helmglass.identity.api;

import com.helmglass.api.DomainException;
import com.helmglass.identity.domain.AuthenticatedActor;
import jakarta.servlet.http.HttpServletRequest;

public final class Actors {
  private Actors() {}

  public static AuthenticatedActor current(HttpServletRequest request) {
    Object value = request.getAttribute(AuthenticatedActor.class.getName());
    if (value instanceof AuthenticatedActor actor) {
      return actor;
    }
    throw new DomainException(401, "AUTHENTICATION_REQUIRED", "Authentication is required");
  }
}
