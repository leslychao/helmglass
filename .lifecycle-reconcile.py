from pathlib import Path
p=Path('backend/api/src/main/java/ru/helmglass/api/browsers/BrowserService.java')
s=p.read_text(encoding='utf-8')
s=s.replace('  @Transactional\n  public void reconcile(UUID id, JsonNode result) {\n    SessionReference reference = reference(id);', '''  public void reconcile(UUID id, JsonNode result) {
    SessionReference initial = reference(id);
    Contracts.Browser before = get(initial.ownerId(), id);
    if ("CLOSED".equals(before.status())) return;
    if ("LIVE".equals(result.path("status").asString()) && !"LIVE".equals(before.status())
        && !initial.closeRequested() && !"TRANSFERRING".equals(before.controlOwner())) {
      Map<String, Object> desired = new HashMap<>();
      desired.put("owner", before.controlOwner());
      desired.put("privateMode", before.privateMode());
      desired.put("controlEpoch", before.controlEpoch());
      desired.put("deadlineAt", Instant.now().plusSeconds(30).toString());
      if (initial.controllerId() != null) desired.put("controllerId", initial.controllerId());
      worker.call("POST", "/sessions/" + id + "/control", desired, Duration.ofSeconds(30));
    }
    transactions.executeWithoutResult(transaction -> reconcileState(id, result));
  }

  private void reconcileState(UUID id, JsonNode result) {
    SessionReference reference = reference(id);''')
start=s.index('      Map<String, Object> desired', s.index('  private void reconcileState'))
end=s.index('      jdbc.sql("UPDATE browser_sessions SET started_at',start)
s=s[:start]+s[end:]
s=s.replace('''    if (reference.closeRequested() && Set.of("LIVE", "STARTING").contains(status)) {''', '''    if (Set.of("CLOSED", "LOST").contains(status) && !result.path("runtimeStoppedAt").isString()) {
      status = "UNREACHABLE";
    }
    if ("LOST".equals(status) && result.path("runtimeStoppedAt").isString()) status = "CLOSED";
    if (reference.closeRequested() && Set.of("LIVE", "STARTING").contains(status)) {''')
s=s.replace('''    String previous = previousBrowser.status();
    String reportedUrl''', '''    String previous = previousBrowser.status();
    if ("CLOSED".equals(previous)) return;
    String reportedUrl''')
s=s.replace('''+ " status=:status,last_seen_at=now(),current_url=coalesce(:url,current_url),version=version+1"''', '''+ " status=:status,last_seen_at=now(),current_url=coalesce(:url,current_url),"
                + "cleanup_state=CASE WHEN :status='CLOSED' AND cleanup_state='NONE' THEN :cleanup ELSE cleanup_state END,"
                + "version=version+CASE WHEN status IS DISTINCT FROM :status OR current_url IS DISTINCT FROM coalesce(:url,current_url) THEN 1 ELSE 0 END"''')
s=s.replace('''        .param("status", status)
        .param("url", result.path("currentUrl").asString(null))''', '''        .param("status", status)
        .param("cleanup", result.path("cleanupState").asString("NONE"))
        .param("url", result.path("currentUrl").asString(null))''')
p.write_text(s,encoding='utf-8',newline='\n')
