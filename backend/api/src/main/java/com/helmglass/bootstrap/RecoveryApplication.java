package com.helmglass.bootstrap;

import com.helmglass.account.application.AccountCleanupService;
import com.helmglass.account.infrastructure.DeletionLedger;
import com.helmglass.account.infrastructure.IndependentDeletionStore;
import com.helmglass.account.infrastructure.repository.AccountCleanupRepository;
import com.helmglass.account.infrastructure.repository.AccountDataRepository;
import com.helmglass.api.JsonSupport;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.artifact.infrastructure.S3Configuration;
import com.helmglass.identity.infrastructure.KeycloakSessionClient;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import com.helmglass.recovery.application.RecoveryService;
import com.helmglass.recovery.infrastructure.repository.RecoveryRepository;
import java.io.IOException;
import java.nio.file.Path;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.data.redis.autoconfigure.DataRedisAutoConfiguration;
import org.springframework.boot.jackson.autoconfigure.JacksonAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceTransactionManagerAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.JdbcClientAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.JdbcTemplateAutoConfiguration;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.EnableTransactionManagement;

/** Restores admission only through the recovery owner, without API listeners or schedulers. */
@Slf4j
public final class RecoveryApplication {
  private RecoveryApplication() {}

  public static void run(boolean statusOnly) throws IOException {
    SpringApplication application = new SpringApplication(RecoveryProcess.class);
    application.setWebApplicationType(WebApplicationType.NONE);
    application.setLogStartupInfo(false);
    try (var context =
        application.run("--helm.process-role=api", "--spring.liquibase.enabled=false")) {
      Path directory =
          Path.of(context.getEnvironment().getProperty("helm.recovery-directory", "/run/recovery"));
      RecoveryService recovery = context.getBean(RecoveryService.class);
      if (statusOnly) {
        log.info(
            "HELM_RECOVERY_STATUS {}",
            context.getBean(JsonSupport.class).write(recovery.status(directory)));
      } else {
        recovery.recover(directory);
        log.info("Helm recovery completed; admission is ready");
      }
    }
  }

  @EnableTransactionManagement
  @ImportAutoConfiguration({
    DataSourceAutoConfiguration.class,
    DataSourceTransactionManagerAutoConfiguration.class,
    JdbcTemplateAutoConfiguration.class,
    JdbcClientAutoConfiguration.class,
    DataRedisAutoConfiguration.class,
    JacksonAutoConfiguration.class
  })
  @Import({
    RecoveryService.class,
    RecoveryRepository.class,
    AccountCleanupService.class,
    AccountCleanupRepository.class,
    AccountDataRepository.class,
    DeletionLedger.class,
    IndependentDeletionStore.class,
    ObjectStorage.class,
    S3Configuration.class,
    ProfileKeyService.class,
    UserEphemeralState.class,
    IdentityRepository.class,
    KeycloakSessionClient.class,
    JsonSupport.class
  })
  static class RecoveryProcess {}
}
