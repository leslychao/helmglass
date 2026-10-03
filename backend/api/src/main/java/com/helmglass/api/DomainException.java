package com.helmglass.api;

import lombok.Getter;

@Getter
public final class DomainException extends RuntimeException {
  private final int status;
  private final String code;
  private final Long resourceVersion;

  public DomainException(int status, String code, String message) {
    this(status, code, message, null);
  }

  public DomainException(int status, String code, String message, Long resourceVersion) {
    super(message);
    this.status = status;
    this.code = code;
    this.resourceVersion = resourceVersion;
  }

  public static DomainException notFound() {
    return new DomainException(404, "NOT_FOUND", "Resource not found");
  }

  public static DomainException conflict(String code, String message) {
    return new DomainException(409, code, message);
  }

  public static void requireVersion(long actual, Long expected) {
    if (expected == null) {
      throw new DomainException(400, "EXPECTED_VERSION_REQUIRED", "Expected version is required");
    }
    if (actual != expected) {
      throw new DomainException(409, "VERSION_CONFLICT", "Resource changed", actual);
    }
  }
}
