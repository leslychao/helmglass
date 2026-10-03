package com.helmglass.enrollment.api;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.enrollment.application.WorkerEnrollmentService;
import jakarta.servlet.http.HttpServletRequest;
import java.security.cert.X509Certificate;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

@RestController
public class EnrollmentController {
  private final WorkerEnrollmentService enrollment;
  private final WorkerProtocol protocol;
  private final JsonSupport json;

  public EnrollmentController(WorkerEnrollmentService enrollment, WorkerProtocol protocol, JsonSupport json) {
    this.enrollment = enrollment;
    this.protocol = protocol;
    this.json = json;
  }

  @PostMapping("/internal/worker/enroll")
  public EnrollmentContracts.Response enroll(@RequestBody JsonNode body,
      HttpServletRequest request) {
    if (request.getLocalPort() != 8444 || !request.isSecure()) {
      throw new DomainException(403, "ENROLLMENT_TRANSPORT", "Enrollment requires its TLS endpoint");
    }
    Object peer = request.getAttribute("jakarta.servlet.request.X509Certificate");
    X509Certificate certificate = peer instanceof X509Certificate[] chain && chain.length > 0
        ? chain[0] : null;
    protocol.validateEnrollmentRequest(body);
    return enrollment.enroll(json.convert(body, EnrollmentContracts.Request.class), certificate);
  }
}
