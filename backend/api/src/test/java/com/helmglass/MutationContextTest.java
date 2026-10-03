package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

class MutationContextTest {
  @Test
  void canonicalNginxAndUuidCorrelationPreserveTheSameIdentity() {
    UUID expected = UUID.fromString("01234567-89ab-cdef-0123-456789abcdef");
    for (String supplied : List.of("0123456789abcdef0123456789abcdef", expected.toString())) {
      var request = request(supplied);
      assertThat(MutationContext.from(request).requestId()).isEqualTo(expected);
      assertThat(request.getAttribute("helm.requestId")).isEqualTo(expected);
    }
  }

  @Test
  void malformedAndAbbreviatedIdsAreRejected() {
    for (String supplied : List.of("", "1-1-1-1-1", "x".repeat(32), "0".repeat(31))) {
      assertThatThrownBy(() -> MutationContext.from(request(supplied)))
          .isInstanceOf(DomainException.class);
    }
  }

  private static MockHttpServletRequest request(String id) {
    var request = new MockHttpServletRequest();
    request.addHeader("X-Request-ID", id);
    request.addHeader("Idempotency-Key", "fixture-intent");
    return request;
  }
}
