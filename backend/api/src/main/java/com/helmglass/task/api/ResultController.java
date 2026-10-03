package com.helmglass.task.api;

import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.identity.api.Actors;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.task.application.ResultService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.node.NullNode;

@RestController
public class ResultController {
  private final ResultService results;

  public ResultController(ResultService results) {
    this.results = results;
  }

  @GetMapping("/api/v1/tasks/{id}/result")
  ResponseEntity<Object> result(@PathVariable UUID id, HttpServletRequest request) {
    var result = results.latest(Actors.current(request), id);
    return ResponseEntity.ok(result == null ? NullNode.getInstance() : result);
  }

  @PostMapping("/api/v1/tasks/{id}/results")
  MutationReceipt publish(@PathVariable UUID id, @Valid @RequestBody ResultContracts.Publish input,
      HttpServletRequest request) {
    return results.publish(Actors.current(request), id, input, MutationContext.from(request));
  }

  @GetMapping("/api/v1/results/{id}/rows")
  PageResult<Map<String, Object>> rows(@PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query, HttpServletRequest request) {
    return results.rows(Actors.current(request), id, PageQuery.from(query));
  }

  @GetMapping("/api/v1/results/{id}/rows/{rowId}")
  Map<String, Object> row(@PathVariable UUID id, @PathVariable UUID rowId,
      HttpServletRequest request) {
    return results.row(Actors.current(request), id, rowId);
  }
}
