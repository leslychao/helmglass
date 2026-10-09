package ru.helmglass.api;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class ApiErrors {
  private static final Logger log = LoggerFactory.getLogger(ApiErrors.class);

  @ExceptionHandler(ApiException.class)
  ResponseEntity<Map<String, Object>> application(ApiException exception) {
    return ResponseEntity.status(exception.status())
        .body(exception.response());
  }

  @ExceptionHandler({
    IllegalArgumentException.class,
    org.springframework.http.converter.HttpMessageNotReadableException.class,
    org.springframework.web.bind.MissingServletRequestParameterException.class,
    org.springframework.web.multipart.MultipartException.class
  })
  ResponseEntity<Map<String, String>> invalid(Exception exception) {
    return ResponseEntity.badRequest()
        .body(
            Map.of(
                "code",
                "INVALID_REQUEST",
                "message",
                "Некорректный запрос. Проверьте поля и формат данных."));
  }

  @ExceptionHandler(DataIntegrityViolationException.class)
  ResponseEntity<Map<String, String>> concurrent(DataIntegrityViolationException exception) {
    return ResponseEntity.status(409)
        .body(
            Map.of(
                "code",
                "CONCURRENT_CHANGE",
                "message",
                "Состояние уже изменилось. Получите актуальные данные."));
  }

  @ExceptionHandler(org.springframework.web.multipart.MaxUploadSizeExceededException.class)
  ResponseEntity<Map<String, String>> uploadTooLarge() {
    return ResponseEntity.status(413)
        .body(
            Map.of(
                "code",
                "IMAGE_TOO_LARGE",
                "message",
                "Размер фотографии не должен превышать 5 МиБ."));
  }

  @ExceptionHandler(NoResourceFoundException.class)
  ResponseEntity<Map<String, String>> notFound() {
    return ResponseEntity.status(404)
        .body(Map.of("code", "NOT_FOUND", "message", "Ресурс не найден."));
  }

  @ExceptionHandler(
      org.springframework.web.context.request.async.AsyncRequestNotUsableException.class)
  void disconnected() {
    // The peer has closed an SSE response; writing a JSON error to it is impossible.
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<Map<String, String>> unexpected(Exception exception) {
    // Request data, SQL arguments and nested messages can contain private task content.
    log.error("Application request failed: {}", exception.getClass().getSimpleName());
    return ResponseEntity.internalServerError()
        .body(
            Map.of(
                "code",
                "SERVICE_ERROR",
                "message",
                "Не удалось выполнить запрос. Сохранённые данные не потеряны."));
  }
}
