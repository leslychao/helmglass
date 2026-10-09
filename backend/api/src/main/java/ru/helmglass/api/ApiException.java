package ru.helmglass.api;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {
  private final HttpStatus status;
  private final String code;
  private final Map<String, String> fieldErrors;
  private final UUID currentTaskId;

  public ApiException(HttpStatus status, String code, String message) {
    this(status, code, message, Map.of());
  }

  public ApiException(
      HttpStatus status, String code, String message, Map<String, String> fieldErrors) {
    this(status, code, message, fieldErrors, null);
  }

  private ApiException(HttpStatus status, String code, String message,
      Map<String, String> fieldErrors, UUID currentTaskId) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = Map.copyOf(fieldErrors);
    this.currentTaskId = currentTaskId;
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

  public Map<String, Object> response() {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("code", code);
    result.put("message", getMessage());
    result.put("fieldErrors", fieldErrors);
    if (currentTaskId != null) {
      result.put("currentTaskId", currentTaskId);
    }
    return result;
  }

  public static ApiException chatOccupied(UUID task) {
    return new ApiException(HttpStatus.CONFLICT, "CHAT_TASK_IN_PROGRESS",
        "В этом чате уже есть незавершённая задача " + task
            + ". Продолжите её либо явно остановите перед созданием новой.", Map.of(), task);
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
