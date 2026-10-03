package com.helmglass.bootstrap;

import com.helmglass.enrollment.application.WorkerEnrollmentService;
import com.helmglass.enrollment.infrastructure.repository.EnrollmentRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceTransactionManagerAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.JdbcClientAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.JdbcTemplateAutoConfiguration;
import org.springframework.context.annotation.Import;

/** Operator command for deployment after Docker confirms that the entire worker pool is stopped. */
@Slf4j
public final class WorkerRetirementApplication {
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

  @ImportAutoConfiguration({
    DataSourceAutoConfiguration.class,
    JdbcTemplateAutoConfiguration.class,
    JdbcClientAutoConfiguration.class,
    DataSourceTransactionManagerAutoConfiguration.class
  })
  @Import({WorkerEnrollmentService.class, EnrollmentRepository.class})
  static class EnrollmentProcess {}
}
