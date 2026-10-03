package com.helmglass.bootstrap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.enrollment.api.EnrollmentContracts;
import com.helmglass.enrollment.application.WorkerEnrollmentService;
import com.helmglass.enrollment.infrastructure.repository.EnrollmentRepository;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import com.helmglass.recovery.application.RecoveryService;
import com.helmglass.recovery.domain.RecoveryProof;
import com.helmglass.recovery.infrastructure.repository.RecoveryRepository;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.vault.VaultException;
import org.springframework.vault.authentication.TokenAuthentication;
import org.springframework.vault.client.VaultClient;
import org.springframework.vault.client.VaultEndpoint;
import org.springframework.vault.core.VaultTemplate;
import org.springframework.web.bind.annotation.RestController;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.json.JsonMapper;

class VaultIntegrationTest {
  private static final String IMAGE =
      "hashicorp/vault:2.1.1@sha256:"
          + "47f14a6acb98f48d798a07df7c83f23a6e636e1cf724c5f8ff165cb32667a1e2";

  @TempDir Path directory;

  @Test
  void tlsAppRoleScopesKeysAndBootstrapsIsolatedMigrationAndRecoveryProcesses() throws Exception {
    String rootToken = UUID.randomUUID().toString();
    try (var container =
        new GenericContainer<>(IMAGE)
            .withEnv("VAULT_DEV_ROOT_TOKEN_ID", rootToken)
            .withCommand(
                "server",
                "-dev-tls",
                "-dev-tls-cert-dir=/tmp",
                "-dev-tls-san=host.docker.internal",
                "-dev-tls-san=172.17.0.1",
                "-dev-listen-address=0.0.0.0:8200",
                "-dev-no-store-token")
            .withExposedPorts(8200)
            .waitingFor(Wait.forListeningPort())
            .withStartupTimeout(Duration.ofSeconds(45))) {
      container.start();
      String ca =
          container.copyFileFromContainer(
              "/tmp/vault-ca.pem",
              input -> new String(input.readAllBytes(), StandardCharsets.US_ASCII));
      URI endpoint =
          URI.create("https://" + container.getHost() + ":" + container.getMappedPort(8200));
      try (HttpClient http =
          HttpClient.newBuilder()
              .sslContext(CertificateTrust.context(ca))
              .connectTimeout(Duration.ofSeconds(3))
              .build()) {
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(http);
        requestFactory.setReadTimeout(Duration.ofSeconds(5));
        VaultClient client =
            VaultClient.builder()
                .endpoint(VaultEndpoint.from(endpoint))
                .requestFactory(requestFactory)
                .build();
        VaultTemplate administrator = new VaultTemplate(client, new TokenAuthentication(rootToken));
        administrator.write(
            "sys/mounts/helm-kv", Map.of("type", "kv", "options", Map.of("version", "2")));
        administrator.write("sys/mounts/helm-transit", Map.of("type", "transit"));
        administrator.write("sys/auth/approle", Map.of("type", "approle"));
        administrator.write(
            "sys/policies/acl/helm-api",
            Map.of(
                "policy",
                """
                path "helm-kv/data/services/api" { capabilities = ["read"] }
                path "helm-transit/keys/profiles-*" {
                  capabilities = ["create", "read", "update", "delete"]
                  allowed_parameters = {
                    "type" = ["aes256-gcm96"]
                    "exportable" = [false]
                    "allow_plaintext_backup" = [false]
                    "derived" = [false]
                    "convergent_encryption" = [false]
                    "deletion_allowed" = [true]
                  }
                }
                path "helm-transit/encrypt/profiles-*" { capabilities = ["update"] }
                path "helm-transit/decrypt/profiles-*" { capabilities = ["update"] }
                path "helm-pki/sign/browser-workers" { capabilities = ["update"] }
                path "helm-pki/revoke" { capabilities = ["update"] }
                """));
        administrator.write(
            "auth/approle/role/helm-api",
            Map.of(
                "token_policies",
                "helm-api",
                "token_ttl",
                "5m",
                "token_max_ttl",
                "30m",
                "secret_id_num_uses",
                0));
        var role = administrator.read("auth/approle/role/helm-api/role-id");
        var secret = administrator.write("auth/approle/role/helm-api/secret-id", Map.of());
        assertThat(role).isNotNull();
        assertThat(secret).isNotNull();
        String roleId = String.valueOf(role.getRequiredData().get("role_id"));
        String secretId = String.valueOf(secret.getRequiredData().get("secret_id"));
        administrator
            .opsForVersionedKeyValue("helm-kv")
            .put("services/api", Map.of("marker", "api"));
        administrator
            .opsForVersionedKeyValue("helm-kv")
            .put("services/migration", Map.of("marker", "ddl"));
        try (VaultSession session =
            new VaultSession(
                new BootstrapIdentity.VaultIdentity(endpoint.toString(), ca, roleId, secretId))) {
          var own = session.operations().opsForVersionedKeyValue("helm-kv").get("services/api");
          assertThat(own).isNotNull();
          assertThat(own.getRequiredData()).containsEntry("marker", "api");
          assertThatThrownBy(
                  () ->
                      session
                          .operations()
                          .opsForVersionedKeyValue("helm-kv")
                          .get("services/migration"))
              .isInstanceOf(VaultException.class);
          ProfileKeyService keys = new ProfileKeyService(session.operations());
          UUID user = UUID.randomUUID();
          try (var material = keys.create(user)) {
            byte[] unwrapped = keys.unwrap(user, material.wrapped());
            assertThat(unwrapped).isEqualTo(material.plaintext()).hasSize(32);
            Arrays.fill(unwrapped, (byte) 0);
            assertThatThrownBy(() -> keys.unwrap(UUID.randomUUID(), material.wrapped()))
                .isInstanceOf(DomainException.class);
          }
        }
        var tls =
            new BootstrapIdentity.TlsIdentity(
                container.copyFileFromContainer(
                    "/tmp/vault-cert.pem",
                    input -> new String(input.readAllBytes(), StandardCharsets.US_ASCII)),
                container.copyFileFromContainer(
                    "/tmp/vault-key.pem",
                    input -> new String(input.readAllBytes(), StandardCharsets.US_ASCII)),
                ca);
        verifyMigrationBootstrap(administrator, endpoint, ca, tls);
      }
    }
  }

