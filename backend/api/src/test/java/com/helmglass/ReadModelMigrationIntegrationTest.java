package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;

import com.helmglass.api.JsonSupport;
import java.util.UUID;
import liquibase.command.CommandScope;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.postgresql.PostgreSQLContainer;

class ReadModelMigrationIntegrationTest {
  @Test
  void populatedPreviousSchemaRetainsResultFileMembershipWhenUpgraded() throws Exception {
    try (var database = new PostgreSQLContainer("postgres:18.3-bookworm")) {
      database.start();
      migrate(database, 13);
      JdbcClient jdbc = JdbcClient.create(new DriverManagerDataSource(database.getJdbcUrl(),
          database.getUsername(), database.getPassword()));
      UUID user = UUID.randomUUID();
      UUID task = UUID.randomUUID();
      UUID result = UUID.randomUUID();
      UUID file = UUID.randomUUID();
      jdbc.sql("""
          INSERT INTO application_users(id,issuer,subject,display_name,email,identity_hash)
          VALUES(:id,'https://issuer.example',:subject,'Migration test','migration@example.test',:hash)
          """).param("id", user).param("subject", user.toString())
          .param("hash", JsonSupport.sha256("https://issuer.example\n" + user)).update();
      jdbc.sql("""
          INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state,outcome)
          VALUES(:id,:user,'Completed report','Report','FILE','ANGULAR','COMPLETED','SUCCESS')
          """).param("id", task).param("user", user).update();
      jdbc.sql("""
          INSERT INTO task_results(id,task_id,revision,conclusion,final)
          VALUES(:id,:task,1,'Original report',true)
          """).param("id", result).param("task", task).update();
      jdbc.sql("""
          INSERT INTO task_artifacts(id,user_id,task_id,result_id,purpose,bucket,object_key,
            mime,size,checksum,filename,state,ready_at)
          VALUES(:id,:user,:task,:result,'FILE','hg-artifacts',:key,'text/plain',12,repeat('a',64),
            'original.txt','READY',now())
          """).param("id", file).param("user", user).param("task", task)
          .param("result", result).param("key", file.toString()).update();

      migrate(database, null);
      assertThat(jdbc.sql("""
          SELECT count(*) FROM task_results WHERE id=:id AND conclusion='Original report'
            AND final AND sections='[]'::jsonb AND sources='[]'::jsonb
            AND cardinality(artifact_ids)=1 AND :file=ANY(artifact_ids)
          """).param("id", result).param("file", file).query(Long.class).single()).isEqualTo(1);
      assertThat(jdbc.sql("""
          SELECT count(*) FROM task_artifacts WHERE id=:id AND result_id=:result
            AND filename='original.txt' AND state='READY'
          """).param("id", file).param("result", result).query(Long.class).single()).isEqualTo(1);
      migrate(database, null);
      assertThat(jdbc.sql("SELECT cardinality(artifact_ids) FROM task_results WHERE id=:id")
          .param("id", result).query(Integer.class).single()).isEqualTo(1);
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
