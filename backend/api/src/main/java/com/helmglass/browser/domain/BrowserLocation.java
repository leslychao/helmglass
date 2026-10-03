package com.helmglass.browser.domain;

import com.helmglass.api.DomainException;
import java.net.URI;
import java.util.List;

/** Durable address projection excludes credentials, query parameters and fragments. */
public final class BrowserLocation {
  private BrowserLocation() {}

  public static String safe(String value) {
    if (value.equals("about:blank")) {
      return value;
    }
    if (value.length() > 2048) {
      throw new DomainException(
          422, "INVALID_OBSERVATION_URL", "Observation URL exceeds its bound");
    }
    URI uri = URI.create(value);
    if (!List.of("http", "https").contains(uri.getScheme()) || uri.getHost() == null) {
      throw new DomainException(422, "INVALID_OBSERVATION_URL", "Observation URL is not HTTP(S)");
    }
    return uri.getScheme()
        + "://"
        + uri.getHost()
        + (uri.getPort() == -1 ? "" : ":" + uri.getPort())
        + (uri.getRawPath() == null ? "" : uri.getRawPath());
  }
}
