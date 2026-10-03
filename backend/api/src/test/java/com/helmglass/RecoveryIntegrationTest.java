package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.helmglass.account.application.AccountCleanupService;
import com.helmglass.account.infrastructure.DeletionLedger;
import com.helmglass.account.infrastructure.repository.AccountCleanupRepository;
import com.helmglass.account.infrastructure.repository.AccountDataRepository;
import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.PageQuery;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.identity.infrastructure.KeycloakSessionClient;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.recovery.application.RecoveryAdmissionGuard;
import com.helmglass.recovery.application.RecoveryService;
import com.helmglass.recovery.domain.RecoveryProof;
import com.helmglass.recovery.infrastructure.repository.RecoveryRepository;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import liquibase.integration.spring.SpringLiquibase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.DependsOn;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/** PostgreSQL recovery and cleanup owners; remote providers are explicit state-machine doubles. */
@SpringJUnitConfig(RecoveryIntegrationTest.Owners.class)
class RecoveryIntegrationTest {
  static final PostgreSQLContainer DATABASE = new PostgreSQLContainer("postgres:18.3-bookworm");

  static {
    DATABASE.start();
  }

  @Configuration
  @EnableTransactionManagement
  @Import({
    RecoveryService.class,
    RecoveryRepository.class,
    AccountCleanupService.class,
    AccountCleanupRepository.class,
    AccountDataRepository.class,
    IdentityRepository.class,
    ConnectionRepository.class,
    BrowserStartupRepository.class,
    ChangeRepository.class,
    JsonSupport.class
  })
  static class Owners {
    @Bean
    DataSource dataSource() {
      return new DriverManagerDataSource(
          DATABASE.getJdbcUrl(), DATABASE.getUsername(), DATABASE.getPassword());
    }

    @Bean
    SpringLiquibase liquibase(DataSource dataSource) {
      var migrations = new SpringLiquibase();
      migrations.setDataSource(dataSource);
      migrations.setChangeLog("classpath:db/changelog/master.xml");
      return migrations;
    }

    @Bean
    @DependsOn("liquibase")
    JdbcClient jdbc(DataSource dataSource) {
      return JdbcClient.create(dataSource);
    }

    @Bean
    PlatformTransactionManager transactions(DataSource dataSource) {
      return new DataSourceTransactionManager(dataSource);
    }

    @Bean
    ObjectMapper mapper() {
      return JsonMapper.builder().build();
    }

    @Bean
    KeycloakSessionClient keycloak() {
      return mock(KeycloakSessionClient.class);
    }

    @Bean
    UserEphemeralState ephemeral() {
      return mock(UserEphemeralState.class);
    }

    @Bean
    DeletionLedger ledger() {
      return mock(DeletionLedger.class);
    }

    @Bean
    ObjectStorage storage() {
      return mock(ObjectStorage.class);
    }

    @Bean
    ProfileKeyService keys() {
      return mock(ProfileKeyService.class);
    }
  }

  @Autowired RecoveryService recovery;
  @Autowired RecoveryRepository repository;
  @Autowired IdentityRepository identities;
  @Autowired ConnectionRepository connections;
  @Autowired BrowserStartupRepository startups;
  @Autowired JdbcClient jdbc;
  @Autowired JsonSupport json;
  @Autowired DeletionLedger ledger;
  @Autowired ObjectStorage storage;
  @Autowired UserEphemeralState ephemeral;
  @Autowired KeycloakSessionClient keycloak;
  @Autowired ProfileKeyService keys;
  @Autowired PlatformTransactionManager transactions;
  @TempDir Path evidence;

  @BeforeEach
  void cleanFixture() {
    jdbc.sql("TRUNCATE application_users,recovery_runs,browser_workers,sites CASCADE").update();
    jdbc.sql("INSERT INTO platform_settings(singleton) VALUES(true)").update();
    reset(ledger, storage, ephemeral, keycloak, keys);
    when(ledger.list(null)).thenReturn(new ObjectStorage.ObjectPage(List.of(), null));
    when(ledger.record(any())).thenReturn("a".repeat(64));
    when(storage.purgeUserBatch(anyString(), any())).thenReturn(true);
    when(ephemeral.purgeBatch(any())).thenReturn(true);
  }

