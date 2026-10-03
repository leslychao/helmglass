package com.helmglass.task.application;

import com.helmglass.api.DomainException;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.task.infrastructure.repository.TaskContextRepository;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TaskContextService {
  private final TaskContextRepository contexts;

  public TaskContextService(TaskContextRepository contexts) {
    this.contexts = contexts;
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public Map<String, Object> get(AuthenticatedActor actor, UUID taskId, String section,
      String expectedContext, String cursor, int limit) {
    actor.requireScope("tasks:read");
    if (limit < 1 || limit > 100) {
      throw new DomainException(422, "INVALID_LIMIT", "Context limit must be between 1 and 100");
    }
    var header = contexts.header(actor.userId(), taskId);
    String context = taskId + ":" + header.instructionRevision();
    if (expectedContext != null && !expectedContext.equals(context)) {
      throw DomainException.conflict("STALE_CONTEXT", "Task instructions changed");
    }
    long position;
    try {
      position = cursor == null ? 0 : Long.parseLong(cursor);
    } catch (NumberFormatException error) {
      throw new DomainException(422, "INVALID_CURSOR", "Context cursor is invalid");
    }
    if (position < 0) {
      throw new DomainException(422, "INVALID_CURSOR", "Context cursor is invalid");
    }
    var rows = contexts.page(taskId, section, position, limit + 1);
    boolean more = rows.size() > limit;
    var page = more ? rows.subList(0, limit) : rows;
    Map<String, Object> result = new HashMap<>();
    result.put("taskId", taskId);
    result.put("section", section);
    result.put("contextRef", context);
    result.put("goal", section.equals("INSTRUCTIONS") && position == 0 ? header.goal() : null);
    result.put("items", page);
    result.put("hasMore", more);
    result.put("nextCursor", more ? page.getLast().get("cursor").toString() : null);
    return result;
  }
}
