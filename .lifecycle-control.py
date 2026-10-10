from pathlib import Path
p=Path('backend/api/src/main/java/ru/helmglass/api/browsers/BrowserService.java')
s=p.read_text(encoding='utf-8')
s=s.replace('private_mode=true,pending_control=CAST(:intent AS jsonb),version=version+1,', '''private_mode=true,pending_control=CAST(:intent AS jsonb),version=version+1,
  control_deadline_at=clock_timestamp()+(:seconds*interval '1 second'),
  control_next_check_at=clock_timestamp(),''')
s=s.replace('.param("intent", json.write(new ControlIntent(input, keepPrivate)))', '''.param("intent", json.write(new ControlIntent(input, keepPrivate)))
        .param("seconds", Boolean.TRUE.equals(input.saveConnection()) ? 360 : 30)''')
start=s.index('  @Scheduled(fixedDelay = 500)\n  public void deliverControlIntents()')
end=s.index('  private void applyControl', start)
s=s[:start]+'''  @Scheduled(fixedDelay = 500)
  public void deliverControlIntents() {
    var pending = jdbc.sql("""
            SELECT id,owner_id FROM browser_sessions WHERE pending_control IS NOT NULL
              AND status='LIVE' AND NOT close_requested
              AND control_next_check_at<=clock_timestamp()
            ORDER BY control_next_check_at,id LIMIT 20
            """).query((row, index) -> new PendingControl(row.getObject("id", UUID.class),
                row.getObject("owner_id", UUID.class))).list();
    for (PendingControl candidate : pending) {
      ControlWork work = transactions.execute(transaction -> {
        tasks.lockOwner(candidate.owner());
        return jdbc.sql("""
                UPDATE browser_sessions SET control_next_check_at=clock_timestamp()+interval '6 minutes'
                WHERE id=:id AND pending_control IS NOT NULL AND NOT close_requested
                  AND control_next_check_at<=clock_timestamp()
                RETURNING pending_control::text,control_epoch,control_deadline_at
                """).param("id", candidate.id()).query((row, index) -> new ControlWork(
                    json.convert(json.read(row.getString("pending_control")), ControlIntent.class),
                    row.getLong("control_epoch"), Database.instant(row, "control_deadline_at")))
            .optional().orElse(null);
      });
      if (work == null) continue;
      try {
        applyControl(candidate.owner(), candidate.id(), work);
      } catch (RuntimeException exception) {
        // A lost acknowledgement cannot restore authority safely. Closing wins over a late reply.
        transactions.executeWithoutResult(transaction -> {
          tasks.lockOwner(candidate.owner());
          if (get(candidate.owner(), candidate.id()).controlEpoch() != work.epoch()) return;
          if (Boolean.TRUE.equals(work.intent().input().saveConnection())) {
            recordProfileFailure(candidate.owner(), work.intent().input().connectionId(),
                new WorkerClient.WorkerException("PROFILE_SAVE_FAILED", 0));
          }
          closeForFailure(candidate.owner(), candidate.id(), "CONTROL_UNCONFIRMED");
        });
      }
    }
  }

  @Scheduled(fixedDelay = 2000)
  public void expireControlIntents() {
    var expired = jdbc.sql("""
            SELECT id,owner_id FROM browser_sessions WHERE pending_control IS NOT NULL
              AND NOT close_requested AND control_deadline_at<=clock_timestamp()
            ORDER BY control_deadline_at,id LIMIT 20
            """).query((row, index) -> new PendingControl(row.getObject("id", UUID.class),
                row.getObject("owner_id", UUID.class))).list();
    for (PendingControl candidate : expired) {
      transactions.executeWithoutResult(transaction -> {
        tasks.lockOwner(candidate.owner());
        closeForFailure(candidate.owner(), candidate.id(), "CONTROL_DEADLINE_EXCEEDED");
      });
    }
  }

  public void closeForFailure(UUID owner, UUID session, String reason) {
    SessionReference reference = reference(session);
    if (reference.closeRequested()) return;
    if (reference.taskId() != null && !"STOPPING".equals(tasks.get(owner, reference.taskId()).status())) {
      tasks.closeBrowser(owner, reference.taskId());
      tasks.history(owner, reference.taskId(), "BROWSER_FAILURE", "Браузер закрывается", reason);
    } else {
      jdbc.sql("UPDATE browser_sessions SET close_requested=true,pending_control=NULL,"
              + "version=version+1 WHERE id=:id").param("id", session).update();
    }
    events.emit(owner, "browser", session, 0);
  }

  private record ControlWork(ControlIntent intent, long epoch, Instant deadline) {}

''' + s[end:]
s=s.replace('private void applyControl(UUID owner, UUID id, ControlIntent intent) {\n    Contracts.ControlInput input = intent.input();', 'private void applyControl(UUID owner, UUID id, ControlWork work) {\n    ControlIntent intent = work.intent();\n    Contracts.ControlInput input = intent.input();')
s=s.replace('long epoch = browser.controlEpoch();\n    boolean incompleteLogin', 'long epoch = work.epoch();\n    boolean incompleteLogin')
s=s.replace('payload.put("controlEpoch", epoch);', 'payload.put("controlEpoch", epoch);\n    payload.put("deadlineAt", work.deadline().toString());')
s=s.replace('saveProfile(owner, id, input.connectionId(), input.accountLabel(), input.accountSubject(), epoch);', 'saveProfile(owner, id, input.connectionId(), input.accountLabel(), input.accountSubject(), epoch, work.deadline());')
s=s.replace('    worker.call("POST", "/sessions/" + id + "/control", payload);\n    jdbc.sql(', '''    worker.call("POST", "/sessions/" + id + "/control", payload, remaining(work.deadline()));
    transactions.executeWithoutResult(transaction -> {
    tasks.lockOwner(owner);
    if (reference(id).closeRequested() || get(owner, id).controlEpoch() != epoch) return;
    jdbc.sql(''')
