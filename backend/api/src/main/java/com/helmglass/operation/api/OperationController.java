package com.helmglass.operation.api;

import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.operation.application.OperationService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/operations")
public class OperationController {
  private final OperationService operations;

  public OperationController(OperationService operations) {
    this.operations = operations;
  }

  @GetMapping("/{id}")
  OperationRepository.OperationView get(@PathVariable UUID id, HttpServletRequest request) {
    return operations.get(Actors.current(request), id);
  }

  @GetMapping("/lookup")
  MutationReceipt lookup(@RequestParam String kind, @RequestHeader("Idempotency-Key") String key,
      HttpServletRequest request) {
    return operations.lookup(Actors.current(request), kind, key);
  }
}
