package com.helmglass.bootstrap;

import java.util.LinkedHashMap;
import java.util.Map;

/** Typed KV contract shared with installation provisioning. */
public record RuntimeSecrets(
    String databaseUrl,
    String databaseUsername,
    String databasePassword,
    String redisUsername,
    String redisPassword,
    String s3AccessKey,
    String s3SecretKey,
    String keycloakClientId,
    String keycloakClientSecret,
    String turnSharedSecret,
    String mediaProxyUsername,
    String mediaProxyPassword,
    String installationId,
    String workerEnrollmentToken) {

  Map<String, Object> properties(boolean migration) {
    Map<String, Object> properties = new LinkedHashMap<>();
    put(properties, "spring.datasource.url", databaseUrl);
    put(properties, "spring.datasource.username", databaseUsername);
    put(properties, "spring.datasource.password", databasePassword);
    if (!databaseUrl.startsWith("jdbc:postgresql://")) {
      throw new IllegalArgumentException("Only the configured PostgreSQL backend is supported");
    }
    if (!migration) {
      put(properties, "spring.data.redis.username", redisUsername);
      put(properties, "spring.data.redis.password", redisPassword);
      put(properties, "helm.s3.access-key", s3AccessKey);
      put(properties, "helm.s3.secret-key", s3SecretKey);
      put(properties, "helm.keycloak.client-id", keycloakClientId);
      put(properties, "helm.keycloak.client-secret", keycloakClientSecret);
      put(properties, "helm.turn.shared-secret", turnSharedSecret);
      put(properties, "helm.media-proxy.username", mediaProxyUsername);
      put(properties, "helm.media-proxy.password", mediaProxyPassword);
      BootstrapIdentity.required(installationId, "installationId");
      BootstrapIdentity.required(workerEnrollmentToken, "workerEnrollmentToken");
      if (!installationId.matches("[A-Za-z0-9_-]{1,80}")
          || workerEnrollmentToken.length() < 32 || workerEnrollmentToken.length() > 512) {
        throw new IllegalArgumentException("Invalid worker enrollment scope");
      }
    }
    return properties;
  }

  private static void put(Map<String, Object> properties, String key, String value) {
    properties.put(key, BootstrapIdentity.required(value, key));
  }

  @Override
  public String toString() {
    return "RuntimeSecrets[redacted]";
  }
}
