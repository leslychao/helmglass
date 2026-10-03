package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.domain.ChatPresentation;
import com.helmglass.realtime.domain.HostConversationContext;
import com.helmglass.realtime.domain.ViewerFence;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.realtime.infrastructure.repository.ChatPresentationRepository;
import com.helmglass.realtime.infrastructure.repository.OutboxRepository;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import liquibase.command.CommandScope;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.containers.GenericContainer;
import tools.jackson.databind.json.JsonMapper;

class ChatPresentationIntegrationTest {
  private static final PostgreSQLContainer DATABASE =
      new PostgreSQLContainer("postgres:18.3-bookworm");
  private static final GenericContainer<?> REDIS = new GenericContainer<>("redis:8.4.6-alpine")
      .withExposedPorts(6379);
  private static LettuceConnectionFactory redisConnection;
  private static ChannelTicketService tickets;
  private static JdbcClient jdbc;
  private static TransactionTemplate transaction;
  private static RealtimeDeliveryService realtime;
  private static ChatPresentationRepository presentations;
  private static OutboxRepository outbox;

  @BeforeAll
  static void database() throws Exception {
    DATABASE.start();
    REDIS.start();
    new CommandScope("update")
        .addArgumentValue("changelogFile", "db/changelog/master.xml")
        .addArgumentValue("url", DATABASE.getJdbcUrl())
        .addArgumentValue("username", DATABASE.getUsername())
        .addArgumentValue("password", DATABASE.getPassword())
        .execute();
    var dataSource =
        new DriverManagerDataSource(
            DATABASE.getJdbcUrl(), DATABASE.getUsername(), DATABASE.getPassword());
    jdbc = JdbcClient.create(dataSource);
    transaction = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
    var json = new JsonSupport(JsonMapper.builder().findAndAddModules().build());
    var changes = new ChangeRepository(jdbc, json);
    var identities = new IdentityRepository(jdbc, json);
    redisConnection = new LettuceConnectionFactory(REDIS.getHost(), REDIS.getMappedPort(6379));
    redisConnection.afterPropertiesSet();
    redisConnection.start();
    var redis = new StringRedisTemplate(redisConnection);
    redis.afterPropertiesSet();
    tickets = new ChannelTicketService(redis, json, new UserEphemeralState(redis, identities));
    presentations = new ChatPresentationRepository(jdbc);
    outbox = new OutboxRepository(jdbc);
    realtime =
        new RealtimeDeliveryService(
            outbox,
            identities,
            json,
            presentations,
            new OperationRepository(jdbc, json, changes), event -> {});
  }

  @AfterAll
  static void stopDatabase() {
    if (redisConnection != null) {
      redisConnection.destroy();
    }
    REDIS.stop();
    DATABASE.stop();
  }

  @Test
  void eventTicketsAreOneUseBoundToOriginAndCannotReviveAfterRedisLoss() {
    Fixture fixture = fixture();
    ChatPresentation slot = publish(fixture, null, 0, mutation()).slot();
    UUID viewer = UUID.randomUUID();
    slot = attach(fixture, slot.id(), 1, viewer).slot();
    String origin = "https://helm-test.web-sandbox.oaiusercontent.com";
    ChatPresentation current = slot;
    var wrongOrigin = tx(() -> tickets.eventTicket(current, origin, "wss://helm.test/events"));
    assertThatThrownBy(() -> tickets.consumeTaskEvents((String) wrongOrigin.get("ticket"), fixture.task(), "https://other.test"))
        .isInstanceOf(DomainException.class).extracting("code").isEqualTo("TICKET_BINDING_MISMATCH");
    var issued = tx(() -> tickets.eventTicket(current, origin, "wss://helm.test/events"));
    var binding = tickets.consumeTaskEvents((String) issued.get("ticket"), fixture.task(), origin);
    assertThatThrownBy(() -> tickets.consumeTaskEvents((String) issued.get("ticket"), fixture.task(), origin))
        .isInstanceOf(DomainException.class).extracting("code").isEqualTo("TICKET_EXPIRED");
    assertThat(tx(() -> realtime.connectWidgetEvents(binding))).isTrue();
    assertThat(tx(() -> realtime.connectWidgetEvents(binding))).isFalse();
    assertThat(tx(() -> realtime.renewWidget(binding))).isTrue();
    try (var connection = redisConnection.getConnection()) {
      connection.serverCommands().flushDb();
    }
    assertThat(realtime.widgetAuthorized(binding)).isTrue();
    publish(fixture, current.id(), 1, mutation());
    assertThat(realtime.widgetAuthorized(binding)).isFalse();
    assertThat(attach(fixture, current.id(), 1, viewer).state()).isEqualTo("SUPERSEDED");
  }

