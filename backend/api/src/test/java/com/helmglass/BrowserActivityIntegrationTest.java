package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;

import com.helmglass.api.JsonSupport;
import com.helmglass.browser.application.BrowserSessionOperationService;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.browser.domain.BrowserActivityClock;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserSessionOperationRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.application.ChannelTicketService.TicketBinding;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

@SpringJUnitConfig(ProfilePersistenceIntegrationTest.TestConfiguration.class)
class BrowserActivityIntegrationTest {
  private record Fixture(
      AuthenticatedActor actor,
      UUID task,
      UUID session,
      UUID worker,
      UUID boot,
      UUID controller,
      UUID channel,
      TicketBinding ticket) {}

  private record Clock(
      Instant lastActivityAt,
      Instant idleDeadlineAt,
      long activityInputEpoch,
      long activityInputSequence,
      long version) {}

  @Autowired private BrowserSessionService sessions;
  @Autowired private BrowserSessionOperationService operations;
  @Autowired private BrowserSessionOperationRepository closing;
  @Autowired private BrowserRepository browsers;
  @Autowired private IdentityRepository identities;
  @Autowired private JsonSupport json;
  @Autowired private JdbcClient jdbc;
  private final TransactionTemplate transaction;

  @Autowired
  BrowserActivityIntegrationTest(PlatformTransactionManager transactions) {
    transaction = new TransactionTemplate(transactions);
  }

  @ParameterizedTest
  @ValueSource(strings = {"NORMAL", "LOGIN_PRIVATE"})
  void onlyAppliedInputExtendsIdleWithExactPrivacyInterval(String privacy) {
    var fixture = fixture(privacy);
    Clock before = clock(fixture);
    sessions.get(fixture.actor(), fixture.session(), fixture.controller());
    input(fixture, 1, false, 1, fixture.channel());
    assertThat(clock(fixture)).isEqualTo(before);
    input(fixture, 2, true, 1, fixture.channel());
    Clock applied = clock(fixture);
    assertThat(applied.lastActivityAt()).isAfter(before.lastActivityAt());
    assertThat(Duration.between(applied.lastActivityAt(), applied.idleDeadlineAt()))
        .isEqualTo(Duration.ofMinutes(privacy.equals("LOGIN_PRIVATE") ? 10 : 15));
    assertThat(applied.activityInputEpoch()).isEqualTo(1);
    assertThat(applied.activityInputSequence()).isEqualTo(2);
    // Idle clocks do not invalidate unrelated optimistic edits or trigger a GET for every
    // mousemove.
    assertThat(applied.version()).isEqualTo(before.version());
    input(fixture, 2, true, 1, fixture.channel());
    input(fixture, 3, false, 1, fixture.channel());
    input(fixture, 4, true, 2, fixture.channel());
    input(fixture, 4, true, 1, UUID.randomUUID());
    sessions.get(fixture.actor(), fixture.session(), fixture.controller());
    assertThat(clock(fixture)).isEqualTo(applied);
    var web = fixture.actor();
    var mcp =
        new AuthenticatedActor(
            web.userId(),
            null,
            UUID.randomUUID(),
            "helm-mcp",
            web.displayName(),
            web.email(),
            web.accessEpoch(),
            Set.of("browser:view"),
            true);
    var external = sessions.get(mcp, fixture.session(), null);
    if (privacy.equals("LOGIN_PRIVATE")) {
      assertThat(external)
          .containsEntry("lastActivityAt", null)
          .containsEntry("idleDeadlineAt", null);
      assertThat(sessions.get(web, fixture.session(), UUID.randomUUID()))
          .containsEntry("lastActivityAt", null)
          .containsEntry("idleDeadlineAt", null);
      var otherLogin =
          new AuthenticatedActor(
              web.userId(),
              UUID.randomUUID(),
              null,
              "helm-web",
              web.displayName(),
              web.email(),
              web.accessEpoch(),
              Set.of(),
              false);
      assertThat(sessions.get(otherLogin, fixture.session(), fixture.controller()))
          .containsEntry("lastActivityAt", null)
          .containsEntry("idleDeadlineAt", null);
      assertThat(sessions.get(web, fixture.session(), fixture.controller()))
          .containsEntry("lastActivityAt", applied.lastActivityAt())
          .containsEntry("idleDeadlineAt", applied.idleDeadlineAt());
    } else {
      assertThat(external).containsEntry("lastActivityAt", applied.lastActivityAt());
    }
  }

