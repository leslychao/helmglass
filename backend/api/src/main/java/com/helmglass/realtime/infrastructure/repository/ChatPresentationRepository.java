package com.helmglass.realtime.infrastructure.repository;

import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.realtime.domain.ChatPresentation;
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
    return jdbc.sql("""
        SELECT * FROM chat_view_slots WHERE user_id=:user AND client_id=:client
          AND verified_correlation=:correlation
        """)
        .param("user", actor.userId()).param("client", actor.clientId())
        .param("correlation", correlation).query(ChatPresentation.class).optional();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public Optional<ChatPresentation> lock(AuthenticatedActor actor, String correlation) {
    return jdbc.sql("""
        SELECT * FROM chat_view_slots WHERE user_id=:user AND client_id=:client
          AND verified_correlation=:correlation FOR UPDATE
        """)
        .param("user", actor.userId()).param("client", actor.clientId())
        .param("correlation", correlation).query(ChatPresentation.class).optional();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public ChatPresentation create(AuthenticatedActor actor, String correlation, UUID taskId,
      long grantVersion) {
    return jdbc.sql("""
        INSERT INTO chat_view_slots(id,user_id,client_id,verified_correlation,task_id,
          grant_id,grant_version,access_epoch)
        VALUES(:id,:user,:client,:correlation,:task,:grant,:grantVersion,:accessEpoch)
        RETURNING *
        """)
        .param("id", UUID.randomUUID()).param("user", actor.userId())
        .param("client", actor.clientId()).param("correlation", correlation)
        .param("task", taskId).param("grant", actor.grantId())
        .param("grantVersion", grantVersion).param("accessEpoch", actor.accessEpoch())
        .query(ChatPresentation.class).single();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public ChatPresentation publish(ChatPresentation previous, AuthenticatedActor actor,
      UUID taskId, long grantVersion) {
    return jdbc.sql("""
        UPDATE chat_view_slots SET task_id=:task,presentation_revision=presentation_revision+1,
          grant_id=:grant,grant_version=:grantVersion,access_epoch=:accessEpoch,
          version=version+1,updated_at=now()
        WHERE id=:id AND presentation_revision=:revision AND retired_at IS NULL RETURNING *
        """)
        .param("id", previous.id()).param("revision", previous.presentationRevision())
        .param("task", taskId).param("grant", actor.grantId())
        .param("grantVersion", grantVersion).param("accessEpoch", actor.accessEpoch())
        .query(ChatPresentation.class).single();
  }

  public boolean retiredInstance(UUID scope, UUID viewer) {
    return jdbc.sql("""
        SELECT EXISTS(SELECT 1 FROM chat_view_instances
          WHERE view_scope_id=:scope AND viewer_instance_id=:viewer AND retired_at IS NOT NULL)
        """)
        .param("scope", scope).param("viewer", viewer).query(Boolean.class).single();
  }

  /** Revocation and its exact physical fence intent commit together. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void retireViewer(ChatPresentation slot) {
    if (slot.activeViewerInstanceId() == null) {
      return;
    }
    jdbc.sql("""
        UPDATE chat_view_instances SET retired_at=coalesce(retired_at,now())
        WHERE view_scope_id=:scope AND viewer_instance_id=:viewer
        """)
        .param("scope", slot.id()).param("viewer", slot.activeViewerInstanceId()).update();
    jdbc.sql("""
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
        .param("id", slot.id()).param("viewer", slot.activeViewerInstanceId())
        .param("generation", slot.viewGeneration()).update();
    jdbc.sql("""
        UPDATE chat_view_slots SET active_viewer_instance_id=NULL,viewer_lease_expires_at=NULL,
          viewer_authorization_expires_at=NULL,browser_session_id=NULL,worker_id=NULL,
          worker_boot_id=NULL,allocation_epoch=0,version=version+1,updated_at=now(),
          transfer_state=CASE WHEN EXISTS(SELECT 1 FROM transactional_outbox o
            WHERE o.aggregate_id=:id AND o.event_type='viewer.fence' AND o.published_at IS NULL)
            THEN 'TRANSFERRING' ELSE 'ACTIVE' END
        WHERE id=:id AND active_viewer_instance_id=:viewer AND view_generation=:generation
        """)
        .param("id", slot.id()).param("viewer", slot.activeViewerInstanceId())
        .param("generation", slot.viewGeneration()).update();
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public ChatPresentation admit(ChatPresentation slot, AuthenticatedActor actor, UUID viewer,
      long grantVersion, Instant authorizationExpiresAt, Instant leaseExpiresAt) {
    ChatPresentation admitted = jdbc.sql("""
        UPDATE chat_view_slots SET active_viewer_instance_id=:viewer,
          view_generation=view_generation+1,viewer_lease_expires_at=:lease,
          viewer_authorization_expires_at=:authorization,grant_id=:grant,
          grant_version=:grantVersion,access_epoch=:epoch,version=version+1,updated_at=now()
        WHERE id=:id AND active_viewer_instance_id IS NULL AND retired_at IS NULL
          AND presentation_revision=:revision RETURNING *
        """)
        .param("id", slot.id()).param("revision", slot.presentationRevision())
        .param("viewer", viewer).param("lease", leaseExpiresAt)
        .param("authorization", authorizationExpiresAt).param("grant", actor.grantId())
        .param("grantVersion", grantVersion).param("epoch", actor.accessEpoch())
        .query(ChatPresentation.class).single();
    jdbc.sql("""
        INSERT INTO chat_view_instances(view_scope_id,viewer_instance_id,presentation_revision,
          view_generation) VALUES(:scope,:viewer,:revision,:generation)
        """)
        .param("scope", admitted.id()).param("viewer", viewer)
        .param("revision", admitted.presentationRevision())
        .param("generation", admitted.viewGeneration()).update();
    return admitted;
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public List<ChatPresentation> expiredViewers() {
    return jdbc.sql("""
        SELECT * FROM chat_view_slots WHERE active_viewer_instance_id IS NOT NULL
          AND retired_at IS NULL AND (viewer_lease_expires_at<=now()
            OR viewer_authorization_expires_at<=now())
        ORDER BY viewer_lease_expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
        """).query(ChatPresentation.class).list();
  }
}
