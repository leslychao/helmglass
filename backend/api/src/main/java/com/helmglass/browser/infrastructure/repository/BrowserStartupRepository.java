package com.helmglass.browser.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class BrowserStartupRepository {
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public BrowserStartupRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public record Startup(
      UUID sessionId,
      UUID commandId,
      UUID profileVersionId,
      String state,
      UUID transferId,
      UUID navigationId,
      UUID attemptId,
      String action,
      String actionDigest,
      Instant deadline,
      UUID permitId,
      String resultDigest) {}

  public record Context(
      UUID sessionId,
      UUID userId,
      UUID taskId,
      UUID workerId,
      UUID workerBootId,
      UUID connectionId,
      Long scopeVersion,
      long allocationEpoch,
      long controlEpoch,
      long pageEpoch,
      long privacyEpoch,
      long policyVersion,
      long instructionRevision,
      String sessionState,
      String privacy,
      String controlOwner,
      String controlState,
      Instant leaseExpiresAt,
      Instant budgetDeadlineAt) {}

  public Context context(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT s.id session_id,s.user_id,s.task_id,s.worker_id,s.worker_boot_id,s.connection_id,
            c.scope_version,s.allocation_epoch,l.epoch control_epoch,s.page_epoch,s.privacy_epoch,
            p.version policy_version,t.instruction_revision,s.state session_state,s.privacy,
            l.owner_kind control_owner,l.state control_state,l.expires_at lease_expires_at,s.budget_deadline_at
            FROM browser_sessions s JOIN tasks t ON t.id=s.task_id
            JOIN browser_control_leases l ON l.session_id=s.id JOIN user_policies p ON p.user_id=s.user_id
            LEFT JOIN connections c ON c.id=s.connection_id WHERE s.id=:id AND s.binding_released_at IS NULL
            """)
        .param("id", sessionId)
        .query(Context.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void prepare(
      UUID sessionId, UUID commandId, UUID profileVersionId, String startUrl, Instant deadline) {
    var action = json.read(json.write(Map.of("type", "NAVIGATE", "url", startUrl)));
    jdbc.sql(
            """
            INSERT INTO browser_profile_startups(session_id,command_id,profile_version_id,navigation_id,
            attempt_id,action,action_digest,deadline) VALUES(:session,:command,:profile,:navigation,
            :attempt,CAST(:action AS jsonb),:digest,:deadline)
            """)
        .param("session", sessionId)
        .param("command", commandId)
        .param("profile", profileVersionId)
        .param("navigation", UUID.randomUUID())
        .param("attempt", UUID.randomUUID())
        .param("action", json.write(action))
        .param("digest", json.workerDigest(action))
        .param("deadline", Timestamp.from(deadline))
        .update();
    jdbc.sql(
            """
            UPDATE browser_sessions SET profile_version_id=:profile,startup_state='PROFILE_PENDING'
            WHERE id=:session AND state='STARTING'
            """)
        .param("profile", profileVersionId)
        .param("session", sessionId)
        .update();
  }

  public Optional<Startup> forSession(UUID id) {
    return jdbc.sql("SELECT * FROM browser_profile_startups WHERE session_id=:id FOR UPDATE")
        .param("id", id)
        .query(Startup.class)
        .optional();
  }

  public Optional<Startup> forCommand(UUID id) {
    return jdbc.sql("SELECT * FROM browser_profile_startups WHERE navigation_id=:id FOR UPDATE")
        .param("id", id)
        .query(Startup.class)
        .optional();
  }

  public boolean containsCommand(UUID id) {
    return jdbc.sql("SELECT EXISTS(SELECT 1 FROM browser_profile_startups WHERE navigation_id=:id)")
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  public List<UUID> expired() {
    return jdbc.sql(
            """
            SELECT session_id FROM browser_profile_startups
            WHERE state NOT IN ('READY','FAILED','UNKNOWN') AND deadline<=now() ORDER BY deadline LIMIT 20
            """)
        .query(UUID.class)
        .list();
  }

  public boolean beginLoading(UUID id) {
    return jdbc.sql(
                """
                UPDATE browser_profile_startups SET state='LOADING'
                WHERE session_id=:id AND state='PREPARING' AND deadline>now()
                """)
            .param("id", id)
            .update()
        == 1;
  }

  public void transfer(UUID id, UUID transferId) {
    if (jdbc.sql(
                """
                UPDATE browser_profile_startups SET transfer_id=:transfer WHERE session_id=:id
                AND state='LOADING' AND transfer_id IS NULL AND deadline>now()
                """)
            .param("id", id)
            .param("transfer", transferId)
            .update()
        != 1) {
      throw DomainException.conflict("STARTUP_FENCED", "Browser startup is no longer current");
    }
  }

  public boolean loaded(Startup startup, UUID transferId, String checksum, long bytes) {
    return jdbc.sql(
                """
                UPDATE browser_profile_startups st SET state='NAVIGATING' FROM browser_profile_versions v
                WHERE st.session_id=:id AND st.state='LOADING' AND st.transfer_id=:transfer
                AND v.id=st.profile_version_id AND v.state='READY' AND v.checksum=:checksum AND v.size=:bytes
                AND st.deadline>now()
                """)
            .param("id", startup.sessionId())
            .param("transfer", transferId)
            .param("checksum", checksum)
            .param("bytes", bytes)
            .update()
        == 1;
  }

  public void started(UUID sessionId, UUID permitId) {
    if (jdbc.sql(
                """
                UPDATE browser_profile_startups SET state='STARTED',permit_id=:permit
                WHERE session_id=:id AND state='NAVIGATING' AND permit_id IS NULL AND deadline>now()
                """)
            .param("id", sessionId)
            .param("permit", permitId)
            .update()
        != 1) {
      throw DomainException.conflict(
          "STARTUP_PERMIT_USED", "Startup navigation already has a permit");
    }
  }

  public void ready(UUID sessionId, String resultDigest) {
    if (resultDigest != null
        && jdbc.sql(
                    """
                    UPDATE browser_profile_startups SET state='READY',result_digest=:digest
                    WHERE session_id=:id AND state='STARTED' AND permit_id IS NOT NULL
                    """)
                .param("id", sessionId)
                .param("digest", resultDigest)
                .update()
            != 1) {
      throw DomainException.conflict("STARTUP_FENCED", "Startup navigation has no active permit");
    }
    int activated =
        jdbc.sql(
                """
                UPDATE browser_sessions SET startup_state='READY',
                version=version+1 WHERE id=:id AND state='STARTING' AND binding_released_at IS NULL
                AND budget_deadline_at>now()
                AND EXISTS(SELECT 1 FROM browser_allocations a WHERE a.session_id=:id AND a.state='ASSIGNED')
                """)
            .param("id", sessionId)
            .update();
    if (activated != 1
        && !(resultDigest == null
            && jdbc.sql(
                    """
                    SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE id=:id AND state IN ('STARTING','ACTIVE')
                    AND startup_state='READY' AND binding_released_at IS NULL AND budget_deadline_at>now())
                    """)
                .param("id", sessionId)
                .query(Boolean.class)
                .single())) {
      throw DomainException.conflict("STARTUP_FENCED", "Browser assignment is no longer starting");
    }
  }

  public BrowserRepository.Session readyCandidate(
      UUID workerId, UUID bootId, UUID sessionId, long epoch) {
    return jdbc.sql(
            """
            SELECT * FROM browser_sessions WHERE id=:id AND worker_id=:worker AND worker_boot_id=:boot
            AND allocation_epoch=:epoch AND state IN ('STARTING','ACTIVE') AND startup_state='READY'
            AND binding_released_at IS NULL AND budget_deadline_at>now()
            """)
        .param("id", sessionId)
        .param("worker", workerId)
        .param("boot", bootId)
        .param("epoch", epoch)
        .query(BrowserRepository.Session.class)
        .optional()
        .orElseThrow(
            () ->
                DomainException.conflict(
                    "RUNTIME_READY_FENCED", "Runtime readiness no longer matches its startup"));
  }

  public void acknowledgeReady(UUID sessionId, Instant startedAt) {
    if (jdbc.sql(
                    """
                    UPDATE browser_sessions SET state='ACTIVE',ready_at=:started,version=version+1
                    WHERE id=:id AND state='STARTING' AND startup_state='READY' AND ready_at IS NULL
                    AND binding_released_at IS NULL AND budget_deadline_at>now()
                    """)
                .param("id", sessionId)
                .param("started", Timestamp.from(startedAt))
                .update()
            == 0
        && !jdbc.sql(
                """
                SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE id=:id AND state='ACTIVE'
                AND startup_state='READY' AND ready_at=:started AND binding_released_at IS NULL)
                """)
            .param("id", sessionId)
            .param("started", Timestamp.from(startedAt))
            .query(Boolean.class)
            .single()) {
      throw DomainException.conflict(
          "RUNTIME_READY_FENCED", "Runtime readiness clock cannot change");
    }
  }

  public void failed(UUID sessionId, String resultDigest) {
    if (jdbc.sql(
                """
                UPDATE browser_profile_startups SET state='FAILED',result_digest=coalesce(result_digest,:digest)
                WHERE session_id=:id AND state NOT IN ('READY','FAILED','UNKNOWN')
                """)
            .param("id", sessionId)
            .param("digest", resultDigest)
            .update()
        == 0) {
      return;
    }
    jdbc.sql(
            "UPDATE browser_sessions SET state='STOPPING',startup_state='FAILED' WHERE id=:id AND"
                + " binding_released_at IS NULL")
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE command_attempts SET state='FAILED',effect_state='NOT_STARTED',finished_at=now(),
            version=version+1 WHERE command_id=(SELECT command_id FROM browser_profile_startups
            WHERE session_id=:id) AND state='DISPATCHED' AND start_permit_id IS NULL
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE task_commands SET state='FAILED',failure_code='PROFILE_STARTUP_FAILED',finished_at=now(),
            version=version+1 WHERE id=(SELECT command_id FROM browser_profile_startups WHERE session_id=:id)
            AND state='DISPATCHED'
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE operations SET state='FAILED',failure_code='PROFILE_STARTUP_FAILED',finished_at=now(),
            updated_at=now(),version=version+1 WHERE target_type='command'
            AND target_id=(SELECT command_id FROM browser_profile_startups WHERE session_id=:id)
            AND state IN ('PENDING','RUNNING')
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE tasks SET state='INTERRUPTED',failure_code='PROFILE_STARTUP_FAILED',updated_at=now(),
            version=version+1 WHERE id=(SELECT task_id FROM browser_sessions WHERE id=:id)
            AND state IN ('STARTING','QUEUED')
            AND EXISTS(SELECT 1 FROM browser_profile_startups WHERE session_id=:id AND command_id IS NOT NULL)
            """)
        .param("id", sessionId)
        .update();
  }
}
