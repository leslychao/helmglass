package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.when;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.browser.api.BrowserContracts;
import com.helmglass.browser.api.WorkerGateway;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserSessionOperationService;
import com.helmglass.browser.application.ControlDispatcher;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlOutboxRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.OutboxRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
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
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

@SpringJUnitConfig(ControlOutboxIntegrationTest.Owners.class)
class ControlOutboxIntegrationTest {
  @Configuration
  @Import({
    WorkflowIntegrationTest.Owners.class,
    ControlOutboxRepository.class,
    ControlDispatcher.class,
    OutboxRepository.class
  })
  static class Owners {
    @Bean
    WorkerGateway gateway() {
      return mock(WorkerGateway.class);
    }

    @Bean
    BrowserSessionOperationService sessionOperations() {
      return mock(BrowserSessionOperationService.class);
    }
  }

  private record Fixture(
      AuthenticatedActor actor, UUID worker, UUID boot, UUID session, UUID controller) {}

  private final JdbcClient jdbc;
  private final IdentityRepository identities;
  private final BrowserRepository browsers;
  private final ControlRepository leases;
  private final BrowserControlService controls;
  private final ControlOutboxRepository outbox;
  private final ControlDispatcher dispatcher;
  private final WorkerGateway gateway;
  private final BrowserSessionOperationService sessionOperations;
  private final OperationRepository operations;
  private final OutboxRepository realtime;
  private final JsonSupport json;
  private final TransactionTemplate transaction;
  private final WorkerRegistryRepository registry;
  private final List<UUID> fixtureSessions = new ArrayList<>();

  @Autowired
  ControlOutboxIntegrationTest(
      JdbcClient jdbc,
      IdentityRepository identities,
      BrowserRepository browsers,
      ControlRepository leases,
      BrowserControlService controls,
      ControlOutboxRepository outbox,
      ControlDispatcher dispatcher,
      WorkerGateway gateway,
      BrowserSessionOperationService sessionOperations,
      OperationRepository operations,
      OutboxRepository realtime,
      JsonSupport json,
      WorkerRegistryRepository registry,
      PlatformTransactionManager transactions) {
    this.jdbc = jdbc;
    this.identities = identities;
    this.browsers = browsers;
    this.leases = leases;
    this.controls = controls;
    this.outbox = outbox;
    this.dispatcher = dispatcher;
    this.gateway = gateway;
    this.sessionOperations = sessionOperations;
    this.operations = operations;
    this.realtime = realtime;
    this.json = json;
    this.registry = registry;
    transaction = new TransactionTemplate(transactions);
  }

  @AfterEach
  void fenceFixtures() {
    for (UUID session : fixtureSessions) {
      jdbc.sql("UPDATE browser_control_leases SET epoch=epoch+1 WHERE session_id=:id")
          .param("id", session)
          .update();
    }
    reset(gateway, sessionOperations);
  }

  @Test
  void committedControlSurvivesLostCallbackAndExactAckCommitsWithItsOperation() {
    var fixture = fixture();
    transaction.executeWithoutResult(
        status -> {
          acquire(fixture);
          status.setRollbackOnly();
        });
    assertThat(count(fixture)).isZero();
    UUID operation = acquire(fixture);
    var delivery = intent(fixture);
    assertThat(realtime.due()).noneMatch(row -> row.id().equals(delivery.id()));
    realtime.published(delivery.id());
    assertThat(outbox.published(delivery.id())).isFalse();
    assertThat(leases.get(fixture.session()).state()).isEqualTo("TRANSFERRING");

    List<Map<String, Object>> sent = new ArrayList<>();
    when(gateway.send(any(UUID.class), any(UUID.class), any()))
        .thenAnswer(
            call -> {
              Map<String, Object> message = call.getArgument(2);
              sent.add(message);
              assertThat(call.getArgument(0, UUID.class)).isEqualTo(fixture.worker());
              assertThat(call.getArgument(1, UUID.class)).isEqualTo(fixture.boot());
              return sent.size() > 1;
            });
    dispatcher.deliverControls();
    assertThat(failure(delivery.id())).isEqualTo("WORKER_TRANSPORT_UNAVAILABLE");
    retry(delivery.id());
    dispatcher.deliverControls();
    assertThat(sent).hasSize(2);
    assertThat(sent.getFirst()).isEqualTo(sent.getLast());
    assertThat(outbox.published(delivery.id())).isFalse();

    JsonNode acknowledgement = acknowledgement(delivery);
    when(sessionOperations.acknowledge(any(), any(), any(), any()))
        .thenAnswer(
            call -> {
              controls.acknowledge(
                  fixture.worker(),
                  fixture.boot(),
                  fixture.session(),
                  acknowledgement.path("controlEpoch").asLong());
              throw new IllegalStateException("fixture rollback after transition");
            });
    assertThatThrownBy(
            () -> dispatcher.acknowledge(fixture.worker(), fixture.boot(), acknowledgement))
        .isInstanceOf(IllegalStateException.class);
    assertThat(outbox.published(delivery.id())).isFalse();
    assertThat(leases.get(fixture.session()).state()).isEqualTo("TRANSFERRING");
    assertThat(operations.owned(fixture.actor().userId(), operation).state()).isEqualTo("PENDING");
    reset(sessionOperations);
    Instant grantedExpiry = leases.get(fixture.session()).expiresAt();
    dispatcher.acknowledge(fixture.worker(), fixture.boot(), acknowledgement);
    assertThat(outbox.published(delivery.id())).isTrue();
    assertThat(leases.get(fixture.session()).state()).isEqualTo("ACTIVE");
    assertThat(leases.get(fixture.session()).expiresAt()).isEqualTo(grantedExpiry);
    assertThat(operations.owned(fixture.actor().userId(), operation).state())
        .isEqualTo("SUCCEEDED");
    long version = leases.get(fixture.session()).version();
    dispatcher.acknowledge(fixture.worker(), fixture.boot(), acknowledgement);
    assertThat(leases.get(fixture.session()).version()).isEqualTo(version);
  }

