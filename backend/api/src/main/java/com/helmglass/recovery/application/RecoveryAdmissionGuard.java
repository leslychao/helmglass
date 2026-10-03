package com.helmglass.recovery.application;

import com.helmglass.recovery.infrastructure.repository.RecoveryRepository;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.stereotype.Component;

/** An unfinished restore cannot start application listeners or scheduled owners. */
@Component
public class RecoveryAdmissionGuard implements SmartInitializingSingleton {
  private final RecoveryRepository recovery;

  public RecoveryAdmissionGuard(RecoveryRepository recovery) {
    this.recovery = recovery;
  }

  @Override
  public void afterSingletonsInstantiated() {
    if (!recovery.ready()) {
      throw new IllegalStateException(
          "Restore admission is closed; complete the one-shot recovery procedure first");
    }
  }
}
