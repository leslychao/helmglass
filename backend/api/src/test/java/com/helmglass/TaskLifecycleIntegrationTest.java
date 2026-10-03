package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.browser.infrastructure.repository.BrowserCloseOutboxRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.identity.infrastructure.repository.PolicyRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.realtime.infrastructure.repository.ChatPresentationRepository;
import com.helmglass.realtime.infrastructure.repository.OutboxRepository;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.ReconciliationService;
import com.helmglass.task.application.TaskLifecycleService;
import com.helmglass.task.domain.TaskAggregate;
import com.helmglass.task.infrastructure.repository.JpaTaskRepository;
import com.helmglass.task.infrastructure.repository.ReconciliationRepository;
import com.helmglass.task.infrastructure.repository.TaskQueries;
import com.helmglass.usage.application.UsageProjectionService;
import com.helmglass.usage.infrastructure.repository.UsageRepository;
import jakarta.persistence.EntityManagerFactory;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import liquibase.integration.spring.SpringLiquibase;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.DependsOn;
import org.springframework.context.annotation.Import;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

@SpringJUnitConfig(TaskLifecycleIntegrationTest.DatabaseConfiguration.class)
class TaskLifecycleIntegrationTest {
  static final PostgreSQLContainer DATABASE = new PostgreSQLContainer("postgres:18.3-bookworm");

  static {
    DATABASE.start();
  }

  @Configuration
  @EnableTransactionManagement(proxyTargetClass = true)
  @EnableJpaRepositories(basePackageClasses = JpaTaskRepository.class)
  @Import({
    TaskLifecycleService.class,
    TaskQueries.class,
    IdentityRepository.class,
    OperationRepository.class,
    ChangeRepository.class,
    JsonSupport.class,
    TaskContinuationService.class,
    RealtimeDeliveryService.class,
    ChatPresentationRepository.class,
    OutboxRepository.class,
    BrowserControlService.class,
    ConnectionRepository.class,
    LoginRepository.class,
    ContinuationRepository.class,
    CommandRepository.class,
    BrowserRepository.class,
    BrowserCloseOutboxRepository.class,
    ControlRepository.class,
    UserPolicyService.class,
    PolicyRepository.class,
    ReconciliationService.class,
    ReconciliationRepository.class,
    UsageProjectionService.class,
    UsageRepository.class
  })
  static class DatabaseConfiguration {
    @Bean
    ChannelTicketService tickets() {
      return mock(ChannelTicketService.class);
    }

    @Bean
    BrowserSessionService browserSessionService(
        BrowserRepository browsers,
        ControlRepository controls,
        IdentityRepository identities,
        ChannelTicketService tickets,
        LoginRepository logins,
        ChangeRepository changes) {
      return new BrowserSessionService(
          browsers, controls, identities, tickets, logins, changes, "https://helm.example");
    }

    @Bean
    DataSource dataSource() {
      return new DriverManagerDataSource(
          DATABASE.getJdbcUrl(), DATABASE.getUsername(), DATABASE.getPassword());
    }

    @Bean
    SpringLiquibase liquibase(DataSource dataSource) {
      SpringLiquibase liquibase = new SpringLiquibase();
      liquibase.setDataSource(dataSource);
      liquibase.setChangeLog("classpath:db/changelog/master.xml");
      return liquibase;
    }

    @Bean
    @DependsOn("liquibase")
    LocalContainerEntityManagerFactoryBean entityManagerFactory(DataSource dataSource) {
      var factory = new LocalContainerEntityManagerFactoryBean();
      factory.setDataSource(dataSource);
      factory.setPackagesToScan(TaskAggregate.class.getPackageName());
      factory.setJpaVendorAdapter(new HibernateJpaVendorAdapter());
      factory.setJpaPropertyMap(
          Map.of(
              "hibernate.hbm2ddl.auto",
              "validate",
              "hibernate.physical_naming_strategy",
              "org.hibernate.boot.model.naming.CamelCaseToUnderscoresNamingStrategy"));
      return factory;
    }

