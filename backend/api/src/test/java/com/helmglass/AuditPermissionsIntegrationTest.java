package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.SQLException;
import liquibase.integration.spring.SpringLiquibase;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.postgresql.PostgreSQLContainer;

class AuditPermissionsIntegrationTest {
  @Test
  void applicationRoleCanAppendAndReadButCannotRewriteAudit() throws Exception {
    try (var database = new PostgreSQLContainer("postgres:18.3-bookworm")) {
      database.start();
      var source = new DriverManagerDataSource(database.getJdbcUrl(), database.getUsername(),
          database.getPassword());
      JdbcClient owner = JdbcClient.create(source);
      owner.sql("CREATE ROLE helm_api NOLOGIN").update();
      owner.sql("GRANT USAGE ON SCHEMA public TO helm_api").update();
      owner.sql("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO helm_api").update();
      owner.sql("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO helm_api").update();
      var migrations = new SpringLiquibase();
      migrations.setDataSource(source);
      migrations.setChangeLog("classpath:db/changelog/master.xml");
      migrations.afterPropertiesSet();

      try (var connection = source.getConnection(); var statement = connection.createStatement()) {
        statement.execute("SET ROLE helm_api");
        assertThat(statement.executeUpdate("""
            INSERT INTO admin_audit_log(id,actor_id,actor_name,actor_email,target_id,target_type,
            action,reason,previous_value,new_value,operation_id,request_id)
            VALUES(gen_random_uuid(),gen_random_uuid(),'Test administrator','admin@example.test',
            gen_random_uuid(),'user','BLOCK','Verified test operation','{}','{}',
            gen_random_uuid(),gen_random_uuid())
            """)).isEqualTo(1);
        try (var rows = statement.executeQuery("SELECT count(*) FROM admin_audit_log")) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getLong(1)).isEqualTo(1);
        }
        assertThatThrownBy(() -> statement.executeUpdate("UPDATE admin_audit_log SET reason='rewritten'"))
            .isInstanceOfSatisfying(SQLException.class, error -> assertThat(error.getSQLState()).isEqualTo("42501"));
        assertThatThrownBy(() -> statement.executeUpdate("DELETE FROM admin_audit_log"))
            .isInstanceOfSatisfying(SQLException.class, error -> assertThat(error.getSQLState()).isEqualTo("42501"));
        assertThatThrownBy(() -> statement.executeUpdate("TRUNCATE admin_audit_log"))
            .isInstanceOfSatisfying(SQLException.class, error -> assertThat(error.getSQLState()).isEqualTo("42501"));
      }
    }
  }
}
