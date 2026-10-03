package com.helmglass.identity.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.identity.domain.AuthenticatedActor;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class IdentityRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public IdentityRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public record Account(
      UUID id,
      String displayName,
      String email,
      String state,
      long version,
      long accessEpoch,
      Instant reauthenticationAfter) {}

  public Account resolve(String issuer, String subject, String displayName, String email) {
    UUID id = UUID.randomUUID();
    String identityHash = JsonSupport.sha256(issuer + "\n" + subject);
    jdbc.sql(
            """
            INSERT INTO application_users(id,issuer,subject,display_name,email,identity_hash)
            VALUES(:id,:issuer,:subject,:name,:email,:identity) ON CONFLICT DO NOTHING
            """)
        .param("id", id)
        .param("issuer", issuer)
        .param("subject", subject)
        .param("name", displayName)
        .param("email", email)
        .param("identity", identityHash)
        .update();
    Account account =
        jdbc.sql(
                """
                SELECT id,display_name,email,state,version,access_epoch,reauthentication_after
                FROM application_users WHERE identity_hash=:identity FOR UPDATE
                """)
            .param("identity", identityHash)
            .query(Account.class)
            .single();
    if (account.state().equals("DELETED")) {
      throw new DomainException(403, "ACCOUNT_DELETED", "Account was permanently deleted");
    }
    jdbc.sql("INSERT INTO user_policies(user_id) VALUES(:id) ON CONFLICT DO NOTHING")
        .param("id", account.id())
        .update();
    jdbc.sql("INSERT INTO admin_user_limits(user_id) VALUES(:id) ON CONFLICT DO NOTHING")
        .param("id", account.id())
        .update();
    return account;
  }

  public UUID admitLogin(
      Account account, String issuer, String sid, Instant authTime, Instant expiresAt) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO application_logins(id,user_id,issuer,sid,auth_time,admitted_access_epoch,expires_at)
            VALUES(:id,:userId,:issuer,:sid,:authTime,:epoch,:expiresAt)
            ON CONFLICT(issuer,sid,user_id) DO UPDATE SET
            expires_at=greatest(application_logins.expires_at,excluded.expires_at),last_seen_at=now()
            WHERE application_logins.state='ACTIVE'
            AND application_logins.admitted_access_epoch=excluded.admitted_access_epoch
            """)
        .param("id", id)
        .param("userId", account.id())
        .param("issuer", issuer)
        .param("sid", sid)
        .param("authTime", Timestamp.from(authTime))
        .param("epoch", account.accessEpoch())
        .param("expiresAt", Timestamp.from(expiresAt))
        .update();
    return jdbc.sql(
            """
            SELECT id FROM application_logins WHERE user_id=:userId AND issuer=:issuer AND sid=:sid
            AND state='ACTIVE' AND admitted_access_epoch=:epoch AND expires_at>now()
            """)
        .param("userId", account.id())
        .param("issuer", issuer)
        .param("sid", sid)
        .param("epoch", account.accessEpoch())
        .query(UUID.class)
        .optional()
        .orElseThrow(() -> new DomainException(401, "LOGIN_REVOKED", "Login is no longer active"));
  }

  public UUID admitGrant(UUID userId, String clientId, String sid, List<String> scopes) {
    UUID id = UUID.randomUUID();
    jdbc.sql(
            """
            INSERT INTO client_grants(id,user_id,client_id,sid,scopes)
            VALUES(:id,:userId,:clientId,:sid,CAST(:scopes AS jsonb))
            ON CONFLICT(user_id,client_id,sid) DO UPDATE SET last_used_at=now(),scopes=excluded.scopes
            WHERE client_grants.status='ACTIVE'
            """)
        .param("id", id)
        .param("userId", userId)
        .param("clientId", clientId)
        .param("sid", sid)
        .param("scopes", json.write(scopes))
        .update();
    return jdbc.sql(
            """
            SELECT id FROM client_grants WHERE user_id=:userId AND client_id=:clientId
            AND sid=:sid AND status='ACTIVE'
            """)
        .param("userId", userId)
        .param("clientId", clientId)
        .param("sid", sid)
        .query(UUID.class)
        .optional()
        .orElseThrow(
            () -> new DomainException(403, "GRANT_REVOKED", "Client access has been revoked"));
  }

  public void lockActive(UUID userId) {
    String state = lockState(userId);
    if (!state.equals("ACTIVE")) {
      throw new DomainException(403, "ACCOUNT_UNAVAILABLE", "Account is unavailable");
    }
  }

  public boolean isActive(UUID userId) {
    return jdbc.sql("SELECT count(*) FROM application_users WHERE id=:id AND state='ACTIVE'")
            .param("id", userId)
            .query(Long.class)
            .single()
        == 1;
  }

  public String lockState(UUID userId) {
    return jdbc.sql("SELECT state FROM application_users WHERE id=:id FOR UPDATE")
        .param("id", userId)
        .query(String.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public boolean loginActive(UUID userId, UUID loginId) {
    return loginId != null
        && jdbc.sql(
                """
                SELECT EXISTS(SELECT 1 FROM application_logins WHERE id=:login AND user_id=:user
                AND state='ACTIVE' AND expires_at>now())
                """)
            .param("login", loginId)
            .param("user", userId)
            .query(Boolean.class)
            .single();
  }

  public boolean authorizationActive(UUID userId, UUID loginId, UUID grantId, long accessEpoch) {
    if (jdbc.sql(
                "SELECT count(*) FROM application_users WHERE id=:id AND state='ACTIVE' AND"
                    + " access_epoch=:epoch")
            .param("id", userId)
            .param("epoch", accessEpoch)
            .query(Long.class)
            .single()
        != 1) {
      return false;
    }
    if (loginId != null) {
      return jdbc.sql(
                  "SELECT count(*) FROM application_logins WHERE id=:id AND user_id=:user AND"
                      + " state='ACTIVE' AND expires_at>now()")
              .param("id", loginId)
              .param("user", userId)
              .query(Long.class)
              .single()
          == 1;
    }
    return grantId != null
        && jdbc.sql(
                    "SELECT count(*) FROM client_grants WHERE id=:id AND user_id=:user AND"
                        + " status='ACTIVE'")
                .param("id", grantId)
                .param("user", userId)
                .query(Long.class)
                .single()
            == 1;
  }

  /** Returns the current version only for the exact admitted, still-authorized MCP grant. */
  public long activeGrantVersion(AuthenticatedActor actor) {
    if (!actor.mcp() || actor.grantId() == null) {
      throw new DomainException(403, "MCP_GRANT_REQUIRED", "An active MCP grant is required");
    }
    return jdbc.sql("""
        SELECT g.version FROM client_grants g JOIN application_users u ON u.id=g.user_id
        WHERE g.id=:grant AND g.user_id=:user AND g.client_id=:client AND g.status='ACTIVE'
          AND u.state='ACTIVE' AND u.access_epoch=:epoch
          AND g.scopes @> '["tasks:read","browser:view"]'::jsonb
        """)
        .param("grant", actor.grantId()).param("user", actor.userId())
        .param("client", actor.clientId()).param("epoch", actor.accessEpoch())
        .query(Long.class).optional()
        .orElseThrow(() -> new DomainException(403, "GRANT_REVOKED", "Client access has changed"));
  }

  public void revokeLogin(UUID id) {
    jdbc.sql(
            """
            UPDATE application_logins SET state='REVOKED',revoked_at=now(),version=version+1,
            revoke_reason='LOGOUT' WHERE id=:id AND state='ACTIVE'
            """)
        .param("id", id)
        .update();
  }

  public Optional<Account> find(UUID id) {
    return jdbc.sql(
            """
            SELECT id,display_name,email,state,version,access_epoch,reauthentication_after
            FROM application_users WHERE id=:id
            """)
        .param("id", id)
        .query(Account.class)
        .optional();
  }
}
