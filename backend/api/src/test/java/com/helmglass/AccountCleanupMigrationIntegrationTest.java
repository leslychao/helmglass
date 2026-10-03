package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.account.infrastructure.repository.AccountCleanupRepository;
import com.helmglass.api.JsonSupport;
import java.util.UUID;
import liquibase.command.CommandScope;
import liquibase.exception.CommandExecutionException;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.json.JsonMapper;

class AccountCleanupMigrationIntegrationTest {
  @Test
  void upgradeRetiresPendingLedgerAndPreservesAccountAndCompletedHistory() throws Exception {
    try (var database = new PostgreSQLContainer("postgres:18.3-bookworm")) {
      database.start();
      migrate(database, 27);
      var jdbc =
          JdbcClient.create(
              new DriverManagerDataSource(
                  database.getJdbcUrl(), database.getUsername(), database.getPassword()));
      UUID user = UUID.randomUUID();
      UUID request = UUID.randomUUID();
      UUID operation = UUID.randomUUID();
      UUID completed = UUID.randomUUID();
      jdbc.sql(
              """
              INSERT INTO application_users(id,issuer,subject,display_name,email,identity_hash,state)
              VALUES(:id,'https://issuer.example',:subject,'Keep me','user@example.test',:hash,'PURGING')
              """)
          .param("id", user)
          .param("subject", user.toString())
          .param("hash", JsonSupport.sha256(user.toString()))
          .update();
      for (UUID id : new UUID[] {operation, completed}) {
        jdbc.sql(
                """
                INSERT INTO operations(id,kind,target_type,target_id,request_id,state,attempts)
                VALUES(:id,'ACCOUNT_PURGE','deletionRequest',:request,:id,'NEEDS_ATTENTION',3)
                """)
            .param("id", id)
            .param("request", request)
            .update();
      }
      jdbc.sql(
              """
              INSERT INTO account_deletion_requests(id,user_id,previous_account_state,status,
                delete_requested_at,restore_until,purge_operation_id,next_attempt_at)
              VALUES(:id,:user,'ACTIVE','PURGING',now()-interval '169 hours',
                now()-interval '1 hour',:operation,now()+interval '1 day')
              """)
          .param("id", request)
          .param("user", user)
          .param("operation", operation)
          .update();
      jdbc.sql(
              """
              INSERT INTO operation_items(operation_id,item_key,phase,state) VALUES
                (:operation,'01_LEDGER','01_LEDGER','PENDING'),
                (:operation,'02_RUNTIME','02_RUNTIME','PENDING'),
                (:completed,'01_LEDGER','01_LEDGER','SUCCEEDED')
              """)
          .param("operation", operation)
          .param("completed", completed)
          .update();

      // An unfinished old restore must not bypass its admission barrier during upgrade.
      jdbc.sql("UPDATE platform_settings SET recovery_state='REQUIRED'").update();
      assertThatThrownBy(() -> migrate(database, null))
          .isInstanceOf(CommandExecutionException.class);
      assertThat(jdbc.sql("SELECT count(*) FROM operation_items").query(Long.class).single())
          .isEqualTo(3);
      jdbc.sql("UPDATE platform_settings SET recovery_state='NORMAL'").update();
      migrate(database, null);

      var repository =
          new AccountCleanupRepository(jdbc, new JsonSupport(JsonMapper.builder().build()));
      assertThat(repository.duePurges()).contains(request);
      assertThat(repository.nextStage(operation).phase()).isEqualTo("02_RUNTIME");
      assertThat(
              jdbc.sql("SELECT display_name FROM application_users WHERE id=:id")
                  .param("id", user)
                  .query(String.class)
                  .single())
          .isEqualTo("Keep me");
      assertThat(
              jdbc.sql("SELECT state FROM operation_items WHERE operation_id=:id")
                  .param("id", completed)
                  .query(String.class)
                  .single())
          .isEqualTo("SUCCEEDED");
      assertThat(
              jdbc.sql("SELECT state FROM operations WHERE id=:id")
                  .param("id", completed)
                  .query(String.class)
                  .single())
          .isEqualTo("NEEDS_ATTENTION");
      migrate(database, null);
      assertThat(jdbc.sql("SELECT count(*) FROM operation_items").query(Long.class).single())
          .isEqualTo(2);
    }
  }

  private static void migrate(PostgreSQLContainer database, Integer count)
      throws CommandExecutionException {
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
