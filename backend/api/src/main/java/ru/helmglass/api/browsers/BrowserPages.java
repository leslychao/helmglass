package ru.helmglass.api.browsers;

import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.tasks.TaskService;

/** Lifetime of browser views; browser and control transitions remain in BrowserService. */
@Service
public class BrowserPages {
  private static final Logger log = LoggerFactory.getLogger(BrowserPages.class);
  private static final int RECONNECT_SECONDS = 60;
  private final JdbcClient jdbc;
  private final BrowserService browsers;
  private final TaskService tasks;
  private final TransactionTemplate transactions;

  public BrowserPages(
      JdbcClient jdbc, BrowserService browsers, TaskService tasks,
      PlatformTransactionManager manager) {
    this.jdbc = jdbc;
    this.browsers = browsers;
    this.tasks = tasks;
    transactions = new TransactionTemplate(manager);
  }

  @Transactional
  public void open(UUID owner, UUID session, UUID visit, UUID viewer) {
    tasks.lockOwner(owner);
    Contracts.Browser browser = browsers.get(owner, session);
    if (Set.of("CLOSED", "LOST", "CLOSING").contains(browser.status())) {
      throw ApiException.conflict("BROWSER_UNAVAILABLE", "Браузер уже закрывается.");
    }
    var existing = jdbc.sql("SELECT session_id FROM browser_page_visits WHERE id=:id")
        .param("id", visit).query(UUID.class).optional();
    if (existing.isPresent() && !session.equals(existing.get())) {
      throw Identity.denied("Просмотр относится к другому браузеру.");
    }
    if (existing.isEmpty() && jdbc.sql("""
            SELECT count(*) FROM browser_page_visits v JOIN browser_sessions b ON b.id=v.session_id
            WHERE b.owner_id=:owner
            """).param("owner", owner).query(Integer.class).single() >= 16) {
      throw ApiException.conflict("SUBSCRIPTION_LIMIT", "Закройте лишние страницы подключения.");
    }
    BrowserService.SessionReference reference = browsers.reference(session);
    Long epoch = viewer.toString().equals(reference.controllerId()) ? browser.controlEpoch() : null;
    int changed = jdbc.sql("""
            INSERT INTO browser_page_visits(id,session_id,viewer_id,control_epoch,expires_at)
            VALUES (:id,:session,:viewer,:epoch,clock_timestamp()+(:seconds*interval '1 second'))
            ON CONFLICT(id) DO UPDATE SET control_epoch=EXCLUDED.control_epoch,
              expires_at=EXCLUDED.expires_at
            WHERE NOT browser_page_visits.leaving
              AND browser_page_visits.viewer_id=EXCLUDED.viewer_id
            """).param("id", visit).param("session", session).param("viewer", viewer)
        .param("epoch", epoch).param("seconds", RECONNECT_SECONDS).update();
    if (changed != 1) {
      throw ApiException.conflict("PAGE_CLOSED", "Этот просмотр уже завершён.");
    }
    browsers.refreshIdle(owner, session, false);
  }

  /** Only a successfully delivered, authenticated SSE heartbeat keeps the page alive. */
  public void heartbeat(UUID owner, UUID visit) {
    jdbc.sql("""
            UPDATE browser_page_visits v
            SET expires_at=clock_timestamp()+(:seconds*interval '1 second')
            FROM browser_sessions b WHERE v.id=:id AND b.id=v.session_id AND b.owner_id=:owner
              AND NOT v.leaving AND v.expires_at>clock_timestamp()
              AND b.status NOT IN ('CLOSED','LOST','CLOSING')
            """).param("id", visit).param("owner", owner)
        .param("seconds", RECONNECT_SECONDS).update();
  }

