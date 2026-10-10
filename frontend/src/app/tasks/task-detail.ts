import { Icon } from '../shared/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { BrowserViewer, browserViewerId } from '../browser/viewer';
import { BrowserSteps } from '../browser/steps';
import { Tooltip } from '../shared/tooltip';
import { PageContext, pageReturnLabel, pageReturnUrl } from '../core/page-context';
import { Api, ApiError, errorMessage } from '../core/api';
import { ResourceUnavailable } from '../core/account';
import { LiveEvents } from '../core/live-events';
import {
  BrowserSession,
  newestBrowser,
  Command,
  Page,
  Task,
  stepSchema,
  pageSchema,
  taskSchema,
} from '../core/models';
import { Dialog } from '../shared/dialog';
import { DurationPipe, LabelPipe, Pager, Status } from '../shared/ui';
import { ResultView } from './result-view';
import { SearchInput } from '../shared/search-input';
import { QueryState } from '../shared/query-state';
import { TaskStop } from './task-stop';
import { TaskDuration } from './task-duration';
import { BrowserPageLifetime } from '../browser/page-lifetime';

@Component({
  selector: 'hg-task-detail',
  imports: [
    CdkMenuModule,
    Tooltip,
    Icon,
    DatePipe,
    RouterLink,
    BrowserViewer,
    BrowserSteps,
    ResultView,
    DurationPipe,
    TaskDuration,
    LabelPipe,
    Pager,
    Status,
    SearchInput,
    ResourceUnavailable,
  ],
  templateUrl: './task-detail.html',
  styleUrl: './task-detail.css',
  providers: [QueryState],
})
export class TaskDetail {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private readonly taskStop = inject(TaskStop);
  private readonly lifetime = inject(BrowserPageLifetime);
  private readonly destroy = inject(DestroyRef);
  private readonly pageContext = inject(PageContext);
  readonly query = inject(QueryState);
  private readonly params = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });
  private generation = 0;
  private historyGeneration = 0;
  readonly task = signal<Task | null>(null);
  readonly error = signal('');
  readonly unavailable = signal(false);
  readonly busy = signal(false);
  readonly loading = signal(true);
  readonly tab = computed(() =>
    this.query.text(
      'tab',
      this.route.snapshot.data['tab'] === 'result' ||
        (this.task()?.result &&
          ['SUCCEEDED', 'PARTIAL', 'NOT_ACHIEVED', 'FAILED', 'STOPPED'].includes(
            this.task()?.status ?? '',
          ))
        ? 'result'
        : 'overview',
    ),
  );
  readonly history = signal<Page<z.infer<typeof stepSchema>> | null>(null);
  readonly historyPage = signal(1);
  readonly historyBefore = signal<number | undefined>(undefined);
  readonly historyOpen = signal(false);
  readonly newEvents = signal(false);
  readonly historyError = signal('');
  readonly historyLoading = signal(false);
  readonly historySearch = signal('');
  readonly viewerId = browserViewerId();
  readonly controller = signal(false);
  get currentUrl() {
    return this.router.url;
  }
  get returnLabel() {
    return pageReturnLabel(pageReturnUrl(this.route, this.router, '/tasks').toString());
  }
  constructor() {
    effect(() => {
      this.params();
      this.historyGeneration++;
      this.task.set(null);
      this.busy.set(false);
      this.unavailable.set(false);
      this.historyPage.set(1);
      this.historyBefore.set(undefined);
      this.history.set(null);
      this.historySearch.set('');
      this.loading.set(true);
      void this.load();
    });
    effect(() => {
      this.params();
      this.historyPage();
      this.historySearch();
      if (this.historyOpen()) untracked(() => void this.loadHistory());
    });
    effect(() => {
      const task = this.task();
      if (this.query.text('login') !== '1' || !task?.browser || this.busy()) return;
      const browser = task.browser;
      const needsLogin = task.request?.type === 'LOGIN' || task.waitReason === 'LOGIN';
      if (
        !needsLogin ||
        ['CLOSED', 'LOST'].includes(browser.status)
      ) {
        untracked(() => this.query.set({ login: null }, false));
        return;
      }
      if (!browser.connectionId && !this.can('BEGIN_LOGIN')) return;
      untracked(() => {
        this.query.set({ login: null, tab: 'overview' }, false);
        void this.openLogin();
      });
    });
    inject(LiveEvents)
      .watch(['task', 'step', 'browser', 'connection'])
      .pipe(takeUntilDestroyed())
      .subscribe((change) => {
        if (
          change.resource === 'sync' ||
          change.entityId === this.params().get('id') ||
          (change.resource === 'browser' && change.entityId === this.task()?.browser?.id)
          || (change.resource === 'connection'
            && change.entityId === this.task()?.browser?.connectionId)
        ) {
          void this.load();
          if (this.historyOpen() && ['sync', 'step'].includes(change.resource)) {
            void this.loadHistory();
            if (this.historyPage() > 1) this.newEvents.set(true);
          }
        }
      });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
      this.historyGeneration++;
    });
  }
  can(type: string) {
    return this.task()?.allowedCommands.includes(type) ?? false;
  }

  async canLeave(nextUrl: string): Promise<boolean> {
    if (this.lifetime.retains(this.task()?.browser, nextUrl)) return true;
    if (this.busy()) {
      this.error.set('Дождитесь завершения действия с браузером перед выходом.');
      return false;
    }
    try {
      await this.lifetime.follow(this.task()?.browser);
      await this.lifetime.leave();
      return true;
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
      return false;
    }
  }
  async openLogin() {
    const task = this.task();
    if (!task?.browser || this.busy()) return;
    let connectionId = task.browser.connectionId;
    if (!connectionId) {
      if (!this.can('BEGIN_LOGIN')) return;
      const updated = await this.command('BEGIN_LOGIN', {
        viewerId: this.viewerId,
        requestId: task.request?.id,
        requestVersion: task.request?.version,
      });
      connectionId = updated?.browser?.connectionId ?? null;
    }
    if (!connectionId || this.destroy.destroyed || this.params().get('id') !== task.id) return;
    const returnUrl = this.router.createUrlTree(['/tasks', task.id], {
      queryParams: { ...this.route.snapshot.queryParams, login: null },
    }).toString();
    await this.router.navigate(['/connections', connectionId, 'login'], {
      queryParams: { return: returnUrl },
    });
  }
  async load() {
    const generation = ++this.generation;
    const id = this.params().get('id');
    if (!id) return;
    try {
      const task = await this.api.get('/api/tasks/' + id, taskSchema);
      if (generation !== this.generation) return;
      const current = this.task();
      if (!current || task.version >= current.version) {
        this.applyTask(task);
      }
      this.error.set('');
      this.unavailable.set(false);
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.error.set(errorMessage(error));
        this.unavailable.set(error instanceof ApiError && [403, 404].includes(error.status));
        if (this.unavailable()) this.task.set(null);
      }
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
  async command(type: string, extra: Partial<Command> = {}) {
    const task = this.task();
    if (!task || this.busy()) return;
    if (
      ['TAKE_CONTROL', 'BEGIN_LOGIN'].includes(type) &&
      task.browser?.controlOwner === 'USER' &&
      !this.controller() &&
      !(await this.dialog.ask(
        'Передать управление этому окну?',
        'Управление в другом окне будет прекращено.',
        'Передать управление',
      ))
    )
      return;
    if (type === 'CLOSE_BROWSER' && !(await this.dialog.ask(
      'Закрыть браузер?',
      'Задача останется на паузе. Шаги и результаты сохранятся. Несохранённый вход будет потерян.',
      'Закрыть браузер', [], true,
    ))) return;
    if (type === 'OPEN_BROWSER' && task.request?.type !== 'UNKNOWN_RESULT' && !(await this.dialog.ask(
      'Возобновить браузер?',
      'Будет использован последний сохранённый вход. Несохранённая страница прежнего браузера не восстановится. Задача продолжится автоматически, если нет других причин ожидания.',
      'Возобновить браузер',
    ))) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const updated =
        type === 'STOP'
          ? await this.taskStop.stop(task)
          : await this.api.mutate(
              '/api/tasks/' + task.id + '/commands',
              { type, expectedVersion: task.version, ...extra },
              taskSchema,
            );
      if (!updated) return;
      if (this.destroy.destroyed || this.params().get('id') !== task.id) return;
      this.generation++;
      if (this.task()?.id === updated.id && updated.version >= (this.task()?.version ?? 0))
        this.applyTask(updated);
      if (updated.browser && ['TAKE_CONTROL', 'BEGIN_LOGIN', 'RETURN_CONTROL'].includes(type)) {
        if (['TAKE_CONTROL', 'BEGIN_LOGIN'].includes(type)) {
          sessionStorage.setItem('helm-controller:' + updated.browser.id, 'true');
        }
        this.syncController(this.task() ?? updated);
      }
      return updated;
    } catch (error: unknown) {
      if (this.destroy.destroyed || this.params().get('id') !== task.id) return;
      this.error.set(errorMessage(error));
      if (error instanceof ApiError && error.status === 409) {
        await this.load();
        this.error.set(
          ['STALE_VERSION', 'STALE_REQUEST'].includes(error.code)
            ? 'Запрос или состояние задачи изменились. Проверьте актуальные данные и повторите действие.'
            : error.message,
        );
      }
    } finally {
      if (!this.destroy.destroyed && this.params().get('id') === task.id) this.busy.set(false);
    }
    return undefined;
  }
  openHistory() {
    this.historyOpen.set(!this.historyOpen());
  }
  sessionChanged(browser: BrowserSession) {
    this.generation++;
    this.task.update((task) =>
      task && task.browser?.id === browser.id
        ? { ...task, browser: newestBrowser(task.browser, browser) }
        : task,
    );
  }
  private applyTask(incoming: Task) {
    const current = this.task();
    const browser = newestBrowser(current?.browser ?? null, incoming.browser);
    const task = { ...incoming, browser };
    this.task.set(task);
    this.pageContext.setResource('tasks', task.id, task.title || 'Задача без названия');
    this.syncController(task);
  }
  private syncController(task: Task) {
    void this.lifetime.follow(task.browser).catch((error: unknown) => {
      if (!this.destroy.destroyed && this.task()?.id === task.id)
        this.error.set(errorMessage(error));
    });
    const browser = task.browser;
    if (!browser) {
      this.controller.set(false);
      return;
    }
    const key = 'helm-controller:' + browser.id;
    if (browser.controlOwner !== 'USER' && browser.controlOwner !== 'TRANSFERRING') {
      sessionStorage.removeItem(key);
    }
    this.controller.set(browser.controlOwner === 'USER' && sessionStorage.getItem(key) === 'true');
  }
  async loadHistory() {
    const id = this.params().get('id');
    if (!id) return;
    const generation = ++this.historyGeneration;
    this.historyLoading.set(true);
    try {
      const data = await this.api.get('/api/tasks/' + id + '/steps', pageSchema(stepSchema), {
        page: this.historyPage(),
        pageSize: 10,
        beforeSequence: this.historyPage() > 1 ? this.historyBefore() : undefined,
        search: this.historySearch(),
      });
      if (generation !== this.historyGeneration || id !== this.params().get('id')) return;
      this.history.set(data);
      if (this.historyPage() === 1) {
        this.historyBefore.set(data.items[0]?.sequence);
        this.newEvents.set(false);
      }
      this.historyError.set('');
    } catch (error: unknown) {
      if (generation === this.historyGeneration) this.historyError.set(errorMessage(error));
    } finally {
      if (generation === this.historyGeneration) this.historyLoading.set(false);
    }
  }
  latestHistory() {
    this.historyPage.set(1);
    this.historyBefore.set(undefined);
  }
  filterHistory(search: string) {
    this.historySearch.set(search);
    this.historyPage.set(1);
    this.historyBefore.set(undefined);
  }
  back() {
    void this.router.navigateByUrl(pageReturnUrl(this.route, this.router, '/tasks'));
  }
  async deleteDraft() {
    const task = this.task();
    if (
      !task ||
      this.busy() ||
      !(await this.dialog.ask(
        'Удалить черновик?',
        'Этот черновик будет удалён.',
        'Удалить',
        [],
        true,
      ))
    )
      return;
    this.busy.set(true);
    try {
      await this.api.mutate(
        '/api/tasks/' + task.id,
        { expectedVersion: task.version },
        z.unknown(),
        'DELETE',
      );
      this.back();
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