  @Test
  void navigationInputCountsItsAdmittedPageAndRejectsAnUnrelatedOldPage() {
    var fixture = fixture("NORMAL");
    Clock before = clock(fixture);
    jdbc.sql("UPDATE browser_sessions SET page_epoch=2 WHERE id=:id")
        .param("id", fixture.session())
        .update();
    sessions.inputApplied(
        fixture.ticket(),
        fixture.channel(),
        fixture.worker(),
        fixture.boot(),
        1,
        1,
        2,
        1,
        2,
        1,
        true);
    assertThat(clock(fixture)).isEqualTo(before);
    sessions.inputApplied(
        fixture.ticket(),
        fixture.channel(),
        fixture.worker(),
        fixture.boot(),
        1,
        1,
        2,
        1,
        1,
        1,
        true);
    assertThat(clock(fixture).lastActivityAt()).isAfter(before.lastActivityAt());
  }

  @Test
  void committedActivityPublishesOnlyLatestClockAndFencesOldRuntimeOrPrivacy() {
    var fixture = fixture("NORMAL");
    input(fixture, 1, false, 1, fixture.channel());
    assertThat(clockIntentCount(fixture)).isZero();
    input(fixture, 2, true, 1, fixture.channel());
    UUID intentId =
        jdbc.sql(
                "SELECT id FROM transactional_outbox WHERE aggregate_id=:id AND"
                    + " event_type='browserActivity'")
            .param("id", fixture.session())
            .query(UUID.class)
            .single();
    var first = publishedClock(fixture);
    assertThat(sessions.deadlineCurrent(first)).isTrue();
    assertThat(BrowserSessionService.clockSnapshot(first))
        .containsOnlyKeys(
            "browserSessionId",
            "allocationEpoch",
            "privacyEpoch",
            "lastActivityAt",
            "idleDeadlineAt",
            "budgetDeadlineAt");
    input(fixture, 3, true, 1, fixture.channel());
    var latest = publishedClock(fixture);
    assertThat(clockIntentCount(fixture)).isEqualTo(1);
    assertThat(
            jdbc.sql(
                    "SELECT id FROM transactional_outbox WHERE aggregate_id=:id AND"
                        + " event_type='browserActivity'")
                .param("id", fixture.session())
                .query(UUID.class)
                .single())
        .isEqualTo(intentId);
    assertThat(latest.lastActivityAt()).isAfter(first.lastActivityAt());
    assertThat(sessions.deadlineCurrent(first)).isFalse();
    assertThat(sessions.deadlineCurrent(latest)).isTrue();
    input(fixture, 4, false, 1, fixture.channel());
    assertThat(publishedClock(fixture)).isEqualTo(latest);
    jdbc.sql(
            "UPDATE browser_sessions SET privacy='LOGIN_PRIVATE',privacy_epoch=privacy_epoch+1"
                + " WHERE id=:id")
        .param("id", fixture.session())
        .update();
    assertThat(sessions.deadlineCurrent(latest)).isFalse();
    transaction.executeWithoutResult(
        status -> sessions.synchronizeIdlePolicy(fixture.actor().userId(), fixture.session()));
    var privateClock = publishedClock(fixture);
    assertThat(privateClock.privacyMode()).isEqualTo("LOGIN_PRIVATE");
    assertThat(privateClock.lastActivityAt()).isEqualTo(latest.lastActivityAt());
    assertThat(privateClock.idleDeadlineAt()).isEqualTo(latest.lastActivityAt().plusSeconds(600));
    assertThat(sessions.deadlineCurrent(privateClock)).isTrue();
    jdbc.sql("UPDATE browser_sessions SET worker_boot_id=:boot WHERE id=:id")
        .param("boot", UUID.randomUUID())
        .param("id", fixture.session())
        .update();
    assertThat(sessions.deadlineCurrent(privateClock)).isFalse();
  }

  @Test
  void revokedOrClosedInputCannotResurrectIdle() {
    var fixture = fixture("NORMAL");
    Clock before = clock(fixture);
    jdbc.sql("UPDATE application_logins SET state='REVOKED',revoked_at=now() WHERE id=:id")
        .param("id", fixture.actor().loginId())
        .update();
    input(fixture, 1, true, 1, fixture.channel());
    assertThat(clock(fixture)).isEqualTo(before);
    jdbc.sql("UPDATE browser_sessions SET state='CLOSED',binding_released_at=now() WHERE id=:id")
        .param("id", fixture.session())
        .update();
    transaction.executeWithoutResult(
        status ->
            sessions.commandCompleted(
                fixture.actor().userId(),
                fixture.worker(),
                fixture.boot(),
                fixture.session(),
                receipt("SUCCEEDED", "CONFIRMED", 1)));
    assertThat(clock(fixture)).isEqualTo(before);
  }