    @Bean
    PlatformTransactionManager transactionManager(EntityManagerFactory factory) {
      return new JpaTransactionManager(factory);
    }

    @Bean
    JdbcClient jdbcClient(DataSource dataSource) {
      return JdbcClient.create(dataSource);
    }

    @Bean
    ObjectMapper objectMapper() {
      return JsonMapper.builder().findAndAddModules().build();
    }
  }

  private final TaskLifecycleService tasks;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final TransactionTemplate transaction;
  private final JdbcClient jdbc;

  @Autowired
  TaskLifecycleIntegrationTest(
      TaskLifecycleService tasks,
      IdentityRepository identities,
      OperationRepository operations,
      JdbcClient jdbc,
      PlatformTransactionManager transactionManager) {
    this.tasks = tasks;
    this.identities = identities;
    this.operations = operations;
    this.jdbc = jdbc;
    transaction = new TransactionTemplate(transactionManager);
  }

  @Test
  void acceptedCreationSurvivesRetryAndDifferentIntentCannotReuseKey() {
    var actor = actor();
    var context = context();
    var input = create("Observe the public page", "PREPARE");
    var first = tasks.create(actor, input, context, null);
    var replay = tasks.create(actor, input, context, null);
    assertThat(replay).isEqualTo(first);
    assertThat(tasks.get(actor, first.resource().id()).state()).isEqualTo("WAITING_AGENT");
    assertThat(operations.lookup(actor, "tasks.create", context.key())).isEqualTo(first);
    assertThatThrownBy(
            () -> tasks.create(actor, create("Different intent", "PREPARE"), context, null))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("different request");
  }

  @Test
  void ownershipIsEnforcedEvenWhenCallerHasAdministratorRole() {
    var owner = actor();
    var task = tasks.create(owner, create("Private task", "DRAFT"), context(), null);
    var other = actor();
    var admin =
        new AuthenticatedActor(
            other.userId(),
            other.loginId(),
            null,
            other.clientId(),
            other.displayName(),
            other.email(),
            other.accessEpoch(),
            Set.of("platform_admin"),
            false);
    assertThatThrownBy(() -> tasks.get(admin, task.resource().id()))
        .isInstanceOf(DomainException.class)
        .hasMessage("Resource not found");
  }

