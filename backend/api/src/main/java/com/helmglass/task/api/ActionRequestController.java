package com.helmglass.task.api;

import com.helmglass.api.MutationContext;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.task.application.ActionRequestService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ActionRequestController {
  private final ActionRequestService requests;

  public ActionRequestController(ActionRequestService requests) {
    this.requests = requests;
  }

  @PostMapping("/api/v1/action-requests/{id}/answer")
  MutationReceipt answer(@PathVariable UUID id, @Valid @RequestBody ActionRequestContracts.Answer input,
      HttpServletRequest request) {
    return requests.answer(Actors.current(request), id, input, MutationContext.from(request));
  }
}
