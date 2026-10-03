package com.helmglass.notification.infrastructure.repository;

import com.helmglass.api.DomainException;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class NotificationRepository {
  private final JdbcClient jdbc;

  public NotificationRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public List<Map<String, Object>> list(UUID userId, UUID cursor, int limit) {
    return jdbc.sql("""
        SELECT id,task_id AS "taskId",kind,version,created_at AS "createdAt",read_at AS "readAt"
        FROM notifications WHERE user_id=:user AND (:cursor::uuid IS NULL OR (created_at,id)<
        (SELECT created_at,id FROM notifications WHERE id=:cursor AND user_id=:user))
        ORDER BY created_at DESC,id DESC LIMIT :limit
        """).param("user", userId).param("cursor", cursor).param("limit", limit).query().listOfRows();
  }

  public long unread(UUID userId) {
    return jdbc.sql("SELECT count(*) FROM notifications WHERE user_id=:user AND read_at IS NULL")
        .param("user", userId).query(Long.class).single();
  }

  public long read(UUID userId, UUID id) {
    return jdbc.sql("""
        UPDATE notifications SET read_at=coalesce(read_at,now()),version=version+CASE WHEN read_at IS NULL THEN 1 ELSE 0 END
        WHERE user_id=:user AND id=:id RETURNING version
        """).param("user", userId).param("id", id).query(Long.class).optional().orElseThrow(DomainException::notFound);
  }
}