  @Test
  void missingEvidenceClosesAdmissionAndPreventsApplicationStartup() {
    assertThatThrownBy(() -> recovery.recover(evidence)).isInstanceOf(IOException.class);
    assertThat(repository.ready()).isFalse();
    assertThatThrownBy(() -> new RecoveryAdmissionGuard(repository).afterSingletonsInstantiated())
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void unfinishedCommandsAreUnknownEvenBeforePermitAndOldClaimsCannotResume() throws IOException {
    UUID user = user();
    UUID worker = UUID.randomUUID();
    UUID session = UUID.randomUUID();
    UUID task = task(user, "STARTING");
    UUID command = command(user, task, "DISPATCHED");
    UUID queued = command(user, task(user, "QUEUED"), "ACCEPTED");
    UUID humanOperation = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO operations(id,user_id,kind,target_type,target_id,request_id,state,human_checkpoint,
            input_accepted_sequence,input_applied_sequence)
            VALUES(:id,:user,'control.acquire','browserSession',:session,:id,'SUCCEEDED','OPEN',10,10)
            """)
        .param("id", humanOperation)
        .param("user", user)
        .param("session", session)
        .update();
    jdbc.sql(
            "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                + " VALUES(:id,:boot,1,'fixture')")
        .param("id", worker)
        .param("boot", UUID.randomUUID())
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,worker_id,purpose,state,idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:task,:worker,'TASK','STARTING',now()+interval '1 hour',now()+interval '1 hour')
            """)
        .param("id", session)
        .param("user", user)
        .param("task", task)
        .param("worker", worker)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_allocations(id,session_id,user_id,worker_id,slot_index,allocation_epoch)
            VALUES(:id,:session,:user,:worker,0,1)
            """)
        .param("id", UUID.randomUUID())
        .param("session", session)
        .param("user", user)
        .param("worker", worker)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_control_leases(session_id,owner_id,state,controller_instance_id,desired_owner,expires_at)
            VALUES(:session,:user,'QUIESCED',:controller,'HUMAN',now()+interval '1 hour')
            """)
        .param("session", session)
        .param("user", user)
        .param("controller", UUID.randomUUID())
        .update();
    jdbc.sql(
            """
            INSERT INTO command_attempts(id,command_id,session_id,worker_id,attempt_no,assignment_epoch,control_epoch)
            VALUES(:id,:command,:session,:worker,1,1,1)
            """)
        .param("id", UUID.randomUUID())
        .param("command", command)
        .param("session", session)
        .param("worker", worker)
        .update();
    jdbc.sql(
            """
            INSERT INTO application_logins(id,user_id,issuer,sid,auth_time,admitted_access_epoch,expires_at)
            VALUES(:id,:user,'https://issuer.example','old',now(),1,now()+interval '1 hour')
            """)
        .param("id", UUID.randomUUID())
        .param("user", user)
        .update();
    UUID profileVersion = profile(user);
    jdbc.sql(
            """
            INSERT INTO browser_profile_startups(session_id,command_id,profile_version_id,state,navigation_id,
            attempt_id,action,action_digest,deadline,permit_id)
            VALUES(:session,:command,:profile,'STARTED',:navigation,:attempt,'{}',:hash,now()+interval '1 hour',:permit)
            """)
        .param("session", session)
        .param("command", command)
        .param("profile", profileVersion)
        .param("navigation", UUID.randomUUID())
        .param("attempt", UUID.randomUUID())
        .param("hash", "a".repeat(64))
        .param("permit", UUID.randomUUID())
        .update();
    proof(List.of());
    recovery.recover(evidence);
    assertThat(value("SELECT state FROM task_commands WHERE id=:id", command)).isEqualTo("UNKNOWN");
    assertThat(value("SELECT state FROM task_commands WHERE id=:id", queued)).isEqualTo("UNKNOWN");
    assertThat(value("SELECT state FROM operations WHERE id=:id", humanOperation))
        .isEqualTo("NEEDS_ATTENTION");
    assertThat(value("SELECT human_checkpoint FROM operations WHERE id=:id", humanOperation))
        .isEqualTo("UNKNOWN");
    assertThat(value("SELECT state FROM browser_profile_startups WHERE session_id=:id", session))
        .isEqualTo("UNKNOWN");
    jdbc.sql("UPDATE browser_profile_startups SET deadline=now()-interval '1 second'").update();
    assertThat(startups.expired()).isEmpty();
    new TransactionTemplate(transactions)
        .executeWithoutResult(status -> startups.failed(session, null));
    assertThat(value("SELECT state FROM browser_profile_startups WHERE session_id=:id", session))
        .isEqualTo("UNKNOWN");
    assertThat(jdbc.sql("SELECT effect_state FROM command_attempts").query(String.class).single())
        .isEqualTo("UNKNOWN");
    assertThat(value("SELECT state FROM tasks WHERE id=:id", task)).isEqualTo("INTERRUPTED");
    assertThat(value("SELECT state FROM browser_sessions WHERE id=:id", session))
        .isEqualTo("CLOSED");
    assertThat(jdbc.sql("SELECT state FROM browser_allocations").query(String.class).single())
        .isEqualTo("RELEASED");
    assertThat(
            jdbc.sql(
                    "SELECT controller_instance_id IS NULL AND desired_owner IS NULL AND epoch=2"
                        + " FROM browser_control_leases")
                .query(Boolean.class)
                .single())
        .isTrue();
    assertThat(jdbc.sql("SELECT state FROM application_logins").query(String.class).single())
        .isEqualTo("REVOKED");
    assertThat(recovery.status(evidence).state()).isEqualTo("READY");
    assertThat(repository.ready()).isTrue();
    assertThatThrownBy(() -> recovery.recover(evidence))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("already completed");
    assertThat(repository.ready()).isTrue();
  }

  @Test
  void restoredExplicitOpenQueueIsFencedWithoutInventingAPhysicalAllocation() throws IOException {
    UUID user = user();
    UUID task = task(user, "PAUSED");
    UUID session = UUID.randomUUID();
    UUID operation = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO operations(id,user_id,kind,target_type,target_id,request_id,state)
            VALUES(:id,:user,'browser.open','browserSession',:session,:id,'PENDING')
            """)
        .param("id", operation)
        .param("user", user)
        .param("session", session)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,purpose,state,idle_deadline_at,budget_deadline_at,
            open_operation_id,open_request_deadline,open_instruction_revision,open_next_attempt_at)
            VALUES(:id,:user,:task,'TASK','REQUESTED',now()+interval '2 minutes',now()+interval '2 minutes',
            :operation,now()+interval '2 minutes',1,now())
            """)
        .param("id", session)
        .param("user", user)
        .param("task", task)
        .param("operation", operation)
        .update();
    proof(List.of());
    recovery.recover(evidence);
    assertThat(value("SELECT state FROM browser_sessions WHERE id=:id", session))
        .isEqualTo("CLOSED");
    assertThat(value("SELECT state FROM operations WHERE id=:id", operation))
        .isEqualTo("NEEDS_ATTENTION");
    assertThat(value("SELECT state FROM tasks WHERE id=:id", task)).isEqualTo("INTERRUPTED");
    assertThat(
            jdbc.sql("SELECT binding_released_at IS NOT NULL FROM browser_sessions WHERE id=:id")
                .param("id", session)
                .query(Boolean.class)
                .single())
        .isTrue();
    assertThat(jdbc.sql("SELECT count(*) FROM browser_allocations").query(Long.class).single())
        .isZero();
  }

  @Test
  void independentDeletionPreventsResurrectionAndKeepsImmutableOriginalTime() throws IOException {
    UUID user = user();
    task(user, "DRAFT");
    String hash = value("SELECT identity_hash FROM application_users WHERE id=:id", user);
    var entry =
        new DeletionLedger.Entry(1, UUID.randomUUID(), user, hash, Instant.now().minusSeconds(60));
    String key = DeletionLedger.PREFIX + hash + "/" + entry.requestId() + ".json";
    String checksum = JsonSupport.sha256(json.write(entry));
    when(ledger.restoreIndependent(key, checksum)).thenReturn(entry);
    when(ledger.list(null)).thenReturn(new ObjectStorage.ObjectPage(List.of(key), null));
    proof(List.of(new RecoveryProof.LedgerObject(key, checksum)));
    recovery.recover(evidence);
    assertThat(value("SELECT state FROM application_users WHERE id=:id", user))
        .isEqualTo("DELETED");
    assertThat(jdbc.sql("SELECT count(*) FROM tasks").query(Long.class).single()).isZero();
    assertThat(
            jdbc.sql("SELECT status FROM account_deletion_requests").query(String.class).single())
        .isEqualTo("PURGED");
    assertThat(recovery.status(evidence).state()).isEqualTo("READY");
    verify(ledger).restoreIndependent(key, checksum);
    verify(keys, times(2)).destroy(user);
  }

  @Test
  void checksumAndRedisRecoveryBindingFailuresNeverOpenAdmission() throws IOException {
    proof(List.of());
    Files.writeString(evidence.resolve("deletion-ledger.json"), "{}");
    assertThatThrownBy(() -> recovery.recover(evidence)).isInstanceOf(RuntimeException.class);
    assertThat(repository.ready()).isFalse();
    proof(List.of());
    Files.writeString(evidence.resolve("redis.json"), "{}");
    assertThatThrownBy(() -> recovery.recover(evidence)).isInstanceOf(RuntimeException.class);
    assertThat(repository.ready()).isFalse();
  }

  @Test
  void restoredPurgeBeforeLedgerWriteRestartsAtTheIndependentLedgerBoundary() throws IOException {
    UUID user = user();
    UUID request = UUID.randomUUID();
    UUID operation = UUID.randomUUID();
    jdbc.sql("UPDATE application_users SET state='PURGING' WHERE id=:id")
        .param("id", user)
        .update();
    jdbc.sql(
            "INSERT INTO operations(id,kind,target_type,target_id,request_id,state)"
                + " VALUES(:id,'ACCOUNT_PURGE','deletionRequest',:request,:id,'RUNNING')")
        .param("id", operation)
        .param("request", request)
        .update();
    jdbc.sql(
            """
            INSERT INTO account_deletion_requests(id,user_id,previous_account_state,status,delete_requested_at,
            restore_until,purge_started_at,purge_operation_id)
            VALUES(:id,:user,'BLOCKED','PURGING',now()-interval '169 hours',now()-interval '1 hour',now()-interval '1 minute',:operation)
            """)
        .param("id", request)
        .param("user", user)
        .param("operation", operation)
        .update();
    proof(List.of());
    recovery.recover(evidence);
    assertThat(value("SELECT state FROM application_users WHERE id=:id", user))
        .isEqualTo("DELETED");
    assertThat(recovery.status(evidence).state()).isEqualTo("READY");
    verify(ledger).record(any());
  }

  @Test
  void connectionSiteFilterAndDeclaredSortsRemainServerOwned() {
    UUID user = user();
    UUID firstSite = site(user, "first.example");
    UUID secondSite = site(user, "second.example");
    UUID first = connection(user, firstSite, "Zebra", "2026-10-01T00:00:00Z");
    UUID second = connection(user, secondSite, "Alpha", "2026-10-02T00:00:00Z");
    var query = new LinkedMultiValueMap<String, String>();
    query.add("sort", "accountLabel");
    query.add("direction", "asc");
    assertThat(connections.list(user, PageQuery.from(query)).items())
        .extracting(row -> row.id())
        .containsExactly(second, first);
    query.set("sort", "lastSuccessfulLoginAt");
    assertThat(connections.list(user, PageQuery.from(query)).items())
        .extracting(row -> row.id())
        .containsExactly(first, second);
    query.add("siteId", firstSite.toString());
    assertThat(connections.list(user, PageQuery.from(query)).items())
        .extracting(row -> row.id())
        .containsExactly(first);
  }

  @Test
  void selectedSiteLabelsAreScopedAndExcludedBeforeSuggestionLimit() {
    UUID user = user();
    UUID other = user();
    UUID first = site(user, "one.example");
    UUID second = site(user, "two.example");
    UUID foreign = site(other, "private.example");
    assertThat(connections.selectedSites(user, "tasks", List.of(second, foreign)))
        .extracting(row -> row.get("id"))
        .containsExactly(second);
    assertThat(connections.suggestions(user, "tasks", "", 1, List.of(first)))
        .extracting(row -> row.get("id"))
        .containsExactly(second);
    assertThat(connections.selectedSites(user, "connections", List.of(second))).isEmpty();
  }

  @Test
  void sameSecondAuthenticationDoesNotBypassRevocationButLaterFreshLoginIsAdmitted() {
    UUID user = user();
    Instant second = Instant.now().truncatedTo(ChronoUnit.SECONDS);
    Instant barrier = second.plusMillis(100);
    jdbc.sql("UPDATE application_users SET reauthentication_after=:time WHERE id=:id")
        .param("id", user)
        .param("time", Timestamp.from(barrier))
        .update();
    var account =
        new IdentityRepository.Account(
            user, "Fixture", "fixture@example.com", "ACTIVE", 1, 1, barrier);
    var transaction = new TransactionTemplate(transactions);
    assertThatThrownBy(
            () ->
                transaction.execute(
                    status ->
                        identities.admitLogin(
                            account,
                            "https://issuer.example",
                            "same-second",
                            second,
                            second.plusSeconds(3600))))
        .isInstanceOf(DomainException.class)
        .hasMessage("A fresh login is required");
    UUID login =
        transaction.execute(
            status ->
                identities.admitLogin(
                    account,
                    "https://issuer.example",
                    "next-second",
                    second.plusSeconds(1),
                    second.plusSeconds(3600)));
    assertThat(login).isNotNull();
  }

  private void proof(List<RecoveryProof.LedgerObject> entries) throws IOException {
    UUID id = UUID.randomUUID();
    Instant now = Instant.now();
    String container = "c".repeat(64);
    var fencing =
        new RecoveryProof.RuntimeFencing(
            "fixture-daemon",
            now.minusSeconds(1),
            List.of(container),
            List.of(new RecoveryProof.Container(container, "api", "exited")));
    var manifest =
        new RecoveryProof.Manifest(
            1, id, "backup-fixture", "2026-10-03T00:00Z", now, "independent-current", entries);
    var redis =
        new RecoveryProof.RedisReplacement(
            1, id, "fixture-daemon", "helm-glass-redis-recovery-" + id, "new-empty-volume", now);
    String fencingJson = json.write(fencing);
    String manifestJson = json.write(manifest);
    String redisJson = json.write(redis);
    var proof =
        new RecoveryProof(
            1,
            id,
            manifest.backupId(),
            manifest.restorePoint(),
            "none",
            true,
            fencing,
            JsonSupport.sha256(fencingJson),
            true,
            JsonSupport.sha256(redisJson),
            JsonSupport.sha256(manifestJson));
    Files.writeString(evidence.resolve("proof.json"), json.write(proof));
    Files.writeString(evidence.resolve("fencing.json"), fencingJson);
    Files.writeString(evidence.resolve("deletion-ledger.json"), manifestJson);
    Files.writeString(evidence.resolve("redis.json"), redisJson);
  }

  private UUID user() {
    return new TransactionTemplate(transactions)
        .execute(
            status ->
                identities
                    .resolve(
                        "https://issuer.example",
                        UUID.randomUUID().toString(),
                        "Fixture",
                        "fixture@example.com")
                    .id());
  }

  private UUID task(UUID user, String state) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            "INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)"
                + " VALUES(:id,:user,'Read','Read','TEXT','ANGULAR',:state)")
        .param("id", id)
        .param("user", user)
        .param("state", state)
        .update();
    return id;
  }

  private UUID command(UUID user, UUID task, String state) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO task_commands(id,user_id,task_id,command_sequence,kind,payload,payload_hash,accepted_task_version,instruction_revision,deadline,state)
            VALUES(:id,:user,:task,1,'SNAPSHOT','{}',:hash,1,1,now()+interval '1 hour',:state)
            """)
        .param("id", id)
        .param("user", user)
        .param("task", task)
        .param("hash", "a".repeat(64))
        .param("state", state)
        .update();
    return id;
  }

  private UUID site(UUID user, String host) {
    UUID id = UUID.randomUUID();
    jdbc.sql("INSERT INTO sites(id,normalized_host,display_name) VALUES(:id,:host,:host)")
        .param("id", id)
        .param("host", host)
        .update();
    jdbc.sql("INSERT INTO user_sites(user_id,site_id,scope) VALUES(:user,:site,'tasks')")
        .param("user", user)
        .param("site", id)
        .update();
    return id;
  }

  private UUID connection(UUID user, UUID site, String label, String lastLogin) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO connections(id,user_id,site_id,display_name,start_url,origin,account_label,last_successful_login_at)
            VALUES(:id,:user,:site,'Fixture','https://example.com','https://example.com',:label,:login)
            """)
        .param("id", id)
        .param("user", user)
        .param("site", site)
        .param("label", label)
        .param("login", Timestamp.from(Instant.parse(lastLogin)))
        .update();
    return id;
  }

  private UUID profile(UUID user) {
    UUID connection =
        connection(user, site(user, "profile.example"), "Profile", "2026-10-01T00:00:00Z");
    UUID profile = UUID.randomUUID();
    UUID version = UUID.randomUUID();
    jdbc.sql("INSERT INTO browser_profiles(id,user_id,connection_id) VALUES(:id,:user,:connection)")
        .param("id", profile)
        .param("user", user)
        .param("connection", connection)
        .update();
    jdbc.sql(
            """
            INSERT INTO browser_profile_versions(id,profile_id,revision,object_key,checksum,wrapped_dek,vault_key_ref,
            runtime_version,origins_manifest,state,size)
            VALUES(:id,:profile,1,:key,:hash,'wrapped','key','fixture','{}','READY',42)
            """)
        .param("id", version)
        .param("profile", profile)
        .param("key", version.toString())
        .param("hash", "a".repeat(64))
        .update();
    return version;
  }

  private String value(String sql, UUID id) {
    return jdbc.sql(sql).param("id", id).query(String.class).single();
  }
}
