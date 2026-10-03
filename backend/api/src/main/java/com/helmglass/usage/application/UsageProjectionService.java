package com.helmglass.usage.application;

import com.helmglass.api.JsonSupport;
import com.helmglass.usage.api.UsageContracts.Metric;
import com.helmglass.usage.infrastructure.repository.UsageRepository;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Rebuildable task display, committed atomically with its measurement or source change. */
@Service
public class UsageProjectionService {
  private final UsageRepository usage;
  private final JsonSupport json;

  public UsageProjectionService(UsageRepository usage, JsonSupport json) {
    this.usage = usage;
    this.json = json;
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void refresh(UUID userId, UUID taskId) {
    if (taskId == null) {
      return;
    }
    // Lock before reading aggregates so concurrent sources cannot overwrite a newer projection.
    usage.lockProjection(userId, taskId);
    Map<String, Metric> metrics = UsageService.metrics(usage.taskTotals(userId, taskId));
    Map<String, Object> display = new LinkedHashMap<>();
    display.put("browserSeconds", metrics.get("browser_seconds").value());
    display.put("executionSeconds", metrics.get("execution_seconds").value());
    display.put("activeSeconds", metrics.get("execution_seconds").value());
    display.put("humanSeconds", metrics.get("human_login_seconds").value());
    display.put("humanControlSeconds", metrics.get("human_control_seconds").value());
    display.put("mediaSeconds", metrics.get("media_seconds").value());
    display.put("mediaBytes", metrics.get("media_bytes").value());
    display.put("commandCount", metrics.get("command_count").value());
    display.put("metrics", metrics);
    List<Metric> visible =
        List.of(
            metrics.get("browser_seconds"),
            metrics.get("execution_seconds"),
            metrics.get("human_login_seconds"),
            metrics.get("human_control_seconds"),
            metrics.get("media_seconds"),
            metrics.get("media_bytes"));
    String coverage = "UNKNOWN";
    if (visible.stream().allMatch(metric -> metric.completeness().equals("COMPLETE"))) {
      coverage = "COMPLETE";
    } else if (visible.stream().anyMatch(metric -> metric.knownValue() != null)) {
      coverage = "PARTIAL";
    }
    display.put("completeness", coverage);
    usage.saveProjection(taskId, json.write(display), coverage);
  }

  @Transactional
  public int rebuildMissing() {
    var missing = usage.missingProjections();
    for (var task : missing) {
      refresh(task.userId(), task.taskId());
    }
    return missing.size();
  }
}
