package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;

import com.helmglass.api.JsonSupport;
import java.util.List;
import java.util.UUID;
import liquibase.command.CommandScope;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.postgresql.PostgreSQLContainer;

class TaskEventMigrationIntegrationTest {
  @Test
  void populatedUpgradePreservesEventsAndCountersAndCreatesStableKeysIncludingEmptyHistory()
      throws Exception {
    try (var database = new PostgreSQLContainer("postgres:18.3-bookworm")) {
      database.start();
      migrate(database, 36);
      var jdbc =
          JdbcClient.create(
              new DriverManagerDataSource(
                  database.getJdbcUrl(), database.getUsername(), database.getPassword()));
      UUID user = UUID.randomUUID();
      jdbc.sql(
              """
              INSERT INTO application_users(id,issuer,subject,display_name,email,identity_hash)
              VALUES(:id,'https://issuer.example',:subject,'History fixture','history@example.test',:hash)
              """)
          .param("id", user)
          .param("subject", user.toString())
          .param("hash", JsonSupport.sha256("https://issuer.example\n" + user))
          .update();
      UUID populated = UUID.randomUUID();
      UUID missingCounter = UUID.randomUUID();
      UUID empty = UUID.randomUUID();
      for (UUID task : List.of(populated, missingCounter, empty)) {
        jdbc.sql(
                """
                INSERT INTO tasks(id,user_id,goal,title,output_format,origin,state)
                VALUES(:id,:user,'Preserve goal','Preserve title','TEXT','ANGULAR','DRAFT')
                """)
            .param("id", task)
            .param("user", user)
            .update();
      }
      for (UUID task : List.of(populated, missingCounter)) {
        jdbc.sql(
                """
                INSERT INTO task_execution_events(task_id,sequence,event_id,type,code,summary)
                SELECT :task,n,gen_random_uuid(),'SYSTEM','SAFE_EVENT','Safe history'
                FROM generate_series(1,25) AS n
                """)
            .param("task", task)
            .update();
      }
      jdbc.sql(
              """
              INSERT INTO task_event_counters(task_id,next_sequence,event_count,confirmed_step_count)
              VALUES(:task,26,25,7)
              """)
          .param("task", populated)
          .update();
      String eventsBefore =
          jdbc.sql(
                  """
                  SELECT md5(string_agg(row_to_json(e)::text,',' ORDER BY task_id,sequence))
                  FROM task_execution_events e
                  """)
              .query(String.class)
              .single();
      migrate(database, null);
      var beforeRepeat =
          jdbc.sql(
                  """
                  SELECT task_id,next_sequence,event_count,confirmed_step_count,snapshot_key
                  FROM task_event_counters ORDER BY task_id
                  """)
              .query()
              .listOfRows();
      assertThat(beforeRepeat).hasSize(3);
      assertThat(beforeRepeat)
          .allSatisfy(row -> assertThat(row.get("snapshot_key")).isInstanceOf(UUID.class));
      assertThat(beforeRepeat.stream().map(row -> row.get("snapshot_key")).distinct().count())
          .isEqualTo(3);
      assertThat(
              beforeRepeat.stream()
                  .filter(row -> row.get("task_id").equals(populated))
                  .findFirst()
                  .orElseThrow())
          .containsEntry("next_sequence", 26L)
          .containsEntry("event_count", 25L)
          .containsEntry("confirmed_step_count", 7L);
      assertThat(
              beforeRepeat.stream()
                  .filter(row -> row.get("task_id").equals(missingCounter))
                  .findFirst()
                  .orElseThrow())
          .containsEntry("next_sequence", 26L)
          .containsEntry("event_count", 25L);
      assertThat(
              beforeRepeat.stream()
                  .filter(row -> row.get("task_id").equals(empty))
                  .findFirst()
                  .orElseThrow())
          .containsEntry("next_sequence", 1L)
          .containsEntry("event_count", 0L);
      migrate(database, null);
      assertThat(
              jdbc.sql(
                      """
                      SELECT task_id,next_sequence,event_count,confirmed_step_count,snapshot_key
                      FROM task_event_counters ORDER BY task_id
                      """)
                  .query()
                  .listOfRows())
          .isEqualTo(beforeRepeat);
      assertThat(
              jdbc.sql(
                      """
                      SELECT md5(string_agg(row_to_json(e)::text,',' ORDER BY task_id,sequence))
                      FROM task_execution_events e
                      """)
                  .query(String.class)
                  .single())
          .isEqualTo(eventsBefore);
      assertThat(
              jdbc.sql("SELECT count(*) FROM tasks WHERE user_id=:user AND goal='Preserve goal'")
                  .param("user", user)
                  .query(Long.class)
                  .single())
          .isEqualTo(3);
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
