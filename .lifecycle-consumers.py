from pathlib import Path
p=Path('backend/api/src/main/java/ru/helmglass/api/browsers/BrowserService.java')
s=p.read_text(encoding='utf-8')
s=s.replace('import java.util.UUID;', 'import java.util.UUID;\nimport java.util.concurrent.ExecutorService;\nimport java.util.concurrent.Executors;\nimport java.util.concurrent.Semaphore;')
s=s.replace('  private final TransactionTemplate transactions;', '  private final TransactionTemplate transactions;\n  private final ExecutorService controlDelivery = Executors.newVirtualThreadPerTaskExecutor();\n  private final Semaphore controlSlots = new Semaphore(4);')
s=s.replace('''    for (PendingControl candidate : pending) {
      ControlWork work''','''    for (PendingControl candidate : pending) {
      if (!controlSlots.tryAcquire()) break;
      ControlWork work''',1)
s=s.replace('''      if (work == null) continue;
      try {
        applyControl''','''      if (work == null) { controlSlots.release(); continue; }
      controlDelivery.execute(() -> {
      try {
        applyControl''',1)
s=s.replace('''          continue;
        }
        // A lost acknowledgement''','''          return;
        }
        // A lost acknowledgement''',1)
s=s.replace('''          closeForFailure(candidate.owner(), candidate.id(), "CONTROL_UNCONFIRMED");
        });
      }
    }
  }

  @Scheduled''','''          closeForFailure(candidate.owner(), candidate.id(), "CONTROL_UNCONFIRMED");
        });
      } finally { controlSlots.release(); }
      });
    }
  }

  @jakarta.annotation.PreDestroy
  void stopControlDelivery() { controlDelivery.shutdownNow(); }

  @Scheduled''',1)
p.write_text(s,encoding='utf-8',newline='\n')
# UI and administration use the same persisted delivery state; stopped browsers occupy no slot.
p=Path('backend/api/src/main/java/ru/helmglass/api/accounts/NodeService.java')
s=p.read_text(encoding='utf-8')
s=s.replace('b.status,t.status', 'b.status,b.cleanup_state,b.cleanup_error,t.status')
s=s.replace("b.node_id=:node AND b.status NOT IN ('CLOSED','QUEUED') ORDER BY", "b.node_id=:node AND (b.status NOT IN ('CLOSED','QUEUED') OR b.cleanup_state IN ('PENDING','RUNNING','FAILED')) ORDER BY")
s=s.replace('''+ " AND b.status NOT IN ('CLOSED','QUEUED')";''','''+ " AND (b.status NOT IN ('CLOSED','QUEUED') OR b.cleanup_state IN ('PENDING','RUNNING','FAILED'))";''')
s=s.replace('browser.getString("task_status")))', 'browser.getString("task_status"), browser.getString("cleanup_state"), browser.getString("cleanup_error")))')
s=s.replace('row.getString("task_status")))', 'row.getString("task_status"), row.getString("cleanup_state"), row.getString("cleanup_error")))')
s=s.replace('String taskStatus) {}', 'String taskStatus, String cleanupState, String cleanupError) {}')
p.write_text(s,encoding='utf-8',newline='\n')
p=Path('frontend/src/app/core/models.ts')
s=p.read_text(encoding='utf-8').replace('  taskStatus: z.nullable(z.string()),', '  taskStatus: z.nullable(z.string()),\n  cleanupState: z.string(),\n  cleanupError: z.nullable(z.string()),')
p.write_text(s,encoding='utf-8',newline='\n')
p=Path('frontend/src/app/admin/nodes.html')
s=p.read_text(encoding='utf-8').replace('''                      @if (browser.taskId) {''', '''                      @if (browser.cleanupState === 'FAILED') {
                        <button class="button small" [disabled]="!!busy() || !available()"
                          hgTooltip="Браузер остановлен. Повторить сохранение файлов и очистку"
                          (click)="retryCleanup(browser, node.id)"><hg-icon name="refresh" />Повторить сохранение</button>
                      } @else if (browser.status === 'CLOSED') {
                        <span>Браузер освобождён · сохраняем файлы</span>
                      } @else if (browser.taskId) {''')
p.write_text(s,encoding='utf-8',newline='\n')
p=Path('frontend/src/app/admin/nodes.ts')
s=p.read_text(encoding='utf-8').replace('  async stop(browser: AdminBrowser, nodeId: string) {', '''  async retryCleanup(browser: AdminBrowser, nodeId: string) {
    if (this.busy() || !this.available() || browser.cleanupState !== 'FAILED') return;
    this.busy.set(browser.id);
    try {
      await this.api.mutate('/api/admin/browsers/' + browser.id + '/retry-cleanup', {}, z.unknown());
      await this.loadBrowsers(nodeId);
    } catch (error: unknown) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(''); }
  }
  async stop(browser: AdminBrowser, nodeId: string) {''')
p.write_text(s,encoding='utf-8',newline='\n')
p=Path('frontend/src/app/shared/ui.ts')
s=p.read_text(encoding='utf-8').replace("  CONNECTION_BUSY:", "  ADMIN_PAUSED: 'Новые назначения приостановлены администратором',\n  DEPLOYMENT_DRAIN: 'Новые назначения приостановлены для развёртывания',\n  ADMIN_PAUSED_DEPLOYMENT_DRAIN: 'Действуют административная пауза и пауза развёртывания',\n  USER_BROWSER_LIMIT: 'Достигнут лимит браузеров пользователя',\n  NODE_UNAVAILABLE: 'Нет доступного узла для запуска',\n  CONNECTION_BUSY:")
p.write_text(s,encoding='utf-8',newline='\n')
