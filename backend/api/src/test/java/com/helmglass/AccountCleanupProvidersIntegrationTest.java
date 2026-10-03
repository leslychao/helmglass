package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.account.application.AccountCleanupService;
import com.helmglass.account.application.AccountLifecycleService;
import com.helmglass.account.infrastructure.repository.AccountCleanupRepository;
import com.helmglass.account.infrastructure.repository.AccountDataRepository;
import com.helmglass.administration.api.AdminContracts;
import com.helmglass.administration.infrastructure.repository.AdministrationRepository;
import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.bootstrap.CertificateTrust;
import com.helmglass.bootstrap.RuntimeSecrets;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.KeycloakSessionClient;
import com.helmglass.identity.infrastructure.UserEphemeralState;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import com.helmglass.task.api.TaskContracts;
import com.helmglass.task.application.TaskLifecycleService;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.vault.authentication.TokenAuthentication;
import org.springframework.vault.client.VaultClient;
import org.springframework.vault.client.VaultEndpoint;
import org.springframework.vault.core.VaultTemplate;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.apache5.Apache5HttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.BucketVersioningStatus;
import software.amazon.awssdk.services.s3.model.S3Exception;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Run with Deploy/tests/account-cleanup.integration.mjs; no deployed account is used. */
@EnabledIfEnvironmentVariable(named = "HELM_ACCOUNT_PROVIDER_FIXTURE", matches = ".+")
@SpringJUnitConfig(AccountCleanupProvidersIntegrationTest.Owners.class)
class AccountCleanupProvidersIntegrationTest {
  private static final List<String> BUCKETS =
      List.of("hg-artifacts", "hg-browser-profiles", "hg-staging");

  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    AccountLifecycleService.class,
    AccountCleanupService.class,
    AccountCleanupRepository.class,
    AccountDataRepository.class,
    AdministrationRepository.class
  })
  static class Owners {
    @Bean(destroyMethod = "close")
    Providers providers() throws Exception {
      return new Providers();
    }

    @Bean
    KeycloakSessionClient keycloak(Providers providers, JsonSupport json) {
      RuntimeSecrets secrets =
          new RuntimeSecrets(
              "unused",
              "unused",
              "unused",
              "helm_api",
              "unused",
              "unused",
              "unused",
              "helm-api-service",
              providers.text("apiClientSecret"),
              "unused",
              "unused",
              "unused",
              "account-cleanup-fixture",
              "unused");
      return new KeycloakSessionClient(secrets, json, providers.text("keycloakAddress"), "helm");
    }

    @Bean
    UserEphemeralState ephemeral(Providers providers, IdentityRepository identities) {
      return new UserEphemeralState(providers.redis, identities);
    }

    @Bean
    ObjectStorage storage(Providers providers) {
      return new ObjectStorage(providers.s3);
    }

    @Bean
    ProfileKeyService keys(Providers providers) {
      return new ProfileKeyService(providers.vault);
    }
  }

  @Autowired private AccountLifecycleService accounts;
  @Autowired private AccountCleanupService cleanup;
  @Autowired private IdentityRepository identities;
  @Autowired private TaskLifecycleService tasks;
  @Autowired private JdbcClient jdbc;
  @Autowired private UserEphemeralState ephemeral;
  @Autowired private ProfileKeyService keys;
  @Autowired private Providers providers;
  @Autowired private PlatformTransactionManager transactions;

  @Test
  void purgesRealProvidersWithScopedCredentialsAndPreservesAnotherAccount() throws Exception {
    var admin = actor(UUID.randomUUID().toString(), true);
    var user = actor(providers.subject(0), false);
    var retained = actor(providers.subject(1), false);
    seed(user, 0);
    seed(retained, 1);
    assertThat(providers.refresh(0)).isEqualTo(200);
    assertThat(providers.refresh(1)).isEqualTo(200);
    assertThatThrownBy(
            () ->
                providers.s3.putObject(
                    request -> request.bucket("hg-artifacts").key("outside-user-scope"),
                    RequestBody.fromString("denied")))
        .isInstanceOfSatisfying(
            S3Exception.class, error -> assertThat(error.statusCode()).isEqualTo(403));
    assertThatThrownBy(() -> providers.vault.read("helm-kv/data/services/migration"))
        .isInstanceOf(org.springframework.vault.VaultException.class);

    var deletion =
        accounts.change(
            admin,
            user.userId(),
            new AdminContracts.Reason(1L, "Disposable provider acceptance"),
            context(),
            "delete");
    UUID requestId = deletion.resource().id();
    cleanup.processIdentity(user.userId());
    assertThat(providers.keycloakUser(0).path("enabled").asBoolean()).isFalse();
    assertThat(providers.refresh(0)).isEqualTo(400);
    assertThat(providers.refresh(1)).isEqualTo(200);
    assertRedisAbsent(user);
    cleanup.processPurge(requestId);
    assertThat(state(user.userId())).isEqualTo("DELETING");
    assertThat(providers.vault.opsForTransit("helm-transit").getKey("profiles-" + user.userId()))
        .isNotNull();

    // Advance only the disposable fixture's clock; the production retention remains 168 hours.
    jdbc.sql(
            "UPDATE account_deletion_requests SET delete_requested_at=now()-interval '169 hours',"
                + "restore_until=now()-interval '1 hour' WHERE id=:id")
        .param("id", requestId)
        .update();
    advance(requestId);
    assertThat(state(user.userId())).isEqualTo("PURGING");

    // A real provider denial must not become a successful purge or destroy the encryption key.
    String deny =
        "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Deny\","
            + "\"Principal\":\"*\",\"Action\":[\"s3:DeleteObjectVersion\"],"
            + "\"Resource\":[\"arn:aws:s3:::hg-artifacts/u/"
            + user.userId()
            + "/*\"]}]}";
    providers.rootS3.putBucketPolicy(value -> value.bucket("hg-artifacts").policy(deny));
    try {
      advance(requestId);
      assertThat(
              jdbc.sql(
                      "SELECT o.failure_code FROM operations o JOIN account_deletion_requests d ON"
                          + " d.purge_operation_id=o.id WHERE d.id=:id")
                  .param("id", requestId)
                  .query(String.class)
                  .single())
          .isEqualTo("PURGE_EFFECT_UNCONFIRMED");
      assertThat(providers.vault.opsForTransit("helm-transit").getKey("profiles-" + user.userId()))
          .isNotNull();
    } finally {
      providers.rootS3.deleteBucketPolicy(value -> value.bucket("hg-artifacts"));
    }

    boolean complete = false;
    for (int batch = 0; batch < 40; batch++) {
      advance(requestId);
      if (state(user.userId()).equals("DELETED")) {
        complete = true;
        break;
      }
    }
    assertThat(complete)
        .as("Bounded canonical cleanup must finish after provider recovery")
        .isTrue();
    for (String bucket : BUCKETS) {
      var versions =
          providers.rootS3.listObjectVersions(
              value -> value.bucket(bucket).prefix(prefix(user)).maxKeys(1));
      assertThat(versions.versions()).isEmpty();
      assertThat(versions.deleteMarkers()).isEmpty();
      assertThat(
              providers
                  .rootS3
                  .listMultipartUploads(
                      value -> value.bucket(bucket).prefix(prefix(user)).maxUploads(1))
                  .uploads())
          .isEmpty();
      assertThat(
              providers
                  .rootS3
                  .listObjectVersions(
                      value -> value.bucket(bucket).prefix(prefix(retained)).maxKeys(3))
                  .versions())
          .isNotEmpty();
      assertThat(
              providers
                  .rootS3
                  .listMultipartUploads(
                      value -> value.bucket(bucket).prefix(prefix(retained)).maxUploads(1))
                  .uploads())
          .hasSize(1);
    }
    assertThat(providers.vault.opsForTransit("helm-transit").getKey("profiles-" + user.userId()))
        .isNull();
    assertThat(
            providers.vault.opsForTransit("helm-transit").getKey("profiles-" + retained.userId()))
        .isNotNull();
    assertRedisAbsent(user);
    assertThat(providers.redis.opsForValue().get(redisKey(retained))).isEqualTo("disposable");
    assertThat(providers.oauthRedis.hasKey(proxyKey(retained))).isTrue();
    assertThat(providers.keycloakStatus(0)).isEqualTo(404);
    assertThat(providers.keycloakUser(1).path("enabled").asBoolean()).isTrue();
    assertThat(providers.refresh(1)).isEqualTo(200);
    assertThat(count("SELECT count(*) FROM tasks WHERE user_id=:id", user.userId())).isZero();
    assertThat(count("SELECT count(*) FROM tasks WHERE user_id=:id", retained.userId())).isOne();
    assertThat(
            count("SELECT count(*) FROM admin_audit_log WHERE target_user_id=:id", user.userId()))
        .isGreaterThanOrEqualTo(3);
    assertThat(
            jdbc.sql("SELECT email FROM application_users WHERE id=:id")
                .param("id", user.userId())
                .query(String.class)
                .single())
        .isEmpty();
    assertThatThrownBy(
            () ->
                new TransactionTemplate(transactions)
                    .execute(
                        status ->
                            identities.resolve(
                                providers.issuer(),
                                providers.subject(0),
                                "Old identity",
                                "old@example.test")))
        .isInstanceOf(DomainException.class)
        .hasMessageContaining("permanently deleted");
    cleanup.processPurge(requestId);
    assertThat(
            count(
                "SELECT count(*) FROM operations WHERE target_id=:id AND kind='ACCOUNT_PURGE'",
                requestId))
        .isOne();
  }

  private void seed(AuthenticatedActor user, int userIndex) {
    tasks.create(
        user,
        new TaskContracts.Create(
            "Disposable private draft",
            "https://example.com",
            List.of(),
            "TEXT",
            false,
            1800,
            "DRAFT"),
        context(),
        null);
    ephemeral.set(user.userId(), redisKey(user), "disposable", Duration.ofHours(1));
    ephemeral.registerProxySession(user.userId(), proxyKey(user));
    providers.oauthRedis.opsForValue().set(proxyKey(user), "disposable", Duration.ofHours(1));
    try (var material = keys.create(user.userId())) {
      assertThat(material.plaintext().length).isEqualTo(32);
    }
    for (String bucket : BUCKETS) {
      int versions = userIndex == 0 ? 105 : 2;
      for (int version = 0; version < versions; version++) {
        providers.s3.putObject(
            value -> value.bucket(bucket).key(prefix(user) + "fixture"),
            RequestBody.fromString("v" + version));
      }
      providers.s3.deleteObject(value -> value.bucket(bucket).key(prefix(user) + "fixture"));
      providers.s3.createMultipartUpload(
          value -> value.bucket(bucket).key(prefix(user) + "incomplete"));
    }
  }

  private void assertRedisAbsent(AuthenticatedActor user) {
    assertThat(providers.redis.opsForValue().get(redisKey(user))).isNull();
    assertThat(providers.oauthRedis.hasKey(proxyKey(user))).isFalse();
    assertThat(providers.redis.opsForSet().size("helm:user-state:" + user.userId())).isZero();
  }

  private AuthenticatedActor actor(String subject, boolean admin) {
    var account =
        Objects.requireNonNull(
            new TransactionTemplate(transactions)
                .execute(
                    status ->
                        identities.resolve(
                            providers.issuer(), subject, "Disposable", "fixture@example.test")));
    return new AuthenticatedActor(
        account.id(),
        UUID.randomUUID(),
        null,
        "helm-web",
        "Disposable",
        "fixture@example.test",
        1,
        admin ? Set.of("platform_admin") : Set.of(),
        false);
  }

  private void advance(UUID request) {
    jdbc.sql("UPDATE account_deletion_requests SET next_attempt_at=now() WHERE id=:id")
        .param("id", request)
        .update();
    cleanup.processPurge(request);
  }

  private String state(UUID user) {
    return jdbc.sql("SELECT state FROM application_users WHERE id=:id")
        .param("id", user)
        .query(String.class)
        .single();
  }

  private long count(String sql, UUID id) {
    return jdbc.sql(sql).param("id", id).query(Long.class).single();
  }

  private static String prefix(AuthenticatedActor user) {
    return "u/" + user.userId() + "/";
  }

  private static String redisKey(AuthenticatedActor user) {
    return "helm:ticket:" + user.userId();
  }

  private static String proxyKey(AuthenticatedActor user) {
    return "__Host-helm_session-" + user.userId().toString().replace("-", "");
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }

  static class Providers implements AutoCloseable {
    final JsonMapper json = JsonMapper.builder().build();
    final JsonNode input;
    final HttpClient http;
    final HttpClient vaultHttp;
    final S3Client s3;
    final S3Client rootS3;
    final LettuceConnectionFactory redisConnection;
    final LettuceConnectionFactory oauthConnection;
    final StringRedisTemplate redis;
    final StringRedisTemplate oauthRedis;
    final VaultTemplate vault;
    final String[] refreshTokens;
    String apiToken;

    Providers() throws Exception {
      Path path = Path.of(Objects.requireNonNull(System.getenv("HELM_ACCOUNT_PROVIDER_FIXTURE")));
      assertThat(Files.size(path)).isLessThan(65_536);
      try (InputStream bytes = Files.newInputStream(path)) {
        input = json.readTree(bytes);
      }
      http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
      vaultHttp =
          HttpClient.newBuilder()
              .sslContext(CertificateTrust.context(text("vaultCaPem")))
              .connectTimeout(Duration.ofSeconds(3))
              .build();
      s3 =
          s3(
              input.path("minio").path("apiAccessKey").asString(),
              input.path("minio").path("apiSecretKey").asString());
      rootS3 =
          s3(
              input.path("minio").path("rootUser").asString(),
              input.path("minio").path("rootPassword").asString());
      for (String bucket : BUCKETS) {
        rootS3.putBucketVersioning(
            value ->
                value
                    .bucket(bucket)
                    .versioningConfiguration(
                        config -> config.status(BucketVersioningStatus.ENABLED)));
      }
      redisConnection = redisConnection("helm_api", text("redisPassword"));
      oauthConnection = redisConnection("helm_oauth", text("oauthRedisPassword"));
      redis = new StringRedisTemplate(redisConnection);
      oauthRedis = new StringRedisTemplate(oauthConnection);
      var requestFactory = new JdkClientHttpRequestFactory(vaultHttp);
      requestFactory.setReadTimeout(Duration.ofSeconds(5));
      var client =
          VaultClient.builder()
              .endpoint(VaultEndpoint.from(URI.create("https://vault:8200")))
              .requestFactory(requestFactory)
              .build();
      var administrator =
          new VaultTemplate(client, new TokenAuthentication(text("vaultRootToken")));
      administrator.write("sys/mounts/helm-transit", Map.of("type", "transit"));
      administrator.write("sys/policies/acl/helm-api", Map.of("policy", text("vaultPolicy")));
      var token =
          Objects.requireNonNull(
              administrator.write(
                  "auth/token/create", Map.of("policies", List.of("helm-api"), "ttl", "15m")));
      vault =
          new VaultTemplate(
              client,
              new TokenAuthentication(
                  String.valueOf(Objects.requireNonNull(token.getAuth()).get("client_token"))));
      refreshTokens =
          new String[] {
            input.path("users").get(0).path("refreshToken").asString(),
            input.path("users").get(1).path("refreshToken").asString()
          };
      var response =
          request(
              "POST",
              "/realms/helm/protocol/openid-connect/token",
              "grant_type=client_credentials&client_id=helm-api-service&client_secret="
                  + encode(text("apiClientSecret")),
              null);
      assertThat(response.status()).isEqualTo(200);
      apiToken = response.body().path("access_token").asString();
    }

    String text(String name) {
      return input.path(name).asString();
    }

    String subject(int index) {
      return input.path("users").get(index).path("subject").asString();
    }

    String issuer() {
      return text("keycloakAddress") + "/realms/helm";
    }

    int refresh(int index) throws Exception {
      var response =
          request(
              "POST",
              "/realms/helm/protocol/openid-connect/token",
              "grant_type=refresh_token&client_id=helm-mcp&refresh_token="
                  + encode(refreshTokens[index]),
              null);
      if (response.status() == 200) {
        refreshTokens[index] = response.body().path("refresh_token").asString();
      }
      return response.status();
    }

    JsonNode keycloakUser(int index) throws Exception {
      var response = request("GET", "/admin/realms/helm/users/" + subject(index), null, apiToken);
      assertThat(response.status()).isEqualTo(200);
      return response.body();
    }

    int keycloakStatus(int index) throws Exception {
      return request("GET", "/admin/realms/helm/users/" + subject(index), null, apiToken).status();
    }

    private Reply request(String method, String path, String body, String bearer) throws Exception {
      var request =
          HttpRequest.newBuilder(URI.create(text("keycloakAddress") + path))
              .timeout(Duration.ofSeconds(5));
      if (bearer != null) {
        request.header("Authorization", "Bearer " + bearer);
      }
      if (body != null) {
        request.header("Content-Type", "application/x-www-form-urlencoded");
      }
      request.method(
          method,
          body == null
              ? HttpRequest.BodyPublishers.noBody()
              : HttpRequest.BodyPublishers.ofString(body));
      var response = http.send(request.build(), HttpResponse.BodyHandlers.ofInputStream());
      try (var stream = response.body()) {
        byte[] bytes = stream.readNBytes(65_537);
        if (bytes.length > 65_536) {
          throw new IllegalStateException("Fixture response exceeded bound");
        }
        return new Reply(
            response.statusCode(),
            bytes.length == 0 ? json.createObjectNode() : json.readTree(bytes));
      }
    }

    private S3Client s3(String access, String secret) throws Exception {
      var trust = CertificateTrust.managers(input.path("minio").path("caPem").asString());
      return S3Client.builder()
          .endpointOverride(URI.create("https://minio:9000"))
          .region(Region.US_EAST_1)
          .forcePathStyle(true)
          .httpClientBuilder(
              Apache5HttpClient.builder()
                  .tlsTrustManagersProvider(() -> trust)
                  .connectionTimeout(Duration.ofSeconds(3))
                  .socketTimeout(Duration.ofSeconds(5))
                  .maxConnections(2))
          .credentialsProvider(
              StaticCredentialsProvider.create(AwsBasicCredentials.create(access, secret)))
          .overrideConfiguration(
              value ->
                  value
                      .apiCallTimeout(Duration.ofSeconds(5))
                      .retryStrategy(retries -> retries.maxAttempts(1)))
          .build();
    }

    private static LettuceConnectionFactory redisConnection(String username, String password) {
      var config = new RedisStandaloneConfiguration("redis", 6379);
      config.setUsername(username);
      config.setPassword(password);
      var connection = new LettuceConnectionFactory(config);
      connection.afterPropertiesSet();
      connection.start();
      return connection;
    }

    private static String encode(String value) {
      return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private record Reply(int status, JsonNode body) {
      @Override
      public String toString() {
        return "ProviderReply[status=" + status + ",redacted]";
      }
    }

    @Override
    public void close() {
      redisConnection.destroy();
      oauthConnection.destroy();
      s3.close();
      rootS3.close();
      http.close();
      vaultHttp.close();
    }
  }
}
