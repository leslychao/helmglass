package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.when;

import com.helmglass.account.infrastructure.repository.AccountDataRepository;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.BrowserCloseDeliveryService;
import com.helmglass.browser.infrastructure.repository.BrowserCloseOutboxRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.infrastructure.repository.OutboxRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringJUnitConfig(BrowserCloseOutboxIntegrationTest.Owners.class)
class BrowserCloseOutboxIntegrationTest {
  @Configuration
  @Import({
    WorkflowIntegrationTest.Owners.class,
    BrowserCloseDeliveryService.class,
    OutboxRepository.class,
    AccountDataRepository.class
  })
  static class Owners {
    @Bean
    WorkerGateway gateway() {
      return mock(WorkerGateway.class);
    }
  }

  private record Fixture(UUID userId, UUID workerId, UUID bootId, UUID sessionId) {}

  private final JdbcClient jdbc;
  private final IdentityRepository identities;
  private final BrowserRepository browsers;
  private final ControlRepository controls;
  private final WorkerRegistryRepository registry;
  private final BrowserCloseOutboxRepository outbox;
  private final BrowserCloseDeliveryService delivery;
  private final OutboxRepository realtime;
  private final AccountDataRepository accountData;
  private final WorkerGateway gateway;
  private final TransactionTemplate transaction;
  private final List<Fixture> fixtures = new ArrayList<>();

  @Autowired
  BrowserCloseOutboxIntegrationTest(
      JdbcClient jdbc,
      IdentityRepository identities,
      BrowserRepository browsers,
      ControlRepository controls,
      WorkerRegistryRepository registry,
      BrowserCloseOutboxRepository outbox,
      BrowserCloseDeliveryService delivery,
      OutboxRepository realtime,
      AccountDataRepository accountData,
      WorkerGateway gateway,
      PlatformTransactionManager transactions) {
    this.jdbc = jdbc;
    this.identities = identities;
    this.browsers = browsers;
    this.controls = controls;
    this.registry = registry;
    this.outbox = outbox;
    this.delivery = delivery;
    this.realtime = realtime;
    this.accountData = accountData;
    this.gateway = gateway;
    transaction = new TransactionTemplate(transactions);
  }

  @AfterEach
  void closeFixtures() {
    transaction.executeWithoutResult(
        status -> {
          for (Fixture fixture : fixtures) {
            registry.closed(fixture.sessionId());
          }
        });
    reset(gateway);
  }

  @Test
  void commitSurvivesLostCallbackAndOnlyPhysicalClosureConfirmsDelivery() {
    var fixture = fixture();
    transaction.executeWithoutResult(
        status -> {
          controls.closeRequested(fixture.sessionId());
          status.setRollbackOnly();
        });
    assertThat(intentCount(fixture)).isZero();
    assertThat(browsers.owned(fixture.userId(), fixture.sessionId()).state()).isEqualTo("STARTING");
    request(fixture);
    UUID messageId = intentId(fixture);
    request(fixture);
    assertThat(intentId(fixture)).isEqualTo(messageId);
    assertThat(intentCount(fixture)).isEqualTo(1);
    assertThat(realtime.due()).noneMatch(item -> item.id().equals(messageId));
    realtime.published(messageId);
    assertThat(published(messageId)).isFalse();

    List<Map<String, Object>> sent = new ArrayList<>();
    when(gateway.send(any(UUID.class), any(UUID.class), any()))
        .thenAnswer(
            call -> {
              Map<String, Object> message = call.getArgument(2);
              sent.add(message);
              assertThat(call.getArgument(0, UUID.class)).isEqualTo(fixture.workerId());
              assertThat(call.getArgument(1, UUID.class)).isEqualTo(fixture.bootId());
              return sent.size() > 1;
            });
    delivery.dispatch();
    assertThat(failure(messageId)).isEqualTo("WORKER_TRANSPORT_UNAVAILABLE");
    retryNow(messageId);
    delivery.dispatch();
    assertThat(sent).hasSize(2);
    assertThat(sent.getFirst())
        .isEqualTo(sent.getLast())
        .containsEntry("requestId", messageId)
        .containsEntry("browserSessionId", fixture.sessionId());
    assertThat(published(messageId)).isFalse();
    assertThat(allocation(fixture)).isEqualTo("RESERVED");

    transaction.executeWithoutResult(status -> registry.closed(fixture.sessionId()));
    assertThat(published(messageId)).isTrue();
    assertThat(allocation(fixture)).isEqualTo("RELEASED");
    request(fixture);
    delivery.dispatch();
    assertThat(sent).hasSize(2);
    assertThat(browsers.owned(fixture.userId(), fixture.sessionId()).state()).isEqualTo("CLOSED");
  }

  @Test
  void crashAfterClaimKeepsTheSameIntentAndExhaustionStaysUnconfirmed() {
    var fixture = fixture();
    request(fixture);
    UUID messageId = intentId(fixture);
    assertThat(outbox.due())
        .extracting(BrowserCloseOutboxRepository.Delivery::id)
        .contains(messageId);
    assertThat(attempts(messageId)).isEqualTo(1);
    when(gateway.send(any(UUID.class), any(UUID.class), any())).thenReturn(false);
    for (int attempt = 2; attempt <= 9; attempt++) {
      retryNow(messageId);
      delivery.dispatch();
    }
    assertThat(intentId(fixture)).isEqualTo(messageId);
    assertThat(attempts(messageId)).isEqualTo(8);
    assertThat(published(messageId)).isFalse();
    assertThat(failure(messageId)).isEqualTo("WORKER_TRANSPORT_UNAVAILABLE");
    assertThat(allocation(fixture)).isEqualTo("RESERVED");
  }

