package com.helmglass.account.infrastructure.repository;

import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Bounded metadata erasure in foreign-key order; retained audit and tombstones are excluded. */
@Repository
public class AccountDataRepository {
  private static final int BATCH_SIZE = 500;
  private static final List<String> DETACH =
      List.of(
          "UPDATE operations SET source_command_id=NULL WHERE ctid IN (SELECT ctid FROM operations"
              + " WHERE source_command_id IN (SELECT id FROM task_commands WHERE user_id=:user)"
              + " LIMIT :limit)",
          "UPDATE operations SET source_human_operation_id=NULL WHERE ctid IN (SELECT ctid FROM"
              + " operations WHERE source_human_operation_id IN (SELECT id FROM operations WHERE"
              + " user_id=:user) LIMIT :limit)",
          "UPDATE task_artifacts SET parent_artifact_id=NULL,result_id=NULL WHERE ctid IN (SELECT"
              + " ctid FROM task_artifacts WHERE user_id=:user AND (parent_artifact_id IS NOT NULL"
              + " OR result_id IS NOT NULL) LIMIT :limit)",
          "UPDATE browser_profiles SET current_version_id=NULL WHERE ctid IN (SELECT ctid FROM"
              + " browser_profiles WHERE user_id=:user AND current_version_id IS NOT NULL LIMIT"
              + " :limit)");

  private record Table(String name, String predicate) {}

  private static final List<Table> TABLES =
      List.of(
          new Table("task_continuations", "user_id=:user"),
          new Table("chat_view_slots", "user_id=:user"),
          new Table("notifications", "user_id=:user"),
          new Table("usage_measurements", "user_id=:user"),
          new Table(
              "session_usage_checkpoints",
              "session_id IN (SELECT id FROM browser_sessions WHERE user_id=:user)"),
          new Table("artifact_transfers", "user_id=:user"),
          new Table(
              "upload_parts", "artifact_id IN (SELECT id FROM task_artifacts WHERE user_id=:user)"),
          new Table("task_artifacts", "user_id=:user"),
          new Table(
              "task_result_rows",
              "result_id IN (SELECT r.id FROM task_results r JOIN tasks t ON t.id=r.task_id WHERE"
                  + " t.user_id=:user)"),
          new Table("task_results", "task_id IN (SELECT id FROM tasks WHERE user_id=:user)"),
          new Table(
              "user_action_requests", "task_id IN (SELECT id FROM tasks WHERE user_id=:user)"),
          new Table("task_clarifications", "user_id=:user"),
          new Table(
              "task_execution_events", "task_id IN (SELECT id FROM tasks WHERE user_id=:user)"),
          new Table("task_event_counters", "task_id IN (SELECT id FROM tasks WHERE user_id=:user)"),
          new Table("task_usage_totals", "task_id IN (SELECT id FROM tasks WHERE user_id=:user)"),
          new Table(
              "browser_profile_startups",
              "session_id IN (SELECT id FROM browser_sessions WHERE user_id=:user)"),
          new Table("browser_session_operations", "user_id=:user"),
          new Table("profile_transfers", "user_id=:user"),
          new Table("session_operation_commands", "user_id=:user"),
          new Table("human_browser_commands", "user_id=:user"),
          new Table("connection_login_operations", "user_id=:user"),
          new Table("account_identity_jobs", "user_id=:user"),
          new Table(
              "operation_items", "operation_id IN (SELECT id FROM operations WHERE user_id=:user)"),
          new Table("idempotency_records", "user_id=:user"),
          new Table("operations", "user_id=:user"),
          new Table(
              "command_attempts",
              "command_id IN (SELECT id FROM task_commands WHERE user_id=:user)"),
          new Table("task_commands", "user_id=:user"),
          new Table(
              "browser_control_leases",
              "session_id IN (SELECT id FROM browser_sessions WHERE user_id=:user)"),
          new Table("browser_allocations", "user_id=:user"),
          new Table("browser_sessions", "user_id=:user"),
          new Table("task_connections", "user_id=:user"),
          new Table("tasks", "user_id=:user"),
          new Table(
              "browser_profile_versions",
              "profile_id IN (SELECT id FROM browser_profiles WHERE user_id=:user)"),
          new Table("browser_profiles", "user_id=:user"),
          new Table("connection_origins", "user_id=:user"),
          new Table("connections", "user_id=:user"),
          new Table("client_grants", "user_id=:user"),
          new Table("application_logins", "user_id=:user"),
          new Table("user_sites", "user_id=:user"),
          new Table("user_site_rules", "user_id=:user"),
          new Table("user_policies", "user_id=:user"),
          new Table("admin_user_limits", "user_id=:user"),
          new Table("transactional_outbox", "user_id=:user"),
          new Table("list_revisions", "scope_id=:user"));

  private final JdbcClient jdbc;

  public AccountDataRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** Returns true only after a complete pass confirms there are no remaining owned records. */
  public boolean purgeBatch(UUID userId) {
    if (jdbc.sql("""
            SELECT EXISTS(SELECT 1 FROM transactional_outbox WHERE user_id=:user
              AND event_type='worker.close' AND published_at IS NULL)
            """)
        .param("user", userId).query(Boolean.class).single()) {
      return false;
    }
    for (String statement : DETACH) {
      if (jdbc.sql(statement).param("user", userId).param("limit", BATCH_SIZE).update() > 0) {
        return false;
      }
    }
    for (Table table : TABLES) {
      String statement =
          "DELETE FROM "
              + table.name()
              + " WHERE ctid IN (SELECT ctid FROM "
              + table.name()
              + " WHERE "
              + table.predicate()
              + " LIMIT :limit)";
      if (jdbc.sql(statement).param("user", userId).param("limit", BATCH_SIZE).update() > 0) {
        return false;
      }
    }
    return true;
  }

  public List<UUID> loginIds(UUID userId) {
    return jdbc.sql(
            "SELECT id FROM application_logins WHERE user_id=:user ORDER BY id LIMIT :limit")
        .param("user", userId)
        .param("limit", BATCH_SIZE)
        .query(UUID.class)
        .list();
  }
}