s=s.replace('controller_id=:controller,pending_control=NULL,', 'controller_id=:controller,pending_control=NULL,control_deadline_at=NULL,')
s=s.replace('    if (sessionSave) {\n      events.emit(owner, "browser", id, browser.version() + 1);', '    if (sessionSave) {\n      refreshIdle(owner, id, true);\n      events.emit(owner, "browser", id, browser.version() + 1);')
s=s.replace('    refreshIdle(owner, id, true);\n  }\n\n  private record PendingControl', '    refreshIdle(owner, id, true);\n    });\n  }\n\n  private record PendingControl')
s=s.replace('UUID owner, UUID session, UUID connection, String label, String subject, long controlEpoch) {', 'UUID owner, UUID session, UUID connection, String label, String subject, long controlEpoch,\n      Instant deadline) {')
s=s.replace('"operationId", session + ":" + controlEpoch), Duration.ofSeconds(310));\n    recordProfileSave', '''"operationId", session + ":" + controlEpoch, "deadlineAt", deadline.toString()), remaining(deadline));
    transactions.executeWithoutResult(transaction -> {
    tasks.lockOwner(owner);
    if (reference(session).closeRequested() || get(owner, session).controlEpoch() != controlEpoch) return;
    recordProfileSave''')
s=s.replace('    events.emit(owner, "connection", connection, 0);\n  }\n\n  @Transactional(propagation', '''    events.emit(owner, "connection", connection, 0);
    });
  }

  private static Duration remaining(Instant deadline) {
    Duration duration = Duration.between(Instant.now(), deadline);
    if (duration.isNegative() || duration.isZero()) {
      throw new WorkerClient.WorkerException("OPERATION_DEADLINE_EXCEEDED", 408);
    }
    return duration;
  }

  @Transactional(propagation''')
s=s.replace('  @Transactional\n  public boolean prepareClose(UUID session)', '  public boolean prepareClose(UUID session)')
s=s.replace('    tasks.lockOwner(owner);\n    SessionReference reference = reference(session);', '    SessionReference reference = reference(session);')
s=s.replace('  @Transactional\n  public boolean refreshProfile(UUID owner, UUID session, String operationId)', '  public boolean refreshProfile(UUID owner, UUID session, String operationId)')
s=s.replace('    tasks.lockOwner(owner);\n    var connection = jdbc.sql', '    var connection = jdbc.sql')
p.write_text(s, encoding='utf-8', newline='\n')
