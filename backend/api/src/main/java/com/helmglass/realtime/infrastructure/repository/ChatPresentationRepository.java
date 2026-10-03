package com.helmglass.realtime.infrastructure.repository;

import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.realtime.domain.ChatPresentation;
import com.helmglass.realtime.domain.BrowserMediaBinding;
import com.helmglass.realtime.domain.ViewerFence;
import java.sql.Timestamp;
import com.helmglass.realtime.application.ChannelTicketService.TicketBinding;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Storage and locking for the presentation owner; Redis never decides a slot's authority. */
@Repository
public class ChatPresentationRepository {
  private final JdbcClient jdbc;

  public ChatPresentationRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public Optional<ChatPresentation> find(AuthenticatedActor actor, String correlation) {
    return jdbc.sql(
            """
            SELECT * FROM chat_view_slots WHERE user_id=:user AND client_id=:client
              AND verified_correlation=:correlation
            """)
        .param("user", actor.userId())
        .param("client", actor.clientId())
        .param("correlation", correlation)
        .query(ChatPresentation.class)
        .optional();
  }

  public Optional<ChatPresentation> find(UUID id) {
    return jdbc.sql("SELECT * FROM chat_view_slots WHERE id=:id")
        .param("id", id).query(ChatPresentation.class).optional();
  }

  public boolean connectEvents(TicketBinding binding) {
    return jdbc.sql("""
        UPDATE chat_view_slots SET events_connected=true WHERE id=:scope
          AND presentation_revision=:revision AND active_viewer_instance_id=:viewer
          AND view_generation=:generation AND NOT events_connected AND retired_at IS NULL
          AND viewer_lease_expires_at>now() AND viewer_authorization_expires_at>now()
        """).param("scope", binding.viewScopeId()).param("revision", binding.presentationRevision())
        .param("viewer", binding.viewerInstanceId()).param("generation", binding.viewGeneration())
        .update() == 1;
  }

  public void disconnectEvents(TicketBinding binding) {
    jdbc.sql("""
        UPDATE chat_view_slots SET events_connected=false WHERE id=:scope
          AND presentation_revision=:revision AND active_viewer_instance_id=:viewer
          AND view_generation=:generation
        """).param("scope", binding.viewScopeId()).param("revision", binding.presentationRevision())
        .param("viewer", binding.viewerInstanceId()).param("generation", binding.viewGeneration()).update();
  }

