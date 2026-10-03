package com.helmglass.bootstrap;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;
import org.springframework.beans.factory.support.DefaultSingletonBeanRegistry;
import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.bootstrap.ConfigurableBootstrapContext;
import org.springframework.boot.context.config.ConfigDataEnvironmentPostProcessor;
import org.springframework.boot.context.event.ApplicationFailedEvent;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.vault.support.Versioned;

/** Resolves protected credentials before any pool or application listener starts. */
public final class VaultBootstrap implements EnvironmentPostProcessor, Ordered {
  private final ConfigurableBootstrapContext bootstrapContext;

  public VaultBootstrap(ConfigurableBootstrapContext bootstrapContext) {
    this.bootstrapContext = bootstrapContext;
  }

  @Override
  public int getOrder() {
    return ConfigDataEnvironmentPostProcessor.ORDER + 1;
  }

  @Override
  public void postProcessEnvironment(ConfigurableEnvironment environment,
      SpringApplication application) {
    String role = environment.getProperty("helm.process-role", "api");
    if (!role.equals("api") && !role.equals("migration")) {
      throw new IllegalStateException("Unsupported Helm process role");
    }
    boolean migration = role.equals("migration");
    Path input = Path.of(environment.getProperty("helm.bootstrap-identity",
        "/run/secrets/" + (migration ? "migration_identity" : "api_identity")));
    VaultSession session = null;
    try {
      BootstrapIdentity identity = BootstrapIdentity.read(input, migration);
      session = new VaultSession(identity.vault());
      Versioned<RuntimeSecrets> versioned = session.operations()
          .opsForVersionedKeyValue("helm-kv").get("services/" + role, RuntimeSecrets.class);
      if (versioned == null || versioned.getData() == null) {
        throw new IllegalStateException("Required Vault service credentials are absent");
      }
      RuntimeSecrets secrets = versioned.getData();
      Map<String, Object> properties = secrets.properties(migration);
      if (!migration) {
        writeTls(identity.tls(), properties);
      }
      environment.getPropertySources().addFirst(new MapPropertySource("helmVault", properties));
      transferSession(application, session, secrets);
    } catch (Exception error) {
      if (session != null) {
        session.close();
      }
      // HTTP/JSON exception payloads can contain credentials. The bootstrap boundary reports
      // only the failure category; Vault's protected audit trail provides further diagnostics.
      throw new IllegalStateException("Secure bootstrap failed ("
          + error.getClass().getSimpleName() + "); check installation identity and Vault readiness");
    }
  }

  private void transferSession(SpringApplication application, VaultSession session,
      RuntimeSecrets secrets) {
    application.addListeners(event -> {
      if (event instanceof ApplicationFailedEvent) {
        session.close();
      }
    });
    bootstrapContext.addCloseListener(event -> {
      var factory = event.getApplicationContext().getBeanFactory();
      if (!(factory instanceof DefaultSingletonBeanRegistry registry)) {
        session.close();
        throw new IllegalStateException("Unsupported bean factory lifecycle");
      }
      registry.registerSingleton("helmVaultOperations", session.operations());
      registry.registerSingleton("helmRuntimeSecrets", secrets);
      registry.registerDisposableBean("helmVaultOperations", session::close);
    });
  }

  private static void writeTls(BootstrapIdentity.TlsIdentity tls,
      Map<String, Object> properties) throws IOException {
    Path directory = Path.of("/run/helm");
    if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
      Files.createDirectory(directory, PosixFilePermissions.asFileAttribute(
          PosixFilePermissions.fromString("rwx------")));
    }
    if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
      throw new IOException("TLS staging directory is invalid");
    }
    Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
    writePrivate(directory.resolve("api.crt"), tls.certificatePem());
    writePrivate(directory.resolve("api.key"), tls.privateKeyPem());
    writePrivate(directory.resolve("ca.crt"), tls.caPem());
    properties.put("helm.internal-tls.certificate", directory.resolve("api.crt").toString());
    properties.put("helm.internal-tls.private-key", directory.resolve("api.key").toString());
    properties.put("helm.internal-tls.trust-certificate", directory.resolve("ca.crt").toString());
  }

  private static void writePrivate(Path path, String contents) throws IOException {
    Files.createFile(path, PosixFilePermissions.asFileAttribute(
        PosixFilePermissions.fromString("rw-------")));
    Files.writeString(path, contents, StandardOpenOption.WRITE);
  }
}
