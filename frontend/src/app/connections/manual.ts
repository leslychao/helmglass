import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { BrowserViewer, browserViewerId } from '../browser/viewer';
import { Api, ApiError, errorMessage } from '../core/api';
import { ResourceUnavailable } from '../core/account';
import { LiveEvents } from '../core/live-events';
import {
  BrowserSession,
  newestBrowser,
  Connection,
  Task,
  browserSchema,
  connectionSchema,
  taskSchema,
} from '../core/models';
import { PageContext, pageReturnLabel, pageReturnUrl } from '../core/page-context';
import { Dialog } from '../shared/dialog';
import { Icon } from '../shared/icon';
import { Tooltip } from '../shared/tooltip';
import { Status } from '../shared/ui';
import { BrowserPageLifetime } from '../browser/page-lifetime';

@Component({
  selector: 'hg-manual',
  imports: [Icon, BrowserViewer, Status, ResourceUnavailable, Tooltip, RouterLink],
  styles: `
    .connection-page-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
  `,
  template: `
    <button class="back-link" hgTooltip="Вернуться на исходную страницу" (click)="back()">
      <hg-icon name="arrow-left" />{{ returnLabel }}
    </button>
    <h1 class="sr-only">{{ connection()?.name || 'Браузер подключения' }}</h1>
    @if (returnError()) {
      <p class="error-banner" role="alert">{{ returnError() }}
        <button class="text-button" [disabled]="busy()" (click)="returnAfterSave()">Вернуться в подключение</button>
      </p>
    }
    @if (unavailable()) {
      <hg-resource-unavailable
        title="Подключение недоступно для текущего аккаунта"
        backUrl="/connections"
        backLabel="К подключениям"
      />
    } @else if (error() || entryError()) {
      <div class="error-banner" role="alert">
        {{ entryError() || error()
        }}<button class="text-button" [disabled]="busy()" (click)="retry()">Повторить</button>
      </div>
    }
    @if (connection(); as item) {
      <header class="connection-page-bar">
        <div class="inline-meta">
          <hg-status [value]="item.status === 'READY' ? 'CONNECTION_READY' : item.status" /><span>{{
            item.site
          }}</span>
          @if (task(); as linked) {
            <a [routerLink]="['/tasks', linked.id]" [queryParams]="{ return: currentUrl }"
              >Задача: {{ linked.title || linked.id }}</a
            >
          }
        </div>
      </header>
      <hg-browser
        [browser]="item.browser"
        [connection]="item"
        [loginSaved]="saved()"
        [task]="task()"
        [role]="controller() ? 'CONTROLLER' : 'VIEWER'"
        [busy]="busy()"
        [allowStreamPause]="false"
        [canOpen]="task() ? !!task()?.allowedCommands?.includes('OPEN_BROWSER') : !item.browser || ['CLOSED', 'LOST'].includes(item.browser.status)"
        (openBrowser)="task() ? taskCommand('OPEN_BROWSER') : start()"
        [allowSession]="!task() || !!task()?.allowedCommands?.includes('FINISH_LOGIN')"
        (controlLost)="controlLost()"
        (sessionChanged)="sessionChanged($event)"
        (loginFinished)="loginFinished($event)"
      />
    } @else if (!error()) {
      <div class="loading" role="status">Загружаем подключение…</div>
    }
  `,
})
export class Manual {
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly context = inject(PageContext);
  private readonly destroy = inject(DestroyRef);
  private readonly lifetime = inject(BrowserPageLifetime);
  private leaving: Promise<boolean> | null = null;
  private generation = 0;
  private routeRevision = 0;
  private entryPending = true;
  readonly saved = signal(false);
  readonly returnError = signal('');
  private get id() {
    return this.route.snapshot.paramMap.get('id') ?? '';
  }
  get currentUrl() {
    return this.router.url;
  }
  get returnLabel() {
    return pageReturnLabel(pageReturnUrl(this.route, this.router, '/connections').toString());
  }
  readonly connection = signal<Connection | null>(null);
  readonly task = signal<Task | null>(null);
  readonly error = signal('');
  readonly entryError = signal('');
  readonly unavailable = signal(false);
  readonly busy = signal(false);
  readonly controller = signal(false);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(() => {
      this.routeRevision++;
      this.entryPending = true;
      this.saved.set(false);
      this.returnError.set('');
      this.generation++;
      this.busy.set(false);
      this.error.set('');
      this.entryError.set('');
      this.connection.set(null);
      this.task.set(null);
      this.controller.set(false);
      this.unavailable.set(false);
      void this.load();
    });
    inject(LiveEvents)
      .watch(['connection', 'browser', 'task'])
      .pipe(takeUntilDestroyed())
      .subscribe((change) => {
        if (
          change.resource === 'sync' ||
          [this.id, this.connection()?.browser?.id, this.task()?.id].includes(
            change.entityId ?? undefined,
          )
        ) {
          void this.load();
        }
      });
    this.destroy.onDestroy(() => {
      this.generation++;
    });
    effect((cleanup) => {
      if (!this.closesOnLeave() || this.saved()) return;
      const warn = (event: BeforeUnloadEvent) => {
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', warn);
      cleanup(() => window.removeEventListener('beforeunload', warn));
    });
  }
  private closesOnLeave() {
    const browser = this.connection()?.browser;
    return !!browser && !browser.taskId && !['CLOSED', 'LOST', 'CLOSING'].includes(browser.status);
  }
  canLeave(nextUrl: string): Promise<boolean> {
    if (this.lifetime.retains(this.connection()?.browser, nextUrl)) return Promise.resolve(true);
    return this.leaving ??= this.leavePage().finally(() => { this.leaving = null; });
  }
  private async leavePage() {
    if (this.busy()) {
      this.error.set('Дождитесь завершения действия с браузером перед выходом.');
      return false;
    }
    if (!this.saved() && this.closesOnLeave() && !(await this.dialog.ask(
      'Закрыть браузер и выйти?',
      'Браузер подключения будет закрыт. Несохранённый вход будет потерян. Сохранённая сессия останется в подключении.',
      'Закрыть и выйти',
    ))) return false;
    this.busy.set(true);
    try {
      await this.lifetime.follow(this.connection()?.browser);
      await this.lifetime.leave();
      return true;
    } catch (error: unknown) {
      if (this.saved()) this.returnError.set('Сессия сохранена, но не удалось завершить выход со страницы. Повторите возврат.');
      else this.error.set(errorMessage(error));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
  back() {
    void this.router.navigateByUrl(pageReturnUrl(this.route, this.router, '/connections'));
  }
  loginFinished(browser: BrowserSession) {
    if (this.saved() || browser.id !== this.connection()?.browser?.id) return;
    this.saved.set(true);
    void this.returnAfterSave();
  }
  async returnAfterSave() {
    if (!this.saved()) return;
    const revision = this.routeRevision;
    this.returnError.set('');
    try {
      if (await this.router.navigate(['/connections', this.id], { replaceUrl: true })) return;
    } catch { /* The saved profile remains available if navigation fails. */ }
    if (this.isCurrent(revision))
      this.returnError.set('Сессия сохранена, но не удалось вернуться в подключение. Повторите возврат.');
  }
  controlLost() {
    const browser = this.connection()?.browser;
    if (browser) sessionStorage.removeItem('helm-controller:' + browser.id);
    this.controller.set(false);
  }
  sessionChanged(browser: BrowserSession) {
    this.generation++;
    this.connection.update((current) =>
      current?.browser?.id === browser.id
        ? { ...current, browser: newestBrowser(current.browser, browser) }
        : current,
    );
    this.syncController();
  }
  private isCurrent(revision: number) {
    return !this.destroy.destroyed && revision === this.routeRevision;
  }
  private applyConnection(incoming: Connection) {
    this.connection.update((current) => {
      if (!current || current.id !== incoming.id) return incoming;
      const latest = incoming.version >= current.version ? incoming : current;
      const browser = newestBrowser(current.browser, incoming.browser);
      return { ...latest, browser };
    });
    this.syncController();
  }
  private syncController() {
    const browser = this.connection()?.browser;
    this.controller.set(
      !!browser &&
        browser.controlOwner === 'USER' &&
        sessionStorage.getItem('helm-controller:' + browser.id) === 'true',
    );
    const revision = this.routeRevision;
    void this.lifetime.follow(browser).catch((error: unknown) => {
      if (this.isCurrent(revision)) this.error.set(errorMessage(error));
    });
  }
  async load() {
    const generation = ++this.generation;
    try {
      const connection = await this.api.get('/api/connections/' + this.id, connectionSchema);
      const task = connection.browser?.taskId
        ? await this.api.get('/api/tasks/' + connection.browser.taskId, taskSchema)
        : null;
      if (generation !== this.generation) return;
      this.applyConnection(connection);
      this.task.update((current) =>
        current?.id === task?.id && current && task && current.version > task.version
          ? current
          : task,
      );
      this.context.setResource('connections', connection.id, connection.name);
      this.error.set('');
      this.unavailable.set(false);
      if (this.entryPending && !this.busy()
        && (!connection.browser || ['LIVE', 'CLOSED', 'LOST'].includes(connection.browser.status))
        && connection.browser?.controlOwner !== 'TRANSFERRING') {
        this.entryPending = false;
        await this.enterBrowser();
      }
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.error.set(errorMessage(error));
        this.unavailable.set(error instanceof ApiError && [403, 404].includes(error.status));
        if (this.unavailable()) this.connection.set(null);
      }
    }
  }
  private async enterBrowser() {
    const connection = this.connection();
    if (!connection) return;
    const browser = connection.browser;
    if (!browser || ['CLOSED', 'LOST'].includes(browser.status)) {
      if (this.task()) {
        const revision = this.routeRevision;
        await this.taskCommand('OPEN_BROWSER', false);
        if (!this.isCurrent(revision) || this.error()
          || ['CLOSED', 'LOST'].includes(this.connection()?.browser?.status ?? 'CLOSED')) return;
        this.entryPending = true;
        await this.load();
      } else {
        await this.start(false);
      }
      return;
    }
    await this.control();
  }
  retry() {
    if (this.entryError()) {
      this.entryError.set('');
      this.entryPending = true;
    }
    void this.load();
  }
  async start(confirmReopen = true) {
    if (this.busy()) return;
    if (confirmReopen && this.connection()?.browser && !(await this.dialog.ask(
      'Возобновить браузер?',
      'Будет использован последний сохранённый вход. Несохранённая страница прежнего браузера не восстановится.',
      'Возобновить браузер',
    ))) return;
    const id = this.id,
      revision = this.routeRevision;
    this.busy.set(true);
    try {
      const connection = await this.api.mutate(
        '/api/connections/' + id + '/login',
        { action: 'START', viewerId: browserViewerId(), pageVisitId: this.lifetime.prepareStart() },
        connectionSchema,
      );
      if (!this.isCurrent(revision)) return;
      if (connection.browser)
        sessionStorage.setItem('helm-controller:' + connection.browser.id, 'true');
      this.generation++;
      this.applyConnection(connection);
      await this.load();
    } catch (error: unknown) {
      if (this.isCurrent(revision)) this.error.set(errorMessage(error));
    } finally {
      if (this.isCurrent(revision)) this.busy.set(false);
    }
  }
  private async control() {
    const browser = this.connection()?.browser;
    if (!browser || this.busy()) return;
    const revision = this.routeRevision;
    if (!this.isCurrent(revision)) return;
    this.busy.set(true);
    try {
      const updated = await this.api.mutate(
        '/api/browser-sessions/' + browser.id + '/control',
        {
          type: 'BEGIN_LOGIN',
          viewerId: browserViewerId(),
          controlEpoch: browser.controlEpoch,
          resume: true,
        },
        browserSchema,
      );
      if (!this.isCurrent(revision) || this.connection()?.browser?.id !== browser.id) return;
      sessionStorage.setItem('helm-controller:' + browser.id, 'true');
      this.sessionChanged(updated);
    } catch (error: unknown) {
      if (this.isCurrent(revision)) this.entryError.set(errorMessage(error));
    } finally {
      if (this.isCurrent(revision)) this.busy.set(false);
    }
  }
  async taskCommand(type: 'OPEN_BROWSER', confirmReopen = true) {
    const task = this.task();
    if (!task || this.busy()) return;
    const revision = this.routeRevision;
    if (confirmReopen && !(await this.dialog.ask('Возобновить браузер?',
      'Будет использован последний сохранённый вход. Несохранённая страница прежнего браузера не восстановится. Задача продолжится автоматически, если нет других причин ожидания.', 'Возобновить браузер'))) return;
    if (!this.isCurrent(revision)) return;
    this.busy.set(true);
    try {
      const updated = await this.api.mutate(
        '/api/tasks/' + task.id + '/commands',
        { type, expectedVersion: task.version },
        taskSchema,
      );
      if (!this.isCurrent(revision) || this.task()?.id !== task.id) return;
      this.generation++;
      if ((this.task()?.version ?? -1) <= updated.version) this.task.set(updated);
      if (updated.browser) this.sessionChanged(updated.browser);
      await this.load();
    } catch (error: unknown) {
      if (this.isCurrent(revision)) this.error.set(errorMessage(error));
    } finally {
      if (this.isCurrent(revision)) this.busy.set(false);
    }
  }
}
