package com.helmglass.realtime.infrastructure.repository;

import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class OutboxRepository {
  private static final List<String> UI_EVENTS =
      List.of("tasks", "usage", "connections", "result", "events", "artifacts", "audio",
          "notifications", "sites", "operations", "browserSessions", "users", "userTasks",
          "userDays", "nodes", "sessions", "audit");
  private final JdbcClient jdbc;

  public OutboxRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record Intent(UUID id, UUID userId, UUID aggregateId, String eventType, String payload) {}

  @Transactional
  public List<Intent> due() {
    return jdbc.sql(
            """
            UPDATE transactional_outbox SET retry_at=now()+interval '10 seconds'
            WHERE id IN (SELECT id FROM transactional_outbox WHERE published_at IS NULL AND retry_at<=now()
            AND event_type IN (:types)
            ORDER BY retry_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)
            RETURNING id,user_id,aggregate_id,event_type,payload::text
            """)
        .param("types", UI_EVENTS)
        .query(Intent.class)
        .list();
  }

  public void published(UUID id) {
    jdbc.sql(
            "UPDATE transactional_outbox SET published_at=now() WHERE id=:id AND published_at IS"
                + " NULL AND event_type IN (:types)")
        .param("id", id)
        .param("types", UI_EVENTS)
        .update();
  }
}
