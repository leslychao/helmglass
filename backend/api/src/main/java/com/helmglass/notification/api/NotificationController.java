package com.helmglass.notification.api;

import com.helmglass.identity.api.Actors;
import com.helmglass.api.MutationContext;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.notification.application.NotificationService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class NotificationController {
  private final NotificationService notifications;

  public NotificationController(NotificationService notifications) {
    this.notifications = notifications;
  }

  @GetMapping("/api/v1/notifications")
  Map<String, Object> list(@RequestParam(required = false) UUID cursor,
      @RequestParam(defaultValue = "20") int limit, HttpServletRequest request) {
    return notifications.list(Actors.current(request), cursor, limit);
  }

  @PostMapping("/api/v1/notifications/{id}/read")
  MutationReceipt read(@PathVariable UUID id, HttpServletRequest request) {
    return notifications.read(Actors.current(request), id, MutationContext.from(request));
  }
}
