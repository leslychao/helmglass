package com.helmglass.browser.infrastructure.repository;

import com.helmglass.api.DomainException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Durable worker inventory, launch authorization, and delivery checkpoints. */
@Repository
public class WorkerRegistryRepository {
  private static final int MAX_COMMAND_ALLOCATION_ATTEMPTS = 3;
  private final JdbcClient jdbc;
  private final BrowserCloseOutboxRepository closeOutbox;

  public WorkerRegistryRepository(JdbcClient jdbc, BrowserCloseOutboxRepository closeOutbox) {
    this.jdbc = jdbc;
    this.closeOutbox = closeOutbox;
  }

  public record Claim(
      UUID sessionId,
      UUID userId,
      UUID taskId,
      UUID connectionId,
      UUID workerId,
      UUID workerBootId,
      long allocationEpoch,
      String state,
      String sessionState,
      String purpose,
      UUID startPermitId,
      Instant startPermitExpiresAt,
      String assignment,
      String assignmentDigest,
      UUID runtimeGeneration,
      Instant budgetDeadlineAt,
      Instant recoveryStartedAt,
      boolean recoveryControlPending,
      String recoveryMode,
      long controlEpoch,
      long pageEpoch,
      long privacyEpoch,
      long policyVersion,
      long instructionRevision,
      String accountState,
      String taskState,
      String ownerKind,
      String privacy,
      Instant readyAt,
      Instant bindingReleasedAt,
      long sessionVersion,
      Long taskVersion) {}

  public record Worker(
      UUID id,
      UUID bootId,
      String desiredMode,
      String observedState,
      Instant registeredAt,
      Instant heartbeatAt) {}

  public record CommandDisposition(UUID userId, UUID taskId, UUID commandId) {}

  private static final String CLAIM_SELECT =
      """
      SELECT s.id session_id,s.user_id,s.task_id,s.connection_id,s.worker_id,s.worker_boot_id,
      s.allocation_epoch,a.state,s.state session_state,s.purpose,a.start_permit_id,
      a.start_permit_expires_at,a.assignment::text,a.assignment_digest,s.runtime_generation,
      s.budget_deadline_at,s.recovery_started_at,s.recovery_control_pending,s.recovery_mode,
      l.epoch control_epoch,s.page_epoch,s.privacy_epoch,p.version policy_version,
      coalesce(t.instruction_revision,0) instruction_revision,u.state account_state,t.state task_state,
      l.owner_kind,s.privacy,s.ready_at,s.binding_released_at,s.version session_version,
      t.version task_version FROM browser_sessions s
      JOIN browser_allocations a ON a.session_id=s.id
      JOIN browser_control_leases l ON l.session_id=s.id
      JOIN application_users u ON u.id=s.user_id JOIN user_policies p ON p.user_id=s.user_id
      LEFT JOIN tasks t ON t.id=s.task_id
      """;

