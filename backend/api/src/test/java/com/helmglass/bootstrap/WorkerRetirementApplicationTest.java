package com.helmglass.bootstrap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.browser.application.WorkerRegistryService.StoppedAllocation;
import com.helmglass.browser.application.WorkerRegistryService.StoppedWorkerProof;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class WorkerRetirementApplicationTest {
  @Test
  void readsExactProofWithNullableNeverAssignedRuntime() {
    var proof =
        new StoppedWorkerProof(
            "fixture",
            UUID.randomUUID(),
            "a".repeat(64),
            Instant.parse("2026-10-03T12:00:00Z"),
            0,
            Instant.parse("2026-10-03T12:01:00Z"),
            1,
            UUID.randomUUID(),
            UUID.randomUUID(),
            List.of(new StoppedAllocation(UUID.randomUUID(), 1, null)));
    byte[] bytes = JsonMapper.builder().build().writeValueAsBytes(proof);
    assertThat(WorkerRetirementApplication.readProof(new ByteArrayInputStream(bytes)))
        .isEqualTo(proof);
  }

  @Test
  void refusesUnknownFieldsTrailingDocumentsAndNullCountersWithoutEchoingInput() {
    for (String input :
        List.of(
            "{\"unexpected\":\"fixture-secret\"}",
            "{}",
            "{} {}",
            "{\"previousRestartCount\":null}",
            "null",
            "")) {
      assertThatThrownBy(
              () ->
                  WorkerRetirementApplication.readProof(
                      new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8))))
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessageNotContaining("fixture-secret");
    }
  }

  @Test
  void refusesOversizeBeforeConsumingUnboundedInput() {
    var input = new ByteArrayInputStream(new byte[16_386]);
    assertThatThrownBy(() -> WorkerRetirementApplication.readProof(input))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("16384");
    assertThat(input.available()).isEqualTo(1);
  }
}
