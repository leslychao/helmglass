package com.helmglass.identity.infrastructure.repository;

import com.helmglass.api.JsonSupport;
import com.helmglass.identity.api.PolicyContracts;
import com.helmglass.identity.domain.QuotaCeiling;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class PolicyRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public PolicyRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public PolicyContracts.Policy get(UUID userId) {
    var origins =
        jdbc.sql("SELECT origin FROM user_site_rules WHERE user_id=:id ORDER BY origin")
            .param("id", userId)
            .query(String.class)
            .list();
    return jdbc.sql(
            """
            SELECT p.*,l.browser_mode,l.browser_custom,l.queued_mode,l.queued_custom,s.standard_browser_limit
            FROM user_policies p JOIN admin_user_limits l ON l.user_id=p.user_id
            CROSS JOIN platform_settings s WHERE p.user_id=:id
            """)
        .param("id", userId)
        .query(
            (row, index) -> {
              var browser =
                  QuotaCeiling.browsers(
                      row.getString("browser_mode"),
                      row.getObject("browser_custom", Integer.class),
                      row.getInt("standard_browser_limit"),
                      row.getObject("browser_limit", Integer.class));
              var queued =
                  QuotaCeiling.queued(
                      row.getString("queued_mode"),
                      row.getObject("queued_custom", Integer.class),
                      row.getObject("queued_limit", Integer.class));
              return new PolicyContracts.Policy(
                  row.getLong("version"),
                  row.getString("site_mode"),
                  row.getString("connection_mode"),
                  strings(row.getString("prohibited_actions")),
                  row.getBoolean("require_confirmation"),
                  origins,
                  row.getObject("max_commands_per_run", Integer.class),
                  row.getObject("max_active_seconds_per_run", Integer.class),
                  row.getObject("max_parallel_runs", Integer.class),
                  row.getObject("queued_limit", Integer.class),
                  row.getObject("max_retained_media_bytes", Long.class),
                  browser.personal(),
                  new PolicyContracts.Quotas(
                      browser.assigned(),
                      queued.assigned(),
                      browser.effective(),
                      queued.effective()));
            })
        .single();
  }

  public void update(UUID userId, PolicyContracts.Update update) {
    jdbc.sql(
            """
            UPDATE user_policies SET site_mode=:site,connection_mode=:connection,
            prohibited_actions=CAST(:actions AS jsonb),require_confirmation=:confirmation,
            max_commands_per_run=:commands,max_active_seconds_per_run=:seconds,
            max_retained_media_bytes=:bytes,queued_limit=:queued,max_parallel_runs=:runs,browser_limit=:browsers,
            version=version+1,updated_at=now() WHERE user_id=:id
            """)
        .param("id", userId)
        .param("site", update.siteMode())
        .param("connection", update.connectionMode())
        .param("actions", json.write(update.blockedActions()))
        .param("confirmation", update.requireConfirmationBeforeChanges())
        .param("commands", update.maxCommandsPerRun())
        .param("seconds", update.maxActiveSecondsPerRun())
        .param("bytes", update.maxRetainedMediaBytes())
        .param("queued", update.maxQueuedRuns())
        .param("runs", update.maxParallelRuns())
        .param("browsers", update.maxBrowserSessions())
        .update();
    jdbc.sql("DELETE FROM user_site_rules WHERE user_id=:id").param("id", userId).update();
    for (String origin : update.origins()) {
      jdbc.sql("INSERT INTO user_site_rules(user_id,origin,decision) VALUES(:id,:origin,:decision)")
          .param("id", userId)
          .param("origin", origin)
          .param("decision", update.siteMode().equals("DENY_LIST") ? "DENY" : "ALLOW")
          .update();
    }
  }

  public List<Map<String, Object>> grants(UUID userId) {
    var rows =
        jdbc.sql(
                """
                SELECT id,client_id AS "clientId",scopes::text,status,version,created_at AS "createdAt",
                last_used_at AS "lastUsedAt",revoked_at AS "revokedAt" FROM client_grants WHERE user_id=:user
                ORDER BY created_at DESC
                """)
            .param("user", userId)
            .query()
            .listOfRows();
    rows.forEach(row -> row.put("scopes", strings((String) row.get("scopes"))));
    return rows;
  }

  public boolean revoke(UUID userId, UUID id) {
    return jdbc.sql(
                """
                UPDATE client_grants SET status='REVOKED',version=version+1,revoked_at=now()
                WHERE id=:id AND user_id=:user
                """)
            .param("id", id)
            .param("user", userId)
            .update()
        == 1;
  }

  private List<String> strings(String encoded) {
    List<String> result = new ArrayList<>();
    json.read(encoded).forEach(node -> result.add(node.asString()));
    return List.copyOf(result);
  }
}
