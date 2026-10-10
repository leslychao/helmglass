from pathlib import Path

def edit(file, old, new):
    p = Path(file)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise RuntimeError(f'Missing replacement in {file}: {old[:100]}')
    p.write_text(text.replace(old, new), encoding='utf-8', newline='\n')

base='backend/api/src/main/java/ru/helmglass/api/'
edit(base+'connections/ConnectionService.java', 'b.idle_close_at,b.close_reason,',
     'b.idle_close_at,b.idle_timeout_seconds,b.idle_warning_at,b.cleanup_state,b.cleanup_error,b.close_reason,')
edit(base+'connections/ConnectionService.java', 'row.getString("close_reason"));',
     'row.getInt("idle_timeout_seconds"), Database.instant(row, "idle_warning_at"),\n                row.getString("cleanup_state"), row.getString("cleanup_error"), row.getString("close_reason"));')
edit(base+'mcp/McpSchemas.java', 'Map.entry("idleCloseAt", nullable(string())),',
     'Map.entry("idleCloseAt", nullable(string())),\n            Map.entry("idleTimeoutSeconds", integer()),\n            Map.entry("idleWarningAt", nullable(string())),\n            Map.entry("cleanupState", string()),\n            Map.entry("cleanupError", nullable(string())),')
edit('frontend/src/app/core/models.ts', 'idleCloseAt: z.nullable(z.string()),',
     'idleCloseAt: z.nullable(z.string()),\n  idleTimeoutSeconds: z.number(),\n  idleWarningAt: z.nullable(z.string()),\n  cleanupState: z.enum([\'NONE\', \'PENDING\', \'RUNNING\', \'FAILED\', \'COMPLETE\']),\n  cleanupError: z.nullable(z.string()),')
edit('backend/api/widget/src/presentation.ts', 'idleCloseAt: z.string().nullable(),',
     'idleCloseAt: z.string().nullable(), idleTimeoutSeconds: z.number(), idleWarningAt: z.string().nullable(),\n  cleanupState: z.string(), cleanupError: z.string().nullable(),')
edit('frontend/src/app/browser/viewer.ts', "import { BrowserSessionPanel } from './session-panel';", "import { BrowserSessionPanel } from './session-panel';\nimport { BrowserPageLifetime } from './page-lifetime';")
edit('frontend/src/app/browser/viewer.ts', 'export class BrowserViewer {', 'export class BrowserViewer {\n  private readonly pageLifetime = inject(BrowserPageLifetime);')
edit('frontend/src/app/browser/viewer.ts', 'return seconds <= 300 ? seconds : null;', 'return browser.idleWarningAt && Date.parse(browser.idleWarningAt) <= this.idleNow() ? seconds : null;')
edit('frontend/src/app/browser/viewer.ts', 'Оставить ещё на 15 минут', 'Оставить ещё на {{ (browser()?.idleTimeoutSeconds ?? 300) / 60 }} минут')
edit('frontend/src/app/browser/viewer.ts', 'Задача сохранится.\n        <button', 'Задача сохранится; несохранённая страница будет потеряна.\n        <button')
edit('frontend/src/app/browser/viewer.ts', "busy() || sessionPanel()?.busy() || browser()?.controlOwner === 'TRANSFERRING'", 'busy()')
edit('frontend/src/app/browser/viewer.ts', "if (state === 'escape') {", "if (state === 'activity') {\n        if (this.role() === 'CONTROLLER') this.manualActivity();\n        return;\n      }\n      if (state === 'escape') {")
edit('frontend/src/app/browser/viewer.ts', '  addressInput(event: Event) {', '''  private manualActivity() {
    const browser = this.browser();
    if (browser) void this.pageLifetime.activity(browser).catch((error: unknown) => {
      this.idleError.set(errorMessage(error));
    });
  }
  addressInput(event: Event) {
    if (event.isTrusted) this.manualActivity();''')
edit('frontend/src/app/browser/viewer.ts', '    event.preventDefault();\n    if (this.role()', '    event.preventDefault();\n    if (event.isTrusted) this.manualActivity();\n    if (this.role()')
edit('frontend/src/app/browser/page-lifetime.ts', '  private registered = false;', '  private registered = false;\n  private activitySequence = 0;\n  private lastActivity = 0;')
edit('frontend/src/app/browser/page-lifetime.ts', '  async leave() {', '''  async activity(browser: BrowserSession): Promise<void> {
    if (!this.registered || browser.id !== this.session || browser.controlEpoch !== this.epoch
      || this.controlOwner !== 'USER' || Date.now() - this.lastActivity < 1000) return;
    this.lastActivity = Date.now();
    await this.api.mutate(this.path() + '/activity', {
      controlEpoch: this.epoch, sequence: ++this.activitySequence,
    }, pageSchema);
  }

  async leave() {''')
edit('backend/api/widget/src/main.ts', '|| seconds === null || seconds > 300;', '|| seconds === null || !browser?.idleWarningAt || Date.parse(browser.idleWarningAt) > Date.now();\n  keepOpen.textContent = \'Оставить ещё на \' + ((browser?.idleTimeoutSeconds ?? 300) / 60) + \' минут\';')
edit('backend/browser-node/src/server.ts', "      window.addEventListener('keydown', event => {", """      for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
        document.addEventListener(type, event => {
          if (event.isTrusted && rfb && !rfb.viewOnly && !frozen) report('activity', activeEpoch);
        }, {capture:true,passive:true});
      }
      window.addEventListener('keydown', event => {""")

edit(base+'mcp/ChatBindings.java', "continuation_status='SENDING'\n              AND continuation_claimed_at<", "continuation_status IN ('PENDING','SENDING','MESSAGE_SENT')\n              AND coalesce(continuation_claimed_at,continuation_requested_at)<")
edit(base+'mcp/ChatBindings.java', "continuation_reason='Отправка не подтверждена. Продолжите задачу в исходном чате ChatGPT.',", """continuation_reason=CASE continuation_status
                  WHEN 'PENDING' THEN 'Клиент не запросил отправку продолжения.'
                  WHEN 'MESSAGE_SENT' THEN 'Сообщение отправлено, но новая команда не получена.'
                  ELSE 'Результат отправки неизвестен; повторная отправка отключена.' END
                  || ' Продолжите задачу в исходном чате ChatGPT.',""")
edit(base+'mcp/ChatBindings.java', "AND continuation_status='SENDING'\n                  AND continuation_claimed_at<", "AND continuation_status IN ('PENDING','SENDING','MESSAGE_SENT')\n                  AND coalesce(continuation_claimed_at,continuation_requested_at)<")
edit(base+'tasks/TaskService.java', "continuation_requested_at=clock_timestamp(),updated_at=now() FROM tasks t", "continuation_claimed_at=NULL,continuation_requested_at=clock_timestamp(),updated_at=now() FROM tasks t")
