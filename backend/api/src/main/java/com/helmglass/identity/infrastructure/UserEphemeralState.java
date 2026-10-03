package com.helmglass.identity.infrastructure;

import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import java.time.Duration;
import java.util.ArrayList;
import java.util.UUID;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/** Ownership index for short-lived Redis state; cleanup never scans another user's values. */
@Component
public class UserEphemeralState {
  private static final int BATCH_SIZE = 500;
  private final StringRedisTemplate redis;
  private final IdentityRepository identities;

  public UserEphemeralState(StringRedisTemplate redis, IdentityRepository identities) {
    this.redis = redis;
    this.identities = identities;
  }

  @Transactional
  public void set(UUID userId, String key, String value, Duration lifetime) {
    identities.lockActive(userId);
    register(userId, key);
    redis.opsForValue().set(key, value, lifetime);
  }

  @Transactional
  public Long increment(UUID userId, String key, Duration lifetime) {
    identities.lockActive(userId);
    register(userId, key);
    Long value = redis.opsForValue().increment(key);
    redis.expire(key, lifetime);
    return value;
  }

  @Transactional
  public String csrfToken(UUID userId, UUID loginId, String candidate) {
    identities.lockActive(userId);
    String key = "helm:csrf:" + loginId;
    String current = redis.opsForValue().get(key);
    if (current != null) {
      return current;
    }
    register(userId, key);
    redis.opsForValue().set(key, candidate, Duration.ofHours(8));
    return candidate;
  }

  private void register(UUID userId, String key) {
    if (!key.startsWith("helm:csrf:") && !key.startsWith("helm:ticket:")
        && !key.startsWith("helm:viewer-generation:")
        && !key.matches("__Host-helm_session-[a-f0-9]{32}")) {
      throw new IllegalArgumentException("Unsupported ephemeral owner key");
    }
    String index = index(userId);
    redis.opsForSet().add(index, key);
    redis.expire(index, Duration.ofDays(2));
  }

  public boolean contains(UUID userId, String key) {
    return Boolean.TRUE.equals(redis.opsForSet().isMember(index(userId), key));
  }

  @Transactional
  public void registerProxySession(UUID userId, String key) {
    identities.lockActive(userId);
    if (!key.matches("__Host-helm_session-[a-f0-9]{32}")) {
      throw new IllegalArgumentException("Invalid proxy ticket ID");
    }
    register(userId, key);
  }

  public boolean purgeBatch(UUID userId) {
    String index = index(userId);
    var keys = new ArrayList<String>();
    try (var cursor = redis.opsForSet().scan(index, ScanOptions.scanOptions().count(BATCH_SIZE).build())) {
      while (cursor.hasNext() && keys.size() < BATCH_SIZE) {
        keys.add(cursor.next());
      }
    }
    if (!keys.isEmpty()) {
      var proxyKeys = new ArrayList<String>();
      var applicationKeys = new ArrayList<String>();
      for (String key : keys) {
        if (key.startsWith("__Host-helm_session-")) {
          proxyKeys.add(key);
        } else {
          applicationKeys.add(key);
        }
      }
      // Redis requires a single ACL selector to authorize every key in a command.
      if (!applicationKeys.isEmpty()) {
        redis.delete(applicationKeys);
      }
      if (!proxyKeys.isEmpty()) {
        redis.delete(proxyKeys);
      }
      redis.opsForSet().remove(index, keys.toArray());
    }
    Long size = redis.opsForSet().size(index);
    return size != null && size == 0;
  }

  private static String index(UUID userId) {
    return "helm:user-state:" + userId;
  }
}