  @Test
  void unconfirmedOrStaleCommandDoesNotRenewAndPrivacyChangeIsNotActivity() {
    var fixture = fixture("NORMAL");
    Clock before = clock(fixture);
    for (var receipt :
        List.of(
            receipt("UNKNOWN", "UNKNOWN", 1),
            receipt("FAILED", "NOT_STARTED", 1),
            receipt("SUCCEEDED", "CONFIRMED", 2))) {
      transaction.executeWithoutResult(
          status ->
              sessions.commandCompleted(
                  fixture.actor().userId(),
                  fixture.worker(),
                  fixture.boot(),
                  fixture.session(),
                  receipt));
    }
    assertThat(clock(fixture)).isEqualTo(before);
    jdbc.sql("UPDATE browser_sessions SET privacy='LOGIN_PRIVATE' WHERE id=:id")
        .param("id", fixture.session())
        .update();
    transaction.executeWithoutResult(
        status -> sessions.synchronizeIdlePolicy(fixture.actor().userId(), fixture.session()));
    Clock changed = clock(fixture);
    assertThat(changed.lastActivityAt()).isEqualTo(before.lastActivityAt());
    assertThat(changed.idleDeadlineAt()).isEqualTo(before.lastActivityAt().plusSeconds(600));
    transaction.executeWithoutResult(
        status -> sessions.synchronizeIdlePolicy(fixture.actor().userId(), fixture.session()));
    assertThat(clock(fixture)).isEqualTo(changed);
  }

  @Test
  void startedCommandDoesNotIdleCloseButBudgetStillCloses() {
    var fixture = fixture("NORMAL");
    expireIdle(fixture);
    jdbc.sql("UPDATE tasks SET state='RUNNING' WHERE id=:id").param("id", fixture.task()).update();
    assertThat(closing.closeDue(fixture.session())).isFalse();
    operations.prepareDueClosures();
    assertThat(closing.pendingForSession(fixture.session())).isEmpty();
    jdbc.sql(
            "UPDATE browser_sessions SET budget_deadline_at=now()-interval '1 second' WHERE id=:id")
        .param("id", fixture.session())
        .update();
    assertThat(closing.closeDue(fixture.session())).isTrue();
    operations.prepareDueClosures();
    assertThat(closing.pendingForSession(fixture.session())).isPresent();
  }

  @Test
  void successfulActivityCommitsBeforeStaleCloseCandidateIsRechecked() throws Exception {
    var fixture = fixture("NORMAL");
    expireIdle(fixture);
    assertThat(closing.dueClosures())
        .anyMatch(candidate -> candidate.id().equals(fixture.session()));
    CompletableFuture<Integer> closingPid = new CompletableFuture<>();
    try (var executor = Executors.newSingleThreadExecutor()) {
      Future<?>[] close = new Future<?>[1];
      transaction.executeWithoutResult(
          status -> {
            identities.lockState(fixture.actor().userId());
            close[0] =
                executor.submit(
                    () ->
                        transaction.executeWithoutResult(
                            closeStatus -> {
                              closingPid.complete(
                                  jdbc.sql("SELECT pg_backend_pid()")
                                      .query(Integer.class)
                                      .single());
                              operations.prepareDueClosures();
                            }));
            try {
              int pid = closingPid.get(5, TimeUnit.SECONDS);
              long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
              boolean waiting = false;
              while (System.nanoTime() < end && !waiting) {
                waiting =
                    jdbc.sql("SELECT cardinality(pg_blocking_pids(:pid))>0")
                        .param("pid", pid)
                        .query(Boolean.class)
                        .single();
                if (!waiting) {
                  Thread.sleep(10);
                }
              }
              assertThat(waiting)
                  .as("Closing transaction waits on canonical account lock")
                  .isTrue();
              sessions.commandCompleted(
                  fixture.actor().userId(),
                  fixture.worker(),
                  fixture.boot(),
                  fixture.session(),
                  receipt("SUCCEEDED", "CONFIRMED", 1));
            } catch (InterruptedException error) {
              Thread.currentThread().interrupt();
              throw new IllegalStateException(error);
            } catch (ExecutionException | TimeoutException error) {
              throw new IllegalStateException(error);
            }
          });
      close[0].get(10, TimeUnit.SECONDS);
    }
    assertThat(closing.pendingForSession(fixture.session())).isEmpty();
    assertThat(browsers.owned(fixture.actor().userId(), fixture.session()).state())
        .isEqualTo("ACTIVE");
    assertThat(closing.closeDue(fixture.session())).isFalse();
  }

  @Test
  void rollbackDoesNotPersistActivityOrConsumeInputCheckpoint() {
    var fixture = fixture("NORMAL");
    Clock before = clock(fixture);
    transaction.executeWithoutResult(
        status -> {
          input(fixture, 1, true, 1, fixture.channel());
          status.setRollbackOnly();
        });
    assertThat(clock(fixture)).isEqualTo(before);
    assertThat(clockIntentCount(fixture)).isZero();
    input(fixture, 1, true, 1, fixture.channel());
    assertThat(clock(fixture).activityInputSequence()).isEqualTo(1);
  }