  @Test
  void claimedMessageIsFencedWhenTheWorkerBootOrAllocationChanges() {
    var fixture = fixture();
    request(fixture);
    UUID messageId = intentId(fixture);
    outbox.due();
    assertThat(outbox.deliverable(messageId)).isTrue();
    jdbc.sql("UPDATE browser_workers SET boot_id=:boot WHERE id=:id")
        .param("boot", UUID.randomUUID())
        .param("id", fixture.workerId())
        .update();
    assertThat(outbox.deliverable(messageId)).isFalse();
    retryNow(messageId);
    assertThat(outbox.due()).noneMatch(item -> item.id().equals(messageId));
    jdbc.sql("UPDATE browser_workers SET boot_id=:boot WHERE id=:id")
        .param("boot", fixture.bootId())
        .param("id", fixture.workerId())
        .update();
    jdbc.sql("UPDATE browser_sessions SET allocation_epoch=allocation_epoch+1 WHERE id=:id")
        .param("id", fixture.sessionId())
        .update();
    assertThat(outbox.deliverable(messageId)).isFalse();
    assertThat(published(messageId)).isFalse();
    jdbc.sql("UPDATE browser_sessions SET allocation_epoch=allocation_epoch-1 WHERE id=:id")
        .param("id", fixture.sessionId())
        .update();
  }

  @Test
  void concurrentRelaysReserveOneAttemptAndPurgeCannotEraseUnsentClosure() throws Exception {
    var fixture = fixture();
    request(fixture);
    UUID messageId = intentId(fixture);
    try (var executor = Executors.newFixedThreadPool(2)) {
      Future<List<BrowserCloseOutboxRepository.Delivery>> first = executor.submit(outbox::due);
      Future<List<BrowserCloseOutboxRepository.Delivery>> second = executor.submit(outbox::due);
      long matches =
          first.get().stream().filter(item -> item.id().equals(messageId)).count()
              + second.get().stream().filter(item -> item.id().equals(messageId)).count();
      assertThat(matches).isEqualTo(1);
    }
    assertThat(attempts(messageId)).isEqualTo(1);
    assertThat(accountData.purgeBatch(fixture.userId())).isFalse();
    assertThat(intentCount(fixture)).isEqualTo(1);
    assertThat(allocation(fixture)).isEqualTo("RESERVED");
  }

  private Fixture fixture() {
    Fixture fixture =
        Objects.requireNonNull(
            transaction.execute(
                status -> {
                  var user =
                      identities.resolve(
                          "https://issuer.example",
                          UUID.randomUUID().toString(),
                          "Outbox fixture",
                          "outbox@example.test");
                  UUID worker = UUID.randomUUID();
                  UUID boot = UUID.randomUUID();
                  jdbc.sql(
                          "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                              + " VALUES(:id,:boot,1,'fixture')")
                      .param("id", worker)
                      .param("boot", boot)
                      .update();
                  var session =
                      browsers.reserve(
                          user.id(),
                          null,
                          null,
                          "CONNECTION_LOGIN",
                          new BrowserRepository.Worker(worker, boot, 1),
                          600);
                  return new Fixture(user.id(), worker, boot, session.id());
                }));
    fixtures.add(fixture);
    return fixture;
  }

  private void request(Fixture fixture) {
    transaction.executeWithoutResult(status -> controls.closeRequested(fixture.sessionId()));
  }

  private UUID intentId(Fixture fixture) {
    return jdbc.sql(
            "SELECT id FROM transactional_outbox WHERE aggregate_id=:session AND"
                + " event_type='worker.close'")
        .param("session", fixture.sessionId())
        .query(UUID.class)
        .single();
  }

  private long intentCount(Fixture fixture) {
    return jdbc.sql(
            "SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:session AND"
                + " event_type='worker.close'")
        .param("session", fixture.sessionId())
        .query(Long.class)
        .single();
  }

  private boolean published(UUID id) {
    return jdbc.sql("SELECT published_at IS NOT NULL FROM transactional_outbox WHERE id=:id")
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  private int attempts(UUID id) {
    return jdbc.sql("SELECT delivery_attempts FROM transactional_outbox WHERE id=:id")
        .param("id", id)
        .query(Integer.class)
        .single();
  }

  private String failure(UUID id) {
    return jdbc.sql("SELECT last_failure_code FROM transactional_outbox WHERE id=:id")
        .param("id", id)
        .query(String.class)
        .single();
  }

  private void retryNow(UUID id) {
    jdbc.sql("UPDATE transactional_outbox SET retry_at=now() WHERE id=:id")
        .param("id", id)
        .update();
  }

  private String allocation(Fixture fixture) {
    return jdbc.sql("SELECT state FROM browser_allocations WHERE session_id=:id")
        .param("id", fixture.sessionId())
        .query(String.class)
        .single();
  }
}
