package ru.helmglass.api.browsers;

import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.auth.Actor;

/** Durable closure of viewers after their application grant has been revoked. */
@Service
public class ViewerAccess {
  private final JdbcClient jdbc;
  private final WorkerClient worker;
  private final ru.helmglass.api.events.EventService events;
  private final TransactionTemplate transactions;

  public ViewerAccess(
      JdbcClient jdbc,
      WorkerClient worker,
      ru.helmglass.api.events.EventService events,
      org.springframework.transaction.PlatformTransactionManager manager) {
    this.jdbc = jdbc;
    this.worker = worker;
    this.events = events;
    transactions = new TransactionTemplate(manager);
  }

  /**
   * Caller holds its account row lock and commits this intent with the local authorization change.
   */
  public Receipt revoke(UUID owner, String channel, String grant) {
    String key = grant == null ? "" : grant;
    jdbc.sql(
            """
INSERT INTO viewer_revocations(owner_id,channel,grant_id) VALUES (:owner,:channel,:grant)
ON CONFLICT(owner_id,channel,grant_id) DO UPDATE SET attempts=0,next_attempt_at=now(),requested_at=now(),last_error=NULL
""")
        .param("owner", owner)
        .param("channel", channel)
        .param("grant", key)
        .update();
    boolean closed = deliver(new Intent(owner, channel, key, 0));
    return closed
        ? new Receipt("COMPLETED", null)
        : new Receipt(
            "PENDING",
            "Доступ уже отозван. Закрытие открытых просмотров ещё не подтверждено; повторите"
                + " проверку.");
  }

  public Map<String, Boolean> status(UUID owner, String channel) {
    return jdbc.sql(
            """
SELECT count(*)>0 pending,coalesce(bool_or(attempts>=20),false) failed
FROM viewer_revocations WHERE owner_id=:owner AND channel=:channel
""")
        .param("owner", owner)
        .param("channel", channel)
        .query(
            (row, index) ->
                Map.of(
                    "viewerClosePending",
                    row.getBoolean("pending"),
                    "viewerCloseFailed",
                    row.getBoolean("failed")))
        .single();
  }

  /** No new grant's viewer can race a delayed channel-wide closure from an earlier grant. */
  public void beforeTicket(Actor actor) {
    var pending =
        jdbc.sql(
                """
SELECT owner_id,channel,grant_id,attempts FROM viewer_revocations
WHERE owner_id=:owner AND channel=:channel ORDER BY requested_at LIMIT 20
""")
            .param("owner", actor.id())
            .param("channel", actor.channel())
            .query(
                (row, index) ->
                    new Intent(
                        row.getObject("owner_id", UUID.class),
                        row.getString("channel"),
                        row.getString("grant_id"),
                        row.getInt("attempts")))
            .list();
    for (Intent intent : pending) {
      if (!deliver(intent)) {
        throw ApiException.conflict(
            "VIEWER_REVOCATION_PENDING", "Дождитесь подтверждения отзыва предыдущего просмотра.");
      }
    }
    if (status(actor.id(), actor.channel()).get("viewerClosePending")) {
      throw ApiException.conflict(
          "VIEWER_REVOCATION_PENDING", "Закрытие прежних просмотров ещё продолжается.");
    }
  }

  @Scheduled(fixedDelay = 1000)
  public void deliverPending() {
    var pending =
        jdbc.sql(
                """
SELECT owner_id,channel,grant_id,attempts FROM viewer_revocations
WHERE attempts<20 AND next_attempt_at<=now() ORDER BY requested_at LIMIT 20
""")
            .query(
                (row, index) ->
                    new Intent(
                        row.getObject("owner_id", UUID.class),
                        row.getString("channel"),
                        row.getString("grant_id"),
                        row.getInt("attempts")))
            .list();
    for (Intent candidate : pending) {
      transactions.executeWithoutResult(
          transaction -> {
            jdbc.sql("SELECT id FROM accounts WHERE id=:owner FOR UPDATE")
                .param("owner", candidate.owner())
                .query(UUID.class)
                .optional();
            var current =
                jdbc.sql(
                        """
SELECT attempts FROM viewer_revocations WHERE owner_id=:owner AND channel=:channel AND grant_id=:grant
AND attempts<20 AND next_attempt_at<=now() FOR UPDATE
""")
                    .param("owner", candidate.owner())
                    .param("channel", candidate.channel())
                    .param("grant", candidate.grant())
                    .query(Integer.class)
                    .optional();
            current.ifPresent(
                attempts ->
                    deliver(
                        new Intent(
                            candidate.owner(), candidate.channel(), candidate.grant(), attempts)));
          });
    }
  }

  private boolean deliver(Intent intent) {
    Map<String, Object> body = new HashMap<>();
    body.put("channel", intent.channel());
    if (!intent.grant().isEmpty()) {
      body.put("grantId", intent.grant());
    }
    try {
      worker.call(
          "POST", "/owners/" + intent.owner() + "/viewers/revoke", body, Duration.ofSeconds(3));
      jdbc.sql(
              "DELETE FROM viewer_revocations WHERE owner_id=:owner AND channel=:channel AND"
                  + " grant_id=:grant")
          .param("owner", intent.owner())
          .param("channel", intent.channel())
          .param("grant", intent.grant())
          .update();
      if ("MCP".equals(intent.channel())) {
        events.emit(intent.owner(), "integration", intent.owner(), 0);
      }
      return true;
    } catch (WorkerClient.WorkerException exception) {
      int attempts = Math.min(20, intent.attempts() + 1);
      int delay = 1 << Math.min(6, attempts);
      jdbc.sql(
              """
UPDATE viewer_revocations SET attempts=:attempts,next_attempt_at=now()+(:delay*interval '1 second'),last_error=:error
WHERE owner_id=:owner AND channel=:channel AND grant_id=:grant
""")
          .param("attempts", attempts)
          .param("delay", delay)
          .param("error", exception.getMessage())
          .param("owner", intent.owner())
          .param("channel", intent.channel())
          .param("grant", intent.grant())
          .update();
      if (attempts == 20 && "MCP".equals(intent.channel())) {
        events.emit(intent.owner(), "integration", intent.owner(), 0);
      }
      return false;
    }
  }

  public record Receipt(String status, String message) {}

  private record Intent(UUID owner, String channel, String grant, int attempts) {}
}