  @Test
  void staleBootEpochAndChangedReceiptCannotActivateOrConfirmControl() {
    var fixture = fixture();
    acquire(fixture);
    var delivery = intent(fixture);
    ObjectNode acknowledgement = acknowledgement(delivery);
    assertThatThrownBy(
            () -> dispatcher.acknowledge(fixture.worker(), UUID.randomUUID(), acknowledgement))
        .isInstanceOf(DomainException.class);
    acknowledgement.put("pageEpoch", acknowledgement.path("pageEpoch").asLong() + 1);
    assertThatThrownBy(
            () -> dispatcher.acknowledge(fixture.worker(), fixture.boot(), acknowledgement))
        .isInstanceOf(DomainException.class);
    jdbc.sql("UPDATE browser_control_leases SET epoch=epoch+1 WHERE session_id=:id")
        .param("id", fixture.session())
        .update();
    assertThat(outbox.deliverable(delivery.id())).isFalse();
    assertThatThrownBy(
            () ->
                dispatcher.acknowledge(fixture.worker(), fixture.boot(), acknowledgement(delivery)))
        .isInstanceOf(DomainException.class);
    assertThat(outbox.published(delivery.id())).isFalse();
  }

  @Test
  void concurrentRelaysClaimOneAttemptAndCrashDoesNotResetBoundedRetries() throws Exception {
    var fixture = fixture();
    acquireAgent(fixture);
    var delivery = intent(fixture);
    try (var executor = Executors.newFixedThreadPool(2)) {
      var first = executor.submit(outbox::due);
      var second = executor.submit(outbox::due);
      assertThat(
              first.get().stream().filter(row -> row.id().equals(delivery.id())).count()
                  + second.get().stream().filter(row -> row.id().equals(delivery.id())).count())
          .isEqualTo(1);
    }
    when(gateway.send(any(UUID.class), any(UUID.class), any())).thenReturn(false);
    for (int index = 0; index < 10; index++) {
      retry(delivery.id());
      dispatcher.deliverControls();
    }
    assertThat(
            jdbc.sql("SELECT delivery_attempts FROM transactional_outbox WHERE id=:id")
                .param("id", delivery.id())
                .query(Integer.class)
                .single())
        .isEqualTo(8);
    transaction.executeWithoutResult(
        status -> controls.redeliverControl(fixture.actor().userId(), fixture.session(), "AGENT"));
    assertThat(count(fixture)).isEqualTo(1);
    assertThat(intent(fixture).id()).isEqualTo(delivery.id());
    assertThat(outbox.published(delivery.id())).isFalse();
    assertThat(failure(delivery.id())).isEqualTo("WORKER_TRANSPORT_UNAVAILABLE");
  }

