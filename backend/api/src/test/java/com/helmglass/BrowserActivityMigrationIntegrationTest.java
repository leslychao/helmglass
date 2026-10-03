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

class BrowserActivityMigrationIntegrationTest {
  @Test
  void populatedUpgradePreservesDeadlinesWithoutInventingHistoricalActivity() throws Exception {
    try (var database = new PostgreSQLContainer("postgres:18.3-bookworm")) {
      database.start();
      migrate(database, 35);
      var jdbc =
          JdbcClient.create(
              new DriverManagerDataSource(
                  database.getJdbcUrl(), database.getUsername(), database.getPassword()));
      UUID user = UUID.randomUUID();
      UUID session = UUID.randomUUID();
      jdbc.sql(
              """
              INSERT INTO application_users(id,issuer,subject,display_name,email,identity_hash)
              VALUES(:id,'https://issuer.example',:subject,'Migration','fixture@example.test',:hash)
              """)
          .param("id", user)
          .param("subject", user.toString())
          .param("hash", JsonSupport.sha256("https://issuer.example\n" + user))
          .update();
      jdbc.sql(
              """
              INSERT INTO browser_sessions(id,user_id,purpose,state,privacy,last_activity_at,idle_deadline_at,budget_deadline_at)
              VALUES(:id,:user,'CONNECTION_LOGIN','ACTIVE','LOGIN_PRIVATE',now()-interval '3 minutes',
                now()+interval '7 minutes',now()+interval '25 minutes')
              """)
          .param("id", session)
          .param("user", user)
          .update();
      record Existing(
          UUID userId,
          String privacy,
          Instant lastActivityAt,
          Instant idleDeadlineAt,
          Instant budgetDeadlineAt,
          long version) {}
      var before =
          jdbc.sql("SELECT * FROM browser_sessions WHERE id=:id")
              .param("id", session)
              .query(Existing.class)
              .single();
      migrate(database, null);
      migrate(database, null);
      assertThat(
              jdbc.sql("SELECT * FROM browser_sessions WHERE id=:id")
                  .param("id", session)
                  .query(Existing.class)
                  .single())
          .isEqualTo(before);
      assertThat(
              jdbc.sql(
                      "SELECT activity_input_epoch,activity_input_sequence FROM browser_sessions"
                          + " WHERE id=:id")
                  .param("id", session)
                  .query()
                  .singleRow())
          .containsEntry("activity_input_epoch", 0L)
          .containsEntry("activity_input_sequence", 0L);
      assertThat(
              jdbc.sql("SELECT count(*) FROM databasechangelog WHERE id='036-browser-activity'")
                  .query(Long.class)
                  .single())
          .isEqualTo(1);
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
