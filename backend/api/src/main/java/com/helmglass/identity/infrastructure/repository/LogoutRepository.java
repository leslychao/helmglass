package com.helmglass.identity.infrastructure.repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class LogoutRepository {

  private final JdbcClient jdbc;

  public LogoutRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record SessionLogout(UUID id, String sid, String state) {}

  public Optional<SessionLogout> find(UUID id) {
    return jdbc.sql("""
            SELECT o.id,l.sid,o.state FROM operations o JOIN application_logins l ON l.id=o.target_id
            WHERE o.id=:id AND o.kind='auth.logout'
            """)
        .param("id", id)
        .query(SessionLogout.class)
        .optional();
  }

  public List<SessionLogout> pending() {
    return jdbc.sql("""
            SELECT o.id,l.sid,o.state FROM operations o JOIN application_logins l ON l.id=o.target_id
            WHERE o.kind='auth.logout' AND o.state='PENDING' AND o.next_attempt_at<=now()
            ORDER BY o.created_at LIMIT 20
            """)
        .query(SessionLogout.class)
        .list();
  }

  public void completed(UUID id) {
    jdbc.sql("""
            UPDATE operations SET state='SUCCEEDED',finished_at=now(),updated_at=now(),progress=100,
            failure_code=NULL,version=version+1 WHERE id=:id AND state='PENDING'
            """)
        .param("id", id)
        .update();
  }

  public void retry(UUID id) {
    jdbc.sql("""
            UPDATE operations SET attempts=attempts+1,next_attempt_at=now()+interval '10 seconds',
            state=CASE WHEN attempts>=2 THEN 'NEEDS_ATTENTION' ELSE state END,
            failure_code='IDENTITY_PROVIDER_UNAVAILABLE',version=version+1,updated_at=now()
            WHERE id=:id AND state='PENDING'
            """)
        .param("id", id)
        .update();
  }
}