  private void verifyMigrationBootstrap(
      VaultTemplate administrator, URI endpoint, String ca, BootstrapIdentity.TlsIdentity tls)
      throws Exception {
    var databaseImage =
        DockerImageName.parse(
                "postgres:18.3-bookworm@sha256:"
                    + "80630f83606d8db77d30b3851b16a9f78be2d0d4dda6f7b82a1fdca5ebe3acba")
            .asCompatibleSubstituteFor("postgres");
    try (var database = new PostgreSQLContainer(databaseImage)) {
      database.start();
      administrator
          .opsForVersionedKeyValue("helm-kv")
          .put(
              "services/migration",
              Map.of(
                  "databaseUrl",
                  database.getJdbcUrl(),
                  "databaseUsername",
                  database.getUsername(),
                  "databasePassword",
                  database.getPassword()));
      administrator.write(
          "sys/policies/acl/helm-migration",
          Map.of(
              "policy", "path \"helm-kv/data/services/migration\" { capabilities = [\"read\"] }"));
      administrator.write(
          "auth/approle/role/helm-migration",
          Map.of(
              "token_policies",
              "helm-migration",
              "token_ttl",
              "5m",
              "token_max_ttl",
              "5m",
              "secret_id_num_uses",
              1));
      var role = administrator.read("auth/approle/role/helm-migration/role-id");
      var secret = administrator.write("auth/approle/role/helm-migration/secret-id", Map.of());
      assertThat(role).isNotNull();
      assertThat(secret).isNotNull();
      Path identity = directory.resolve("migration.json");
      Files.writeString(
          identity,
          JsonMapper.builder()
              .build()
              .writeValueAsString(
                  Map.of(
                      "schemaVersion",
                      1,
                      "vault",
                      Map.of(
                          "address",
                          endpoint.toString(),
                          "caPem",
                          ca,
                          "roleId",
                          role.getRequiredData().get("role_id"),
                          "secretId",
                          secret.getRequiredData().get("secret_id")))));
      String previous = System.getProperty("helm.bootstrap-identity");
      try {
        System.setProperty("helm.bootstrap-identity", identity.toString());
        MigrationApplication.run();
      } finally {
        if (previous == null) {
          System.clearProperty("helm.bootstrap-identity");
        } else {
          System.setProperty("helm.bootstrap-identity", previous);
        }
      }
      try (var connection =
              DriverManager.getConnection(
                  database.getJdbcUrl(), database.getUsername(), database.getPassword());
          var statement = connection.createStatement();
          var rows = statement.executeQuery("SELECT count(*) FROM databasechangelog")) {
        assertThat(rows.next()).isTrue();
        assertThat(rows.getInt(1)).isGreaterThanOrEqualTo(3);
      }
      verifyWorkerEnrollment(administrator, endpoint, ca, database);
      verifyRecoveryBootstrap(administrator, endpoint, ca, database, tls);
    }
  }

