package com.helmglass.profile.infrastructure;

import com.helmglass.api.DomainException;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;
import javax.crypto.KeyGenerator;
import org.springframework.stereotype.Component;
import org.springframework.vault.VaultException;
import org.springframework.vault.core.VaultOperations;
import org.springframework.vault.support.Ciphertext;
import org.springframework.vault.support.Plaintext;
import org.springframework.vault.support.VaultTransitKeyCreationRequest;

/** Transit owns wrapping keys; only a short-lived data key crosses the scoped worker channel. */
@Component
public class ProfileKeyService {
  public record WrappedKey(String reference, String ciphertext) {
    @Override
    public String toString() {
      return "WrappedProfileKey[redacted]";
    }
  }

  public record KeyMaterial(WrappedKey wrapped, byte[] plaintext) implements AutoCloseable {
    @Override
    public void close() {
      Arrays.fill(plaintext, (byte) 0);
    }

    @Override
    public String toString() {
      return "ProfileKeyMaterial[redacted]";
    }
  }

  private final VaultOperations vault;

  public ProfileKeyService(VaultOperations vault) {
    this.vault = vault;
  }

  public KeyMaterial create(UUID userId) {
    String reference = "profiles/" + userId;
    String keyName = vaultKeyName(userId);
    var transit = vault.opsForTransit("helm-transit");
    if (transit.getKey(keyName) == null) {
      transit.createKey(
          keyName,
          VaultTransitKeyCreationRequest.builder()
              .type("aes256-gcm96")
              .exportable(false)
              .allowPlaintextBackup(false)
              .build());
    }
    byte[] key;
    try {
      KeyGenerator generator = KeyGenerator.getInstance("AES");
      generator.init(256);
      key = generator.generateKey().getEncoded();
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException("Required AES key generation is unavailable", error);
    }
    try {
      WrappedKey wrapped =
          new WrappedKey(reference, transit.encrypt(keyName, Plaintext.of(key)).getCiphertext());
      return new KeyMaterial(wrapped, key);
    } catch (RuntimeException error) {
      Arrays.fill(key, (byte) 0);
      throw error;
    }
  }

  public byte[] unwrap(UUID userId, WrappedKey wrapped) {
    if (!wrapped.reference().equals("profiles/" + userId)) {
      throw new DomainException(
          403, "PROFILE_KEY_SCOPE", "The wrapped key belongs to another owner");
    }
    byte[] key =
        vault
            .opsForTransit("helm-transit")
            .decrypt(vaultKeyName(userId), Ciphertext.of(wrapped.ciphertext()))
            .getPlaintext();
    if (key.length != 32) {
      Arrays.fill(key, (byte) 0);
      throw new DomainException(503, "PROFILE_KEY_INVALID", "The profile key has an invalid size");
    }
    return key;
  }

  /** Wraps a transfer credential under the already admitted account key for exact redelivery. */
  public WrappedKey wrapTransferToken(UUID userId, byte[] token) {
    if (token.length != 32) {
      throw new IllegalArgumentException("Profile transfer token must contain 32 bytes");
    }
    return new WrappedKey(
        "profiles/" + userId,
        vault
            .opsForTransit("helm-transit")
            .encrypt(vaultKeyName(userId), Plaintext.of(token))
            .getCiphertext());
  }

  /** Called only after irreversible account purge has fenced all profile creators. */
  public void destroy(UUID userId) {
    String name = vaultKeyName(userId);
    var transit = vault.opsForTransit("helm-transit");
    if (transit.getKey(name) == null) {
      return;
    }
    try {
      vault.write("helm-transit/keys/" + name + "/config", Map.of("deletion_allowed", true));
      vault.delete("helm-transit/keys/" + name);
    } catch (VaultException error) {
      if (transit.getKey(name) == null) {
        return;
      }
      throw error;
    }
    if (transit.getKey(name) != null) {
      throw new DomainException(
          503, "PROFILE_KEY_DELETE_UNCONFIRMED", "Profile key deletion is unconfirmed");
    }
  }

  private static String vaultKeyName(UUID userId) {
    // Transit names are a single path segment. Keep the domain reference stable in metadata.
    return "profiles-" + userId;
  }
}
