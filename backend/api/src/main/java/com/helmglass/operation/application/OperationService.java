package com.helmglass.operation.application;

import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class OperationService {
  private final OperationRepository operations;

  public OperationService(OperationRepository operations) {
    this.operations = operations;
  }

  public OperationRepository.OperationView get(AuthenticatedActor actor, UUID id) {
    actor.requireScope("tasks:read");
    return operations.owned(actor.userId(), id);
  }

  public MutationReceipt lookup(AuthenticatedActor actor, String kind, String key) {
    actor.requireScope("tasks:read");
    return operations.lookup(actor, kind, key);
  }
}
