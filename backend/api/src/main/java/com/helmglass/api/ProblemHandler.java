package com.helmglass.api;

import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataAccessException;
import org.springframework.vault.VaultException;
import software.amazon.awssdk.core.exception.SdkException;
import org.springframework.http.ProblemDetail;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@Slf4j
@RestControllerAdvice
public class ProblemHandler {
  @ExceptionHandler(DomainException.class)
  ResponseEntity<ProblemDetail> domain(DomainException error, HttpServletRequest request) {
    ProblemDetail detail = ProblemDetail.forStatusAndDetail(HttpStatusCode.valueOf(error.getStatus()), error.getMessage());
    detail.setType(URI.create("urn:helm:problem:" + error.getCode().toLowerCase().replace('_', '-')));
    detail.setProperty("code", error.getCode());
    detail.setProperty("requestId", requestId(request));
    detail.setProperty("retryable", false);
    if (error.getResourceVersion() != null) {
      detail.setProperty("resourceVersion", error.getResourceVersion());
    }
    return ResponseEntity.status(error.getStatus()).body(detail);
  }

  @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class,
      IllegalArgumentException.class})
  ResponseEntity<ProblemDetail> validation(Exception error, HttpServletRequest request) {
    return domain(new DomainException(400, "INVALID_REQUEST", "Request does not match the contract"),
        request);
  }

  @ExceptionHandler(DataAccessException.class)
  ResponseEntity<ProblemDetail> storage(DataAccessException error, HttpServletRequest request) {
    String requestId = requestId(request);
    log.error("Database operation failed; requestId={}, errorType={}", requestId,
        error.getClass().getSimpleName());
    return domain(new DomainException(503, "DEPENDENCY_UNAVAILABLE", "Storage is unavailable"),
        request);
  }

  @ExceptionHandler({VaultException.class, SdkException.class})
  ResponseEntity<ProblemDetail> dependency(RuntimeException error, HttpServletRequest request) {
    log.error("External dependency failed; requestId={}, errorType={}", requestId(request),
        error.getClass().getSimpleName());
    return domain(new DomainException(503, "DEPENDENCY_UNAVAILABLE", "Required service is unavailable"), request);
  }

  private static String requestId(HttpServletRequest request) {
    Object value = request.getAttribute("helm.requestId");
    return value instanceof UUID id ? id.toString() : UUID.randomUUID().toString();
  }
}
