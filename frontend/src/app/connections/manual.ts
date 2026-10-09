import { Component, DestroyRef, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { BrowserViewer, browserViewerId } from '../browser/viewer';
import { Api, ApiError, errorMessage } from '../core/api';
import { ResourceUnavailable } from '../core/account';
import { LiveEvents } from '../core/live-events';
import {
  BrowserSession,
  Connection,
  Page,
  Task,
  browserSchema,
  connectionSchema,
  pageSchema,
  stepSchema,
  taskSchema,
} from '../core/models';
import { PageContext, pageReturnLabel, pageReturnUrl } from '../core/page-context';
import { Dialog } from '../shared/dialog';
import { Icon } from '../shared/icon';
import { Tooltip } from '../shared/tooltip';
import { Pager, Status } from '../shared/ui';
import * as z from 'zod/mini';
import { SearchInput } from '../shared/search-input';

@Component({
  selector: 'hg-manual',
  imports: [Icon, BrowserViewer, Status, ResourceUnavailable, Tooltip, RouterLink, Pager, DatePipe, SearchInput],
  styles: `
    .connection-page-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .connection-page-bar .actions {
      flex-wrap: wrap;
    }
    .button.danger-light {
      border-color: #efceca;
      color: var(--red);
    }
    .connection-steps {
      padding: 0;
      list-style: none;
    }
    .connection-steps li {
      padding: 12px 0;
      border-bottom: 1px solid var(--line);
    }
    .connection-steps p {
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .connection-steps time {
      display: block;
      color: var(--muted);
      font-size: 11px;
    }
  `,
  template: `
    <button class="back-link" hgTooltip="Вернуться на исходную страницу" (click)="back()">
      <hg-icon name="arrow-left" />{{ returnLabel }}
    </button>
    <h1 class="sr-only">{{ connection()?.name || 'Браузер подключения' }}</h1>
    @if (unavailable()) {
      <hg-resource-unavailable
        title="Подключение недоступно для текущего аккаунта"
        backUrl="/connections"
        backLabel="К подключениям"
      />
    } @else if (error()) {
      <div class="error-banner" role="alert">
        {{ error()
        }}<button class="text-button" [disabled]="busy()" (click)="load()">Повторить</button>
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
        <div class="actions">
          @if (task(); as linked) {
            @if (linked.allowedCommands.includes('PAUSE')) {
              <button class="button small" [disabled]="busy()" (click)="taskCommand('PAUSE')">
                <hg-icon name="pause" />Пауза
              </button>
            }
            @if (linked.allowedCommands.includes('RESUME')) {
              <button
                class="button primary small"
                [disabled]="busy()"
                (click)="taskCommand('RESUME')"
              >
                <hg-icon name="play" />Продолжить
              </button>
            }
            @if (linked.allowedCommands.includes('STOP')) {
              <button class="button small" [disabled]="busy()" (click)="taskCommand('STOP')">
                <hg-icon name="stop" />Завершить
              </button>
            }
          }
        </div>
      </header>
      <hg-browser
        [browser]="item.browser"
        [connection]="item"
        [task]="task()"
        [role]="controller() ? 'CONTROLLER' : 'VIEWER'"
        [steps]="true"
        [stepCount]="task()?.stepCount ?? 0"
        [busy]="busy()"
        [canOpen]="task() ? !!task()?.allowedCommands?.includes('OPEN_BROWSER') : !item.browser || ['CLOSED', 'LOST'].includes(item.browser.status)"
        [canClose]="task() ? !!task()?.allowedCommands?.includes('CLOSE_BROWSER') : !!item.browser && !['CLOSED', 'LOST', 'CLOSING'].includes(item.browser.status)"
        (closeBrowser)="task() ? taskCommand('CLOSE_BROWSER') : close()"
        (openBrowser)="task() ? taskCommand('OPEN_BROWSER') : start()"
        [allowSession]="!task() || !!task()?.allowedCommands?.includes('FINISH_LOGIN')"
        (controlLost)="controlLost()"
        (sessionChanged)="sessionChanged($event)"
        (stepsOpen)="showSteps($event)"
      >
        @if (item.browser?.status === 'LIVE') {
          @if (!controller()) {
            <button
              class="button small browser-control-button"
              [disabled]="busy() || !canControl('TAKE_CONTROL')"
              (click)="control('BEGIN_LOGIN')"
            >
              <hg-icon name="pointer" />Взять управление
            </button>
          } @else {
            <button
              class="button small browser-control-button"
              [disabled]="busy() || !canControl('RETURN_CONTROL')"
              (click)="control('RETURN')"
            >
              <hg-icon name="play" />{{ task() ? 'Передать агенту' : 'Завершить управление' }}
            </button>
          }
        }
        <div browserSteps>
          @if (task()) {
            <input hgSearch aria-label="Найти шаги" placeholder="Найти шаги" [value]="stepsSearch()" (searchChange)="searchSteps($event)" />
          } @else {
            <p>Нет связанных шагов. Браузер открыт отдельно от задачи.</p>
          }
          @if (stepsError()) {
            <p class="error-banner" role="alert">{{ stepsError() }}</p>
          }
          @if (stepsLoading()) {
            <p role="status">Загружаем шаги…</p>
          }
          <ol class="connection-steps">
            @for (step of steps()?.items; track step.id) {
              <li>
                <strong>{{ step.title }}</strong
                ><time>{{ step.createdAt | date: 'dd.MM HH:mm:ss' }}</time
                ><hg-status [value]="step.status" />
                @if (step.result) {
                  <p>{{ step.result }}</p>
                }
              </li>
            }
          </ol>
          @if (steps(); as page) {
            @if (!page.total) {
              <p>Шаги пока не записаны.</p>
            }
            <hg-pager
              [page]="page.page"
              [size]="10"
              [total]="page.total"
              [fixed]="true"
              (pageChange)="loadSteps($event)"
            />
          }
        </div>
      </hg-browser>
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
  private generation = 0;
  private routeRevision = 0;
  private stepsGeneration = 0;
  private stepsVisible = false;
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
  readonly unavailable = signal(false);
  readonly busy = signal(false);
  readonly controller = signal(false);
  readonly steps = signal<Page<z.infer<typeof stepSchema>> | null>(null);
  readonly stepsLoading = signal(false);
  readonly stepsSearch = signal('');
  readonly stepsError = signal('');

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(() => {
      this.routeRevision++;
      this.generation++;
      this.stepsGeneration++;
      this.stepsVisible = false;
      this.stepsLoading.set(false);
      this.stepsError.set('');
      this.busy.set(false);
      this.error.set('');
      this.connection.set(null);
      this.task.set(null);
      this.controller.set(false);
      this.steps.set(null);
      this.unavailable.set(false);
      void this.load();
    });
    inject(LiveEvents)
      .watch(['connection', 'browser', 'task', 'step'])
      .pipe(takeUntilDestroyed())
      .subscribe((change) => {
        if (
          change.resource === 'sync' ||
          [this.id, this.connection()?.browser?.id, this.task()?.id].includes(
            change.entityId ?? undefined,
          )
        ) {
          void this.load();
          if (this.stepsVisible && ['sync', 'step'].includes(change.resource))
            void this.loadSteps(this.steps()?.page ?? 1);
        }
      });
    this.destroy.onDestroy(() => {
      this.generation++;
      this.stepsGeneration++;
    });
  }
  back() {
    void this.router.navigateByUrl(pageReturnUrl(this.route, this.router, '/connections'));
  }
  canControl(command: string) {
    return (
      this.connection()?.browser?.controlOwner !== 'TRANSFERRING' &&
      (!this.connection()?.browser?.taskId || !!this.task()?.allowedCommands.includes(command))
    );
  }
  controlLost() {
    const browser = this.connection()?.browser;
    if (browser) sessionStorage.removeItem('helm-controller:' + browser.id);
    this.controller.set(false);
  }
  sessionChanged(browser: BrowserSession) {
    this.generation++;
    this.connection.update((current) =>
      current?.browser?.id === browser.id && current.browser.version <= browser.version
        ? { ...current, browser }
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
      const browser =
        incoming.browser?.id === current.browser?.id &&
        current.browser &&
        current.browser.version > (incoming.browser?.version ?? -1)
          ? current.browser
          : latest.browser;
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
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.error.set(errorMessage(error));
        this.unavailable.set(error instanceof ApiError && [403, 404].includes(error.status));
        if (this.unavailable()) this.connection.set(null);
      }
    }
  }
  async start() {
    if (this.busy()) return;
    const id = this.id,
      revision = this.routeRevision;
    this.busy.set(true);
    try {
      const connection = await this.api.mutate(
        '/api/connections/' + id + '/login',
        { action: 'START', viewerId: browserViewerId() },
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
  async control(type: 'TAKE' | 'BEGIN_LOGIN' | 'RETURN') {
    const browser = this.connection()?.browser;
    if (!browser || this.busy()) return;
    const revision = this.routeRevision;
    if (
      browser.controlOwner === 'USER' &&
      !this.controller() &&
      !(await this.dialog.ask(
        'Передать управление этому окну?',
        'Управление в другом окне будет прекращено.',
        'Взять управление',
      ))
    )
      return;
    if (!this.isCurrent(revision)) return;
    this.busy.set(true);
    try {
      const updated = await this.api.mutate(
        '/api/browser-sessions/' + browser.id + '/control',
        {
          type,
          viewerId: browserViewerId(),
          controlEpoch: browser.controlEpoch,
          resume: true,
        },
        browserSchema,
      );
      if (!this.isCurrent(revision) || this.connection()?.browser?.id !== browser.id) return;
      if (type !== 'RETURN') sessionStorage.setItem('helm-controller:' + browser.id, 'true');
      this.sessionChanged(updated);
    } catch (error: unknown) {
      if (this.isCurrent(revision)) this.error.set(errorMessage(error));
    } finally {
      if (this.isCurrent(revision)) this.busy.set(false);
    }
  }
  async taskCommand(type: 'PAUSE' | 'RESUME' | 'STOP' | 'CLOSE_BROWSER' | 'OPEN_BROWSER') {
    const task = this.task();
    if (!task || this.busy()) return;
    const revision = this.routeRevision;
    if (type === 'CLOSE_BROWSER' && !(await this.dialog.ask('Закрыть браузер?',
      'Задача останется на паузе. Шаги и результаты сохранятся. Несохранённый вход будет потерян.', 'Закрыть браузер', [], true))) return;
    if (type === 'OPEN_BROWSER' && !(await this.dialog.ask('Открыть новый браузер?',
      'Будет использован последний сохранённый вход. Задача останется на паузе.', 'Открыть браузер'))) return;
    if (
      type === 'STOP' &&
      !(await this.dialog.ask(
        'Завершить задачу?',
        'Браузер закроется после текущего действия. Результаты сохранятся.',
        'Завершить',
        [],
        true,
      ))
    )
      return;
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
      if (type === 'OPEN_BROWSER') await this.load();
    } catch (error: unknown) {
      if (this.isCurrent(revision)) this.error.set(errorMessage(error));
    } finally {
      if (this.isCurrent(revision)) this.busy.set(false);
    }
  }
  async close() {
    const id = this.id,
      revision = this.routeRevision;
    if (
      this.busy() ||
      !(await this.dialog.ask(
        'Закрыть браузер?',
        'Несохранённый вход будет потерян. Сохранённая сессия останется в подключении.',
        'Закрыть',
      ))
    )
      return;
    if (!this.isCurrent(revision)) return;
    this.busy.set(true);
    try {
      const updated = await this.api.mutate(
        '/api/connections/' + id + '/login',
        { action: 'CLOSE', viewerId: browserViewerId() },
        connectionSchema,
      );
      if (!this.isCurrent(revision)) return;
      this.generation++;
      this.applyConnection(updated);
    } catch (error: unknown) {
      if (this.isCurrent(revision)) this.error.set(errorMessage(error));
    } finally {
      if (this.isCurrent(revision)) this.busy.set(false);
    }
  }
  showSteps(open: boolean) {
    this.stepsVisible = open;
    if (open) void this.loadSteps(this.steps()?.page ?? 1);
  }
  searchSteps(search: string) {
    this.stepsSearch.set(search);
    void this.loadSteps(1);
  }
  async loadSteps(page: number) {
    const id = this.task()?.id;
    if (!id) return;
    const generation = ++this.stepsGeneration;
    this.stepsLoading.set(true);
    try {
      const steps = await this.api.get('/api/tasks/' + id + '/steps', pageSchema(stepSchema), {
        page,
        pageSize: 10,
        search: this.stepsSearch(),
      });
      if (generation === this.stepsGeneration) {
        this.steps.set(steps);
        this.stepsError.set('');
      }
    } catch (error: unknown) {
      if (generation === this.stepsGeneration) this.stepsError.set(errorMessage(error));
    } finally {
      if (generation === this.stepsGeneration) this.stepsLoading.set(false);
    }
  }
}
