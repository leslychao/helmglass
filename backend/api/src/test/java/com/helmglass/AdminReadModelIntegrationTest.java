package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.administration.api.AdminContracts.BrowserQuery;
import com.helmglass.administration.application.AdministrationService;
import com.helmglass.administration.infrastructure.repository.AdministrationRepository;
import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.PageQuery;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.domain.MutationReceipt.ResourceReference;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;

@SpringJUnitConfig(CoreOwnersIntegrationTest.Owners.class)
class AdminReadModelIntegrationTest {
  private final AdministrationService administration;
  private final AdministrationRepository repository;
  private final IdentityRepository identities;
  private final ChangeRepository changes;
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final TransactionTemplate transaction;

  @Autowired
  AdminReadModelIntegrationTest(
      AdministrationService administration,
      AdministrationRepository repository,
      IdentityRepository identities,
      ChangeRepository changes,
      JdbcClient jdbc,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.administration = administration;
    this.repository = repository;
    this.identities = identities;
    this.changes = changes;
    this.jdbc = jdbc;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void overviewAndUserFiltersUseAllMatchingRowsAndRejectUnauthorizedReads() {
    var admin = actor(true, "Administrator");
    long initial = ((Number) administration.overview(admin).get("totalUsers")).longValue();
    String group = UUID.randomUUID().toString();
    var waiting = actor(false, group + " waiting");
    var deleted = actor(false, group + " deleted");
    jdbc.sql("UPDATE application_users SET state='DELETED' WHERE id=:id")
        .param("id", deleted.userId())
        .update();
    task(waiting.userId(), "WAITING_USER");
    task(waiting.userId(), "DRAFT");
    audit(admin, waiting.userId(), "STOP_ALL_REQUESTED", Map.of(), Map.of());
    assertThat(((Number) administration.overview(admin).get("totalUsers")).longValue())
        .isEqualTo(initial + 1);

    var query = new LinkedMultiValueMap<String, String>();
    query.set("q", group);
    query.set("pending", "true");
    query.set("waiting", "true");
    query.set("sort", "queuedTasks");
    query.set("direction", "desc");
    var result = administration.users(admin, PageQuery.from(query));
    assertThat(result.total()).isEqualTo(1);
    assertThat(result.items().getFirst())
        .containsEntry("id", waiting.userId())
        .containsEntry("queuedTasks", 1L)
        .containsEntry("pendingOperations", 1L);
    query.set("accountState", "DELETED");
    assertThat(administration.users(admin, PageQuery.from(query)).total()).isZero();
    query.remove("accountState");
    query.set("pending", "yes");
    assertThatThrownBy(() -> administration.users(admin, PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("boolean");
    assertThatThrownBy(() -> administration.overview(waiting))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Administrator");
    assertThatThrownBy(
            () -> administration.browsers(waiting, BrowserQuery.from(new LinkedMultiValueMap<>())))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Administrator");
  }

  @Test
  void auditFiltersTargetNameAndActionAndReturnsOnlySafeChangedValues() {
    var admin = actor(true, "Administrator");
    var user = actor(false, "Audit " + UUID.randomUUID());
    audit(
        admin,
        user.userId(),
        "LIMITS_CHANGED",
        Map.of("browserMode", "CUSTOM", "browserCustom", 2, "privateGoal", "never-expose"),
        Map.of("browserMode", "CUSTOM", "browserCustom", 3, "email", "private@example.test"));
    var query = new LinkedMultiValueMap<String, String>();
    query.set("q", user.displayName());
    query.set("action", "LIMITS_CHANGED");
    query.set("sort", "targetName");
    query.set("direction", "asc");
    var result = administration.audit(admin, null, PageQuery.from(query));
    assertThat(result.total()).isEqualTo(1);
    var row = result.items().getFirst();
    assertThat(row)
        .containsEntry("targetName", user.displayName())
        .containsEntry("operationState", "RUNNING");
    assertThat(json.tree(row.get("previousValue")).path("browserCustom").asInt()).isEqualTo(2);
    assertThat(json.tree(row.get("newValue")).path("browserCustom").asInt()).isEqualTo(3);
    assertThat(json.write(result))
        .doesNotContain("never-expose", "privateGoal", "private@example.test");
    query.set("action", "ACCOUNT_BLOCKED");
    assertThat(administration.audit(admin, null, PageQuery.from(query)).total()).isZero();
    assertThatThrownBy(() -> administration.audit(user, null, PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Administrator");
  }

  @Test
  void offlineOccupancyStaysUnknownAndDoesNotConsumeAnotherWorkersFreeSlot() {
    var admin = actor(true, "Administrator");
    var user = actor(false, "Browser fixture");
    UUID offline = worker("ENABLED", true);
    UUID ready = worker("ENABLED", false);
    UUID draining = worker("DRAINING", false);
    UUID task = task(user.userId(), "RUNNING");
    UUID waiting = task(user.userId(), "QUEUED");
    UUID session = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_id,purpose,state,idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:task,:worker,'TASK','ACTIVE',now()+interval '1 hour',now()+interval '1 hour')
            """)
        .param("id", session)
        .param("user", user.userId())
        .param("task", task)
        .param("worker", offline)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_allocations(id,session_id,user_id,worker_id,slot_index,allocation_epoch,state)
            VALUES(:id,:session,:user,:worker,0,1,'QUARANTINED')
            """)
        .param("id", UUID.randomUUID())
        .param("session", session)
        .param("user", user.userId())
        .param("worker", offline)
        .update();
    var query = new LinkedMultiValueMap<String, String>();
    query.set("workers.q", offline.toString());
    query.set("workers.state", "OFFLINE");
    query.set("queue.q", waiting.toString());
    var pool = json.tree(administration.browsers(admin, BrowserQuery.from(query)));
    assertThat(pool.path("workers").path("total").asLong()).isEqualTo(1);
    var node = pool.path("workers").path("items").get(0);
    assertThat(node.path("occupied").isNull()).isTrue();
    assertThat(node.path("free").isNull()).isTrue();
    assertThat(node.path("lastKnownOccupied").asLong()).isEqualTo(1);
    assertThat(json.write(pool.path("queue").path("items")))
        .contains(waiting.toString())
        .doesNotContain(task.toString());
    assertThat(json.write(pool)).doesNotContain("private-goal", "private-title", "private.example");
    query.set("workers.q", ready.toString());
    query.set("workers.state", "READY");
    node =
        json.tree(administration.browsers(admin, BrowserQuery.from(query)))
            .path("workers")
            .path("items")
            .get(0);
    assertThat(node.path("free").asInt()).isEqualTo(1);
    query.set("workers.q", draining.toString());
    query.set("workers.state", "DRAINING");
    node =
        json.tree(administration.browsers(admin, BrowserQuery.from(query)))
            .path("workers")
            .path("items")
            .get(0);
    assertThat(node.path("free").asInt()).isZero();
  }

  @Test
  void poolPagesAreIndependentAndOnlyFreshExactBootBindingsCountAsConfirmed() {
    transaction.executeWithoutResult(
        status -> {
          var admin = actor(true, "Administrator");
          var user = actor(false, "Paged pool " + UUID.randomUUID());
          var baseline = administration.overview(admin);
          long confirmed = ((Number) baseline.get("confirmedBusy")).longValue();
          long uncertain = ((Number) baseline.get("unconfirmedOccupied")).longValue();
          long unavailable = ((Number) baseline.get("unavailableWorkers")).longValue();
          UUID firstWorker = allocatedBrowser(user.userId());
          UUID secondWorker = allocatedBrowser(user.userId());
          task(user.userId(), "QUEUED");
          task(user.userId(), "QUEUED");
          assertThat(administration.overview(admin).get("confirmedBusy")).isEqualTo(confirmed + 2);
          jdbc.sql("UPDATE browser_sessions SET state='STOPPING' WHERE worker_id=:id")
              .param("id", firstWorker)
              .update();
          assertThat(administration.overview(admin).get("confirmedBusy")).isEqualTo(confirmed + 2);

          var query = new LinkedMultiValueMap<String, String>();
          query.set("workers.pageSize", "1");
          query.set("workers.sort", "id");
          query.set("workers.direction", "asc");
          query.set("allocations.q", user.displayName());
          query.set("allocations.pageSize", "1");
          query.set("allocations.sort", "sessionId");
          query.set("allocations.direction", "asc");
          query.set("queue.q", user.displayName());
          query.set("queue.pageSize", "1");
          query.set("queue.sort", "taskId");
          query.set("queue.direction", "asc");
          var first = json.tree(administration.browsers(admin, BrowserQuery.from(query)));
          assertThat(first.path("allocations").path("total").asInt()).isEqualTo(2);
          assertThat(first.path("queue").path("total").asInt()).isEqualTo(2);
          for (String section : List.of("workers", "allocations", "queue")) {
            assertThat(first.path(section).path("items").size()).isEqualTo(1);
            query.set(section + ".snapshot", first.path(section).path("snapshot").asString());
          }
          query.set("queue.page", "2");
          var second = json.tree(administration.browsers(admin, BrowserQuery.from(query)));
          assertThat(second.path("queue").path("items"))
              .isNotEqualTo(first.path("queue").path("items"));
          assertThat(second.path("allocations").path("items"))
              .isEqualTo(first.path("allocations").path("items"));
          assertThat(second.path("workers").path("items"))
              .isEqualTo(first.path("workers").path("items"));
          query.set("allocations.page", "2");
          var third = json.tree(administration.browsers(admin, BrowserQuery.from(query)));
          assertThat(third.path("allocations").path("items"))
              .isNotEqualTo(first.path("allocations").path("items"));
          assertThat(third.path("queue").path("items"))
              .isEqualTo(second.path("queue").path("items"));

          jdbc.sql("UPDATE browser_workers SET heartbeat_at=now()-interval '1 minute' WHERE id=:id")
              .param("id", firstWorker)
              .update();
          jdbc.sql("UPDATE browser_workers SET boot_id=:boot WHERE id=:id")
              .param("id", secondWorker)
              .param("boot", UUID.randomUUID())
              .update();
          var stale = administration.overview(admin);
          assertThat(stale.get("confirmedBusy")).isEqualTo(confirmed);
          assertThat(stale.get("unconfirmedOccupied")).isEqualTo(uncertain + 2);
          assertThat(stale.get("unavailableWorkers")).isEqualTo(unavailable + 1);
          jdbc.sql(
                  "UPDATE browser_workers SET heartbeat_at=now(),observed_state='OFFLINE' WHERE"
                      + " id=:id")
              .param("id", firstWorker)
              .update();
          assertThat(administration.overview(admin).get("unavailableWorkers"))
              .isEqualTo(unavailable + 1);
          var rows =
              json.tree(administration.browsers(admin, BrowserQuery.from(query)))
                  .path("allocations")
                  .path("items");
          assertThat(rows.get(0).path("sessionState").asString()).isEqualTo("UNKNOWN");
          query.set("workers.q", secondWorker.toString());
          query.remove("workers.snapshot");
          var rebound =
              json.tree(administration.browsers(admin, BrowserQuery.from(query)))
                  .path("workers")
                  .path("items")
                  .get(0);
          assertThat(rebound.path("state").asString()).isEqualTo("READY");
          assertThat(rebound.path("occupied").isNull()).isTrue();
          assertThat(rebound.path("free").isNull()).isTrue();
        });
  }

  private UUID allocatedBrowser(UUID userId) {
    UUID worker = worker("ENABLED", false);
    UUID task = task(userId, "RUNNING");
    UUID session = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_id,worker_boot_id,purpose,state,idle_deadline_at,budget_deadline_at)
            SELECT :id,:user,:task,id,boot_id,'TASK','ACTIVE',now()+interval '1 hour',now()+interval '1 hour'
            FROM browser_workers WHERE id=:worker
            """)
        .param("id", session)
        .param("user", userId)
        .param("task", task)
        .param("worker", worker)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_allocations(id,session_id,user_id,worker_id,slot_index,allocation_epoch,state)
            VALUES(:id,:session,:user,:worker,0,1,'ASSIGNED')
            """)
        .param("id", UUID.randomUUID())
        .param("session", session)
        .param("user", userId)
        .param("worker", worker)
        .update();
    return worker;
  }

  @Test
  void taskAndOperationCommitsInvalidateAdministrativeViewsWithoutPublishingContent() {
    var user = actor(false, "Event fixture");
    UUID task = UUID.randomUUID();
    String snapshot =
        repository.users(user.userId(), PageQuery.from(new LinkedMultiValueMap<>())).snapshot();
    transaction.executeWithoutResult(status -> changes.changed(user.userId(), "tasks", task, 1));
    var payload =
        jdbc.sql(
                "SELECT payload::text FROM transactional_outbox WHERE aggregate_id=:id AND"
                    + " event_type='tasks'")
            .param("id", task)
            .query(String.class)
            .single();
    assertThat(json.read(payload).path("resources").toString())
        .contains("users", "userTasks", "userDays");
    var query = new LinkedMultiValueMap<String, String>();
    query.set("snapshot", snapshot);
    assertThatThrownBy(() -> repository.users(user.userId(), PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Refresh");
    UUID operation = UUID.randomUUID();
    transaction.executeWithoutResult(
        status -> changes.changed(user.userId(), "operations", operation, 1));
    String operationPayload =
        jdbc.sql(
                "SELECT payload::text FROM transactional_outbox WHERE aggregate_id=:id AND"
                    + " event_type='operations'")
            .param("id", operation)
            .query(String.class)
            .single();
    assertThat(operationPayload).contains("users", "audit").doesNotContain("goal", "payload_hash");
  }

  private void audit(
      AuthenticatedActor admin, UUID target, String action, Object before, Object after) {
    UUID operation = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO operations(id,user_id,kind,target_type,target_id,state,request_id)
            VALUES(:id,:user,'admin.fixture','user',:target,'RUNNING',:id)
            """)
        .param("id", operation)
        .param("user", admin.userId())
        .param("target", target)
        .update();
    transaction.executeWithoutResult(
        status ->
            repository.audit(
                admin,
                target,
                "user",
                action,
                "Fixture reason",
                before,
                after,
                new MutationReceipt(
                    operation,
                    new ResourceReference("user", target, 1),
                    "/api/v1/operations/" + operation,
                    UUID.randomUUID())));
  }

  private UUID task(UUID user, String state) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO tasks(id,user_id,goal,title,start_url,output_format,origin,state)
            VALUES(:id,:user,'private-goal','private-title','https://private.example','TEXT','ANGULAR',:state)
            """)
        .param("id", id)
        .param("user", user)
        .param("state", state)
        .update();
    return id;
  }

  private UUID worker(String mode, boolean stale) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO browser_workers(id,boot_id,capacity,image_version,observed_state,desired_mode,heartbeat_at)
            VALUES(:id,:boot,1,'fixture','READY',:mode,now()-CASE WHEN :stale THEN interval '1 minute' ELSE interval '0 seconds' END)
            """)
        .param("id", id)
        .param("boot", UUID.randomUUID())
        .param("mode", mode)
        .param("stale", stale)
        .update();
    return id;
  }

  private AuthenticatedActor actor(boolean admin, String name) {
    var account =
        Objects.requireNonNull(
            transaction.execute(
                status ->
                    identities.resolve(
                        "https://issuer.example",
                        UUID.randomUUID().toString(),
                        name,
                        "fixture@example.test")));
    return new AuthenticatedActor(
        account.id(),
        UUID.randomUUID(),
        null,
        "helm-web",
        account.displayName(),
        account.email(),
        account.accessEpoch(),
        admin ? Set.of("platform_admin") : Set.of(),
        false);
  }
}
