package ru.helmglass.api.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class WorkerAuthentication {
  private final byte[] token;

  public WorkerAuthentication(@Value("${helm.worker-token}") String token) {
    if (token.length() < 32) {
      throw new IllegalArgumentException("WORKER_TOKEN is too short");
    }
    this.token = token.getBytes(StandardCharsets.UTF_8);
  }

  public void verify(String supplied) {
    if (supplied == null
        || !MessageDigest.isEqual(token, supplied.getBytes(StandardCharsets.UTF_8))) {
      throw Identity.denied("Недопустимое внутреннее подключение.");
    }
  }
}
