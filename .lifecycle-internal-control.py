from pathlib import Path
p=Path('backend/api/src/main/java/ru/helmglass/api/browsers/BrowserService.java')
s=p.read_text(encoding='utf-8')
old='''          worker.call("POST", "/sessions/" + session + "/bind",
              Map.of("ownerId", owner, "taskId", taskId));
          worker.call("POST", "/sessions/" + session + "/control",
              Map.of("controlEpoch", epoch, "owner", "CHATGPT", "privateMode", false));'''
assert old in s
s=s.replace(old,'          Contracts.Browser previous = get(owner, session);')
s=s.replace('''          events.emit(owner, "browser", session, 0);
          return session;''', '''          queueInternalControl(owner, session, "ADOPT", previous, connectionId,
              "LOGIN".equals(tasks.get(owner, taskId).waitReason()));
          events.emit(owner, "browser", session, 0);
          return session;''',1)
s=s.replace('''      if ("LIVE".equals(opened.status())) {
        worker.call("POST", "/sessions/" + session + "/control",
            Map.of("controlEpoch", epoch, "owner", "NONE", "privateMode", true));
      }''','')
start=s.index('    if (connection != null && !connection.equals(previous.connectionId())) {',s.index('public Contracts.Task requireLogin'))
end=s.index('    if (task.request() == null)',start)
s=s[:start]+'''    boolean switching = connection != null && !connection.equals(previous.connectionId());
    if (switching) requireAvailableConnection(connection, session);
    if (switching || !browser.privateMode() || !"USER".equals(browser.controlOwner())) {
      if ("LIVE".equals(browser.status())) {
        queueInternalControl(owner, session, "LOGIN", browser, connection, true);
      } else {
        jdbc.sql("UPDATE browser_sessions SET private_mode=true,control_owner='NONE',"
                + "controller_id=NULL,login_completed=false,version=version+1 WHERE id=:id")
            .param("id", session).update();
      }
    }
''' +s[end:]
s=s.replace('new ControlIntent(input, keepPrivate)', 'new ControlIntent(input, keepPrivate, browser.controlOwner(), browser.privateMode(), reference.controllerId(), browser.connectionId())')
s=s.replace('''  private record ControlIntent(Contracts.ControlInput input, boolean keepPrivate) {}''', '''  private record ControlIntent(Contracts.ControlInput input, boolean keepPrivate,
      String previousOwner, Boolean previousPrivate, String previousController, UUID previousConnection) {}

  private void queueInternalControl(UUID owner, UUID session, String type, Contracts.Browser previous,
      UUID connection, boolean privateMode) {
    Contracts.ControlInput input = new Contracts.ControlInput(type, null, true, false, connection, null, null);
    ControlIntent intent = new ControlIntent(input, privateMode, previous.controlOwner(),
        previous.privateMode(), reference(session).controllerId(), previous.connectionId());
    jdbc.sql("""
            UPDATE browser_sessions SET control_owner='TRANSFERRING',private_mode=true,
              control_epoch=control_epoch+1,pending_control=CAST(:intent AS jsonb),
              pending_connection_id=:connection,control_deadline_at=clock_timestamp()+interval '6 minutes',
              control_next_check_at=clock_timestamp(),version=version+1 WHERE id=:id
            """).param("id", session).param("intent", json.write(intent))
        .param("connection", connection).update();
    events.emit(owner, "browser", session, 0);
  }''')
s=s.replace('''    String control = take || sessionSave ? "USER" : reference.taskId() == null ? "NONE" : "CHATGPT";''', '''    boolean internal = Set.of("ADOPT", "LOGIN").contains(input.type());
    String control = take || sessionSave ? "USER"
        : "LOGIN".equals(input.type()) || reference.taskId() == null ? "NONE" : "CHATGPT";
    if ("ADOPT".equals(input.type())) {
      worker.call("POST", "/sessions/" + id + "/bind",
          Map.of("ownerId", owner, "taskId", reference.taskId()), remaining(work.deadline()));
    }
    if ("LOGIN".equals(input.type()) && intent.previousConnection() != null
        && !intent.previousConnection().equals(input.connectionId()) && Boolean.FALSE.equals(intent.previousPrivate())) {
      if (!exportProfile(owner, id, intent.previousConnection(), id + ":switch:" + epoch, remaining(work.deadline()))) {
        throw new WorkerClient.WorkerException("PROFILE_SAVE_FAILED", 422);
      }
    }''')
s=s.replace('''    transactions.executeWithoutResult(transaction -> {
    tasks.lockOwner(owner);
    if (reference(id).closeRequested() || get(owner, id).controlEpoch() != epoch) return;''', '''    if ("LOGIN".equals(input.type()) && input.connectionId() != null
        && !input.connectionId().equals(intent.previousConnection())) {
      String startUrl = jdbc.sql("SELECT start_url FROM connections WHERE id=:id")
          .param("id", input.connectionId()).query(String.class).single();
      worker.call("POST", "/sessions/" + id + "/login-context",
          Map.of("ownerId", owner, "connectionId", input.connectionId(), "startUrl", startUrl), remaining(work.deadline()));
    }
    transactions.executeWithoutResult(transaction -> {
    tasks.lockOwner(owner);
    if (reference(id).closeRequested() || get(owner, id).controlEpoch() != epoch) return;''')
s=s.replace('''    if (sessionSave) {
      refreshIdle(owner, id, true);''', '''    if (internal) {
      jdbc.sql("UPDATE browser_sessions SET connection_id=coalesce(pending_connection_id,connection_id),"
              + "pending_connection_id=NULL WHERE id=:id").param("id", id).update();
      if ("ADOPT".equals(input.type())) tasks.browserReady(owner, reference.taskId());
      refreshIdle(owner, id, true);
      events.emit(owner, "browser", id, 0);
      return;
    }
    if (sessionSave) {
      refreshIdle(owner, id, true);''')
# Shared export path, captured connection for a committed transition, always outside its DB transaction.
s=s.replace('''    try {
      JsonNode result = worker.call("POST", "/sessions/" + session + "/profile/export",
          Map.of("connectionId", connection.get(), "ownerId", owner,
              "origins", connectionOrigins(owner, connection.get()), "operationId", operationId),
          timeout);''', '''    return exportProfile(owner, session, connection.get(), operationId, timeout);
  }

  private boolean exportProfile(UUID owner, UUID session, UUID connection, String operationId, Duration timeout) {
    try {
      JsonNode result = worker.call("POST", "/sessions/" + session + "/profile/export",
          Map.of("connectionId", connection, "ownerId", owner,
              "origins", connectionOrigins(owner, connection), "operationId", operationId,
              "deadlineAt", Instant.now().plus(timeout).toString()), timeout);''')
# Restrict replacements to the newly extracted method.
start=s.index('  private boolean exportProfile(')
end=s.index('  private void recordProfileFailure(',start)
s=s[:start]+s[start:end].replace('connection.get()', 'connection')+s[end:]
p.write_text(s,encoding='utf-8',newline='\n')
