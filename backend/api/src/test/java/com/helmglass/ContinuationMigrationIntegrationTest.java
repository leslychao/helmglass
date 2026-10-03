package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;

import com.helmglass.api.JsonSupport;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import liquibase.command.CommandScope;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.postgresql.PostgreSQLContainer;

class ContinuationMigrationIntegrationTest {
  @Test
  void upgradeKeepsCurrentIdentitiesClaimsAndOriginalDeadlinesAndIsRepeatable() throws Exception {
    try (var database = new PostgreSQLContainer("postgres:18.3-bookworm")) {
      database.start();
      migrate(database, 30);
      var jdbc = JdbcClient.create(new DriverManagerDataSource(
          database.getJdbcUrl(), database.getUsername(), database.getPassword()));
      UUID user = UUID.randomUUID();
      jdbc.sql("""
          INSERT INTO application_users(id,issuer,subject,display_name,email,identity_hash)
          VALUES(:id,'https://issuer.example',:subject,'Migration fixture','fixture@example.test',:hash)
          """).param("id", user).param("subject", user.toString())
          .param("hash", JsonSupport.sha256("https://issuer.example\n" + user)).update();
      UUID claim = UUID.randomUUID();
      UUID ready = UUID.randomUUID();
      for (UUID id : List.of(claim, ready)) {
        jdbc.sql("""
            INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)
            VALUES(:id,:user,'Fixture','Fixture','TEXT','MCP','WAITING_AGENT')
            """).param("id", id).param("user", user).update();
        jdbc.sql("""
            INSERT INTO operations(id,user_id,kind,target_type,target_id,state,request_id)
            VALUES(:id,:user,'task.resume','task',:id,'SUCCEEDED',:id)
            """).param("id", id).param("user", user).update();
        jdbc.sql("""
            INSERT INTO task_continuations(id,task_id,user_id,source_operation_id,
              instruction_revision,reason,mode,binding_version,state,claim_id,expires_at)
            VALUES(:id,:id,:user,:id,1,'TASK_RESUMED','MANUAL',1,:state,:claim,now()+interval '10 minutes')
            """).param("id", id).param("user", user)
            .param("state", id.equals(claim) ? "CLAIMED" : "READY")
            .param("claim", id.equals(claim) ? claim : null).update();
      }
      Instant deadline = jdbc.sql("SELECT expires_at FROM task_continuations WHERE id=:id")
          .param("id", claim).query(Instant.class).single();
      migrate(database, null);
      migrate(database, null);
      assertThat(jdbc.sql("SELECT count(*) FROM task_continuations WHERE id IN (:claim,:ready)")
          .param("claim", claim).param("ready", ready).query(Long.class).single()).isEqualTo(2);
      var current = jdbc.sql("SELECT claim_id,expires_at,claim_expires_at,dispatch_id,state FROM task_continuations WHERE id=:id")
          .param("id", claim).query().singleRow();
      assertThat(current).containsEntry("claim_id", claim).containsEntry("state", "CLAIMED").containsEntry("dispatch_id", null);
      assertThat(jdbc.sql("SELECT expires_at FROM task_continuations WHERE id=:id")
          .param("id", claim).query(Instant.class).single()).isEqualTo(deadline);
      assertThat(jdbc.sql("SELECT claim_expires_at FROM task_continuations WHERE id=:id")
          .param("id", claim).query(Instant.class).single()).isEqualTo(deadline);
      assertThat(jdbc.sql("SELECT dispatch_not_before=created_at AND ready_at=created_at FROM task_continuations WHERE id=:id")
          .param("id", ready).query(Boolean.class).single()).isTrue();
    }
  }

  private static void migrate(PostgreSQLContainer database, Integer count) throws Exception {
    var command = new CommandScope(count == null ? "update" : "updateCount")
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
