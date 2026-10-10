from pathlib import Path
p=Path('backend/api/src/main/java/ru/helmglass/api/browsers/BrowserService.java')
s=p.read_text(encoding='utf-8')
s=s.replace('''UPDATE browser_sessions SET private_mode=true,control_owner='NONE',
                control_epoch=:epoch,version=version+1 WHERE id=:id''','''UPDATE browser_sessions SET private_mode=true,
                control_owner=CASE WHEN pending_control IS NULL THEN 'NONE' ELSE 'TRANSFERRING' END,
                pending_control=CASE WHEN pending_control IS NULL THEN NULL
                  ELSE jsonb_set(pending_control,'{keepPrivate}','true') END,
                control_epoch=:epoch,version=version+1 WHERE id=:id''',1)
p.write_text(s,encoding='utf-8',newline='\n')
p=Path('backend/api/src/main/java/ru/helmglass/api/tasks/ActionService.java')
s=p.read_text(encoding='utf-8').replace('''complete(operation, operation.mutating() ? "UNKNOWN" : "FAILED", null,
          "EXECUTION_STOPPED"''', '''complete(operation, "UNKNOWN", null,
          "EXECUTION_STOPPED"''')
p.write_text(s,encoding='utf-8',newline='\n')
