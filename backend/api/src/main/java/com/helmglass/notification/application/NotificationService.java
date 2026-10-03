package com.helmglass.notification.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.notification.infrastructure.repository.NotificationRepository;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class NotificationService {
  private final NotificationRepository notifications;
  private final OperationRepository operations;
  private final IdentityRepository identities;

  public NotificationService(NotificationRepository notifications, OperationRepository operations, IdentityRepository identities) {
    this.notifications = notifications;
    this.operations = operations;
    this.identities = identities;
  }

  @Transactional(readOnly = true)
  public Map<String, Object> list(AuthenticatedActor actor, UUID cursor, int limit) {
    if (limit < 1 || limit > 100) {
      throw new DomainException(400, "INVALID_LIMIT", "Limit must be between 1 and 100");
    }
    var rows = notifications.list(actor.userId(), cursor, limit + 1);
    Map<String, Object> result = new HashMap<>();
    result.put("items", rows.stream().limit(limit).toList());
    result.put("hasMore", rows.size() > limit);
    result.put("nextCursor", rows.size() > limit ? rows.get(limit - 1).get("id") : null);
    result.put("unreadCount", notifications.unread(actor.userId()));
    return result;
  }

  @Transactional
  public MutationReceipt read(AuthenticatedActor actor, UUID id, MutationContext context) {
    identities.lockActive(actor.userId());
    var input = Map.of("notificationId", id);
    var replay = operations.replay(actor, "notifications.read:" + id, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    long version = notifications.read(actor.userId(), id);
    return operations.save(actor, "notifications.read:" + id, context, input, "notification", id, version, true);
  }
}
