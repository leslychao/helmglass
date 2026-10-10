from pathlib import Path
p=Path('backend/api/src/main/java/ru/helmglass/api/tasks/ActionService.java')
s=p.read_text(encoding='utf-8').replace('import java.sql.Types;', 'import java.sql.Types;\nimport java.time.Duration;\nimport java.time.Instant;')
s=s.replace('return prepareBrowser(actor.id(), task.id());', 'return task;')
s=s.replace('instruction.put("revision", task.instructionRevision());','instruction.put("revision", task.instructionRevision());\n    if (task.browser() != null) instruction.put("browserId", task.browser().id());')
s=s.replace('    return operation(owner, action.operationId());\n  }', '    if (task.browser() != null) browsers.refreshIdle(owner, task.browser().id(), true);\n    return operation(owner, action.operationId());\n  }',1)
old='''      if (!browsers.refreshProfile(candidate.owner(), sessionId, command.id() + ":before-switch")) {
        complete(command, "FAILED", null, "PROFILE_SAVE_FAILED",
            "Не удалось сохранить текущее подключение. Смена аккаунта не выполнялась.");
        return null;
      }
'''
assert old in s
s=s.replace(old,'')
s=s.replace('+ " dispatched_at=clock_timestamp()"', '''+ " dispatched_at=clock_timestamp(),next_check_at=clock_timestamp()+interval '5 seconds',"
                + " deadline_at=clock_timestamp()+CASE WHEN type IN ('captureAudio','applyConnection')"
                + " THEN interval '6 minutes' ELSE interval '90 seconds' END"''')
s=s.replace('    request.put("explicitWait", dispatch.explicitWait());', '''    request.put("explicitWait", dispatch.explicitWait());
    Instant deadline = jdbc.sql("SELECT deadline_at FROM operations WHERE id=:id")
        .param("id", dispatch.id()).query((row, index) -> Database.instant(row, "deadline_at")).single();
    request.put("deadlineAt", deadline.toString());''')
s=s.replace('''      JsonNode response =
          worker.call("POST", "/sessions/" + dispatch.session() + "/commands", request);''', '''      if ("applyConnection".equals(dispatch.type())
          && !browsers.refreshProfile(dispatch.owner(), dispatch.session(), dispatch.id() + ":before-switch")) {
        complete(dispatch, "FAILED", null, "PROFILE_SAVE_FAILED",
            "Не удалось сохранить текущее подключение. Смена аккаунта не выполнялась.");
        return;
      }
      if (browsers.reference(dispatch.session()).closeRequested() || !deadline.isAfter(Instant.now())) {
        complete(dispatch, "FAILED", null, "CANCELLED_BEFORE_DISPATCH", "Действие не отправлено.");
        return;
      }
      JsonNode response = worker.call("POST", "/sessions/" + dispatch.session() + "/commands", request,
          Duration.between(Instant.now(), deadline));''')
s=s.replace('''" dispatched_at<now()-interval '45 seconds' ORDER BY dispatched_at LIMIT 20"''', '''" next_check_at<=clock_timestamp() ORDER BY next_check_at,id LIMIT 20"''')
s=s.replace('''    for (Dispatch operation : operations) {
      try {''', '''    for (Dispatch operation : operations) {
      jdbc.sql("UPDATE operations SET next_check_at=clock_timestamp()+interval '15 seconds' WHERE id=:id")
          .param("id", operation.id()).update();
      try {''')
s=s.replace('''    if ("SUCCEEDED".equals(status)) {
      artifacts.importResults(
          operation.owner(), operation.task(), operation.session(), operation.id(), result);
    }
''','')
s=s.replace('''        errorCode,
        errorMessage);
  }
''', '''        errorCode,
        errorMessage);
    if ("SUCCEEDED".equals(status)) {
      try {
        artifacts.importResults(operation.owner(), operation.task(), operation.session(), operation.id(), result);
      } catch (RuntimeException exception) {
        log.warn("Confirmed operation {} awaits artifact delivery: {}", operation.id(),
            exception.getClass().getSimpleName());
      }
    }
  }
''',1)
# Verify browser identity, because epochs restart in a replacement session.
s=s.replace('''    Long boundEpoch =''', '''    String boundSession = jdbc.sql("SELECT instruction_snapshot->>'browserId' FROM operations WHERE id=:id")
        .param("id", command.id()).query((row, index) -> row.getString(1)).optional().orElse(null);
    if (boundSession != null && !sessionId.toString().equals(boundSession)) {
      jdbc.sql("UPDATE operations SET status='CANCELLED',completed_at=now(),error_code='STALE_BROWSER' WHERE id=:id")
          .param("id", command.id()).update();
      tasks.requestContinuation(task.id());
      return null;
    }
    Long boundEpoch =''')
p.write_text(s,encoding='utf-8',newline='\n')