  public boolean renewViewer(TicketBinding binding) {
    return jdbc.sql("""
        UPDATE chat_view_slots SET viewer_lease_expires_at=least(now()+interval '45 seconds',
          viewer_authorization_expires_at) WHERE id=:scope AND presentation_revision=:revision
          AND active_viewer_instance_id=:viewer AND view_generation=:generation
          AND retired_at IS NULL AND viewer_lease_expires_at>now()
          AND viewer_authorization_expires_at>now()
        """).param("scope", binding.viewScopeId()).param("revision", binding.presentationRevision())
        .param("viewer", binding.viewerInstanceId()).param("generation", binding.viewGeneration())
        .update() == 1;
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public Optional<ChatPresentation> lock(AuthenticatedActor actor, String correlation) {
    return jdbc.sql(
            """
            SELECT * FROM chat_view_slots WHERE user_id=:user AND client_id=:client
              AND verified_correlation=:correlation FOR UPDATE
            """)
        .param("user", actor.userId())
        .param("client", actor.clientId())
        .param("correlation", correlation)
        .query(ChatPresentation.class)
        .optional();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public ChatPresentation create(
      AuthenticatedActor actor, String correlation, UUID taskId, long grantVersion) {
    return jdbc.sql(
            """
            INSERT INTO chat_view_slots(id,user_id,client_id,verified_correlation,task_id,
              grant_id,grant_version,access_epoch)
            VALUES(:id,:user,:client,:correlation,:task,:grant,:grantVersion,:accessEpoch)
            RETURNING *
            """)
        .param("id", UUID.randomUUID())
        .param("user", actor.userId())
        .param("client", actor.clientId())
        .param("correlation", correlation)
        .param("task", taskId)
        .param("grant", actor.grantId())
        .param("grantVersion", grantVersion)
        .param("accessEpoch", actor.accessEpoch())
        .query(ChatPresentation.class)
        .single();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public ChatPresentation publish(
      ChatPresentation previous, AuthenticatedActor actor, UUID taskId, long grantVersion) {
    return jdbc.sql(
            """
            UPDATE chat_view_slots SET task_id=:task,presentation_revision=presentation_revision+1,
              grant_id=:grant,grant_version=:grantVersion,access_epoch=:accessEpoch,
              version=version+1,updated_at=now()
            WHERE id=:id AND presentation_revision=:revision AND retired_at IS NULL RETURNING *
            """)
        .param("id", previous.id())
        .param("revision", previous.presentationRevision())
        .param("task", taskId)
        .param("grant", actor.grantId())
        .param("grantVersion", grantVersion)
        .param("accessEpoch", actor.accessEpoch())
        .query(ChatPresentation.class)
        .single();
  }

  public boolean retiredInstance(UUID scope, UUID viewer) {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM chat_view_instances
              WHERE view_scope_id=:scope AND viewer_instance_id=:viewer AND retired_at IS NOT NULL)
            """)
        .param("scope", scope)
        .param("viewer", viewer)
        .query(Boolean.class)
        .single();
  }

  public boolean currentInstance(UUID scope, UUID viewer, long revision, long generation) {
    return jdbc.sql("""
        SELECT EXISTS(SELECT 1 FROM chat_view_instances WHERE view_scope_id=:scope
          AND viewer_instance_id=:viewer AND presentation_revision=:revision
          AND view_generation=:generation AND retired_at IS NULL)
        """).param("scope", scope).param("viewer", viewer).param("revision", revision)
        .param("generation", generation).query(Boolean.class).single();
  }

  /** Revocation and its exact physical fence intent commit together. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void retireViewer(ChatPresentation slot) {
    jdbc.sql(
            """
            UPDATE chat_view_instances SET retired_at=coalesce(retired_at,now())
            WHERE view_scope_id=:scope AND presentation_revision=:revision AND retired_at IS NULL
            """)
        .param("scope", slot.id())
        .param("revision", slot.presentationRevision())
        .update();
    releaseViewer(slot);
  }

  /**
   * An expired lease releases channels; only publication or a winning replacement retires a mount.
   */
  @Transactional(propagation = Propagation.MANDATORY)
  public void releaseViewer(ChatPresentation slot) {
    if (slot.activeViewerInstanceId() == null) {
      return;
    }
    jdbc.sql(
            """
            INSERT INTO transactional_outbox(id,user_id,aggregate_id,aggregate_version,event_type,payload)
            SELECT gen_random_uuid(),user_id,id,view_generation,'viewer.fence',
              jsonb_build_object('workerId',worker_id,'workerBootId',worker_boot_id,
                'browserSessionId',browser_session_id,'allocationEpoch',allocation_epoch,
                'viewerId',active_viewer_instance_id,'viewGeneration',view_generation,
                'presentationRevision',presentation_revision)
            FROM chat_view_slots WHERE id=:id AND browser_session_id IS NOT NULL
              AND active_viewer_instance_id=:viewer AND view_generation=:generation
            ON CONFLICT(aggregate_id,aggregate_version,event_type,ordinal) DO NOTHING
            """)
        .param("id", slot.id())
        .param("viewer", slot.activeViewerInstanceId())
        .param("generation", slot.viewGeneration())
        .update();
    jdbc.sql(
            """
        UPDATE chat_view_slots SET active_viewer_instance_id=NULL,viewer_lease_expires_at=NULL,
          events_connected=false,media_connected=false,media_ticket_expires_at=NULL,
          control_epoch=0,page_epoch=0,privacy_epoch=0,media_generation=0,
              viewer_authorization_expires_at=NULL,browser_session_id=NULL,worker_id=NULL,
              worker_boot_id=NULL,allocation_epoch=0,version=version+1,updated_at=now(),
              transfer_state=CASE WHEN EXISTS(SELECT 1 FROM transactional_outbox o
                WHERE o.aggregate_id=:id AND o.event_type='viewer.fence' AND o.published_at IS NULL)
                THEN 'TRANSFERRING' ELSE 'ACTIVE' END
            WHERE id=:id AND active_viewer_instance_id=:viewer AND view_generation=:generation
            """)
        .param("id", slot.id())
        .param("viewer", slot.activeViewerInstanceId())
        .param("generation", slot.viewGeneration())
        .update();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public ChatPresentation admit(
      ChatPresentation slot,
      AuthenticatedActor actor,
      UUID viewer,
      long grantVersion,
      Instant authorizationExpiresAt,
      Instant leaseExpiresAt) {
    jdbc.sql(
            """
            UPDATE chat_view_instances SET retired_at=now() WHERE view_scope_id=:scope
              AND viewer_instance_id<>:viewer AND retired_at IS NULL
            """)
        .param("scope", slot.id())
        .param("viewer", viewer)
        .update();
    ChatPresentation admitted =
        jdbc.sql(
                """
                UPDATE chat_view_slots SET active_viewer_instance_id=:viewer,
                  view_generation=view_generation+1,viewer_lease_expires_at=:lease,
                  viewer_authorization_expires_at=:authorization,grant_id=:grant,
                  grant_version=:grantVersion,access_epoch=:epoch,version=version+1,updated_at=now()
                WHERE id=:id AND active_viewer_instance_id IS NULL AND retired_at IS NULL
                  AND presentation_revision=:revision RETURNING *
                """)
            .param("id", slot.id())
            .param("revision", slot.presentationRevision())
            .param("viewer", viewer)
        .param("lease", Timestamp.from(leaseExpiresAt))
        .param("authorization", Timestamp.from(authorizationExpiresAt))
            .param("grant", actor.grantId())
            .param("grantVersion", grantVersion)
            .param("epoch", actor.accessEpoch())
            .query(ChatPresentation.class)
            .single();
    jdbc.sql(
            """
            INSERT INTO chat_view_instances(view_scope_id,viewer_instance_id,presentation_revision,
              view_generation) VALUES(:scope,:viewer,:revision,:generation)
            ON CONFLICT(view_scope_id,viewer_instance_id) DO UPDATE SET view_generation=excluded.view_generation
            WHERE chat_view_instances.retired_at IS NULL
              AND chat_view_instances.presentation_revision=excluded.presentation_revision
            """)
        .param("scope", admitted.id())
        .param("viewer", viewer)
        .param("revision", admitted.presentationRevision())
        .param("generation", admitted.viewGeneration())
        .update();
    return admitted;
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public List<ChatPresentation> expiredViewers() {
    return jdbc.sql(
            """
            SELECT * FROM chat_view_slots WHERE active_viewer_instance_id IS NOT NULL
              AND retired_at IS NULL AND (viewer_lease_expires_at<=now()
                OR viewer_authorization_expires_at<=now())
            ORDER BY viewer_lease_expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
            """)
        .query(ChatPresentation.class)
        .list();
  }

  public ChatPresentation reserveMedia(ChatPresentation slot, BrowserMediaBinding media, Instant expiry) {
    return jdbc.sql("""
        UPDATE chat_view_slots SET browser_session_id=:session,worker_id=:worker,
          worker_boot_id=:boot,allocation_epoch=:allocation,control_epoch=:control,page_epoch=:page,
          privacy_epoch=:privacy,media_generation=:media,media_ticket_expires_at=:expiry,
          version=version+1,updated_at=now()
        WHERE id=:id AND active_viewer_instance_id=:viewer AND view_generation=:generation
          AND transfer_state='ACTIVE' AND retired_at IS NULL RETURNING *
        """).param("session", media.sessionId()).param("worker", media.workerId())
        .param("boot", media.workerBootId()).param("allocation", media.allocationEpoch())
        .param("control", media.controlEpoch()).param("page", media.pageEpoch())
        .param("privacy", media.privacyEpoch()).param("media", media.mediaGeneration())
        .param("expiry", Timestamp.from(expiry)).param("id", slot.id())
        .param("viewer", slot.activeViewerInstanceId()).param("generation", slot.viewGeneration())
        .query(ChatPresentation.class).single();
  }

  public boolean connectMedia(TicketBinding binding) {
    return jdbc.sql("""
        UPDATE chat_view_slots SET media_connected=true WHERE id=:scope
          AND presentation_revision=:revision AND active_viewer_instance_id=:viewer
          AND view_generation=:generation AND NOT media_connected AND retired_at IS NULL
          AND transfer_state='ACTIVE' AND browser_session_id=:session
          AND viewer_lease_expires_at>now() AND viewer_authorization_expires_at>now()
        """).param("scope", binding.viewScopeId()).param("revision", binding.presentationRevision())
        .param("viewer", binding.viewerInstanceId()).param("generation", binding.viewGeneration())
        .param("session", binding.sessionId()).update() == 1;
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public Optional<ChatPresentation> lock(UUID id) {
    return jdbc.sql("SELECT * FROM chat_view_slots WHERE id=:id FOR UPDATE")
        .param("id", id).query(ChatPresentation.class).optional();
  }

  @Transactional
  public List<ViewerFence> dueFences() {
    return jdbc.sql(
            """
            WITH due AS (
              SELECT id FROM transactional_outbox WHERE event_type='viewer.fence'
                AND published_at IS NULL AND delivery_attempts<8 AND retry_at<=now()
              ORDER BY retry_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
            ) UPDATE transactional_outbox o SET delivery_attempts=delivery_attempts+1,
              retry_at=now()+make_interval(secs=>least(30,power(2,delivery_attempts+1)::int)),
              last_failure_code='VIEWER_FENCE_ACK_PENDING'
            FROM due WHERE o.id=due.id
            RETURNING o.id request_id,(payload->>'workerId')::uuid worker_id,
              (payload->>'workerBootId')::uuid worker_boot_id,
              (payload->>'browserSessionId')::uuid browser_session_id,
              (payload->>'allocationEpoch')::bigint allocation_epoch,
              (payload->>'viewerId')::uuid viewer_id,(payload->>'viewGeneration')::bigint view_generation
            """)
        .query(ViewerFence.class)
        .list();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public Optional<UUID> confirmFence(ViewerFence fence) {
    // Match even a previously published exact receipt: the worker's confirmation may have been
    // lost.
    Optional<UUID> scope =
        jdbc.sql(
                """
                UPDATE transactional_outbox SET published_at=coalesce(published_at,now()),last_failure_code=NULL
                WHERE id=:id AND event_type='viewer.fence'
                  AND payload->>'workerId'=:worker AND payload->>'workerBootId'=:boot
                  AND payload->>'browserSessionId'=:session AND payload->>'allocationEpoch'=:allocation
                  AND payload->>'viewerId'=:viewer AND payload->>'viewGeneration'=:generation
                RETURNING aggregate_id
                """)
            .param("id", fence.requestId())
            .param("worker", fence.workerId().toString())
            .param("boot", fence.workerBootId().toString())
            .param("session", fence.browserSessionId().toString())
            .param("allocation", Long.toString(fence.allocationEpoch()))
            .param("viewer", fence.viewerId().toString())
            .param("generation", Long.toString(fence.viewGeneration()))
            .query(UUID.class)
            .optional();
    if (scope.isEmpty()) {
      return Optional.empty();
    }
    jdbc.sql(
            """
            UPDATE chat_view_slots SET transfer_state='ACTIVE',version=version+1,updated_at=now()
            WHERE id=:id AND transfer_state='TRANSFERRING' AND retired_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM transactional_outbox
                WHERE aggregate_id=:id AND event_type='viewer.fence' AND published_at IS NULL)
            """)
        .param("id", scope.get())
        .update();
    return scope;
  }

  public void requestWebFence(UUID userId, ViewerFence fence) {
    jdbc.sql("""
        INSERT INTO transactional_outbox(id,user_id,aggregate_id,aggregate_version,event_type,payload)
        VALUES(:id,:user,:viewer,:generation,'viewer.fence',jsonb_build_object(
          'workerId',CAST(:worker AS text),'workerBootId',CAST(:boot AS text),
          'browserSessionId',CAST(:session AS text),'allocationEpoch',CAST(:allocation AS bigint),
          'viewerId',CAST(:viewer AS text),'viewGeneration',CAST(:generation AS bigint)))
        ON CONFLICT(aggregate_id,aggregate_version,event_type,ordinal) DO NOTHING
        """).param("id", fence.requestId()).param("user", userId)
        .param("worker", fence.workerId()).param("boot", fence.workerBootId())
        .param("session", fence.browserSessionId()).param("allocation", fence.allocationEpoch())
        .param("viewer", fence.viewerId()).param("generation", fence.viewGeneration()).update();
  }

  public void fenceTransportFailed(UUID id) {
    jdbc.sql(
            """
            UPDATE transactional_outbox SET last_failure_code='WORKER_TRANSPORT_UNAVAILABLE'
            WHERE id=:id AND event_type='viewer.fence' AND published_at IS NULL
            """)
        .param("id", id)
        .update();
  }
}
