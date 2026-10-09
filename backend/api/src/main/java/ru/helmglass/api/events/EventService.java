package ru.helmglass.api.events;

import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import ru.helmglass.api.ApiException;

@Service
public class EventService {
  private final JdbcClient jdbc;
  private final Map<UUID, Subscription> subscriptions = new ConcurrentHashMap<>();

  public EventService(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  @Transactional
  public long emit(UUID owner, String resource, UUID entity, long version) {
    long sequence =
        jdbc.sql(
                """
                UPDATE accounts SET event_sequence=event_sequence+1 WHERE id=:owner
                RETURNING event_sequence
                """)
            .param("owner", owner)
            .query(Long.class)
            .single();
    jdbc.sql(
            """
            INSERT INTO user_events(owner_id,sequence,resource,entity_id,version)
            VALUES (:owner,:sequence,:resource,:entity,:version)
            """)
        .param("owner", owner)
        .param("sequence", sequence)
        .param("resource", resource)
        .param("entity", entity)
        .param("version", version)
        .update();
    return sequence;
  }

  @Transactional
  public void emitAdministrators(String resource, UUID entity, long version) {
    jdbc.sql(
            """
            WITH owners AS (UPDATE accounts SET event_sequence=event_sequence+1
              WHERE administrator AND status='ACTIVE' RETURNING id,event_sequence)
            INSERT INTO user_events(owner_id,sequence,resource,entity_id,version)
            SELECT id,event_sequence,:resource,:entity,:version FROM owners
            """)
        .param("resource", resource)
        .param("entity", entity)
        .param("version", version)
        .update();
  }

  public SseEmitter subscribe(UUID owner, Long cursor) {
    return subscribe(
        owner,
        cursor,
        () ->
            jdbc.sql("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=:id AND status='ACTIVE')")
                .param("id", owner)
                .query(Boolean.class)
                .single(),
        change -> true);
  }

  public SseEmitter subscribe(
      UUID owner, Long cursor, BooleanSupplier authorized, Predicate<Change> visible) {
    return subscribe(owner, cursor, authorized, visible, () -> {});
  }

  public synchronized SseEmitter subscribe(
      UUID owner, Long cursor, BooleanSupplier authorized, Predicate<Change> visible,
      Runnable heartbeat) {
    if (!authorized.getAsBoolean()) {
      throw ru.helmglass.api.auth.Identity.denied("Доступ к событиям завершён.");
    }
    if (subscriptions.values().stream().filter(item -> item.owner.equals(owner)).count() >= 16) {
      throw ApiException.conflict("SUBSCRIPTION_LIMIT", "Закройте лишние просмотры приложения.");
    }
    long highWater =
        jdbc.sql("SELECT event_sequence FROM accounts WHERE id=:owner")
            .param("owner", owner)
            .query(Long.class)
            .single();
    long start = cursor == null ? highWater : Math.min(Math.max(0, cursor), highWater);
    SseEmitter emitter = new SseEmitter(0L);
    UUID id = UUID.randomUUID();
    Subscription subscription =
        new Subscription(owner, emitter, start, highWater, authorized, visible, heartbeat);
    emitter.onCompletion(() -> subscriptions.remove(id));
    emitter.onTimeout(() -> subscriptions.remove(id));
    emitter.onError(error -> subscriptions.remove(id));
    subscriptions.put(id, subscription);
    if (start == highWater) {
      synchronize(id, subscription);
    }
    return emitter;
  }

  @Scheduled(fixedDelay = 700)
  void deliverCommittedEvents() {
    for (var entry : subscriptions.entrySet()) {
      Subscription subscription = entry.getValue();
      if (!subscription.authorized.getAsBoolean()) {
        subscription.emitter.complete();
        subscriptions.remove(entry.getKey());
        continue;
      }
      var events =
          jdbc.sql(
                  """
SELECT sequence,resource,entity_id,version FROM user_events
WHERE owner_id=:owner AND sequence>:cursor AND sequence<=:highWater ORDER BY sequence LIMIT 100
""")
              .param("owner", subscription.owner)
              .param("cursor", subscription.cursor)
              .param("highWater", subscription.caughtUp ? Long.MAX_VALUE : subscription.highWater)
              .query(
                  (row, index) ->
                      new Change(
                          row.getLong("sequence"),
                          row.getString("resource"),
                          row.getObject("entity_id", UUID.class),
                          row.getLong("version")))
              .list();
      for (Change event : events) {
        send(entry.getKey(), subscription, event);
      }
      if (!subscription.caughtUp && subscription.cursor >= subscription.highWater) {
        synchronize(entry.getKey(), subscription);
      }
    }
  }

  @Scheduled(fixedDelay = 20000)
  void heartbeat() {
    for (var entry : subscriptions.entrySet()) {
      Subscription subscription = entry.getValue();
      try {
        if (!subscription.authorized.getAsBoolean()) {
          subscription.emitter.complete();
          subscriptions.remove(entry.getKey());
          continue;
        }
        subscription.emitter.send(SseEmitter.event().comment("connection"));
        subscription.heartbeat.run();
      } catch (IOException | IllegalStateException exception) {
        entry.getValue().emitter.complete();
        subscriptions.remove(entry.getKey());
      }
    }
  }

  private void synchronize(UUID id, Subscription subscription) {
    synchronized (subscription) {
      if (subscription.caughtUp) {
        return;
      }
      send(id, subscription, new Change(subscription.highWater, "sync", null, 0));
      subscription.caughtUp = true;
    }
  }

  private void send(UUID id, Subscription subscription, Change event) {
    synchronized (subscription) {
      try {
        if (!subscription.authorized.getAsBoolean()) {
          subscription.emitter.complete();
          subscriptions.remove(id);
          return;
        }
        if ("sync".equals(event.resource()) || subscription.visible.test(event)) {
          subscription.emitter.send(
              SseEmitter.event().id(Long.toString(event.id())).name("change").data(event));
        }
        subscription.cursor = event.id();
      } catch (IOException | IllegalStateException exception) {
        subscription.emitter.complete();
        subscriptions.remove(id);
      }
    }
  }

  public record Change(long id, String resource, UUID entityId, long version) {}

  private static final class Subscription {
    private final UUID owner;
    private final SseEmitter emitter;
    private final BooleanSupplier authorized;
    private final Predicate<Change> visible;
    private final Runnable heartbeat;
    private volatile long cursor;
    private final long highWater;
    private volatile boolean caughtUp;

    private Subscription(
        UUID owner,
        SseEmitter emitter,
        long cursor,
        long highWater,
        BooleanSupplier authorized,
        Predicate<Change> visible,
        Runnable heartbeat) {
      this.owner = owner;
      this.emitter = emitter;
      this.cursor = cursor;
      this.highWater = highWater;
      this.authorized = authorized;
      this.visible = visible;
      this.heartbeat = heartbeat;
    }
  }
}
