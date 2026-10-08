package ru.helmglass.api.auth;

import java.time.Instant;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Database;

@Service
public class Identity {
  private final JdbcClient jdbc;
  private final ru.helmglass.api.browsers.ViewerAccess viewers;

  public Identity(JdbcClient jdbc, ru.helmglass.api.browsers.ViewerAccess viewers) {
    this.jdbc = jdbc;
    this.viewers = viewers;
  }

  @Transactional
  public Actor current() {
    var authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication == null || !(authentication.getPrincipal() instanceof Jwt jwt)) {
      throw denied("Требуется новый вход.");
    }
    return authenticate(jwt);
  }

  @Transactional
  public Actor authenticate(Jwt jwt) {
    String client = jwt.getClaimAsString("azp");
    String channel =
        switch (client == null ? "" : client) {
          case "helmglass-web" -> "WEB";
          case "helmglass-chatgpt" -> "MCP";
          default -> throw denied("Подключение не предназначено для Helm Glass.");
        };
    if ("MCP".equals(channel)
        && !jwt.getAudience()
            .contains(jwt.getIssuer().toString().replace("/auth/realms/helmglass", "") + "/mcp")) {
      throw denied("Токен не предназначен для ресурса MCP.");
    }
    var roles = SecurityConfiguration.roles(jwt);
    if (!roles.contains("USER") && !roles.contains("ADMIN")) {
      throw denied("У аккаунта нет доступа к приложению.");
    }
    UUID owner = UUID.fromString(jwt.getSubject());
    String name = jwt.getClaimAsString("name");
    String email = jwt.getClaimAsString("email");
    if (name == null || name.isBlank()) {
      name = jwt.getClaimAsString("preferred_username");
    }
    if (name == null) {
      name = owner.toString();
    }
    if (email == null) {
      email = "";
    }
    jdbc.sql(
            """
INSERT INTO accounts(id,name,email,administrator) VALUES (:id,:name,:email,:admin)
ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,
  administrator=EXCLUDED.administrator,last_seen_at=now() WHERE accounts.status <> 'DELETED'
""")
        .param("id", owner)
        .param("name", name)
        .param("email", email)
        .param("admin", roles.contains("ADMIN"))
        .update();
    AccountAccess account =
        jdbc.sql(
                """
                SELECT status,access_after,mcp_revoked_at FROM accounts WHERE id=:id
                """)
            .param("id", owner)
            .query(
                (row, index) ->
                    new AccountAccess(
                        row.getString("status"),
                        Database.instant(row, "access_after"),
                        Database.instant(row, "mcp_revoked_at")))
            .single();
    if (!"ACTIVE".equals(account.status())) {
      throw denied("Доступ к аккаунту ограничен.");
    }
    Instant authTime = jwt.getClaimAsInstant("auth_time");
    if (account.accessAfter() != null
        && (authTime == null || authTime.isBefore(account.accessAfter()))) {
      throw reauthentication("Войдите снова после изменения доступа.");
    }
    if ("MCP".equals(channel)
        && account.mcpRevokedAt() != null
        && (authTime == null || !authTime.isAfter(account.mcpRevokedAt()))) {
      throw denied("Подключение ChatGPT отозвано. Подключите его заново.");
    }
    String sid = jwt.getClaimAsString("sid");
    if ("WEB".equals(channel)
        && sid != null
        && jdbc.sql("SELECT EXISTS(SELECT 1 FROM revoked_sessions WHERE sid=:sid)")
            .param("sid", sid)
            .query(Boolean.class)
            .single()) {
      throw reauthentication("Сессия завершена. Войдите снова.");
    }
    if ("MCP".equals(channel)) {
      jdbc.sql("UPDATE accounts SET mcp_connected_at=now() WHERE id=:id")
          .param("id", owner)
          .update();
    }
    return new Actor(owner, roles, channel, sid, authTime, jwt.getExpiresAt());
  }

  public Actor administrator() {
    Actor actor = current();
    if (!actor.administrator()) {
      throw denied("Администрирование доступно только в кабинете.");
    }
    return actor;
  }

  public boolean authorized(Jwt jwt) {
    if (jwt.getExpiresAt() == null || !jwt.getExpiresAt().isAfter(Instant.now())) {
      return false;
    }
    Instant authenticated = jwt.getClaimAsInstant("auth_time");
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM accounts a WHERE a.id=:id AND a.status='ACTIVE'
              AND (a.access_after IS NULL OR a.access_after<=:authenticated)
              AND NOT EXISTS(SELECT 1 FROM revoked_sessions r WHERE r.sid=:sid))
            """)
        .param("id", UUID.fromString(jwt.getSubject()))
        .param(
            "authenticated", authenticated == null ? null : java.sql.Timestamp.from(authenticated))
        .param("sid", jwt.getClaimAsString("sid"))
        .query(Boolean.class)
        .single();
  }

  public void requireGrant(Actor actor) {
    if (actor.expiresAt() == null || !actor.expiresAt().isAfter(Instant.now())) {
      throw reauthentication("Время доступа истекло. Войдите снова.");
    }
    boolean allowed =
        jdbc.sql(
                """