  private void verifyRecoveryBootstrap(
      VaultTemplate administrator,
      URI endpoint,
      String ca,
      PostgreSQLContainer database,
      BootstrapIdentity.TlsIdentity tls)
      throws Exception {
    String credential = UUID.randomUUID().toString();
    administrator
        .opsForVersionedKeyValue("helm-kv")
        .put(
            "services/api",
            Map.ofEntries(
                Map.entry("databaseUrl", database.getJdbcUrl()),
                Map.entry("databaseUsername", database.getUsername()),
                Map.entry("databasePassword", database.getPassword()),
                Map.entry("redisUsername", "fixture"),
                Map.entry("redisPassword", credential),
                Map.entry("s3AccessKey", "fixture"),
                Map.entry("s3SecretKey", credential),
                Map.entry("keycloakClientId", "fixture"),
                Map.entry("keycloakClientSecret", credential),
                Map.entry("turnSharedSecret", credential),
                Map.entry("mediaProxyUsername", "fixture"),
                Map.entry("mediaProxyPassword", credential),
                Map.entry("installationId", "fixture"),
                Map.entry("workerEnrollmentToken", credential)));
    var role = administrator.read("auth/approle/role/helm-api/role-id");
    var secret = administrator.write("auth/approle/role/helm-api/secret-id", Map.of());
    assertThat(role).isNotNull();
    assertThat(secret).isNotNull();
    Path identity = directory.resolve("recovery-api.json");
    var mapper = JsonMapper.builder().build();
    Files.writeString(
        identity,
        mapper.writeValueAsString(
            new BootstrapIdentity(
                1,
                new BootstrapIdentity.VaultIdentity(
                    endpoint.toString(),
                    ca,
                    String.valueOf(role.getRequiredData().get("role_id")),
                    String.valueOf(secret.getRequiredData().get("secret_id"))),
                tls)));
    var staged =
        Map.of(
            Path.of("/run/helm/api.crt"),
            tls.certificatePem(),
            Path.of("/run/helm/api.key"),
            tls.privateKeyPem(),
            Path.of("/run/helm/ca.crt"),
            ca);
    assertThat(staged.keySet()).allMatch(path -> !Files.exists(path));
    SpringApplication application =
        new SpringApplication(RecoveryApplication.RecoveryProcess.class);
    application.setWebApplicationType(WebApplicationType.NONE);
    application.setLogStartupInfo(false);
    try (var context =
        application.run(
            "--helm.process-role=api",
            "--helm.bootstrap-identity=" + identity,
            "--spring.liquibase.enabled=false",
            "--spring.data.redis.host=127.0.0.1",
            "--spring.data.redis.port=1",
            "--helm.s3.endpoint=https://127.0.0.1:1")) {
      assertThat(context.getBeansOfType(ScheduledAnnotationBeanPostProcessor.class)).isEmpty();
      assertThat(context.getBeansWithAnnotation(RestController.class)).isEmpty();
      var proof =
          new RecoveryProof(
              1,
              UUID.randomUUID(),
              "bootstrap-fixture",
              "fixture point",
              "fixture only",
              false,
              null,
              null,
              false,
              null,
              JsonSupport.sha256("fixture ledger"));
      String encoded = mapper.writeValueAsString(proof);
      Files.writeString(directory.resolve("proof.json"), encoded);
      var repository = context.getBean(RecoveryRepository.class);
      var transaction = new TransactionTemplate(context.getBean(PlatformTransactionManager.class));
      transaction.executeWithoutResult(
          status -> repository.begin(proof, JsonSupport.sha256(encoded)));
      var receipt = context.getBean(RecoveryService.class).status(directory);
      assertThat(receipt.recoveryId()).isEqualTo(proof.recoveryId());
      assertThat(receipt.proofHash()).isEqualTo(JsonSupport.sha256(encoded));
      assertThat(receipt.state()).isEqualTo("FENCING");
      assertThat(receipt.admissionState()).isEqualTo("RECOVERING");
      assertThat(repository.state(proof.recoveryId())).isEqualTo("FENCING");
    } finally {
      for (var entry : staged.entrySet()) {
        if (Files.exists(entry.getKey())) {
          assertThat(Files.readString(entry.getKey())).isEqualTo(entry.getValue());
          Files.delete(entry.getKey());
        }
      }
    }
  }

