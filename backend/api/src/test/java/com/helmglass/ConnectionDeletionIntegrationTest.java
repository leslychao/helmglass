package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verifyNoInteractions;

import com.helmglass.api.DomainException;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.artifact.infrastructure.ObjectStorage;
import com.helmglass.browser.application.WorkerProtocol;
import com.helmglass.browser.infrastructure.repository.BrowserCloseOutboxRepository;
import com.helmglass.browser.infrastructure.repository.BrowserRepository;
import com.helmglass.browser.infrastructure.repository.WorkerRegistryRepository;
import com.helmglass.connection.api.ConnectionContracts;
import com.helmglass.connection.application.ConnectionLoginService;
import com.helmglass.connection.application.ConnectionService;
import com.helmglass.connection.infrastructure.repository.ConnectionRepository;
import com.helmglass.connection.infrastructure.repository.ConnectionResolutionRepository;
import com.helmglass.connection.infrastructure.repository.LoginRepository;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.profile.application.BrowserProfileService;
import com.helmglass.profile.infrastructure.ProfileKeyService;
import com.helmglass.profile.infrastructure.repository.ProfileRepository;
import java.net.URI;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;

/** Real PostgreSQL and disposable MinIO; no application or runtime objects from the dev server. */
@SpringJUnitConfig(ConnectionDeletionIntegrationTest.Owners.class)
class ConnectionDeletionIntegrationTest {
  private static final String BUCKET = "hg-browser-profiles";
  private static final GenericContainer<?> MINIO =
      new GenericContainer<>("helmglass-minio:integration")
          .withEnv("MINIO_ROOT_USER", "integration")
          .withEnv("MINIO_ROOT_PASSWORD", "integration-disposable-password")
          .withCreateContainerCmdModifier(command -> command.withEntrypoint("/usr/bin/minio"))
          .withCommand("server", "/data")
          .withExposedPorts(9000)
          .waitingFor(Wait.forHttp("/minio/health/live").forPort(9000));

  static {
    MINIO.start();
  }

  @Configuration
  @Import({
    TaskLifecycleIntegrationTest.DatabaseConfiguration.class,
    ConnectionService.class,
    ConnectionLoginService.class,
    LoginRepository.class,
    ConnectionResolutionRepository.class,
    WorkerProtocol.class,
    BrowserProfileService.class,
    ProfileRepository.class,
    WorkerRegistryRepository.class
  })
  static class Owners {
    @Bean
    S3Client s3() {
      var client =
          S3Client.builder()
              .endpointOverride(
                  URI.create("http://" + MINIO.getHost() + ":" + MINIO.getMappedPort(9000)))
              .region(Region.US_EAST_1)
              .forcePathStyle(true)
              .credentialsProvider(
                  StaticCredentialsProvider.create(
                      AwsBasicCredentials.create("integration", "integration-disposable-password")))
              .overrideConfiguration(value -> value.apiCallTimeout(Duration.ofSeconds(5)))
              .build();
      client.createBucket(value -> value.bucket(BUCKET));
      return client;
    }

    @Bean
    ProfileKeyService keys() {
      return mock(ProfileKeyService.class);
    }

    @Bean
    ObjectStorage storage(S3Client s3) {
      return spy(new ObjectStorage(s3));
    }
  }

  @Autowired private ConnectionService connections;
  @Autowired private ConnectionRepository repository;
  @Autowired private IdentityRepository identities;
  @Autowired private OperationRepository operations;
  @Autowired private WorkerRegistryRepository registry;
  @Autowired private BrowserCloseOutboxRepository closeOutbox;
  @Autowired private BrowserRepository browsers;
  @Autowired private ProfileKeyService keys;
  @Autowired private ObjectStorage storage;
  @Autowired private JdbcClient jdbc;
  @Autowired private S3Client s3;
  @Autowired private PlatformTransactionManager transactions;

