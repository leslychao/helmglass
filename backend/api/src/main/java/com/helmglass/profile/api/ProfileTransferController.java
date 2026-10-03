package com.helmglass.profile.api;

import com.helmglass.profile.application.BrowserProfileService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProfileTransferController {
  private final BrowserProfileService profiles;

  public ProfileTransferController(BrowserProfileService profiles) {
    this.profiles = profiles;
  }

  @PutMapping(value = "/internal/worker/profile-transfers/{id}",
      consumes = "application/octet-stream")
  public BrowserProfileService.Receipt upload(@PathVariable UUID id,
      @RequestHeader("X-Transfer-Token") String token,
      @RequestHeader("X-Worker-Id") UUID workerId,
      @RequestHeader("X-Worker-Boot-Id") UUID bootId,
      @RequestHeader("X-Content-SHA256") String sha256,
      HttpServletRequest request, HttpServletResponse response) throws IOException {
    response.setHeader("Cache-Control", "no-store");
    return profiles.upload(id, token, workerId, bootId, request.getContentLengthLong(), sha256,
        request.getInputStream());
  }

  @GetMapping("/internal/worker/profile-transfers/{id}")
  public void download(@PathVariable UUID id,
      @RequestHeader("X-Transfer-Token") String token,
      @RequestHeader("X-Worker-Id") UUID workerId,
      @RequestHeader("X-Worker-Boot-Id") UUID bootId,
      HttpServletResponse response) throws IOException {
    response.setHeader("Cache-Control", "no-store");
    response.setContentType("application/octet-stream");
    profiles.download(id, token, workerId, bootId, response.getOutputStream());
  }
}
