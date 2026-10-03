package com.helmglass;

import com.helmglass.bootstrap.MigrationApplication;
import com.helmglass.bootstrap.RecoveryApplication;
import java.io.IOException;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableScheduling
@SpringBootApplication
public class HelmGlassApplication {
  public static void main(String[] args) throws IOException {
    if (args.length == 1 && (args[0].equals("recover") || args[0].equals("recover-status"))) {
      RecoveryApplication.run(args[0].equals("recover-status"));
      return;
    }
    if ((args.length == 1 && args[0].equals("migrate"))
        || "migration".equals(System.getenv("HELM_PROCESS_ROLE"))) {
      MigrationApplication.run();
      return;
    }
    SpringApplication.run(HelmGlassApplication.class, args);
  }
}