  @Test
  void acceptedDeletePurgesOnlyItsPrefixAndRetainsHistoryTombstonesAcrossBatches() {
    var actor = actor();
    UUID id = connection(actor);
    UUID other = connection(actor);
    UUID profile = profile(actor, id);
    String otherKey = prefix(actor, other) + "keep.enc";
    put(otherKey);
    for (int revision = 1; revision <= 105; revision++) {
      UUID version = UUID.randomUUID();
      String key = prefix(actor, id) + "p/" + profile + "/v/" + revision + ".enc";
      put(key);
      jdbc.sql(
              """
              INSERT INTO browser_profile_versions(id,profile_id,revision,object_key,wrapped_dek,
                vault_key_ref,runtime_version,origins_manifest,state,checksum,size)
              VALUES(:id,:profile,:revision,:key,'wrapped','user-key','test','{}','READY',:hash,64)
              """)
          .param("id", version)
          .param("profile", profile)
          .param("revision", revision)
          .param("key", key)
          .param("hash", "a".repeat(64))
          .update();
      if (revision == 105) {
        jdbc.sql("UPDATE browser_profiles SET current_version_id=:version WHERE id=:id")
            .param("version", version)
            .param("id", profile)
            .update();
      }
    }
    s3.createMultipartUpload(value -> value.bucket(BUCKET).key(prefix(actor, id) + "unfinished"));
    var context = context();
    var receipt = connections.delete(actor, id, context);
    assertThat(connections.delete(actor, id, context)).isEqualTo(receipt);
    advance(receipt.operationId());
    assertThat(connections.get(actor, id).status()).isEqualTo("DELETING");
    advance(receipt.operationId());
    assertThat(connections.get(actor, id).status()).isEqualTo("DELETING");
    advance(receipt.operationId());
    assertThat(connections.get(actor, id).status()).isEqualTo("DELETED");
    assertThat(operations.owned(actor.userId(), receipt.operationId()).state())
        .isEqualTo("SUCCEEDED");
    assertThat(s3.listObjectsV2(value -> value.bucket(BUCKET).prefix(prefix(actor, id))).contents())
        .isEmpty();
    assertThat(
            s3.listMultipartUploads(value -> value.bucket(BUCKET).prefix(prefix(actor, id)))
                .uploads())
        .isEmpty();
    assertThat(s3.headObject(value -> value.bucket(BUCKET).key(otherKey)).contentLength())
        .isEqualTo(64);
    assertThat(
            count(
                "SELECT count(*) FROM browser_profile_versions WHERE profile_id=:id AND"
                    + " state='DELETED' AND wrapped_dek=''",
                profile))
        .isEqualTo(105);
    assertThat(count("SELECT count(*) FROM connection_origins WHERE connection_id=:id", id))
        .isZero();
    assertThat(
            count("SELECT count(*) FROM sites WHERE id=:id", connections.get(actor, id).siteId()))
        .isOne();
    verifyNoInteractions(keys);
  }

