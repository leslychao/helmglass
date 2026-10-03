package com.helmglass.bootstrap;

import liquibase.integration.spring.SpringLiquibase;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.liquibase.autoconfigure.LiquibaseAutoConfiguration;

/** One-shot schema process; it does not scan API owners or start listeners and schedulers. */
@Slf4j
public final class MigrationApplication {
  private MigrationApplication() {}

  public static void run() {
    SpringApplication application = new SpringApplication(DatabaseProcess.class);
    application.setWebApplicationType(WebApplicationType.NONE);
    application.setLogStartupInfo(false);
    try (var context = application.run("--helm.process-role=migration",
        "--spring.liquibase.enabled=true")) {
      if (context.getBeansOfType(SpringLiquibase.class).size() != 1) {
        throw new IllegalStateException("Liquibase migration was not initialized");
      }
      log.info("Helm database migration completed");
    }
  }

  @ImportAutoConfiguration({DataSourceAutoConfiguration.class, LiquibaseAutoConfiguration.class})
  static class DatabaseProcess {}
}