  private long clockIntentCount(Fixture fixture) {
    return jdbc.sql(
            "SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:id AND"
                + " event_type='browserActivity'")
        .param("id", fixture.session())
        .query(Long.class)
        .single();
  }

  private BrowserActivityClock publishedClock(Fixture fixture) {
    return json.read(
        jdbc.sql(
                "SELECT payload::text FROM transactional_outbox WHERE aggregate_id=:id AND"
                    + " event_type='browserActivity'")
            .param("id", fixture.session())
            .query(String.class)
            .single(),
        BrowserActivityClock.class);
  }

  private void input(Fixture fixture, long sequence, boolean activity, long epoch, UUID channel) {
    sessions.inputApplied(
        fixture.ticket(),
        channel,
        fixture.worker(),
        fixture.boot(),
        1,
        epoch,
        1,
        1,
        1,
        sequence,
        activity);
  }

  private JsonNode receipt(String status, String effect, long epoch) {
    return json.read(
        json.write(
            Map.of(
                "status",
                status,
                "effectState",
                effect,
                "allocationEpoch",
                1,
                "controlEpoch",
                epoch,
                "pageEpoch",
                1,
                "privacyEpoch",
                1)));
  }

  private Clock clock(Fixture fixture) {
    return jdbc.sql(
            "SELECT"
                + " last_activity_at,idle_deadline_at,activity_input_epoch,activity_input_sequence,version"
                + " FROM browser_sessions WHERE id=:id")
        .param("id", fixture.session())
        .query(Clock.class)
        .single();
  }

  private void expireIdle(Fixture fixture) {
    jdbc.sql(
            "UPDATE browser_sessions SET last_activity_at=now()-interval '16"
                + " minutes',idle_deadline_at=now()-interval '1 minute' WHERE id=:id")
        .param("id", fixture.session())
        .update();
  }

  private Fixture fixture(String privacy) {
    var account =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    identities.resolve(
                        "https://issuer.example",
                        UUID.randomUUID().toString(),
                        "Activity",
                        "activity@example.com")));
    UUID login = UUID.randomUUID();
    UUID task = UUID.randomUUID();
    UUID session = UUID.randomUUID();
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    UUID controller = UUID.randomUUID();
    UUID channel = UUID.randomUUID();
    jdbc.sql(
            "INSERT INTO"
                + " application_logins(id,user_id,issuer,sid,auth_time,admitted_access_epoch,expires_at)"
                + " VALUES(:id,:user,'https://issuer.example',:sid,now(),1,now()+interval '1"
                + " hour')")
        .param("id", login)
        .param("user", account.id())
        .param("sid", login.toString())
        .update();
    var actor =
        new AuthenticatedActor(
            account.id(),
            login,
            null,
            "helm-web",
            account.displayName(),
            account.email(),
            account.accessEpoch(),
            Set.of(),
            false);
    jdbc.sql(
            "INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)"
                + " VALUES(:id,:user,'Read','Read','TEXT','ANGULAR','PAUSED')")
        .param("id", task)
        .param("user", account.id())
        .update();
    jdbc.sql(
            "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                + " VALUES(:id,:boot,1,'fixture')")
        .param("id", worker)
        .param("boot", boot)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_id,worker_boot_id,purpose,state,privacy,
              last_activity_at,idle_deadline_at,budget_deadline_at,runtime_generation,ready_at)
            VALUES(:id,:user,:task,:worker,:boot,'TASK','ACTIVE',:privacy,now()-interval '1 minute',
              now()+interval '14 minutes',now()+interval '1 hour',:generation,now()-interval '1 minute')
            """)
        .param("id", session)
        .param("user", account.id())
        .param("task", task)
        .param("worker", worker)
        .param("boot", boot)
        .param("privacy", privacy)
        .param("generation", UUID.randomUUID())
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_control_leases(session_id,owner_id,owner_kind,state,controller_instance_id,
              login_id,input_channel_id,expires_at)
            VALUES(:id,:user,'HUMAN','ACTIVE',:controller,:login,:channel,now()+interval '5 minutes')
            """)
        .param("id", session)
        .param("user", account.id())
        .param("controller", controller)
        .param("login", login)
        .param("channel", channel)
        .update();
    var ticket =
        new TicketBinding(
            account.id(),
            login,
            null,
            account.accessEpoch(),
            task,
            session,
            null,
            controller,
            1,
            1,
            1,
            1,
            1,
            "HUMAN_INPUT",
            Instant.now().plusSeconds(30),
            Instant.now().plusSeconds(300),
            null,
            0,
            0,
            "https://helm.example");
    return new Fixture(actor, task, session, worker, boot, controller, channel, ticket);
  }
}
