package com.helmglass.usage.application;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/** Upgrades existing tasks before the API reports application readiness. */
@Component
public class UsageProjectionStartup implements ApplicationRunner {
  private final UsageProjectionService projections;

  public UsageProjectionStartup(UsageProjectionService projections) {
    this.projections = projections;
  }

  @Override
  public void run(ApplicationArguments arguments) {
    while (projections.rebuildMissing() > 0) {
      // Each bounded batch commits independently and can be resumed after a process restart.
    }
  }
}
