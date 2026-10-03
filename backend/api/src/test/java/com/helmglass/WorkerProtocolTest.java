package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.browser.application.WorkerProtocol;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class WorkerProtocolTest {
  private final JsonSupport json = new JsonSupport(JsonMapper.builder().build());
  private final WorkerProtocol protocol = new WorkerProtocol();

  @Test
  void rejectsSelectorsAndUnboundTargetsInsteadOfPassingThemToBrowser() {
    assertThatThrownBy(() -> protocol.validateAction(json.read(
        "{\"type\":\"CLICK\",\"selector\":\"button\"}")))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(() -> protocol.validateAction(json.read(
        "{\"type\":\"CLICK\",\"target\":\"e1\",\"observationId\":\"not-a-uuid\"}")))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(() -> protocol.validateInputAction(json.read(
        "{\"type\":\"committedText\",\"text\":\"x\",\"script\":\"alert(1)\"}")))
        .isInstanceOf(DomainException.class);
  }

  @Test
  void digestUsesTheJavascriptNumberRepresentation() {
    var first = json.read("{\"type\":\"SCROLL\",\"deltaX\":1.0,\"deltaY\":-0.0}");
    var second = json.read("{\"deltaY\":0,\"deltaX\":1,\"type\":\"SCROLL\"}");
    protocol.validateAction(first);
    assertThat(json.workerDigest(first)).isEqualTo(json.workerDigest(second));
  }
}