  @Transactional
  public void activity(UUID owner, UUID session, UUID visit, long epoch, long sequence) {
    tasks.lockOwner(owner);
    Contracts.Browser browser = browsers.get(owner, session);
    if (sequence < 1 || !"LIVE".equals(browser.status())
        || !"USER".equals(browser.controlOwner()) || browser.controlEpoch() != epoch
        || browsers.reference(session).closeRequested()) {
      throw ApiException.conflict("CONTROL_CHANGED", "Управление просмотром уже изменилось.");
    }
    var previous = jdbc.sql("""
            SELECT v.activity_sequence FROM browser_page_visits v
            JOIN browser_sessions b ON b.id=v.session_id
            WHERE v.id=:visit AND v.session_id=:session AND NOT v.leaving
              AND v.expires_at>clock_timestamp() AND v.control_epoch=:epoch
              AND v.viewer_id::text=b.controller_id FOR UPDATE OF v
            """).param("visit", visit).param("session", session).param("epoch", epoch)
        .query(Long.class).optional();
    if (previous.isEmpty()) {
      throw Identity.denied("Только действующий управляющий просмотр может продлить сессию.");
    }
    if (sequence <= previous.get()) {
      return;
    }
    jdbc.sql("UPDATE browser_page_visits SET activity_sequence=:sequence WHERE id=:visit")
        .param("sequence", sequence).param("visit", visit).update();
    browsers.refreshIdle(owner, session, true);
  }

  @Transactional
  public void leave(UUID owner, UUID session, UUID visit) {
    tasks.lockOwner(owner);
    browsers.get(owner, session);
    jdbc.sql("""
            UPDATE browser_page_visits SET leaving=true,expires_at=clock_timestamp()
            WHERE id=:id AND session_id=:session
            """).param("id", visit).param("session", session).update();
    finish(owner, session, visit);
  }

  @Scheduled(fixedDelay = 2000)
  public void expire() {
    var expired = jdbc.sql("""
            SELECT v.id,v.session_id,b.owner_id FROM browser_page_visits v
              JOIN browser_sessions b ON b.id=v.session_id
            WHERE v.expires_at<=clock_timestamp() ORDER BY v.expires_at LIMIT 20
            """).query((row, index) -> new Expired(
                row.getObject("id", UUID.class), row.getObject("session_id", UUID.class),
                row.getObject("owner_id", UUID.class))).list();
    for (Expired visit : expired) {
      try {
        transactions.executeWithoutResult(transaction -> {
          tasks.lockOwner(visit.owner());
          finish(visit.owner(), visit.session(), visit.id());
        });
      } catch (ApiException | WorkerClient.WorkerException exception) {
        log.warn("Connection page cleanup will retry for {}: {}",
            visit.id(), exception.getClass().getSimpleName());
      }
    }
  }

  private void finish(UUID owner, UUID session, UUID visit) {
    var expired = jdbc.sql("""
            SELECT viewer_id,control_epoch,leaving FROM browser_page_visits
            WHERE id=:id AND session_id=:session AND expires_at<=clock_timestamp() FOR UPDATE
            """).param("id", visit).param("session", session)
        .query((row, index) -> new Control(
            row.getObject("viewer_id", UUID.class), row.getObject("control_epoch", Long.class),
            row.getBoolean("leaving")))
        .optional();
    if (expired.isEmpty()) {
      return;
    }
    Contracts.Browser browser = browsers.get(owner, session);
    if (!Set.of("CLOSED", "LOST", "CLOSING").contains(browser.status())) {
      if ("TRANSFERRING".equals(browser.controlOwner())) {
        return;
      }
      Control control = expired.get();
      boolean otherPage = jdbc.sql("""
              SELECT EXISTS(SELECT 1 FROM browser_page_visits WHERE session_id=:session
                AND id<>:id AND NOT leaving AND expires_at>clock_timestamp()
                AND (:standalone OR viewer_id=:viewer))
              """).param("session", session).param("id", visit)
          .param("standalone", browser.taskId() == null).param("viewer", control.viewer())
          .query(Boolean.class).single();
      if (!otherPage) {
        if (browser.taskId() == null) {
          browsers.requestClose(owner, session);
        } else if ("USER".equals(browser.controlOwner())
            && control.epoch() != null && control.epoch() == browser.controlEpoch()
            && control.viewer().toString().equals(browsers.reference(session).controllerId())) {
          browsers.control(owner, session, new Contracts.ControlInput(
              "RETURN", control.viewer().toString(), control.deliberate(), false, null, null, null,
              browser.controlEpoch()));
        }
      }
    }
    jdbc.sql("DELETE FROM browser_page_visits WHERE id=:id").param("id", visit).update();
  }

  private record Control(UUID viewer, Long epoch, boolean deliberate) {}

  private record Expired(UUID id, UUID session, UUID owner) {}
}
