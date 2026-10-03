package com.helmglass;

import com.helmglass.api.JsonSupport;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

/** Protocol fixture for the first acknowledged runtime clock; no native execution is implied. */
final class WorkerRuntimeReceipts {
  private WorkerRuntimeReceipts() {}

  static JsonNode ready(JsonSupport json, UUID boot, UUID session, long allocationEpoch) {
    return json.read(
        json.write(
            Map.of(
                "allocationEpoch",
                allocationEpoch,
                "usage",
                Map.of(
                    "sourceId",
                    boot + ":" + session,
                    "sourceStartedAt",
                    Instant.now().truncatedTo(ChronoUnit.MILLIS).toString(),
                    "sourceSequence",
                    1,
                    "browserMs",
                    0,
                    "executionMs",
                    0,
                    "humanMs",
                    0,
                    "loginMs",
                    0,
                    "browserComplete",
                    false,
                    "mediaComplete",
                    false))));
  }
}