  @Test
  void authorizationAndDeadlineChangesFencePendingDeliveryWithoutConfirmingIt() {
    for (String revocation : List.of("login", "policy", "deadline", "boot")) {
      var fixture = fixture();
      acquire(fixture);
      var delivery = intent(fixture);
      switch (revocation) {
        case "login" ->
            jdbc.sql("UPDATE application_logins SET state='REVOKED' WHERE id=:id")
                .param("id", fixture.actor().loginId())
                .update();
        case "policy" ->
            jdbc.sql("UPDATE user_policies SET version=version+1 WHERE user_id=:id")
                .param("id", fixture.actor().userId())
                .update();
        case "deadline" ->
            jdbc.sql(
                    "UPDATE browser_sessions SET budget_deadline_at=now()-interval '1 second' WHERE"
                        + " id=:id")
                .param("id", fixture.session())
                .update();
        case "boot" ->
            jdbc.sql("UPDATE browser_workers SET boot_id=:boot WHERE id=:id")
                .param("boot", UUID.randomUUID())
                .param("id", fixture.worker())
                .update();
        default -> throw new AssertionError("Unknown fixture case");
      }
      assertThat(outbox.deliverable(delivery.id())).isFalse();
      assertThat(outbox.due()).noneMatch(row -> row.id().equals(delivery.id()));
      assertThatThrownBy(
              () ->
                  dispatcher.acknowledge(
                      fixture.worker(), fixture.boot(), acknowledgement(delivery)))
          .isInstanceOf(DomainException.class);
      assertThat(outbox.published(delivery.id())).isFalse();
    }
  }

  @Test
  void expiredClaimCreatesOneDurableFenceAndOnlyItsFreshAckReleasesControl() {
    Fixture fixture = fixture();
    UUID claim = UUID.randomUUID();
    UUID operation = claimFixture(fixture, claim);
    long oldEpoch = leases.get(fixture.session()).epoch();
    var previous = intent(fixture);
    assertThat(fence(fixture, claim, oldEpoch)).isTrue();
    var delivery = intent(fixture);
    assertThat(delivery.id()).isNotEqualTo(previous.id());
    assertThat(leases.get(fixture.session()).epoch()).isEqualTo(oldEpoch + 1);
    assertThat(leases.get(fixture.session()).claimFenceId()).isEqualTo(claim);
    assertThat(leases.get(fixture.session()).continuationClaimId()).isNull();
    assertThat(operations.owned(fixture.actor().userId(), operation).state()).isEqualTo("FAILED");
    assertThat(fence(fixture, claim, oldEpoch)).isTrue();
    assertThat(count(fixture)).isEqualTo(2);
    assertThat(intent(fixture).id()).isEqualTo(delivery.id());
    assertThat(outbox.deliverable(delivery.id())).isTrue();
    assertThat(outbox.deliverable(previous.id())).isFalse();
    assertThatThrownBy(
            () ->
                dispatcher.acknowledge(fixture.worker(), fixture.boot(), acknowledgement(previous)))
        .isInstanceOf(DomainException.class);
    UUID fenceOperation = leases.get(fixture.session()).operationId();
    assertThat(outbox.published(delivery.id())).isFalse();
    dispatcher.acknowledge(fixture.worker(), fixture.boot(), acknowledgement(delivery));
    assertThat(leases.get(fixture.session()).state()).isEqualTo("ACTIVE");
    assertThat(leases.get(fixture.session()).claimFenceId()).isNull();
    assertThat(operations.owned(fixture.actor().userId(), fenceOperation).state())
        .isEqualTo("SUCCEEDED");
    assertThat(outbox.published(delivery.id())).isTrue();
    assertThat(fence(fixture, claim, oldEpoch)).isFalse();
  }

  @Test
  void reconnectRecoveryAckCanFinishClaimFenceButAnOldReceiptCannot() {
    Fixture fixture = fixture();
    UUID claim = UUID.randomUUID();
    claimFixture(fixture, claim);
    long oldEpoch = leases.get(fixture.session()).epoch();
    assertThat(fence(fixture, claim, oldEpoch)).isTrue();
    var delivery = intent(fixture);
    transaction.executeWithoutResult(
        status -> {
          registry.recovering(fixture.session());
          registry.beginRecovery(
              fixture.session(),
              "AGENT",
              browsers.owned(fixture.actor().userId(), fixture.session()).pageEpoch());
        });
    assertThatThrownBy(
            () ->
                dispatcher.acknowledge(fixture.worker(), fixture.boot(), acknowledgement(delivery)))
        .isInstanceOf(DomainException.class);
    ObjectNode recovery = acknowledgement(delivery);
    recovery.put("requestId", UUID.randomUUID().toString());
    recovery.put("controlEpoch", leases.get(fixture.session()).epoch());
    assertThat(dispatcher.acknowledge(fixture.worker(), fixture.boot(), recovery)).isTrue();
    assertThat(leases.get(fixture.session()).state()).isEqualTo("ACTIVE");
    assertThat(leases.get(fixture.session()).claimFenceId()).isNull();
    assertThat(outbox.published(delivery.id())).isFalse();
  }

