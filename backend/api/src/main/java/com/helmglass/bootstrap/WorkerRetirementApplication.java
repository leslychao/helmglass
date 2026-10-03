package com.helmglass.bootstrap;

import com.helmglass.api.JsonSupport;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.artifact.infrastructure.S3Configuration;
import com.helmglass.browser.application.BrowserAllocationService;
import com.helmglass.browser.application.BrowserControlService;
import com.helmglass.browser.application.BrowserOpenService;
import com.helmglass.browser.application.BrowserSessionService;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.application.WorkerRegistryService;
import com.helmglass.browser.application.WorkerRegistryService.StoppedWorkerProof;
import com.helmglass.browser.infrastructure.repository.BrowserCloseOutboxRepository;
import com.helmglass.browser.infrastructure.repository.BrowserOpenRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.BrowserStartupRepository;
import com.helmglass.browser.infrastructure.repository.ControlRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.command.application.CommandExecutionService;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.connection.application.ConnectionLoginService;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionResolutionRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.continuation.infrastructure.repository.ContinuationRepository;
import com.helmglass.enrollment.application.WorkerEnrollmentService;
import com.helmglass.enrollment.infrastructure.repository.EnrollmentRepository;
import com.helmglass.identity.application.UserPolicyService;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.identity.infrastructure.repository.PolicyRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import com.helmglass.profile.infrastructure.repository.ProfileRepository;
import com.helmglass.realtime.application.ChannelTicketService;
import com.helmglass.realtime.application.RealtimeDeliveryService;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.realtime.infrastructure.repository.ChatPresentationRepository;
import com.helmglass.realtime.infrastructure.repository.OutboxRepository;
import com.helmglass.task.application.ReconciliationService;
import com.helmglass.task.application.TaskLifecycleService;
import com.helmglass.task.domain.TaskAggregate;
import com.helmglass.task.infrastructure.repository.JpaTaskRepository;
import com.helmglass.task.infrastructure.repository.ReconciliationRepository;
import com.helmglass.task.infrastructure.repository.TaskQueries;
import com.helmglass.usage.application.UsageProjectionService;
import com.helmglass.usage.application.UsageService;
import com.helmglass.usage.infrastructure.repository.UsageRepository;
import java.io.IOException;
import java.io.InputStream;
import java.util.Objects;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.data.redis.autoconfigure.DataRedisAutoConfiguration;
import org.springframework.boot.hibernate.autoconfigure.HibernateJpaAutoConfiguration;
import org.springframework.boot.jackson.autoconfigure.JacksonAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceTransactionManagerAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.JdbcClientAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.JdbcTemplateAutoConfiguration;
import org.springframework.boot.persistence.autoconfigure.EntityScan;
import org.springframework.boot.transaction.autoconfigure.TransactionAutoConfiguration;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

/** One-shot operator commands for enrollment retirement and inspected worker closure. */
@Slf4j
public final class WorkerRetirementApplication {
  private static final int MAX_PROOF_BYTES = 16_384;

  private WorkerRetirementApplication() {}

  public static void run() {
    SpringApplication application = new SpringApplication(EnrollmentProcess.class);
    application.setWebApplicationType(WebApplicationType.NONE);
    application.setLogStartupInfo(false);
    try (var context = application.run("--helm.process-role=api")) {
      int retired = context.getBean(WorkerEnrollmentService.class).retireStoppedPool();
      log.info("Retired {} worker enrollments for the stopped installation pool", retired);
    }
  }

  /** Confirms a separately inspected runtime incarnation without starting API listeners or jobs. */
  public static void confirmStopped() {
    StoppedWorkerProof proof = readProof(System.in);
    SpringApplication application = new SpringApplication(StoppedWorkerProcess.class);
    application.setWebApplicationType(WebApplicationType.NONE);
    application.setLogStartupInfo(false);
    try (var context = application.run("--helm.process-role=api")) {
      int closed = confirmStopped(context, proof);
      log.info("Confirmed {} closed browser allocations for worker {}", closed, proof.workerId());
    }
  }