  private void verifyWorkerEnrollment(
      VaultTemplate administrator, URI endpoint, String ca, PostgreSQLContainer database)
      throws Exception {
    administrator.write("sys/mounts/helm-pki", Map.of("type", "pki"));
    administrator.write(
        "helm-pki/root/generate/internal", Map.of("common_name", "Helm fixture CA", "ttl", "1h"));
    administrator.write(
        "helm-pki/roles/browser-workers",
        Map.ofEntries(
            Map.entry("allowed_domains", List.of("browser-worker-*")),
            Map.entry("allow_glob_domains", true),
            Map.entry("allow_bare_domains", true),
            Map.entry("allow_subdomains", false),
            Map.entry("use_csr_common_name", false),
            Map.entry("use_csr_sans", false),
            Map.entry("allowed_uri_sans", List.of("urn:helm-glass:fixture:*")),
            Map.entry("server_flag", false),
            Map.entry("client_flag", true),
            Map.entry("key_type", "rsa"),
            Map.entry("key_bits", 3072),
            Map.entry("max_ttl", "15m")));
    Path store = directory.resolve("worker.p12");
    Path csr = directory.resolve("worker.csr");
    keytool(
        "-genkeypair",
        "-alias",
        "worker",
        "-keyalg",
        "RSA",
        "-keysize",
        "3072",
        "-dname",
        "CN=untrusted-csr-subject",
        "-keystore",
        store.toString(),
        "-storepass",
        "fixture-password",
        "-validity",
        "1");
    keytool(
        "-certreq",
        "-alias",
        "worker",
        "-keystore",
        store.toString(),
        "-storepass",
        "fixture-password",
        "-rfc",
        "-ext",
        "SAN=DNS:untrusted.example,URI:urn:foreign:boot",
        "-file",
        csr.toString());
    var dataSource =
        new DriverManagerDataSource(
            database.getJdbcUrl(), database.getUsername(), database.getPassword());
    var repository = new EnrollmentRepository(JdbcClient.create(dataSource));
    var runtime =
        JsonMapper.builder()
            .build()
            .convertValue(
                Map.of(
                    "installationId",
                    "fixture",
                    "workerEnrollmentToken",
                    "fixture-enrollment-token-0123456789"),
                RuntimeSecrets.class);
    var role = administrator.read("auth/approle/role/helm-api/role-id");
    var secret = administrator.write("auth/approle/role/helm-api/secret-id", Map.of());
    assertThat(role).isNotNull();
    assertThat(secret).isNotNull();
    var identity =
        new BootstrapIdentity.VaultIdentity(
            endpoint.toString(),
            ca,
            String.valueOf(role.getRequiredData().get("role_id")),
            String.valueOf(secret.getRequiredData().get("secret_id")));
    try (VaultSession session = new VaultSession(identity)) {
      WorkerEnrollmentService service =
          new WorkerEnrollmentService(
              runtime,
              repository,
              session.operations(),
              new DataSourceTransactionManager(dataSource),
              1);
      var request =
          new EnrollmentContracts.Request(
              1,
              "fixture",
              UUID.randomUUID(),
              UUID.randomUUID(),
              1,
              runtime.workerEnrollmentToken(),
              Files.readString(csr));
      var issued = service.enroll(request, null);
      X509Certificate certificate =
          (X509Certificate)
              CertificateFactory.getInstance("X.509")
                  .generateCertificate(
                      new ByteArrayInputStream(
                          issued.certificatePem().getBytes(StandardCharsets.US_ASCII)));
      assertThat(service.authenticate(certificate, request.workerId(), request.bootId()))
          .isEqualTo(issued.expiresAt());
      assertThat(service.enroll(request, null)).isEqualTo(issued);
      assertThatThrownBy(
              () -> service.authenticate(certificate, request.workerId(), UUID.randomUUID()))
          .isInstanceOf(DomainException.class);
      var excess =
          new EnrollmentContracts.Request(
              1,
              "fixture",
              UUID.randomUUID(),
              UUID.randomUUID(),
              1,
              runtime.workerEnrollmentToken(),
              Files.readString(csr));
      assertThatThrownBy(() -> service.enroll(excess, null))
          .isInstanceOf(DomainException.class)
          .hasMessageContaining("capacity");
      var expanded =
          new WorkerEnrollmentService(
              runtime,
              repository,
              session.operations(),
              new DataSourceTransactionManager(dataSource),
              2);
      assertThat(expanded.enroll(excess, null).workerId()).isEqualTo(excess.workerId());
      assertThat(expanded.enroll(request, null)).isEqualTo(issued);
    }
  }

  private static void keytool(String... arguments) throws Exception {
    var command = new ArrayList<String>();
    command.add(Path.of(System.getProperty("java.home"), "bin", "keytool").toString());
    command.addAll(List.of(arguments));
    Process process =
        new ProcessBuilder(command)
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start();
    if (!process.waitFor(30, TimeUnit.SECONDS)) {
      process.destroyForcibly();
      throw new IllegalStateException("Fixture CSR generation timed out");
    }
    assertThat(process.exitValue()).isZero();
  }
}