  private UUID claimFixture(Fixture fixture, UUID claim) {
    return Objects.requireNonNull(
        transaction.execute(
            status -> {
              UUID task = UUID.randomUUID();
              jdbc.sql(
                      """
                      INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)
                      VALUES(:id,:user,'Control fixture','Control fixture','TEXT','MCP','WAITING_AGENT')
                      """)
                  .param("id", task)
                  .param("user", fixture.actor().userId())
                  .update();
              jdbc.sql("UPDATE browser_sessions SET task_id=:task,purpose='TASK' WHERE id=:id")
                  .param("task", task)
                  .param("id", fixture.session())
                  .update();
              UUID operation =
                  operations.createSystem(
                      fixture.actor().userId(),
                      "tasks.continue:" + task,
                      "continuationClaim",
                      claim);
              leases.claimAgent(fixture.session(), claim, operation, Instant.now().minusSeconds(1));
              controls.publishControl(fixture.actor().userId(), fixture.session(), "AGENT");
              return operation;
            }));
  }

  private boolean fence(Fixture fixture, UUID claim, long epoch) {
    return Boolean.TRUE.equals(
        transaction.execute(
            status ->
                controls.fenceExpiredClaim(
                    fixture.actor().userId(), fixture.session(), claim, epoch)));
  }

  private Fixture fixture() {
    var fixture =
        Objects.requireNonNull(
            transaction.execute(
                status -> {
                  var user =
                      identities.resolve(
                          "https://issuer.example",
                          UUID.randomUUID().toString(),
                          "Control fixture",
                          "control@example.test");
                  UUID login =
                      identities.admitLogin(
                          user,
                          "https://issuer.example",
                          "control:" + UUID.randomUUID(),
                          Instant.now().minusSeconds(10),
                          Instant.now().plusSeconds(600));
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
                  jdbc.sql(
                          "UPDATE browser_sessions SET"
                              + " state='ACTIVE',privacy='NORMAL',runtime_generation=:generation,ready_at=now()"
                              + " WHERE id=:id")
                      .param("generation", UUID.randomUUID())
                      .param("id", session.id())
                      .update();
                  return new Fixture(
                      new AuthenticatedActor(
                          user.id(),
                          login,
                          null,
                          "helm-web",
                          "Control fixture",
                          "control@example.test",
                          user.accessEpoch(),
                          Set.of(),
                          false),
                      worker,
                      boot,
                      session.id(),
                      UUID.randomUUID());
                }));
    fixtureSessions.add(fixture.session());
    return fixture;
  }

  private UUID acquire(Fixture fixture) {
    var session = browsers.owned(fixture.actor().userId(), fixture.session());
    return controls
        .acquire(
            fixture.actor(),
            fixture.session(),
            new BrowserContracts.TakeControl(
                session.version(),
                leases.get(fixture.session()).epoch(),
                fixture.controller(),
                false,
                false),
            new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID()))
        .operationId();
  }

  private void acquireAgent(Fixture fixture) {
    transaction.executeWithoutResult(
        status -> {
          leases.transfer(fixture.session(), null, "AGENT", false, UUID.randomUUID());
          controls.publishControl(fixture.actor().userId(), fixture.session(), "AGENT");
        });
  }

  private ControlOutboxRepository.Delivery intent(Fixture fixture) {
    return jdbc.sql(
            """
            SELECT id,(payload->>'workerId')::uuid worker_id,(payload->>'workerBootId')::uuid worker_boot_id,
              (payload->'message')::text message FROM transactional_outbox
            WHERE aggregate_id=:id AND event_type='worker.control' ORDER BY aggregate_version DESC LIMIT 1
            """)
        .param("id", fixture.session())
        .query(ControlOutboxRepository.Delivery.class)
        .single();
  }

  private ObjectNode acknowledgement(ControlOutboxRepository.Delivery delivery) {
    JsonNode message = json.read(delivery.message());
    ObjectNode result = JsonNodeFactory.instance.objectNode();
    result.put("type", "controlAck");
    result.put("schemaVersion", 1);
    for (String field :
        List.of(
            "requestId",
            "browserSessionId",
            "allocationEpoch",
            "controlEpoch",
            "pageEpoch",
            "privacyEpoch",
            "mode")) {
      result.set(field, message.path(field));
    }
    result.put("lastAcceptedInputSequence", 0);
    result.put("lastAppliedInputSequence", 0);
    return result;
  }

  private long count(Fixture fixture) {
    return jdbc.sql(
            "SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:id AND"
                + " event_type='worker.control'")
        .param("id", fixture.session())
        .query(Long.class)
        .single();
  }

  private void retry(UUID id) {
    jdbc.sql("UPDATE transactional_outbox SET retry_at=now() WHERE id=:id")
        .param("id", id)
        .update();
  }

  private String failure(UUID id) {
    return jdbc.sql("SELECT last_failure_code FROM transactional_outbox WHERE id=:id")
        .param("id", id)
        .query(String.class)
        .single();
  }
}