  @ParameterizedTest
  @ValueSource(strings = {"NORMAL", "LOGIN_PRIVATE"})
  void currentSessionSummaryNeverExposesPrivateInputTimingToWebOrMcp(String privacy) {
    var web = actor();
    var created = tasks.create(web, create("Clock privacy", "PREPARE"), context(), null);
    UUID sessionId = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO browser_sessions(id,user_id,task_id,purpose,state,privacy,
              last_activity_at,idle_deadline_at,budget_deadline_at)
            VALUES(:id,:user,:task,'TASK','ACTIVE',:privacy,now(),
              now()+interval '10 minutes',now()+interval '30 minutes')
            """)
        .param("id", sessionId)
        .param("user", web.userId())
        .param("task", created.resource().id())
        .param("privacy", privacy)
        .update();
    var mcp =
        new AuthenticatedActor(
            web.userId(),
            null,
            UUID.randomUUID(),
            "helm-mcp",
            web.displayName(),
            web.email(),
            web.accessEpoch(),
            Set.of("tasks:read"),
            true);
    for (var caller : List.of(web, mcp)) {
      var current = tasks.get(caller, created.resource().id()).currentSession();
      assertThat(current).containsEntry("id", sessionId).containsEntry("privacy", privacy);
      assertThat(current.get("budgetDeadlineAt")).isNotNull();
      assertThat(current).doesNotContainKey("lastActivityAt");
      if (privacy.equals("LOGIN_PRIVATE")) {
        assertThat(current).containsEntry("idleDeadlineAt", null);
      } else {
        assertThat(current.get("idleDeadlineAt")).isNotNull();
      }
    }
  }

  @Test
  void clarificationPreservesTaskAndIncrementsIntentWithoutRestartingBrowser() {
    var actor = actor();
    var created = tasks.create(actor, create("Original goal", "PREPARE"), context(), null);
    var before = tasks.get(actor, created.resource().id());
    var request =
        new TaskContracts.Clarification(
            UUID.randomUUID(),
            "Also include dates",
            before.instructionRevision(),
            before.version());
    var mutation = context();
    var receipt = tasks.clarify(actor, before.id(), request, mutation);
    assertThat(tasks.clarify(actor, before.id(), request, mutation)).isEqualTo(receipt);
    var after = tasks.get(actor, before.id());
    assertThat(after.id()).isEqualTo(before.id());
    assertThat(after.goal()).isEqualTo("Original goal");
    assertThat(after.instructionRevision()).isEqualTo(before.instructionRevision() + 1);
    assertThat(after.state()).isEqualTo("WAITING_AGENT");
    assertThat(after.currentSession()).isNull();
  }

  @Test
  void staleListSnapshotCannotMixPagesAfterMutation() {
    var actor = actor();
    tasks.create(actor, create("First", "DRAFT"), context(), null);
    var parameters = new LinkedMultiValueMap<String, String>();
    var first = tasks.list(actor, PageQuery.from(parameters));
    tasks.create(actor, create("Second", "DRAFT"), context(), null);
    parameters.add("snapshot", first.snapshot());
    assertThatThrownBy(() -> tasks.list(actor, PageQuery.from(parameters)))
        .isInstanceOf(DomainException.class)
        .hasMessage("Refresh the current list");
  }

  @Test
  void pauseAndStopDoNotRequireAnUnrelatedProgressVersion() {
    var actor = actor();
    var created = tasks.create(actor, create("Pause safely", "PREPARE"), context(), null);
    tasks.pause(actor, created.resource().id(), context());
    assertThat(tasks.get(actor, created.resource().id()).state()).isEqualTo("PAUSED");
    tasks.stop(actor, created.resource().id(), context());
    assertThat(tasks.get(actor, created.resource().id()).state()).isEqualTo("CANCELLED");
  }

  @ParameterizedTest
  @ValueSource(strings = {"ACCEPTED", "WAITING_RESOURCE", "DISPATCHED"})
  void unavailableConnectionCancelsUnstartedWorkAndPublishesOneDurableTransition(String state) {
    var actor = actor();
    var created =
        tasks.create(actor, create("Keep collected findings", "PREPARE"), context(), null);
    UUID taskId = created.resource().id();
    UUID commandId = pendingCommand(actor, taskId, state);
    UUID requestId = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO user_action_requests(id,task_id,command_id,kind,intent_hash,prompt,expires_at)
            VALUES(:id,:task,:command,'LOGIN','login-intent','Sign in',now()+interval '5 minutes')
            """)
        .param("id", requestId)
        .param("task", taskId)
        .param("command", commandId)
        .update();
    UUID resultId = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO task_results(id,task_id,revision,conclusion)
            VALUES(:id,:task,1,'Already confirmed findings')
            """)
        .param("id", resultId)
        .param("task", taskId)
        .update();
    UUID continuationId = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO task_continuations(id,task_id,user_id,source_operation_id,instruction_revision,
              reason,mode,binding_version,expires_at)
            VALUES(:id,:task,:user,:operation,1,'USER_RESPONSE','MANUAL',1,now()+interval '5 minutes')
            """)
        .param("id", continuationId)
        .param("task", taskId)
        .param("user", actor.userId())
        .param("operation", created.operationId())
        .update();
    long priorEvents =
        count("SELECT count(*) FROM task_execution_events WHERE task_id=:id", taskId);
    long priorOutbox =
        count("SELECT count(*) FROM transactional_outbox WHERE user_id=:id", actor.userId());

    tasks.connectionUnavailable(actor.userId(), taskId);

    var current = tasks.get(actor, taskId);
    assertThat(current.state()).isEqualTo("WAITING_USER");
    assertThat(current.waitReason()).isEqualTo("CONNECTION_REQUIRED");
    assertThat(current.mutationBarrier()).isFalse();
    assertThat(current.activeRequest()).isNull();
    assertThat(
            jdbc.sql("SELECT state,failure_code FROM task_commands WHERE id=:id")
                .param("id", commandId)
                .query()
                .singleRow())
        .containsEntry("state", "CANCELLED")
        .containsEntry("failure_code", "CONNECTION_REQUIRED");
    assertThat(
            jdbc.sql("SELECT state,failure_code FROM operations WHERE target_id=:id")
                .param("id", commandId)
                .query()
                .singleRow())
        .containsEntry("state", "FAILED")
        .containsEntry("failure_code", "CONNECTION_REQUIRED");
    assertThat(
            jdbc.sql("SELECT status FROM user_action_requests WHERE id=:id")
                .param("id", requestId)
                .query(String.class)
                .single())
        .isEqualTo("CANCELLED");
    assertThat(
            jdbc.sql("SELECT state FROM task_continuations WHERE id=:id")
                .param("id", continuationId)
                .query(String.class)
                .single())
        .isEqualTo("CANCELLED");
    assertThat(
            jdbc.sql("SELECT conclusion FROM task_results WHERE id=:id")
                .param("id", resultId)
                .query(String.class)
                .single())
        .isEqualTo("Already confirmed findings");
    assertThat(count("SELECT count(*) FROM task_execution_events WHERE task_id=:id", taskId))
        .isEqualTo(priorEvents + 1);
    long deliveredOutbox =
        count("SELECT count(*) FROM transactional_outbox WHERE user_id=:id", actor.userId());
    assertThat(deliveredOutbox).isGreaterThan(priorOutbox);

    tasks.connectionUnavailable(actor.userId(), taskId);
    assertThat(tasks.get(actor, taskId).version()).isEqualTo(current.version());
    assertThat(count("SELECT count(*) FROM transactional_outbox WHERE user_id=:id", actor.userId()))
        .isEqualTo(deliveredOutbox);
  }

  @ParameterizedTest
  @ValueSource(strings = {"DRAFT", "COMPLETED", "FAILED", "CANCELLED", "STOPPING"})
  void unavailableConnectionDoesNotReviveUnpreparedTerminalOrStoppingTask(String state) {
    var actor = actor();
    UUID taskId =
        tasks.create(actor, create("Preserve lifecycle", "DRAFT"), context(), null).resource().id();
    jdbc.sql("UPDATE tasks SET state=:state WHERE id=:id")
        .param("state", state)
        .param("id", taskId)
        .update();
    var before = tasks.get(actor, taskId);
    tasks.connectionUnavailable(actor.userId(), taskId);
    var after = tasks.get(actor, taskId);
    assertThat(after.state()).isEqualTo(state);
    assertThat(after.version()).isEqualTo(before.version());
  }

  @Test
  void unavailableConnectionCancelsDraftLoginRequestWithoutPreparingTheDraft() {
    var actor = actor();
    UUID taskId =
        tasks.create(actor, create("Keep as a draft", "DRAFT"), context(), null).resource().id();
    UUID requestId = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO user_action_requests(id,task_id,kind,intent_hash,prompt,expires_at)
            VALUES(:id,:task,'LOGIN','draft-login','Sign in',now()+interval '5 minutes')
            """)
        .param("id", requestId)
        .param("task", taskId)
        .update();
    var before = tasks.get(actor, taskId);
    assertThat(before.activeRequest()).isNotNull();
    long priorOutbox =
        count("SELECT count(*) FROM transactional_outbox WHERE user_id=:id", actor.userId());

    tasks.connectionUnavailable(actor.userId(), taskId);

    var after = tasks.get(actor, taskId);
    assertThat(after.state()).isEqualTo("DRAFT");
    assertThat(after.activeRequest()).isNull();
    assertThat(after.version()).isEqualTo(before.version() + 1);
    assertThat(after.goal()).isEqualTo(before.goal());
    assertThat(
            jdbc.sql("SELECT status FROM user_action_requests WHERE id=:id")
                .param("id", requestId)
                .query(String.class)
                .single())
        .isEqualTo("CANCELLED");
    assertThat(count("SELECT count(*) FROM transactional_outbox WHERE user_id=:id", actor.userId()))
        .isGreaterThan(priorOutbox);
    tasks.connectionUnavailable(actor.userId(), taskId);
    assertThat(tasks.get(actor, taskId).version()).isEqualTo(after.version());
  }

  @Test
  void unavailableConnectionPreservesUnknownEffectsAndCannotAffectAnotherOwner() {
    var actor = actor();
    UUID taskId =
        tasks.create(actor, create("Reconcile first", "PREPARE"), context(), null).resource().id();
    jdbc.sql("UPDATE tasks SET state='INTERRUPTED',mutation_barrier=true WHERE id=:id")
        .param("id", taskId)
        .update();
    tasks.connectionUnavailable(actor.userId(), taskId);
    var current = tasks.get(actor, taskId);
    assertThat(current.state()).isEqualTo("INTERRUPTED");
    assertThat(current.waitReason()).isEqualTo("CONNECTION_REQUIRED");
    assertThat(current.mutationBarrier()).isTrue();
    var other = actor();
    assertThatThrownBy(() -> tasks.connectionUnavailable(other.userId(), taskId))
        .isInstanceOf(DomainException.class)
        .hasMessage("Resource not found");
    assertThat(tasks.get(actor, taskId).version()).isEqualTo(current.version());
  }

  @Test
  void unavailableConnectionAndItsOutboxRollBackTogether() {
    var actor = actor();
    UUID taskId =
        tasks
            .create(actor, create("Atomic cancellation", "PREPARE"), context(), null)
            .resource()
            .id();
    UUID commandId = pendingCommand(actor, taskId, "ACCEPTED");
    long before =
        count("SELECT count(*) FROM transactional_outbox WHERE user_id=:id", actor.userId());
    transaction.executeWithoutResult(
        status -> {
          tasks.connectionUnavailable(actor.userId(), taskId);
          status.setRollbackOnly();
        });
    assertThat(tasks.get(actor, taskId).state()).isEqualTo("WAITING_AGENT");
    assertThat(
            jdbc.sql("SELECT state FROM task_commands WHERE id=:id")
                .param("id", commandId)
                .query(String.class)
                .single())
        .isEqualTo("ACCEPTED");
    assertThat(count("SELECT count(*) FROM transactional_outbox WHERE user_id=:id", actor.userId()))
        .isEqualTo(before);
  }

  private UUID pendingCommand(AuthenticatedActor actor, UUID taskId, String state) {
    UUID commandId = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO task_commands(id,task_id,user_id,command_sequence,kind,payload,payload_hash,
              accepted_task_version,instruction_revision,deadline,state)
            VALUES(:id,:task,:user,1,'NAVIGATE','{}',repeat('a',64),0,1,now()+interval '5 minutes',:state)
            """)
        .param("id", commandId)
        .param("task", taskId)
        .param("user", actor.userId())
        .param("state", state)
        .update();
    transaction.executeWithoutResult(
        status ->
            operations.save(
                actor,
                "commands.accept:" + taskId,
                context(),
                Map.of("commandId", commandId),
                "command",
                commandId,
                1,
                false));
    return commandId;
  }

  private long count(String sql, UUID id) {
    return jdbc.sql(sql).param("id", id).query(Long.class).single();
  }

  private AuthenticatedActor actor() {
    var account =
        transaction.execute(
            status ->
                identities.resolve(
                    "https://issuer.example",
                    UUID.randomUUID().toString(),
                    "Test person",
                    "person@example.test"));
    if (account == null) {
      throw new IllegalStateException("Account transaction returned no result");
    }
    return new AuthenticatedActor(
        account.id(),
        UUID.randomUUID(),
        null,
        "helm-web",
        account.displayName(),
        account.email(),
        account.accessEpoch(),
        Set.of(),
        false);
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }

  private static TaskContracts.Create create(String goal, String intent) {
    return new TaskContracts.Create(
        goal, "https://example.com", List.of(), "TEXT", true, 1800, intent);
  }
}
