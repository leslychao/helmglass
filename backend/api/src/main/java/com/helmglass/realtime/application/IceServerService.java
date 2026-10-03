package com.helmglass.realtime.application;

import com.helmglass.bootstrap.RuntimeSecrets;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class IceServerService {
  private final RuntimeSecrets secrets;
  private final List<String> publicUrls;
  private final String internalUrl;
  private final String proxyUrl;

  public IceServerService(RuntimeSecrets secrets,
      @Value("${helm.turn.public-urls:}") List<String> publicUrls,
      @Value("${helm.turn.internal-url:turn:coturn:3478?transport=tcp}") String internalUrl,
      @Value("${helm.media-proxy.url:http://egress-proxy:3128}") String proxyUrl) {
    this.secrets = secrets;
    this.internalUrl = internalUrl;
    this.proxyUrl = proxyUrl;
    this.publicUrls = publicUrls.stream().filter(value -> !value.isBlank()).toList();
  }

  public List<Map<String, Object>> forViewer(UUID userId, UUID viewerId, Instant expiresAt) {
    if (publicUrls.isEmpty()) {
      return List.of();
    }
    return List.of(credentials(publicUrls, userId, viewerId, expiresAt));
  }

  public Map<String, Object> forProducer(UUID userId, UUID viewerId, Instant expiresAt) {
    return credentials(List.of(internalUrl), userId, viewerId, expiresAt);
  }

  public Map<String, String> mediaProxy() {
    return Map.of("url", proxyUrl, "username", secrets.mediaProxyUsername(), "password", secrets.mediaProxyPassword());
  }

  private Map<String, Object> credentials(List<String> urls, UUID userId, UUID viewerId, Instant expiresAt) {
    String username = expiresAt.getEpochSecond() + ":" + userId + ":" + viewerId;
    try {
      Mac hmac = Mac.getInstance("HmacSHA1");
      hmac.init(new SecretKeySpec(secrets.turnSharedSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
      String credential = Base64.getEncoder().encodeToString(hmac.doFinal(username.getBytes(StandardCharsets.UTF_8)));
      return Map.of("urls", urls, "username", username, "credential", credential);
    } catch (GeneralSecurityException error) {
      throw new IllegalStateException("Required TURN credential algorithm is unavailable", error);
    }
  }
}