SELECT EXISTS(SELECT 1 FROM accounts WHERE id=:owner AND status='ACTIVE'
 AND (access_after IS NULL OR access_after<=:authenticated)
 AND (:channel<>'MCP' OR mcp_revoked_at IS NULL OR mcp_revoked_at<:authenticated)
 AND (:channel<>'WEB' OR NOT EXISTS(SELECT 1 FROM revoked_sessions WHERE sid=:sid)))
""")
            .param("owner", actor.id())
            .param(
                "authenticated",
                actor.authenticatedAt() == null
                    ? null
                    : java.sql.Timestamp.from(actor.authenticatedAt()))
            .param("channel", actor.channel())
            .param("sid", actor.sessionId())
            .query(Boolean.class)
            .single();
    if (!allowed) {
      throw denied("Разрешение на просмотр отозвано.");
    }
  }

  public void requireActive(UUID owner) {
    if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=:id AND status='ACTIVE')")
        .param("id", owner)
        .query(Boolean.class)
        .single()) {
      throw denied("Доступ к аккаунту ограничен.");
    }
  }

  @Transactional
  public ru.helmglass.api.browsers.ViewerAccess.Receipt logout() {
    var authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication == null
        || !(authentication.getPrincipal() instanceof Jwt jwt)
        || !"helmglass-web".equals(jwt.getClaimAsString("azp"))) {
      throw denied("Веб-сессия отсутствует.");
    }
    UUID owner = UUID.fromString(jwt.getSubject());
    boolean exists =
        jdbc.sql("SELECT id FROM accounts WHERE id=:owner FOR UPDATE")
            .param("owner", owner)
            .query(UUID.class)
            .optional()
            .isPresent();
    if (!exists) {
      return new ru.helmglass.api.browsers.ViewerAccess.Receipt("COMPLETED", null);
    }
    String sid = jwt.getClaimAsString("sid");
    if (sid != null) {
      jdbc.sql(
              "INSERT INTO revoked_sessions(sid,owner_id) SELECT :sid,id FROM accounts WHERE"
                  + " id=:owner ON CONFLICT DO NOTHING")
          .param("sid", sid)
          .param("owner", UUID.fromString(jwt.getSubject()))
          .update();
      return viewers.revoke(owner, "WEB", sid);
    }
    return new ru.helmglass.api.browsers.ViewerAccess.Receipt("COMPLETED", null);
  }

  private static ApiException reauthentication(String message) {
    return new ApiException(HttpStatus.UNAUTHORIZED, "AUTHENTICATION_REQUIRED", message);
  }

  public static ApiException denied(String message) {
    return new ApiException(HttpStatus.FORBIDDEN, "ACCESS_DENIED", message);
  }

  private record AccountAccess(String status, Instant accessAfter, Instant mcpRevokedAt) {}
}
