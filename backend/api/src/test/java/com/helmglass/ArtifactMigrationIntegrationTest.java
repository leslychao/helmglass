package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.JsonSupport;
import java.util.UUID;
import liquibase.command.CommandScope;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.postgresql.PostgreSQLContainer;

class ArtifactMigrationIntegrationTest {
  @Test
  void screenshotOwnershipUpgradePreservesAnExistingAudioTransfer() throws Exception {
    try (var database = new PostgreSQLContainer("postgres:18.3-bookworm")) {
      database.start();
      migrate(database, 26);
      var jdbc =
          JdbcClient.create(
              new DriverManagerDataSource(
                  database.getJdbcUrl(), database.getUsername(), database.getPassword()));
      UUID user = UUID.randomUUID();
      UUID task = UUID.randomUUID();
      UUID worker = UUID.randomUUID();
      UUID boot = UUID.randomUUID();
      UUID session = UUID.randomUUID();
      UUID command = UUID.randomUUID();
      UUID attempt = UUID.randomUUID();
      UUID artifact = UUID.randomUUID();
      UUID transfer = UUID.randomUUID();
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
              """
              INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)
              VALUES(:id,:user,'Original audio','Original audio','TEXT','ANGULAR','PAUSED')
              """)
          .param("id", task)
          .param("user", user)
          .update();
      jdbc.sql(
              "INSERT INTO browser_workers(id,boot_id,capacity,image_version)"
                  + " VALUES(:id,:boot,1,'fixture')")
          .param("id", worker)
          .param("boot", boot)
          .update();
      jdbc.sql(
              """
              INSERT INTO browser_sessions(id,user_id,task_id,worker_id,worker_boot_id,purpose,idle_deadline_at,budget_deadline_at)
              VALUES(:id,:user,:task,:worker,:boot,'TASK',now()+interval '10 minutes',now()+interval '10 minutes')
              """)
          .param("id", session)
          .param("user", user)
          .param("task", task)
          .param("worker", worker)
          .param("boot", boot)
          .update();
      jdbc.sql(
              """
              INSERT INTO task_commands(id,task_id,user_id,command_sequence,kind,payload,payload_hash,
                accepted_task_version,instruction_revision,expected_session_id,control_epoch,page_epoch,
                privacy_epoch,deadline)
              VALUES(:id,:task,:user,1,'READ_MEDIA','{}','fixture',1,1,:session,1,1,1,now()+interval '10 minutes')
              """)
          .param("id", command)
          .param("task", task)
          .param("user", user)
          .param("session", session)
          .update();
      jdbc.sql(
              """
              INSERT INTO command_attempts(id,command_id,session_id,worker_id,attempt_no,assignment_epoch,control_epoch)
              VALUES(:id,:command,:session,:worker,1,1,1)
              """)
          .param("id", attempt)
          .param("command", command)
          .param("session", session)
          .param("worker", worker)
          .update();
      jdbc.sql(
              """
              INSERT INTO task_artifacts(id,user_id,task_id,purpose,bucket,object_key,mime,size,checksum,filename)
              VALUES(:id,:user,:task,'AUDIO','hg-artifacts',:key,'audio/wav',8,repeat('a',64),'original.wav')
              """)
          .param("id", artifact)
          .param("user", user)
          .param("task", task)
          .param("key", artifact.toString())
          .update();
      jdbc.sql(
              """
              INSERT INTO artifact_transfers(id,artifact_id,attempt_id,command_id,session_id,user_id,
                worker_id,boot_id,allocation_epoch,page_epoch,privacy_epoch,control_epoch,policy_version,metadata_hash,token_hash)
              VALUES(:id,:artifact,:attempt,:command,:session,:user,:worker,:boot,1,1,1,1,1,repeat('b',64),repeat('c',64))
              """)
          .param("id", transfer)
          .param("artifact", artifact)
          .param("attempt", attempt)
          .param("command", command)
          .param("session", session)
          .param("user", user)
          .param("worker", worker)
          .param("boot", boot)
          .update();

      migrate(database, null);
      assertThat(
              jdbc.sql(
                      """
                      SELECT count(*) FROM artifact_transfers t JOIN task_artifacts a ON a.id=t.artifact_id
                      WHERE t.id=:id AND t.attempt_id=:attempt AND t.command_id=:command
                        AND t.human_command_id IS NULL AND t.human_attempt_id IS NULL
                        AND a.filename='original.wav' AND a.checksum=repeat('a',64)
                      """)
                  .param("id", transfer)
                  .param("attempt", attempt)
                  .param("command", command)
                  .query(Long.class)
                  .single())
          .isEqualTo(1);
      assertThatThrownBy(
              () ->
                  jdbc.sql(
                          "UPDATE artifact_transfers SET attempt_id=NULL,command_id=NULL WHERE"
                              + " id=:id")
                      .param("id", transfer)
                      .update())
          .isInstanceOf(DataIntegrityViolationException.class);
      migrate(database, null);
      assertThat(
              jdbc.sql("SELECT count(*) FROM artifact_transfers WHERE id=:id")
                  .param("id", transfer)
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
