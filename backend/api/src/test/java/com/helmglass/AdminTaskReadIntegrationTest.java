package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.administration.application.AdministrationService;
import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.PageQuery;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import java.util.HashSet;
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
class AdminTaskReadIntegrationTest {
  private final AdministrationService administration;
  private final IdentityRepository identities;
  private final ChangeRepository changes;
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final TransactionTemplate transaction;

  @Autowired
  AdminTaskReadIntegrationTest(
      AdministrationService administration,
      IdentityRepository identities,
      ChangeRepository changes,
      JdbcClient jdbc,
      JsonSupport json,
      PlatformTransactionManager transactions) {
    this.administration = administration;
    this.identities = identities;
    this.changes = changes;
    this.jdbc = jdbc;
    this.json = json;
    transaction = new TransactionTemplate(transactions);
  }

  @Test
  void safeTaskPagesUseLatestFiftyAndNeverExposeTaskContent() {
    var admin = actor(true);
    var user = actor(false);
    jdbc.sql(
            """
            INSERT INTO tasks(id,user_id,goal,title,start_url,output_format,origin,state,created_at)
            SELECT gen_random_uuid(),:user,'private-goal','private-title','https://private.example',
              'TEXT','ANGULAR','PAUSED',now()-n*interval '1 second' FROM generate_series(1,60) n
            """)
        .param("user", user.userId())
        .update();
    UUID newest =
        jdbc.sql("SELECT id FROM tasks WHERE user_id=:user ORDER BY created_at DESC LIMIT 1")
            .param("user", user.userId())
            .query(UUID.class)
            .single();
    UUID session = UUID.randomUUID();
    UUID worker = UUID.randomUUID();
    jdbc.sql(
            "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                + " VALUES(:id,:boot,1,'fixture')")
        .param("id", worker)
        .param("boot", UUID.randomUUID())
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_id,purpose,state,idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:task,:worker,'TASK','ACTIVE',now()+interval '1 hour',now()+interval '1 hour')
            """)
        .param("id", session)
        .param("user", user.userId())
        .param("task", newest)
        .param("worker", worker)
        .update();
    var query = new LinkedMultiValueMap<String, String>();
    query.set("pageSize", "20");
    var first = administration.tasks(admin, user.userId(), PageQuery.from(query));
    assertThat(first.total()).isEqualTo(50);
    assertThat(first.items()).hasSize(20);
    var row = first.items().getFirst();
    assertThat(row)
        .containsOnlyKeys(
            "id",
            "state",
            "waitReason",
            "failureCode",
            "createdAt",
            "browserSessionId",
            "workerId");
    assertThat(row)
        .containsEntry("id", newest)
        .containsEntry("browserSessionId", session)
        .containsEntry("workerId", worker);
    assertThat(json.write(first))
        .doesNotContain("private-goal", "private-title", "private.example");
    Set<Object> ids = new HashSet<>();
    first.items().forEach(item -> ids.add(item.get("id")));
    query.set("snapshot", first.snapshot());
    for (int page = 2; page <= 3; page++) {
      query.set("page", Integer.toString(page));
      var result = administration.tasks(admin, user.userId(), PageQuery.from(query));
      assertThat(result.items()).hasSize(page == 2 ? 20 : 10);
      result.items().forEach(item -> assertThat(ids.add(item.get("id"))).isTrue());
    }
    assertThat(ids).hasSize(50);
    query.clear();
    query.set("q", "private-goal");
    assertThat(administration.tasks(admin, user.userId(), PageQuery.from(query)).total()).isZero();
    query.clear();
    query.set("q", newest.toString());
    assertThat(administration.tasks(admin, user.userId(), PageQuery.from(query)).total())
        .isEqualTo(1);
    query.clear();
    query.set("state[]", "FAILED");
    assertThat(administration.tasks(admin, user.userId(), PageQuery.from(query)).total()).isZero();
  }

  @Test
  void taskSnapshotsBindAdministratorTargetAndFiltersAndExpireAfterChange() {
    var admin = actor(true);
    var otherAdmin = actor(true);
    var user = actor(false);
    var otherUser = actor(false);
    var query = new LinkedMultiValueMap<String, String>();
    var first = administration.tasks(admin, user.userId(), PageQuery.from(query));
    query.set("snapshot", first.snapshot());
    assertThatThrownBy(() -> administration.tasks(otherAdmin, user.userId(), PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Refresh");
    assertThatThrownBy(() -> administration.tasks(admin, otherUser.userId(), PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Refresh");
    assertThatThrownBy(() -> administration.tasks(user, user.userId(), PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Administrator");
    transaction.executeWithoutResult(
        status -> changes.changed(user.userId(), "tasks", UUID.randomUUID(), 1));
    assertThatThrownBy(() -> administration.tasks(admin, user.userId(), PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Refresh");
    query.clear();
    query.set("sort", "title");
    query.set("direction", "asc");
    assertThatThrownBy(() -> administration.tasks(admin, user.userId(), PageQuery.from(query)))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("Unsupported");
    query.clear();
    assertThatThrownBy(() -> administration.tasks(admin, UUID.randomUUID(), PageQuery.from(query)))
        .isInstanceOf(DomainException.class);
  }

  private AuthenticatedActor actor(boolean admin) {
    var account =
        transaction.execute(
            status ->
                identities.resolve(
                    "https://issuer.example",
                    UUID.randomUUID().toString(),
                    "Admin task fixture",
                    "fixture@example.test"));
    Objects.requireNonNull(account);
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
