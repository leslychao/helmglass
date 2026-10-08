package ru.helmglass.api;

import java.util.Map;
import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {
  private final HttpStatus status;
  private final String code;
  private final Map<String, String> fieldErrors;

  public ApiException(HttpStatus status, String code, String message) {
    this(status, code, message, Map.of());
  }

  public ApiException(
      HttpStatus status, String code, String message, Map<String, String> fieldErrors) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = Map.copyOf(fieldErrors);
  }

  public HttpStatus status() {
    return status;
  }

  public String code() {
    return code;
  }

  public Map<String, String> fieldErrors() {
    return fieldErrors;
  }

  public static ApiException conflict(String code, String message) {
    return new ApiException(HttpStatus.CONFLICT, code, message);
  }

  public static ApiException invalid(String field, String message) {
    return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION", message, Map.of(field, message));
  }

  public static ApiException notFound() {
    return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Объект недоступен или не найден.");
  }
}