  @Test
  void compareAndSetPublicationKeepsOriginalReceiptAndSeparatesConversations() {
    Fixture fixture = fixture();
    MutationContext firstKey = mutation();
    var first = publish(fixture, null, 0, firstKey);
    assertThat(first.slot().presentationRevision()).isEqualTo(1);
    var duplicate = publish(fixture, null, 0, firstKey);
    assertThat(duplicate.receipt()).isEqualTo(first.receipt());
    assertThat(duplicate.superseded()).isFalse();
    var second = publish(fixture, first.slot().id(), 1, mutation());
    assertThat(second.slot().presentationRevision()).isEqualTo(2);
    var historical = publish(fixture, null, 0, firstKey);
    assertThat(historical.receipt()).isEqualTo(first.receipt());
    assertThat(historical.superseded()).isTrue();
    assertThatThrownBy(() -> publish(fixture, first.slot().id(), 1, mutation()))
        .isInstanceOf(DomainException.class)
        .extracting("code")
        .isEqualTo("STALE_PRESENTATION");
    Fixture otherChat = new Fixture(fixture.actor(), fixture.task(), host());
    assertThat(publish(otherChat, null, 0, mutation()).slot().id()).isNotEqualTo(first.slot().id());
    assertThat(attach(otherChat, first.slot().id(), 2, UUID.randomUUID()).state())
        .isEqualTo("LINK_ONLY");
    assertThat(
            realtime
                .currentPresentation(fixture.actor(), fixture.host())
                .orElseThrow()
                .presentationRevision())
        .isEqualTo(2);
  }

  @Test
  void missingOrChangedHostNeverCreatesOrRevokesAChatScope() {
    Fixture fixture = fixture();
    var first = publish(fixture, null, 0, mutation());
    var missing = new Fixture(fixture.actor(), fixture.task(), null);
    assertThat(publish(missing, first.slot().id(), 1, mutation()).slot()).isNull();
    assertThat(attach(missing, first.slot().id(), 1, UUID.randomUUID()).state())
        .isEqualTo("LINK_ONLY");
    assertThat(
            realtime
                .currentPresentation(fixture.actor(), fixture.host())
                .orElseThrow()
                .presentationRevision())
        .isEqualTo(1);
    assertThat(
            jdbc.sql("SELECT count(*) FROM chat_view_slots WHERE user_id=:user")
                .param("user", fixture.actor().userId())
                .query(Long.class)
                .single())
        .isEqualTo(1);
  }

  @Test
  void firstConcurrentMountWinsAndExpiredMountCanRecoverUntilItIsReplaced() throws Exception {
    Fixture fixture = fixture();
    ChatPresentation slot = publish(fixture, null, 0, mutation()).slot();
    UUID one = UUID.randomUUID(), two = UUID.randomUUID();
    CountDownLatch start = new CountDownLatch(1);
    try (var executor = Executors.newFixedThreadPool(2)) {
      var a = executor.submit(() -> competingAttach(fixture, slot, one, start));
      var b = executor.submit(() -> competingAttach(fixture, slot, two, start));
      start.countDown();
      assertThat(List.of(a.get(10, TimeUnit.SECONDS), b.get(10, TimeUnit.SECONDS)))
          .containsExactlyInAnyOrder("ACTIVE", "VIEW_ALREADY_ATTACHED");
    }
    ChatPresentation winner =
        realtime.currentPresentation(fixture.actor(), fixture.host()).orElseThrow();
    assertThat(
            attach(fixture, slot.id(), 1, winner.activeViewerInstanceId()).slot().viewGeneration())
        .isEqualTo(winner.viewGeneration());
    assertThat(winner.viewerLeaseExpiresAt()).isBeforeOrEqualTo(Instant.now().plusSeconds(45));
    expire(slot.id());
    var recovered = attach(fixture, slot.id(), 1, winner.activeViewerInstanceId());
    assertThat(recovered.state()).isEqualTo("ACTIVE");
    assertThat(recovered.slot().viewGeneration()).isGreaterThan(winner.viewGeneration());
    expire(slot.id());
    UUID replacement = UUID.randomUUID();
    assertThat(attach(fixture, slot.id(), 1, replacement).state()).isEqualTo("ACTIVE");
    assertThat(attach(fixture, slot.id(), 1, winner.activeViewerInstanceId()).state())
        .isEqualTo("SUPERSEDED");
    publish(fixture, slot.id(), 1, mutation());
    assertThat(attach(fixture, slot.id(), 1, replacement).state()).isEqualTo("SUPERSEDED");
  }

