from pathlib import Path
p=Path('backend/api/src/main/java/ru/helmglass/api/browsers/AdmissionService.java')
s=p.read_text(encoding='utf-8')
s=s.replace('import java.util.HashMap;', 'import java.util.HashMap;\nimport java.util.concurrent.ExecutorService;\nimport java.util.concurrent.Executors;\nimport java.util.concurrent.Semaphore;')
s=s.replace('import ru.helmglass.api.tasks.TaskService;', 'import ru.helmglass.api.tasks.TaskService;\nimport ru.helmglass.api.tasks.ActionService;')
s=s.replace('  private final ArtifactService artifacts;', '''  private final ArtifactService artifacts;
  private final ActionService actions;
  private final ExecutorService reconciler = Executors.newVirtualThreadPerTaskExecutor();
  private final Semaphore reconciliationSlots = new Semaphore(4);
  private final Semaphore archiveSlot = new Semaphore(1);''')
s=s.replace('      ArtifactService artifacts,', '      ArtifactService artifacts,\n      ActionService actions,')
s=s.replace('    this.artifacts = artifacts;', '    this.artifacts = artifacts;\n    this.actions = actions;')
start=s.index('      var sessions =',s.index('public void reconcile()'))
end=s.index('    } catch (RuntimeException exception)',start)
s=s[:start]+'''      var sessions = jdbc.sql("""
              SELECT id FROM browser_sessions WHERE node_id=:node AND status<>'CLOSED'
                AND next_check_at<=clock_timestamp() ORDER BY next_check_at,id LIMIT 20
              """).param("node", node).query(UUID.class).list();
      for (UUID session : sessions) {
        if (!reconciliationSlots.tryAcquire()) break;
        int claimed = jdbc.sql("""
                UPDATE browser_sessions SET next_check_at=clock_timestamp()+interval '45 seconds'
                WHERE id=:id AND next_check_at<=clock_timestamp()
                """).param("id", session).update();
        if (claimed == 0) { reconciliationSlots.release(); continue; }
        reconciler.execute(() -> {
          try { reconcileSession(session); }
          catch (RuntimeException exception) {
            log.warn("Session reconciliation failed for {}: {}", session, exception.getClass().getSimpleName());
          } finally {
            jdbc.sql("UPDATE browser_sessions SET next_check_at=clock_timestamp()+interval '3 seconds' WHERE id=:id")
                .param("id", session).update();
            reconciliationSlots.release();
          }
        });
      }
''' + s[end:]
start=s.index('  private void recordHealth(')
s=s[:start]+'''  private void reconcileSession(UUID session) {
    JsonNode result = worker.call("GET", "/sessions/" + session, null);
    browsers.reconcile(session, result);
    String state = result.path("status").asString("UNKNOWN");
    boolean close = jdbc.sql("""
            SELECT close_requested AND NOT EXISTS(SELECT 1 FROM operations o JOIN tasks t ON t.id=o.task_id
              WHERE o.session_id=b.id AND o.status='DISPATCHED' AND t.status='PAUSING'
                AND o.deadline_at+interval '10 seconds'>clock_timestamp())
            FROM browser_sessions b WHERE b.id=:id
            """).param("id", session).query(Boolean.class).single();
    if ((close || "LOST".equals(state)) && !"CLOSED".equals(state)) {
      if ("LIVE".equals(state) && !browsers.prepareClose(session)) return;
      browsers.reconcile(session, worker.call("DELETE", "/sessions/" + session, null));
    }
  }

  @Scheduled(fixedDelay = 1000)
  public void archiveSessions() {
    if (!archiveSlot.tryAcquire()) return;
    try {
      var candidate = jdbc.sql("""
              UPDATE browser_sessions SET next_check_at=clock_timestamp()+interval '7 minutes'
              WHERE id=(SELECT id FROM browser_sessions WHERE status='CLOSED'
                AND cleanup_state IN ('PENDING','RUNNING') AND next_check_at<=clock_timestamp()
                ORDER BY next_check_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
              RETURNING id
              """).query(UUID.class).optional();
      if (candidate.isEmpty()) { archiveSlot.release(); return; }
      UUID session = candidate.get();
      reconciler.execute(() -> {
        try {
          boolean receipts = actions.archiveReceipts(session);
          boolean files = artifacts.importSessionBatch(session);
          if (receipts && files) {
            JsonNode cleaned = worker.call("DELETE", "/sessions/" + session + "/cleanup", null);
            if (!"COMPLETE".equals(cleaned.path("cleanupState").asString())) {
              throw new IllegalStateException("Cleanup was not confirmed");
            }
            cleanupState(session, "COMPLETE", null, false);
          } else {
            cleanupState(session, "PENDING", null, false);
          }
        } catch (RuntimeException exception) {
          cleanupState(session, "PENDING", "ARTIFACT_DELIVERY_OR_CLEANUP_FAILED", true);
        } finally { archiveSlot.release(); }
      });
    } catch (RuntimeException exception) {
      archiveSlot.release(); throw exception;
    }
  }

  private void cleanupState(UUID session, String state, String error, boolean failed) {
    transactions.executeWithoutResult(transaction -> {
      var reference = browsers.reference(session);
      tasks.lockOwner(reference.ownerId());
      jdbc.sql("""
              UPDATE browser_sessions SET cleanup_attempts=cleanup_attempts+CASE WHEN :failed THEN 1 ELSE 0 END,
                cleanup_state=CASE WHEN :failed AND cleanup_attempts>=2 THEN 'FAILED' ELSE :state END,
                cleanup_error=:error,next_check_at=clock_timestamp()+
                  (CASE WHEN :failed THEN CASE cleanup_attempts WHEN 0 THEN 1 WHEN 1 THEN 3 ELSE 10 END ELSE 1 END)*interval '1 second',
                version=version+1 WHERE id=:id
              """).param("id", session).param("failed", failed).param("state", state).param("error", error).update();
      events.emit(reference.ownerId(), "browser", session, 0);
      events.emitAdministrators("node", session, 0);
    });
  }

  @org.springframework.transaction.annotation.Transactional
  public Object retryCleanup(UUID session) {
    var reference = browsers.reference(session);
    tasks.lockOwner(reference.ownerId());
    int changed = jdbc.sql("""
            UPDATE browser_sessions SET cleanup_state='PENDING',cleanup_error=NULL,cleanup_attempts=0,
              next_check_at=clock_timestamp(),version=version+1 WHERE id=:id AND cleanup_state='FAILED'
            """).param("id", session).update();
    if (changed != 1) throw ApiException.conflict("CLEANUP_NOT_FAILED", "Повтор очистки сейчас не требуется.");
    events.emit(reference.ownerId(), "browser", session, 0);
    return browsers.get(reference.ownerId(), session);
  }

  @jakarta.annotation.PreDestroy
  void stopReconciler() { reconciler.shutdownNow(); }

''' +s[start:]
s=s.replace('    payload.put("startUrl", allocation.url());','''    payload.put("startUrl", allocation.url());
    payload.put("deadlineAt", jdbc.sql("SELECT start_deadline_at FROM browser_sessions WHERE id=:id")
        .param("id", allocation.id()).query((row, index) -> ru.helmglass.api.Database.instant(row, "start_deadline_at")).single().toString());''')
s=s.replace("UPDATE browser_sessions SET status='STARTING',node_id=:node WHERE id=:id", "UPDATE browser_sessions SET status='STARTING',start_deadline_at=clock_timestamp()+interval '6 minutes',node_id=:node WHERE id=:id")
s=s.replace('  private record Pending(UUID id, boolean close) {}\n\n','')
p.write_text(s,encoding='utf-8',newline='\n')