  @Test
  void deletionWaitsForPhysicalClosureAndExpiredUploadLease() {
    var actor = actor();
    UUID id = connection(actor);
    UUID session = session(actor, id);
    UUID profile = profile(actor, id);
    UUID version = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO browser_profile_versions(id,profile_id,revision,object_key,wrapped_dek,
              vault_key_ref,runtime_version,origins_manifest) VALUES(:id,:profile,1,:key,'wrapped','key','test','{}')
            """)
        .param("id", version)
        .param("profile", profile)
        .param("key", prefix(actor, id) + "private.enc")
        .update();
    UUID transfer = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO profile_transfers(id,version_id,user_id,connection_id,session_id,worker_id,boot_id,
              allocation_epoch,privacy_epoch,control_epoch,policy_version,scope_version,expected_profile_version,
              direction,token_hash,state,expires_at,upload_lease_until)
            SELECT :id,:version,user_id,connection_id,id,worker_id,worker_boot_id,allocation_epoch,
              privacy_epoch,1,1,1,1,'SAVE',:hash,'UPLOADING',now()+interval '2 minutes',now()+interval '3 minutes'
            FROM browser_sessions WHERE id=:session
            """)
        .param("id", transfer)
        .param("version", version)
        .param("hash", "a".repeat(64))
        .param("session", session)
        .update();
    String key = prefix(actor, id) + "private.enc";
    put(key);
    var receipt = connections.delete(actor, id, context());
    advance(receipt.operationId());
    assertThat(operations.owned(actor.userId(), receipt.operationId()).state())
        .isEqualTo("RUNNING");
    UUID closeId =
        jdbc.sql(
                "SELECT id FROM transactional_outbox WHERE aggregate_id=:id AND"
                    + " event_type='worker.close'")
            .param("id", session)
            .query(UUID.class)
            .single();
    assertThat(closeOutbox.deliverable(closeId)).isTrue();
    jdbc.sql("UPDATE transactional_outbox SET delivery_attempts=8 WHERE id=:id")
        .param("id", closeId)
        .update();
    jdbc.sql("UPDATE operations SET state='NEEDS_ATTENTION' WHERE id=:id")
        .param("id", receipt.operationId())
        .update();
    assertThat(connections.delete(actor, id, context()).operationId())
        .isEqualTo(receipt.operationId());
    assertThat(
            count(
                "SELECT count(*) FROM transactional_outbox WHERE id=:id AND delivery_attempts=0",
                closeId))
        .isOne();
    assertThat(closeOutbox.deliverable(closeId)).isTrue();
    assertThat(s3.headObject(value -> value.bucket(BUCKET).key(key)).contentLength()).isEqualTo(64);
    new TransactionTemplate(transactions).executeWithoutResult(status -> registry.closed(session));
    advance(receipt.operationId());
    assertThat(connections.get(actor, id).status()).isEqualTo("DELETING");
    assertThat(s3.headObject(value -> value.bucket(BUCKET).key(key)).contentLength()).isEqualTo(64);
    jdbc.sql(
            "UPDATE profile_transfers SET upload_lease_until=now()-interval '1 second' WHERE"
                + " id=:id")
        .param("id", transfer)
        .update();
    advance(receipt.operationId());
    assertThat(connections.get(actor, id).status()).isEqualTo("DELETED");
  }

  @Test
  void taskChoicesExcludeDeletingConnectionsWithoutHidingTheirDeletionProgress() {
    var actor = actor();
    UUID deleting = connection(actor);
    UUID available = connection(actor);
    connections.delete(actor, deleting, context());
    var filters = new LinkedMultiValueMap<String, String>();
    assertThat(connections.list(actor, PageQuery.from(filters)).total()).isEqualTo(2);
    filters.add("excludeStatus", "DELETING");
    var choices = connections.list(actor, PageQuery.from(filters));
    assertThat(choices.total()).isOne();
    assertThat(choices.items())
        .extracting(ConnectionContracts.ConnectionView::id)
        .containsExactly(available);
    assertThat(connections.get(actor, deleting).capabilities().get("delete").allowed()).isTrue();
    filters.add("excludeStatus", "SAVED");
    assertThatThrownBy(() -> connections.list(actor, PageQuery.from(filters)))
        .isInstanceOf(DomainException.class)
        .hasMessage("Only DELETING may be excluded");
  }

  @Test
  void failedStorageIsNotSuccessAndExplicitRetryKeepsTheAcceptedOperation() {
    var actor = actor();
    UUID id = connection(actor);
    var receipt = connections.delete(actor, id, context());
    doThrow(new IllegalStateException("Injected unconfirmed storage response"))
        .doCallRealMethod()
        .when(storage)
        .purgeConnectionProfilesBatch(actor.userId(), id);
    jdbc.sql("UPDATE operations SET attempts=7 WHERE id=:id")
        .param("id", receipt.operationId())
        .update();
    advance(receipt.operationId());
    assertThat(operations.owned(actor.userId(), receipt.operationId()).state())
        .isEqualTo("NEEDS_ATTENTION");
    assertThat(connections.get(actor, id).status()).isEqualTo("DELETING");
    assertThat(connections.delete(actor, id, context()).operationId())
        .isEqualTo(receipt.operationId());
    advance(receipt.operationId());
    assertThat(operations.owned(actor.userId(), receipt.operationId()).state())
        .isEqualTo("SUCCEEDED");
  }

  @Test
  void foreignDeleteIsNotFoundAndLegacyPendingDeletionIsAdopted() {
    var actor = actor();
    UUID id = connection(actor);
    assertThatThrownBy(() -> connections.delete(actor(), id, context()))
        .isInstanceOf(DomainException.class)
        .hasMessage("Resource not found");
    var receipt =
        new TransactionTemplate(transactions)
            .execute(
                status -> {
                  repository.deleting(id);
                  return operations.save(
                      actor,
                      "connections.delete:" + id,
                      context(),
                      Map.of("connectionId", id),
                      "connection",
                      id,
                      2,
                      false);
                });
    advance(Objects.requireNonNull(receipt).operationId());
    assertThat(connections.get(actor, id).status()).isEqualTo("DELETED");
  }

  private void advance(UUID operation) {
    jdbc.sql("UPDATE operations SET next_attempt_at=now() WHERE id=:id")
        .param("id", operation)
        .update();
    var candidate =
        jdbc.sql(
                "SELECT id operation_id,user_id,target_id connection_id,progress,deadline FROM"
                    + " operations WHERE id=:id")
            .param("id", operation)
            .query(ConnectionRepository.Deletion.class)
            .single();
    connections.processDeletion(candidate);
  }

  private UUID connection(AuthenticatedActor actor) {
    return connections
        .create(
            actor, new ConnectionContracts.Create("Test", "https://example.com", "ASK"), context())
        .resource()
        .id();
  }

  private UUID profile(AuthenticatedActor actor, UUID connection) {
    UUID id = UUID.randomUUID();
    jdbc.sql("INSERT INTO browser_profiles(id,user_id,connection_id) VALUES(:id,:user,:connection)")
        .param("id", id)
        .param("user", actor.userId())
        .param("connection", connection)
        .update();
    return id;
  }

  private UUID session(AuthenticatedActor actor, UUID connection) {
    UUID worker = UUID.randomUUID();
    UUID boot = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO browser_workers(id,boot_id,capacity,image_version,observed_state,heartbeat_at)
            VALUES(:id,:boot,1,'test','READY',now())
            """)
        .param("id", worker)
        .param("boot", boot)
        .update();
    var session =
        Objects.requireNonNull(
            new TransactionTemplate(transactions)
                .execute(
                    status ->
                        browsers.reserve(
                            actor.userId(),
                            null,
                            connection,
                            "CONNECTION_LOGIN",
                            new BrowserRepository.Worker(worker, boot, 1),
                            600)));
    jdbc.sql(
            """
            UPDATE browser_sessions SET state='ACTIVE',privacy='LOGIN_PRIVATE',runtime_generation=:generation WHERE id=:id
            """)
        .param("generation", UUID.randomUUID())
        .param("id", session.id())
        .update();
    return session.id();
  }

  private AuthenticatedActor actor() {
    var account =
        Objects.requireNonNull(
            new TransactionTemplate(transactions)
                .execute(
                    status ->
                        identities.resolve(
                            "https://issuer.example",
                            UUID.randomUUID().toString(),
                            "Test",
                            "test@example.test")));
    return new AuthenticatedActor(
        account.id(),
        UUID.randomUUID(),
        null,
        "helm-web",
        account.displayName(),
        account.email(),
        account.accessEpoch(),
        Set.of(),
        false);
  }

  private static MutationContext context() {
    return new MutationContext(UUID.randomUUID().toString(), UUID.randomUUID());
  }

  private static String prefix(AuthenticatedActor actor, UUID id) {
    return "u/" + actor.userId() + "/c/" + id + "/";
  }

  private void put(String key) {
    s3.putObject(value -> value.bucket(BUCKET).key(key), RequestBody.fromBytes(new byte[64]));
  }

  private long count(String query, UUID id) {
    return jdbc.sql(query).param("id", id).query(Long.class).single();
  }
}
