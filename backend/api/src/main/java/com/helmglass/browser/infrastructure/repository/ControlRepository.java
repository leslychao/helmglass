package com.helmglass.browser.infrastructure.repository;

import com.helmglass.api.DomainException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ControlRepository {
  private final JdbcClient jdbc;

  public ControlRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record Lease(
      UUID sessionId,
      long epoch,
      UUID ownerId,
      String ownerKind,
      UUID controllerInstanceId,
      String state,
      String desiredOwner,
      long privacyEpoch,
      UUID operationId,
      long version,
      Instant expiresAt,
      UUID loginId,
      UUID inputChannelId,
      String returnIntent,
      String priorTaskState) {}

  public Lease lock(UUID sessionId) {
    return jdbc.sql("SELECT * FROM browser_control_leases WHERE session_id=:id FOR UPDATE")
        .param("id", sessionId)
        .query(Lease.class)
        .single();
  }

  public Lease get(UUID sessionId) {
    return jdbc.sql("SELECT * FROM browser_control_leases WHERE session_id=:id")
        .param("id", sessionId)
        .query(Lease.class)
        .optional()
        .orElseThrow(DomainException::notFound);
  }

  public void transfer(
      UUID sessionId, UUID controller, String owner, boolean privateLogin, UUID operationId) {
    if (owner.equals("HUMAN")) {
      jdbc.sql(
              """
              UPDATE browser_control_leases SET prior_task_state=(SELECT t.state FROM tasks t
              JOIN browser_sessions s ON s.task_id=t.id WHERE s.id=:id)
              WHERE session_id=:id AND owner_kind='AGENT'
              """)
          .param("id", sessionId)
          .update();
    }
    jdbc.sql(
            """
            UPDATE browser_control_leases SET epoch=epoch+1,state='TRANSFERRING',desired_owner=:owner,
            controller_instance_id=:controller,input_channel_id=NULL,continuation_claim_id=NULL,privacy_epoch=privacy_epoch+1,operation_id=:operation,
            expires_at=CASE WHEN :owner='AGENT' THEN
            (SELECT budget_deadline_at FROM browser_sessions WHERE id=:id)
            ELSE now()+interval '15 seconds' END,version=version+1,changed_at=now() WHERE session_id=:id
            """)
        .param("id", sessionId)
        .param("owner", owner)
        .param("controller", controller)
        .param("operation", operationId)
        .update();
    jdbc.sql(
            """
            UPDATE browser_sessions SET privacy_epoch=privacy_epoch+1,page_epoch=page_epoch+1,media_generation=media_generation+1,
            privacy=:privacy,current_url=CASE WHEN :privacy='LOGIN_PRIVATE' THEN NULL ELSE current_url END,
            version=version+1 WHERE id=:id
            """)
        .param("id", sessionId)
        .param("privacy", privateLogin ? "LOGIN_PRIVATE" : "NORMAL")
        .update();
    jdbc.sql(
            """
            UPDATE tasks SET state=CASE WHEN state IN ('RUNNING','QUEUED','STARTING') THEN 'PAUSING'
            WHEN state='WAITING_AGENT' THEN 'PAUSED' ELSE state END,version=version+1,updated_at=now()
            WHERE id=(SELECT task_id FROM browser_sessions WHERE id=:id)
            """)
        .param("id", sessionId)
        .update();
    jdbc.sql(
            """
            UPDATE operations SET human_checkpoint='OPEN' WHERE id=:id AND kind LIKE 'control.acquire:%'
            """)
        .param("id", operationId)
        .update();
  }

  public void activate(UUID sessionId, long epoch, UUID operationId) {
    int changed =
        jdbc.sql(
                """
                UPDATE browser_control_leases SET state='ACTIVE',owner_kind=desired_owner,desired_owner=NULL,
                version=version+1,expires_at=CASE WHEN desired_owner='AGENT' THEN expires_at
                ELSE now()+interval '15 seconds' END
                WHERE session_id=:id AND epoch=:epoch AND operation_id=:operation AND state='TRANSFERRING'
                """)
            .param("id", sessionId)
            .param("epoch", epoch)
            .param("operation", operationId)
            .update();
    if (changed != 1) {
      throw DomainException.conflict("STALE_CONTROL_EPOCH", "Control acknowledgement is stale");
    }
  }

  public Instant renew(UUID sessionId, UUID controller, long epoch) {
    return jdbc.sql(
            """
            UPDATE browser_control_leases SET expires_at=now()+interval '15 seconds'
            WHERE session_id=:id AND controller_instance_id=:controller AND epoch=:epoch
            AND state='ACTIVE' AND owner_kind='HUMAN' AND expires_at>now() RETURNING expires_at
            """)
        .param("id", sessionId)
        .param("controller", controller)
        .param("epoch", epoch)
        .query(Instant.class)
        .optional()
        .orElseThrow(
            () ->
                DomainException.conflict(
                    "CONTROL_EXPIRED", "Human control must be acquired again"));
  }

  public void quiesceInput(UUID id) {
    jdbc.sql(
            "UPDATE browser_control_leases SET state='QUIESCED',version=version+1 WHERE"
                + " session_id=:id")
        .param("id", id)
        .update();
  }

  public boolean expireHuman(UUID id, long epoch) {
    return jdbc.sql(
                """
                UPDATE browser_control_leases SET state='QUIESCED',input_channel_id=NULL,version=version+1
                WHERE session_id=:id AND epoch=:epoch AND owner_kind='HUMAN' AND state='ACTIVE'
                AND expires_at<=now()
                """)
            .param("id", id)
            .param("epoch", epoch)
            .update()
        == 1;
  }

  public void resumeInput(UUID id) {
    jdbc.sql(
            "UPDATE browser_control_leases SET state='ACTIVE',version=version+1 WHERE"
                + " session_id=:id")
        .param("id", id)
        .update();
  }

  public void returnIntent(UUID id, String intent) {
    jdbc.sql("UPDATE browser_control_leases SET return_intent=:intent WHERE session_id=:id")
        .param("id", id)
        .param("intent", intent)
        .update();
  }

  public void taskAfterReturn(UUID id, boolean keepPaused) {
    jdbc.sql(
            """
            UPDATE tasks SET state=:state,version=version+1,updated_at=now()
            WHERE id=(SELECT task_id FROM browser_sessions WHERE id=:id)
            AND state IN ('PAUSED','PAUSING') AND NOT mutation_barrier
            """)
        .param("id", id)
        .param("state", keepPaused ? "PAUSED" : "WAITING_AGENT")
        .update();
  }

  public void bindLogin(UUID id, UUID loginId) {
    jdbc.sql("UPDATE browser_control_leases SET login_id=:login WHERE session_id=:id")
        .param("id", id)
        .param("login", loginId)
        .update();
  }

  public boolean beginInputFence(UUID id, UUID channelId) {
    return jdbc.sql(
                """
                UPDATE browser_control_leases SET state='QUIESCING',version=version+1
                WHERE session_id=:id AND input_channel_id=:channel AND state='ACTIVE'
                """)
            .param("id", id)
            .param("channel", channelId)
            .update()
        == 1;
  }

  public void finishInputFence(Lease lease, long accepted, long applied) {
    boolean unknown = accepted != applied;
    checkpoint(lease.operationId(), accepted, applied);
    jdbc.sql(
            "UPDATE browser_control_leases SET state='QUIESCED',version=version+1 WHERE"
                + " session_id=:id")
        .param("id", lease.sessionId())
        .update();
    if (unknown) {
      jdbc.sql(
              """
              UPDATE tasks SET mutation_barrier=true,state='INTERRUPTED',version=version+1
              WHERE id=(SELECT task_id FROM browser_sessions WHERE id=:id)
              AND state NOT IN ('COMPLETED','FAILED','CANCELLED','STOPPING')
              """)
          .param("id", lease.sessionId())
          .update();
    }
  }

  public void reconnectHuman(UUID id) {
    jdbc.sql(
            """
            UPDATE browser_control_leases SET epoch=epoch+1,state='TRANSFERRING',desired_owner='HUMAN',
            input_channel_id=NULL,expires_at=now()+interval '15 seconds',version=version+1
            WHERE session_id=:id AND owner_kind='HUMAN' AND state='QUIESCED'
            """)
        .param("id", id)
        .update();
  }

  public void checkpoint(UUID operationId, long accepted, long applied) {
    jdbc.sql(
            """
            UPDATE operations SET human_checkpoint=:checkpoint,input_accepted_sequence=:accepted,
              input_applied_sequence=:applied,version=version+1 WHERE id=:id
            """)
        .param("id", operationId)
        .param("checkpoint", accepted != applied ? "UNKNOWN" : "CLOSED")
        .param("accepted", accepted)
        .param("applied", applied)
        .update();
  }

  public void unknownInputBoundary(UUID sessionId, UUID previousOperationId, UUID operationId) {
    jdbc.sql(
            """
            UPDATE operations SET human_checkpoint='UNKNOWN',version=version+1 WHERE id IN (:previous,:operation)
            """)
        .param("previous", previousOperationId)
        .param("operation", operationId)
        .update();
    jdbc.sql(
            """
            UPDATE tasks SET state='INTERRUPTED',mutation_barrier=true,version=version+1,updated_at=now()
              WHERE id=(SELECT task_id FROM browser_sessions WHERE id=:id)
              AND state NOT IN ('COMPLETED','FAILED','CANCELLED','STOPPING')
            """)
        .param("id", sessionId)
        .update();
  }

  public void beginSessionBoundary(UUID sessionId, UUID operationId) {
    jdbc.sql(
            """
            UPDATE browser_control_leases SET state='QUIESCING',input_channel_id=NULL,
              operation_id=:operation,version=version+1 WHERE session_id=:id
            """)
        .param("id", sessionId)
        .param("operation", operationId)
        .update();
    jdbc.sql("UPDATE browser_sessions SET version=version+1 WHERE id=:id")
        .param("id", sessionId)
        .update();
  }

  public boolean sessionOperationPending(UUID sessionId) {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM browser_session_operations WHERE session_id=:id
              AND state IN ('QUIESCING','SAVING','RESUMING','CLOSING'))
            """)
        .param("id", sessionId)
        .query(Boolean.class)
        .single();
  }

  public boolean claimInput(UUID id, long epoch, UUID controller, UUID loginId, UUID channelId) {
    return jdbc.sql(
                """
                UPDATE browser_control_leases SET input_channel_id=:channel WHERE session_id=:id
                AND epoch=:epoch AND controller_instance_id=:controller AND login_id=:login
                AND state='ACTIVE' AND owner_kind='HUMAN' AND expires_at>now() AND input_channel_id IS NULL
                """)
            .param("id", id)
            .param("epoch", epoch)
            .param("controller", controller)
            .param("login", loginId)
            .param("channel", channelId)
            .update()
        == 1;
  }

  public long claimAgent(UUID id, UUID claimId, UUID operationId, Instant expiry) {
    return jdbc.sql(
            """
            UPDATE browser_control_leases SET epoch=epoch+1,continuation_claim_id=:claim,
            state='TRANSFERRING',desired_owner='AGENT',operation_id=:operation,expires_at=:expiry,version=version+1 WHERE session_id=:id AND owner_kind='AGENT'
            AND state='ACTIVE' RETURNING epoch
            """)
        .param("id", id)
        .param("claim", claimId)
        .param("operation", operationId)
        .param("expiry", Timestamp.from(expiry))
        .query(Long.class)
        .optional()
        .orElseThrow(() -> DomainException.conflict("CONTROL_CONFLICT", "Agent control changed"));
  }

  public void closeRequested(UUID id) {
    jdbc.sql("UPDATE browser_sessions SET state='STOPPING',version=version+1 WHERE id=:id")
        .param("id", id)
        .update();
  }
}