  static StoppedWorkerProof readProof(InputStream input) {
    try {
      byte[] bytes = input.readNBytes(MAX_PROOF_BYTES + 1);
      if (bytes.length == 0 || bytes.length > MAX_PROOF_BYTES) {
        throw new IllegalArgumentException(
            "Worker proof must contain 1 to " + MAX_PROOF_BYTES + " bytes");
      }
      StoppedWorkerProof proof =
          JsonMapper.builder()
              .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
              .enable(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
              .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
              .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
              .build()
              .readValue(bytes, StoppedWorkerProof.class);
      if (proof == null) {
        throw new IllegalArgumentException("Worker proof is required");
      }
      return proof;
    } catch (IOException | JacksonException error) {
      throw new IllegalArgumentException("Worker proof is not valid bounded JSON");
    }
  }

  static int confirmStopped(ConfigurableApplicationContext context, StoppedWorkerProof proof) {
    RuntimeSecrets secrets = context.getBean(RuntimeSecrets.class);
    if (!Objects.equals(secrets.installationId(), proof.installationId())) {
      throw new IllegalArgumentException("Worker proof belongs to another installation");
    }
    var enrollment = context.getBean(WorkerEnrollmentService.class);
    var registry = context.getBean(WorkerRegistryService.class);
    var transaction = new TransactionTemplate(context.getBean(PlatformTransactionManager.class));
    transaction.setTimeout(10);
    Integer closed =
        transaction.execute(
            status -> {
              enrollment.retireStoppedBoot(proof.workerId(), proof.bootId());
              return registry.confirmStopped(proof);
            });
    return Objects.requireNonNull(closed, "Worker confirmation transaction did not complete");
  }

  @ImportAutoConfiguration({
    DataSourceAutoConfiguration.class,
    JdbcTemplateAutoConfiguration.class,
    JdbcClientAutoConfiguration.class,
    DataSourceTransactionManagerAutoConfiguration.class
  })
  @Import({WorkerEnrollmentService.class, EnrollmentRepository.class})
  static class EnrollmentProcess {}

  @ImportAutoConfiguration({
    DataSourceAutoConfiguration.class,
    JdbcTemplateAutoConfiguration.class,
    JdbcClientAutoConfiguration.class,
    HibernateJpaAutoConfiguration.class,
    TransactionAutoConfiguration.class,
    JacksonAutoConfiguration.class,
    DataRedisAutoConfiguration.class
  })
  @EntityScan(basePackageClasses = TaskAggregate.class)
  @EnableJpaRepositories(basePackageClasses = JpaTaskRepository.class)
  @Import({
    WorkerEnrollmentService.class,
    EnrollmentRepository.class,
    WorkerRegistryService.class,
    WorkerRegistryRepository.class,
    WorkerProtocol.class,
    JsonSupport.class,
    BrowserCloseOutboxRepository.class,
    ControlRepository.class,
    CommandExecutionService.class,
    CommandRepository.class,
    BrowserOpenService.class,
    BrowserOpenRepository.class,
    BrowserAllocationService.class,
    BrowserRepository.class,
    BrowserStartupRepository.class,
    BrowserControlService.class,
    BrowserSessionService.class,
    IdentityRepository.class,
    UserPolicyService.class,
    PolicyRepository.class,
    OperationRepository.class,
    ChangeRepository.class,
    TaskContinuationService.class,
    ContinuationRepository.class,
    ReconciliationService.class,
    ReconciliationRepository.class,
    ConnectionService.class,
    ConnectionRepository.class,
    ConnectionResolutionRepository.class,
    ConnectionLoginService.class,
    LoginRepository.class,
    BrowserProfileService.class,
    ProfileRepository.class,
    ProfileKeyService.class,
    ObjectStorage.class,
    S3Configuration.class,
    TaskLifecycleService.class,
    TaskQueries.class,
    UsageService.class,
    UsageRepository.class,
    UsageProjectionService.class,
    RealtimeDeliveryService.class,
    ChatPresentationRepository.class,
    OutboxRepository.class,
    ChannelTicketService.class,
    UserEphemeralState.class
  })
  static class StoppedWorkerProcess {}
}