  @Test
  void grantVersionAndAccountEpochInvalidateViewerAuthority() {
    Fixture fixture = fixture();
    ChatPresentation slot = publish(fixture, null, 0, mutation()).slot();
    UUID viewer = UUID.randomUUID();
    attach(fixture, slot.id(), 1, viewer);
    assertThat(realtime.requireCurrentViewer(fixture.actor(), fixture.host(), slot.id(), 1, viewer))
        .isNotNull();
    jdbc.sql("UPDATE client_grants SET version=version+1 WHERE id=:id")
        .param("id", fixture.actor().grantId())
        .update();
    assertThatThrownBy(
            () ->
                realtime.requireCurrentViewer(
                    fixture.actor(), fixture.host(), slot.id(), 1, viewer))
        .isInstanceOf(DomainException.class)
        .extracting("code")
        .isEqualTo("STALE_PRESENTATION");
    jdbc.sql("UPDATE application_users SET access_epoch=access_epoch+1 WHERE id=:id")
        .param("id", fixture.actor().userId())
        .update();
    assertThatThrownBy(() -> attach(fixture, slot.id(), 1, UUID.randomUUID()))
        .isInstanceOf(DomainException.class)
        .extracting("code")
        .isEqualTo("GRANT_REVOKED");
  }

  @Test
  void onlyExactPhysicalFenceAcknowledgesCriticalOutboxAndUiCannotConsumeIt() {
    Fixture fixture = fixture();
    ChatPresentation slot = publish(fixture, null, 0, mutation()).slot();
    UUID viewer = UUID.randomUUID();
    ChatPresentation admitted = attach(fixture, slot.id(), 1, viewer).slot();
    UUID worker = UUID.randomUUID(), boot = UUID.randomUUID(), session = UUID.randomUUID();
    jdbc.sql(
            "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                + " VALUES(:id,:boot,1,'fixture')")
        .param("id", worker)
        .param("boot", boot)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_id,worker_boot_id,purpose,state,
              idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:task,:worker,:boot,'TASK','ACTIVE',now()+interval '1 hour',now()+interval '1 hour')
            """)
        .param("id", session)
        .param("user", fixture.actor().userId())
        .param("task", fixture.task())
        .param("worker", worker)
        .param("boot", boot)
        .update();
    jdbc.sql(
            """
            UPDATE chat_view_slots SET browser_session_id=:session,worker_id=:worker,
              worker_boot_id=:boot,allocation_epoch=1 WHERE id=:id
            """)
        .param("id", slot.id())
        .param("session", session)
        .param("worker", worker)
        .param("boot", boot)
        .update();
    var next = publish(fixture, slot.id(), 1, mutation());
    assertThat(next.slot().transferState()).isEqualTo("TRANSFERRING");
    UUID fenceId =
        jdbc.sql(
                "SELECT id FROM transactional_outbox WHERE aggregate_id=:id AND"
                    + " event_type='viewer.fence'")
            .param("id", slot.id())
            .query(UUID.class)
            .single();
    assertThat(tx(outbox::due)).noneMatch(intent -> intent.id().equals(fenceId));
    outbox.published(fenceId);
    assertThat(unpublished(fenceId)).isTrue();
    ViewerFence exact =
        new ViewerFence(fenceId, worker, boot, session, 1, viewer, admitted.viewGeneration());
    ViewerFence stale =
        new ViewerFence(fenceId, worker, boot, session, 1, viewer, admitted.viewGeneration() + 1);
    assertThat(tx(() -> realtime.confirmViewerFence(stale))).isFalse();
    assertThat(unpublished(fenceId)).isTrue();
    assertThat(tx(() -> realtime.confirmViewerFence(exact))).isTrue();
    assertThat(tx(() -> realtime.confirmViewerFence(exact))).isTrue();
    assertThat(unpublished(fenceId)).isFalse();
    assertThat(
            realtime
                .currentPresentation(fixture.actor(), fixture.host())
                .orElseThrow()
                .transferState())
        .isEqualTo("ACTIVE");
  }

  private static String competingAttach(
      Fixture fixture, ChatPresentation slot, UUID viewer, CountDownLatch start)
      throws InterruptedException {
    if (!start.await(5, TimeUnit.SECONDS)) {
      throw new IllegalStateException("Concurrent mount did not start");
    }
    try {
      return attach(fixture, slot.id(), 1, viewer).state();
    } catch (DomainException error) {
      return error.getCode();
    }
  }

  private static void expire(UUID scope) {
    jdbc.sql(
            "UPDATE chat_view_slots SET viewer_lease_expires_at=now()-interval '1 second' WHERE"
                + " id=:id")
        .param("id", scope)
        .update();
    transaction.executeWithoutResult(status -> realtime.expirePresentations());
  }

  private static boolean unpublished(UUID id) {
    return jdbc.sql("SELECT published_at IS NULL FROM transactional_outbox WHERE id=:id")
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  private static RealtimeDeliveryService.Publication publish(
      Fixture fixture, UUID scope, long revision, MutationContext key) {
    return tx(
        () ->
            realtime.publishPresentation(
                fixture.actor(),
                fixture.task(),
                scope,
                revision,
                key,
                fixture.host(),
                Instant.now().plusSeconds(300)));
  }

  private static RealtimeDeliveryService.Attachment attach(
      Fixture fixture, UUID scope, long revision, UUID viewer) {
    return tx(
        () ->
            realtime.attachPresentation(
                fixture.actor(),
                fixture.task(),
                scope,
                revision,
                viewer,
                fixture.host(),
                Instant.now().plusSeconds(300)));
  }

  private static <T> T tx(Supplier<T> operation) {
    return Objects.requireNonNull(transaction.execute(status -> operation.get()));
  }

  private static MutationContext mutation() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }

  private static HostConversationContext host() {
    return new HostConversationContext(
        "CHATGPT_WEB", "2026-10-03", JsonSupport.sha256(UUID.randomUUID().toString()));
  }

  private record Fixture(AuthenticatedActor actor, UUID task, HostConversationContext host) {}

  private static Fixture fixture() {
    UUID user = UUID.randomUUID(), grant = UUID.randomUUID(), task = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO application_users(id,issuer,subject,display_name,email,identity_hash)
            VALUES(:id,'https://issuer.test',:subject,'Fixture','fixture@example.test',:hash)
            """)
        .param("id", user)
        .param("subject", user.toString())
        .param("hash", JsonSupport.sha256(user.toString()))
        .update();
    jdbc.sql(
            """
            INSERT INTO client_grants(id,user_id,client_id,sid,scopes)
            VALUES(:id,:user,'helm-mcp',:sid,'["tasks:read","browser:view"]')
            """)
        .param("id", grant)
        .param("user", user)
        .param("sid", UUID.randomUUID().toString())
        .update();
    jdbc.sql(
            """
            INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)
            VALUES(:id,:user,'Fixture task','Fixture task','TEXT','MCP','DRAFT')
            """)
        .param("id", task)
        .param("user", user)
        .update();
    return new Fixture(
        new AuthenticatedActor(
            user,
            null,
            grant,
            "helm-mcp",
            "Fixture",
            "fixture@example.test",
            1,
            Set.of("tasks:read", "browser:view"),
            true),
        task,
        host());
  }
}
