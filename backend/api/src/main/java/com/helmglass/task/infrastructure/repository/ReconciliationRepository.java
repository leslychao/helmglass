package com.helmglass.task.infrastructure.repository;

import com.helmglass.api.DomainException;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ReconciliationRepository {
  private final JdbcClient jdbc;

  public ReconciliationRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public void requireSource(UUID taskId, UUID commandId, UUID humanOperationId) {
    boolean command = commandId != null;
    String sql = command ? """
        SELECT id FROM task_commands WHERE id=:source AND task_id=:task AND state='UNKNOWN'
        """ : """
        SELECT o.id FROM operations o JOIN browser_sessions s ON s.id=o.target_id
        WHERE o.id=:source AND s.task_id=:task AND o.human_checkpoint IN ('OPEN','UNKNOWN')
        """;
    if (jdbc.sql(sql).param("source", command ? commandId : humanOperationId).param("task", taskId)
        .query(UUID.class).optional().isEmpty()) {
      throw DomainException.notFound();
    }
  }

  public Optional<UUID> existing(UUID commandId, UUID humanOperationId) {
    return jdbc.sql("""
        SELECT id FROM operations WHERE kind='RECONCILE_EFFECT'
        AND (source_command_id=:command OR source_human_operation_id=:human)
        """).param("command", commandId).param("human", humanOperationId)
        .query(UUID.class).optional();
  }

  public UUID unavailable(UUID userId, UUID taskId, UUID commandId, UUID humanOperationId) {
    UUID id = UUID.randomUUID();
    jdbc.sql("""
        INSERT INTO operations(id,user_id,kind,target_type,target_id,state,request_id,
        source_command_id,source_human_operation_id,reconciliation_outcome,evidence,failure_code)
        VALUES(:id,:user,'RECONCILE_EFFECT','task',:task,'NEEDS_ATTENTION',:id,:command,:human,
        'UNRESOLVED',jsonb_build_object('source','NO_SAFE_VERIFIER','checkedAt',now()),'NO_SAFE_VERIFIER')
        """).param("id", id).param("user", userId).param("task", taskId)
        .param("command", commandId).param("human", humanOperationId).update();
    return id;
  }

  public Map<String, Object> outcome(UUID userId, UUID id) {
    return jdbc.sql("""
        SELECT id AS "resolutionId",state,reconciliation_outcome AS outcome,
        failure_code AS "reason",updated_at AS "checkedAt" FROM operations
        WHERE id=:id AND user_id=:user AND kind='RECONCILE_EFFECT'
        """).param("id", id).param("user", userId).query().listOfRows().stream().findFirst()
        .orElseThrow(DomainException::notFound);
  }
}
