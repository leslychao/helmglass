from pathlib import Path
p=Path('backend/api/widget/src/main.ts')
s=p.read_text(encoding='utf-8').replace('Браузер закрыт после 15 минут бездействия.', 'Браузер закрыт после простоя.')
s=s.replace("  else if (current?.continuationStatus === 'MESSAGE_SENT')", "  else if (current?.task.browser?.cleanupState === 'FAILED') notice('Браузер освобождён, но сохранение файлов не завершено. Исходные файлы сохранены; требуется повтор администратора.', true);\n  else if (current?.continuationStatus === 'MESSAGE_SENT')")
p.write_text(s,encoding='utf-8',newline='\n')
p=Path('backend/api/src/main/java/ru/helmglass/api/accounts/AccountService.java')
s=p.read_text(encoding='utf-8')
# Restrict to the deletion guard, not administrative execution completion.
start=s.index('  public void purgeDueAccounts()')
s=s[:start]+s[start:].replace('''+ " owner_id=:owner AND status<>'CLOSED')"''', '''+ " owner_id=:owner AND (status<>'CLOSED' OR cleanup_state NOT IN ('NONE','COMPLETE')))"''',1)
# Closure is a durable intent and immediately forbids new commands. Node reconciliation performs network I/O.
start=s.index('    var sessions =',s.index('  private void revokeAccess('))
end=s.index('\n  private void stopAll(', start)
s=s[:start]+'''    jdbc.sql("""
            UPDATE browser_sessions SET control_epoch=control_epoch+1,control_owner='NONE',
              controller_id=NULL,private_mode=true,pending_control=NULL,control_deadline_at=NULL,
              close_requested=true,next_check_at=clock_timestamp()
            WHERE owner_id=:owner AND status NOT IN ('CLOSED','LOST')
            """).param("owner", target).update();
  }
''' +s[end:]
# Drop a replaced private record if there are no callers left.
s=s.replace('  private record Revocation(UUID id, long epoch) {}\n','')
p.write_text(s,encoding='utf-8',newline='\n')
