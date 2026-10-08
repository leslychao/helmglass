package ru.helmglass.api.events;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;

@Service
public class NotificationService {
  private final JdbcClient jdbc;
  private final EventService events;

  public NotificationService(JdbcClient jdbc, EventService events) {
    this.jdbc = jdbc;
    this.events = events;
  }

  public Inbox list(UUID owner) {
    List<Notification> items =
        jdbc.sql(
                "SELECT * FROM notifications WHERE owner_id=:owner AND read_at IS NULL ORDER BY"
                    + " sequence DESC LIMIT 50")
            .param("owner", owner)
            .query(
                (row, index) ->
                    new Notification(
                        row.getObject("id", UUID.class),
                        row.getLong("sequence"),
                        row.getObject("task_id", UUID.class),
                        row.getString("title"),
                        row.getString("status"),
                        Database.instant(row, "created_at")))
            .list();
    long total =
        jdbc.sql("SELECT count(*) FROM notifications WHERE owner_id=:owner AND read_at IS NULL")
            .param("owner", owner)
            .query(Long.class)
            .single();
    long cutoff =
        jdbc.sql("SELECT coalesce(max(sequence),0) FROM notifications WHERE owner_id=:owner")
            .param("owner", owner)
            .query(Long.class)
            .single();
    return new Inbox(items, total, cutoff);
  }

  @Transactional
  public Inbox read(UUID owner, Contracts.ReadNotifications input) {
    if (input.id() != null) {
      jdbc.sql(
              "UPDATE notifications SET read_at=now() WHERE id=:id AND owner_id=:owner AND read_at"
                  + " IS NULL")
          .param("id", input.id())
          .param("owner", owner)
          .update();
    } else if (input.throughSequence() != null && input.throughSequence() >= 0) {
      jdbc.sql(
              "UPDATE notifications SET read_at=now() WHERE owner_id=:owner AND sequence<=:sequence"
                  + " AND read_at IS NULL")
          .param("owner", owner)
          .param("sequence", input.throughSequence())
          .update();
    } else {
      throw ru.helmglass.api.ApiException.invalid(
          "throughSequence", "Укажите уведомление или границу прочтения.");
    }
    events.emit(owner, "notification", input.id(), 0);
    return list(owner);
  }

  public record Notification(
      UUID id, long sequence, UUID taskId, String title, String status, Instant createdAt) {}

  public record Inbox(List<Notification> items, long total, long throughSequence) {}
}
