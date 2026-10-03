package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;

import com.helmglass.api.JsonSupport;
import java.time.Instant;
import java.util.UUID;
import liquibase.command.CommandScope;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.postgresql.PostgreSQLContainer;

class BrowserCloseMigrationIntegrationTest {
  @Test
  void upgradePreservesPendingAndExhaustedDeliveryWithoutResettingAttempts() throws Exception {
    try (var database = new PostgreSQLContainer("postgres:18.3-bookworm")) {
      database.start();
      migrate(database, 28);
      var jdbc =
          JdbcClient.create(
              new DriverManagerDataSource(
                  database.getJdbcUrl(), database.getUsername(), database.getPassword()));
      UUID user = UUID.randomUUID();
      UUID worker = UUID.randomUUID();
      UUID boot = UUID.randomUUID();
      UUID pending = UUID.randomUUID();
      UUID exhausted = UUID.randomUUID();
      jdbc.sql(
              """
              INSERT INTO application_users(id,issuer,subject,display_name,email,identity_hash)
              VALUES(:id,'https://issuer.example',:subject,'Migration fixture','fixture@example.test',:hash)
              """)
          .param("id", user)
          .param("subject", user.toString())
          .param("hash", JsonSupport.sha256("https://issuer.example\n" + user))
          .update();
      jdbc.sql(
              "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                  + " VALUES(:id,:boot,1,'fixture')")
          .param("id", worker)
          .param("boot", boot)
          .update();
      jdbc.sql(
              """
              INSERT INTO browser_sessions(id,user_id,worker_id,worker_boot_id,purpose,state,
                idle_deadline_at,budget_deadline_at,close_attempts,next_close_at)
              VALUES(:pending,:user,:worker,:boot,'CONNECTION_LOGIN','STOPPING',now(),now(),3,now()+interval '20 seconds'),
                (:exhausted,:user,:worker,:boot,'CONNECTION_LOGIN','LOST',now(),now(),8,now()+interval '30 seconds')
              """)
          .param("pending", pending)
          .param("exhausted", exhausted)
          .param("user", user)
          .param("worker", worker)
          .param("boot", boot)
          .update();
      var pendingRetry =
          jdbc.sql("SELECT next_close_at FROM browser_sessions WHERE id=:id")
              .param("id", pending)
              .query(Instant.class)
              .single();
      migrate(database, null);
      var saved =
          jdbc.sql(
                  """
                  SELECT id,delivery_attempts,retry_at,published_at FROM transactional_outbox
                  WHERE aggregate_id=:id AND event_type='worker.close'
                  """)
              .param("id", pending)
              .query()
              .singleRow();
      UUID messageId = (UUID) saved.get("id");
      assertThat(saved.get("delivery_attempts")).isEqualTo(3);
      assertThat(
              jdbc.sql("SELECT retry_at FROM transactional_outbox WHERE id=:id")
                  .param("id", messageId)
                  .query(Instant.class)
                  .single())
          .isEqualTo(pendingRetry);
      assertThat(saved.get("published_at")).isNull();
      assertThat(
              jdbc.sql(
                      """
                      SELECT count(*) FROM transactional_outbox WHERE aggregate_id=:id
                        AND event_type='worker.close' AND delivery_attempts=8 AND published_at IS NULL
                        AND last_failure_code='CLOSE_ACK_PENDING' AND payload->>'workerBootId'=:boot
                      """)
                  .param("id", exhausted)
                  .param("boot", boot.toString())
                  .query(Long.class)
                  .single())
          .isEqualTo(1);
      migrate(database, null);
      assertThat(
              jdbc.sql(
                      "SELECT id FROM transactional_outbox WHERE aggregate_id=:id AND"
                          + " event_type='worker.close'")
                  .param("id", pending)
                  .query(UUID.class)
                  .single())
          .isEqualTo(messageId);
      assertThat(
              jdbc.sql(
                      "SELECT count(*) FROM browser_sessions WHERE id IN (:pending,:exhausted) AND"
                          + " binding_released_at IS NULL")
                  .param("pending", pending)
                  .param("exhausted", exhausted)
                  .query(Long.class)
                  .single())
          .isEqualTo(2);
    }
  }

  private static void migrate(PostgreSQLContainer database, Integer count) throws Exception {
    var command =
        new CommandScope(count == null ? "update" : "updateCount")
            .addArgumentValue("changelogFile", "db/changelog/master.xml")
            .addArgumentValue("url", database.getJdbcUrl())
            .addArgumentValue("username", database.getUsername())
            .addArgumentValue("password", database.getPassword());
    if (count != null) {
      command.addArgumentValue("count", count);
    }
    command.execute();
  }
}
