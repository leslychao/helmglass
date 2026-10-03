package com.helmglass.bootstrap;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

/** Protected installation input; credentials must never be included in diagnostics. */
record BootstrapIdentity(int schemaVersion, VaultIdentity vault, TlsIdentity tls) {
  static BootstrapIdentity read(Path path, boolean migration) throws IOException {
    if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
      throw new IOException("Bootstrap identity must be a regular file");
    }
    byte[] bytes;
    try (InputStream input = Files.newInputStream(path)) {
      bytes = input.readNBytes(65_537);
    }
    if (bytes.length > 65_536) {
      throw new IOException("Bootstrap identity exceeds its size limit");
    }
    BootstrapIdentity identity = JsonMapper.builder()
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .build().readValue(bytes, BootstrapIdentity.class);
    if (identity == null || identity.schemaVersion != 1 || identity.vault == null) {
      throw new IllegalArgumentException("Unsupported bootstrap identity");
    }
    identity.vault.validate();
    if (!migration) {
      if (identity.tls == null) {
        throw new IllegalArgumentException("API TLS identity is required");
      }
      identity.tls.validate();
    }
    return identity;
  }

  static String required(String value, String name) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("Missing bootstrap field: " + name);
    }
    return value;
  }

  @Override
  public String toString() {
    return "BootstrapIdentity[redacted]";
  }

  record VaultIdentity(String address, String caPem, String roleId, String secretId) {
    void validate() {
      URI uri = URI.create(required(address, "vault.address"));
      if (!"https".equals(uri.getScheme()) || uri.getHost() == null
          || uri.getRawUserInfo() != null || uri.getRawQuery() != null
          || uri.getRawFragment() != null
          || !(uri.getPath().isEmpty() || "/".equals(uri.getPath()))) {
        throw new IllegalArgumentException("Vault requires an HTTPS origin");
      }
      required(caPem, "vault.caPem");
      required(roleId, "vault.roleId");
      required(secretId, "vault.secretId");
    }

    @Override
    public String toString() {
      return "VaultIdentity[redacted]";
    }
  }

  record TlsIdentity(String certificatePem, String privateKeyPem, String caPem) {
    void validate() {
      required(certificatePem, "tls.certificatePem");
      required(privateKeyPem, "tls.privateKeyPem");
      required(caPem, "tls.caPem");
    }

    @Override
    public String toString() {
      return "TlsIdentity[redacted]";
    }
  }
}