  public Claim claim(UUID sessionId) {
    return jdbc.sql(CLAIM_SELECT + " WHERE s.id=:id")
        .param("id", sessionId)
        .query(Claim.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public List<Claim> claims(UUID workerId) {
    List<Claim> claims =
        jdbc.sql(
                CLAIM_SELECT
                    + " WHERE s.worker_id=:worker AND (a.state<>'RELEASED' OR s.binding_released_at"
                    + " IS NULL) ORDER BY s.id LIMIT 257")
            .param("worker", workerId)
            .query(Claim.class)
            .list();
    if (claims.size() > 256) {
      throw DomainException.conflict(
          "WORKER_RECONCILIATION_LIMIT", "Unresolved claims require operator review");
    }
    return claims;
  }

  public List<Claim> claimsBySessionIds(List<UUID> sessionIds) {
    return jdbc.sql(CLAIM_SELECT + " WHERE s.id IN (:ids) ORDER BY s.id")
        .param("ids", sessionIds)
        .query(Claim.class)
        .list();
  }

  public void lockSubjects(List<Claim> claims) {
    List<UUID> users = claims.stream().map(Claim::userId).distinct().sorted().toList();
    List<UUID> tasks =
        claims.stream().map(Claim::taskId).filter(Objects::nonNull).distinct().sorted().toList();
    List<UUID> connections =
        claims.stream()
            .map(Claim::connectionId)
            .filter(Objects::nonNull)
            .distinct()
            .sorted()
            .toList();
    lockIds("application_users", users);
    lockIds("tasks", tasks);
    lockIds("connections", connections);
  }

  private void lockIds(String table, List<UUID> ids) {
    // Table names are fixed by this repository; all data values stay parameterized.
    for (UUID id : ids) {
      jdbc.sql("SELECT id FROM " + table + " WHERE id=:id FOR UPDATE")
          .param("id", id)
          .query(UUID.class)
          .optional();
    }
  }

  public Optional<Worker> lockWorker(UUID workerId) {
    return jdbc.sql(
            "SELECT id,boot_id,desired_mode,observed_state,registered_at,heartbeat_at FROM"
                + " browser_workers WHERE id=:id FOR UPDATE")
        .param("id", workerId)
        .query(Worker.class)
        .optional();
  }

  public void register(UUID id, UUID bootId, int capacity, String image, String inventoryDigest) {
    jdbc.sql(
            """
            INSERT INTO browser_workers(id,boot_id,capacity,image_version,observed_state,inventory_digest)
            VALUES(:id,:boot,:capacity,:image,'REGISTERING',:digest) ON CONFLICT(id) DO UPDATE
            SET boot_id=:boot,capacity=:capacity,image_version=:image,observed_state='REGISTERING',
            inventory_digest=:digest,inventory_reconciled_at=NULL,heartbeat_at=now(),
            registered_at=now(),version=browser_workers.version+1
            """)
        .param("id", id)
        .param("boot", bootId)
        .param("capacity", capacity)
        .param("image", image)
        .param("digest", inventoryDigest)
        .update();
  }

  public void observed(UUID id, UUID bootId, String state, String digest, boolean reconciled) {
    int updated =
        jdbc.sql(
                """
                UPDATE browser_workers SET heartbeat_at=now(),observed_state=:state,inventory_digest=:digest,
                inventory_reconciled_at=CASE WHEN :reconciled THEN now() ELSE inventory_reconciled_at END,
                version=version+1 WHERE id=:id AND boot_id=:boot
                """)
            .param("id", id)
            .param("boot", bootId)
            .param("state", state)
            .param("digest", digest)
            .param("reconciled", reconciled)
            .update();
    if (updated != 1) {
      throw DomainException.conflict("WORKER_BOOT_STALE", "Worker boot is no longer registered");
    }
  }

  public void assignment(UUID sessionId, String encoded, String digest) {
    jdbc.sql(
            """
            UPDATE browser_allocations SET assignment=CAST(:assignment AS jsonb),assignment_digest=:digest,
            dispatch_attempts=dispatch_attempts+1,next_dispatch_at=now()+interval '2 seconds',version=version+1
            WHERE session_id=:id AND state IN ('RESERVED','ASSIGNED')
            """)
        .param("id", sessionId)
        .param("assignment", encoded)
        .param("digest", digest)
        .update();
  }

  public void permit(UUID sessionId, UUID permitId, Instant deadline) {
    if (jdbc.sql(
                """
                UPDATE browser_allocations SET state='ASSIGNED',start_permit_id=:permit,
                start_permit_expires_at=:deadline,version=version+1
                WHERE session_id=:id AND state='RESERVED' AND start_permit_id IS NULL
                """)
            .param("id", sessionId)
            .param("permit", permitId)
            .param("deadline", Timestamp.from(deadline))
            .update()
        != 1) {
      throw DomainException.conflict("LAUNCH_PERMIT_DENIED", "Physical slot authorization changed");
    }
  }

  public void assigned(UUID sessionId, UUID generation, long pageEpoch) {
    jdbc.sql(
            """
            UPDATE browser_sessions SET runtime_generation=:generation,page_epoch=:page,version=version+1
            WHERE id=:id AND binding_released_at IS NULL
            """)
        .param("id", sessionId)
        .param("generation", generation)
        .param("page", pageEpoch)
        .update();
  }

  public void recovering(UUID sessionId) {
    jdbc.sql(
            """
            UPDATE browser_sessions SET state='RECOVERING',recovery_started_at=coalesce(recovery_started_at,now()),
            version=version+1 WHERE id=:id AND binding_released_at IS NULL AND state<>'LOST'
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_allocations SET state='QUARANTINED',version=version+1
            WHERE session_id=:id AND state IN ('RESERVED','ASSIGNED','RELEASING')
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_control_leases SET expires_at=least(expires_at,now()),input_channel_id=NULL,
            state='QUIESCED',version=version+1 WHERE session_id=:id
            """)
        .param("id", sessionId)
        .update();
  }

  public void beginRecovery(UUID sessionId, String mode, long pageEpoch) {
    jdbc.sql(
            """
            UPDATE browser_control_leases SET epoch=epoch+1,state='TRANSFERRING',desired_owner=NULL,
            controller_instance_id=NULL,input_channel_id=NULL,continuation_claim_id=NULL,
            expires_at=CASE WHEN :mode='AGENT' THEN
            (SELECT budget_deadline_at FROM browser_sessions WHERE id=:id) ELSE now() END,version=version+1
            WHERE session_id=:id
            """)
        .param("id", sessionId)
        .param("mode", mode)
        .update();
    jdbc.sql(
            """
            UPDATE browser_sessions SET recovery_control_pending=true,recovery_mode=:mode,
            page_epoch=greatest(page_epoch,:page),media_generation=media_generation+1,version=version+1
            WHERE id=:id
            """)
        .param("id", sessionId)
        .param("mode", mode)
        .param("page", pageEpoch)
        .update();
  }

  public void recovered(UUID sessionId, String mode) {
    jdbc.sql(
            """
            UPDATE browser_sessions SET state=CASE WHEN ready_at IS NULL THEN 'STARTING' ELSE 'ACTIVE' END,
            recovery_started_at=NULL,recovery_control_pending=false,recovery_mode=NULL,version=version+1
            WHERE id=:id
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            "UPDATE browser_allocations SET state='ASSIGNED',version=version+1 WHERE"
                + " session_id=:id")
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_control_leases SET state=:state,version=version+1 WHERE session_id=:id
            """)
        .param("id", sessionId)
        .param("state", mode.equals("AGENT") ? "ACTIVE" : "QUIESCED")
        .update();
  }

  public void interrupt(UUID sessionId) {
    jdbc.sql(
            """
                UPDATE tasks SET state='INTERRUPTED',mutation_barrier=true,version=version+1,updated_at=now()
                WHERE id=(SELECT task_id FROM browser_sessions WHERE id=:id)
            AND state NOT IN ('COMPLETED','FAILED','CANCELLED','STOPPING')
            AND (state<>'INTERRUPTED' OR NOT mutation_barrier)
            """)
        .param("id", sessionId)
        .update();
  }

  public void recoveryInputCheckpoint(UUID sessionId, long accepted, long applied) {
    jdbc.sql(
            """
            UPDATE operations SET human_checkpoint=:checkpoint,input_accepted_sequence=:accepted,
            input_applied_sequence=:applied,version=version+1
            WHERE id=(SELECT operation_id FROM browser_control_leases WHERE session_id=:id)
            AND human_checkpoint='OPEN'
            """)
        .param("id", sessionId)
        .param("accepted", accepted)
        .param("applied", applied)
        .param("checkpoint", accepted == applied ? "CLOSED" : "UNKNOWN")
        .update();
  }

  public void requestClose(UUID sessionId) {
    jdbc.sql(
            """
            UPDATE browser_sessions SET state='STOPPING',version=version+1
            WHERE id=:id AND binding_released_at IS NULL AND state<>'LOST'
            """)
        .param("id", sessionId)
        .update();
  }

  public List<CommandDisposition> lost(UUID sessionId) {
    jdbc.sql(
            "UPDATE browser_sessions SET"
                + " state='LOST',close_reason='WORKER_LOST',recovery_control_pending=false,version=version+1"
                + " WHERE id=:id")
        .param("id", sessionId)
        .update();
    List<CommandDisposition> changed = unknownAttempts(sessionId);
    interrupt(sessionId);
    return changed;
  }

  private List<CommandDisposition> unknownAttempts(UUID sessionId) {
    jdbc.sql(
            """
            UPDATE command_attempts SET state='UNKNOWN',effect_state='UNKNOWN',finished_at=now(),version=version+1
            WHERE session_id=:id AND state='STARTED' AND result_digest IS NULL
            """)
        .param("id", sessionId)
        .update();
    List<CommandDisposition> changed =
        jdbc.sql(
                """
                UPDATE task_commands SET state='UNKNOWN',failure_code='WORKER_LOST',finished_at=now(),version=version+1
                WHERE expected_session_id=:id AND state='STARTED'
                RETURNING user_id,task_id,id command_id
                """)
            .param("id", sessionId)
            .query(CommandDisposition.class)
            .list();
    jdbc.sql(
            """
            UPDATE session_operation_commands SET state='UNKNOWN',effect_state='UNKNOWN',finished_at=now()
            WHERE session_id=:id AND state='STARTED' AND result_digest IS NULL
            """)
        .param("id", sessionId)
        .update();
    return changed;
  }

  public List<CommandDisposition> closed(UUID sessionId) {
    List<CommandDisposition> changed = new ArrayList<>(unknownAttempts(sessionId));
    jdbc.sql(
            """
            UPDATE tasks SET state='INTERRUPTED',mutation_barrier=true,version=version+1,updated_at=now()
            WHERE id=(SELECT task_id FROM browser_sessions WHERE id=:id)
            AND state NOT IN ('COMPLETED','FAILED','CANCELLED','STOPPING')
            AND (state<>'INTERRUPTED' OR NOT mutation_barrier)
            AND EXISTS(SELECT 1 FROM command_attempts WHERE session_id=:id AND effect_state='UNKNOWN')
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_sessions SET state='CLOSED',closed_at=coalesce(closed_at,now()),binding_released_at=now(),
            recovery_control_pending=false,version=version+1 WHERE id=:id AND binding_released_at IS NULL
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_allocations SET state='RELEASED',released_at=now(),version=version+1
            WHERE session_id=:id AND state<>'RELEASED'
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE command_attempts SET state='FAILED',effect_state='NOT_STARTED',finished_at=now(),version=version+1
            WHERE session_id=:id AND state='DISPATCHED' AND start_permit_id IS NULL
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE task_commands c SET state='WAITING_RESOURCE',expected_session_id=NULL,
            failure_code=NULL,next_eligible_at=now()+interval '1 second',version=c.version+1
            FROM tasks t WHERE t.id=c.task_id AND c.expected_session_id=:id AND c.state='DISPATCHED'
            AND c.deadline>now() AND c.instruction_revision=t.instruction_revision
            AND t.state IN ('QUEUED','STARTING') AND NOT t.mutation_barrier
            AND (SELECT count(*) FROM command_attempts a WHERE a.command_id=c.id)<:attemptLimit
            AND NOT EXISTS(SELECT 1 FROM command_attempts a WHERE a.command_id=c.id AND a.start_permit_id IS NOT NULL)
            """)
        .param("id", sessionId)
        .param("attemptLimit", MAX_COMMAND_ALLOCATION_ATTEMPTS)
        .update();
    changed.addAll(
        jdbc.sql(
                """
                UPDATE task_commands c SET state='FAILED',failure_code='NOT_STARTED',finished_at=now(),
                version=c.version+1 WHERE c.expected_session_id=:id AND c.state='DISPATCHED'
                AND NOT EXISTS(SELECT 1 FROM command_attempts a WHERE a.command_id=c.id
                AND a.start_permit_id IS NOT NULL)
                RETURNING user_id,task_id,id command_id
                """)
            .param("id", sessionId)
            .query(CommandDisposition.class)
            .list());
    jdbc.sql(
            """
            UPDATE tasks t SET state='WAITING_AGENT',version=version+1,updated_at=now()
            WHERE t.id=(SELECT task_id FROM browser_sessions WHERE id=:id)
            AND t.state IN ('QUEUED','STARTING')
            AND EXISTS(SELECT 1 FROM task_commands c WHERE c.expected_session_id=:id
            AND c.state='FAILED' AND c.failure_code='NOT_STARTED')
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE tasks t SET state='QUEUED',version=version+1,updated_at=now()
            WHERE t.id=(SELECT task_id FROM browser_sessions WHERE id=:id) AND t.state='STARTING'
            AND EXISTS(SELECT 1 FROM task_commands c WHERE c.task_id=t.id
            AND c.state='WAITING_RESOURCE' AND c.expected_session_id IS NULL)
            """)
        .param("id", sessionId)
        .update();
    closeOutbox.confirmed(sessionId);
    return List.copyOf(changed);
  }

  public List<UUID> staleWorkers() {
    return jdbc.sql(
            """
            SELECT id FROM browser_workers WHERE heartbeat_at<=now()-interval '20 seconds'
            AND observed_state<>'OFFLINE' ORDER BY heartbeat_at LIMIT 50
            """)
        .query(UUID.class)
        .list();
  }

  public void offline(UUID id) {
    jdbc.sql("UPDATE browser_workers SET observed_state='OFFLINE',version=version+1 WHERE id=:id")
        .param("id", id)
        .update();
  }

  public boolean heartbeatExpired(UUID id) {
    return jdbc.sql(
            "SELECT heartbeat_at<=now()-interval '20 seconds' FROM browser_workers WHERE id=:id")
        .param("id", id)
        .query(Boolean.class)
        .single();
  }

  public List<UUID> assignmentsDue() {
    return jdbc.sql(
            """
            SELECT s.id FROM browser_sessions s JOIN browser_allocations a ON a.session_id=s.id
            JOIN browser_workers w ON w.id=s.worker_id AND w.boot_id=s.worker_boot_id
            WHERE s.state='STARTING' AND s.runtime_generation IS NULL AND a.assignment IS NOT NULL
            AND a.state IN ('RESERVED','ASSIGNED') AND a.dispatch_attempts<6 AND a.next_dispatch_at<=now()
            AND s.budget_deadline_at>now() AND w.observed_state='READY'
            AND w.heartbeat_at>now()-interval '20 seconds' ORDER BY a.next_dispatch_at LIMIT 50
            """)
        .query(UUID.class)
        .list();
  }

  public List<UUID> commandsDue() {
    return jdbc.sql(
            """
            SELECT c.id FROM task_commands c JOIN browser_sessions s ON s.id=c.expected_session_id
            JOIN browser_workers w ON w.id=s.worker_id AND w.boot_id=s.worker_boot_id
            WHERE c.state='DISPATCHED' AND c.delivery_attempts<6 AND c.next_delivery_at<=now()
            AND c.deadline>now() AND s.state='ACTIVE' AND w.observed_state='READY'
            AND w.heartbeat_at>now()-interval '20 seconds'
            AND EXISTS(SELECT 1 FROM command_attempts a WHERE a.command_id=c.id AND a.state='DISPATCHED'
            AND a.start_permit_id IS NULL AND a.effect_state='NOT_STARTED')
            ORDER BY c.next_delivery_at LIMIT 50
            """)
        .query(UUID.class)
        .list();
  }

  public boolean claimCommandDelivery(UUID commandId) {
    return jdbc.sql(
                """
                UPDATE task_commands c SET delivery_attempts=delivery_attempts+1,
                next_delivery_at=now()+make_interval(secs=>least(30,power(2,delivery_attempts+1)::int))
                WHERE id=:id AND state='DISPATCHED' AND delivery_attempts<6 AND next_delivery_at<=now()
                AND deadline>now() AND EXISTS(SELECT 1 FROM command_attempts a WHERE a.command_id=c.id
                AND a.state='DISPATCHED' AND a.start_permit_id IS NULL AND a.effect_state='NOT_STARTED')
                """)
            .param("id", commandId)
            .update()
        == 1;
  }

  public List<UUID> expiredRecoveries() {
    return jdbc.sql(
            """
            SELECT id FROM browser_sessions WHERE state='RECOVERING'
            AND recovery_started_at<=now()-interval '30 seconds' ORDER BY recovery_started_at LIMIT 50
            """)
        .query(UUID.class)
        .list();
  }

  public List<Worker> recoveryWorkers() {
    return jdbc.sql(
            """
            SELECT id,boot_id,desired_mode,observed_state,registered_at,heartbeat_at FROM browser_workers w
            WHERE w.heartbeat_at>now()-interval '20 seconds'
            AND EXISTS(SELECT 1 FROM browser_sessions s WHERE s.worker_id=w.id AND s.worker_boot_id=w.boot_id
            AND s.recovery_control_pending AND s.state='RECOVERING') ORDER BY w.id LIMIT 50
            """)
        .query(Worker.class)
        .list();
  }
}
