package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserCloseOutboxRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.identity.infrastructure.repository.PolicyRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
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
  @EnableTransactionManagement
  @EnableJpaRepositories(basePackageClasses = JpaTaskRepository.class)
  @Import({
    TaskLifecycleService.class,
    TaskQueries.class,
    IdentityRepository.class,
    OperationRepository.class,
    ChangeRepository.class,
    JsonSupport.class,
    TaskContinuationService.class,
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

  @Autowired
  TaskLifecycleIntegrationTest(
      TaskLifecycleService tasks,
      IdentityRepository identities,
      OperationRepository operations,
      PlatformTransactionManager transactionManager) {
    this.tasks = tasks;
    this.identities = identities;
    this.operations = operations;
    transaction = new TransactionTemplate(transactionManager);
  }

  @Test
  void acceptedCreationSurvivesRetryAndDifferentIntentCannotReuseKey() {
    var actor = actor();
    var context = context();
    var input = create("Observe the public page", "PREPARE");
    var first = tasks.create(actor, input, context);
    var replay = tasks.create(actor, input, context);
    assertThat(replay).isEqualTo(first);
    assertThat(tasks.get(actor, first.resource().id()).state()).isEqualTo("WAITING_AGENT");
    assertThat(operations.lookup(actor, "tasks.create", context.key())).isEqualTo(first);
    assertThatThrownBy(() -> tasks.create(actor, create("Different intent", "PREPARE"), context))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("different request");
  }

  @Test
  void ownershipIsEnforcedEvenWhenCallerHasAdministratorRole() {
    var owner = actor();
    var task = tasks.create(owner, create("Private task", "DRAFT"), context());
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

  @Test
  void clarificationPreservesTaskAndIncrementsIntentWithoutRestartingBrowser() {
    var actor = actor();
    var created = tasks.create(actor, create("Original goal", "PREPARE"), context());
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
    tasks.create(actor, create("First", "DRAFT"), context());
    var parameters = new LinkedMultiValueMap<String, String>();
    var first = tasks.list(actor, PageQuery.from(parameters));
    tasks.create(actor, create("Second", "DRAFT"), context());
    parameters.add("snapshot", first.snapshot());
    assertThatThrownBy(() -> tasks.list(actor, PageQuery.from(parameters)))
        .isInstanceOf(DomainException.class)
        .hasMessage("Refresh the current list");
  }

  @Test
  void pauseAndStopDoNotRequireAnUnrelatedProgressVersion() {
    var actor = actor();
    var created = tasks.create(actor, create("Pause safely", "PREPARE"), context());
    tasks.pause(actor, created.resource().id(), context());
    assertThat(tasks.get(actor, created.resource().id()).state()).isEqualTo("PAUSED");
    tasks.stop(actor, created.resource().id(), context());
    assertThat(tasks.get(actor, created.resource().id()).state()).isEqualTo("CANCELLED");
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
