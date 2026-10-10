import { TableViews, TableColumn } from '../shared/table-view';
import { DataTable, TableCell } from '../shared/data-table';
import { Icon } from '../shared/icon';
import { ColumnPicker } from '../shared/column-picker';
import { FilterReset } from '../shared/filter-reset';
import { KpiSection } from '../shared/kpi-section';
import { Autocomplete, AutocompleteOption } from '../shared/autocomplete';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DateFilter } from '../shared/date-filter';
import { RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { Api, ApiError, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { Page, Task, kpiSchema, newestBrowser, pageSchema, taskSchema } from '../core/models';
import { MultiFilter, Option } from '../shared/multi-filter';
import { QueryState } from '../shared/query-state';
import { Tooltip } from '../shared/tooltip';
import { DurationPipe, Empty, MegabytesPipe, Pager, Status, states } from '../shared/ui';
import { TaskStop } from './task-stop';
import { TaskDuration } from './task-duration';
import { TaskBrowserState } from './task-browser-state';

@Component({
  selector: 'hg-task-list',
  imports: [
    DataTable,
    TableCell,
    ColumnPicker,
    FilterReset,
    KpiSection,
    Icon,
    Autocomplete,
    DatePipe,
    DateFilter,
    RouterLink,
    MultiFilter,
    DurationPipe,
    MegabytesPipe,
    TaskDuration,
    TaskBrowserState,
    Empty,
    Pager,
    Status,
    Tooltip,
  ],
  providers: [QueryState],
  templateUrl: './task-list.html',
})
export class TaskList {
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private readonly taskStop = inject(TaskStop);
  private readonly live = inject(LiveEvents);
  private readonly destroy = inject(DestroyRef);
  private generation = 0;
  readonly data = signal<Page<Task> | null>(null);
  readonly summary = signal<z.infer<typeof kpiSchema> | null>(null);
  private summaryFilters = '';
  readonly error = signal('');
  readonly loading = signal(true);
  readonly stopping = signal<string | null>(null);
  readonly browserNow = signal(Date.now());
  readonly browserError = signal('');
  readonly staleBrowsers = signal<ReadonlySet<string>>(new Set());
  readonly browsersSynchronized = computed(
    () => this.live.state() === 'ready' && !this.loading() && !this.error(),
  );
  private readonly browserRefreshes = new Map<string, { generation: number; again: boolean }>();
  readonly filterKeys = ['search', 'taskId', 'status', 'site', 'source', 'from', 'to'];
  readonly stateOptions: Option[] = [
    'DRAFT',
    'WAITING_CHATGPT',
    'QUEUED',
    'STARTING',
    'RUNNING',
    'PAUSING',
    'PAUSED',
    'WAITING_USER',
    'STOPPING',
    'SUCCEEDED',
    'PARTIAL',
    'NOT_ACHIEVED',
    'STOPPED',
    'FAILED',
  ].map((id) => ({ id, label: states[id] ?? id }));
  readonly sourceOptions: Option[] = [
    { id: 'WEB', label: 'Веб-интерфейс' },
    { id: 'MCP', label: 'ChatGPT' },
  ];
  readonly activeStates = ['STARTING', 'RUNNING', 'PAUSING', 'STOPPING'];
  readonly successStates = ['SUCCEEDED'];
  readonly attentionStates = ['WAITING_USER'];
  readonly taskSuggestions = async (search: string) => {
    const page = await this.api.get('/api/tasks', pageSchema(taskSchema), {
      search,
      suggestions: 'true',
      sort: 'updatedAt',
      direction: 'desc',
    });
    return {
      total: page.total,
      items: page.items.map((task) => ({
        id: task.id,
        label: task.title || task.goal || 'Черновик без названия',
        detail: task.id,
      })),
    };
  };
  readonly siteSuggestions = async (search: string) => {
    const page = await this.api.get('/api/tasks/sites', pageSchema(z.string()), {
      search,
      suggestions: 'true',
    });
    return { total: page.total, items: page.items.map((site) => ({ id: site, label: site })) };
  };
  selectTask(task: AutocompleteOption) {
    this.query.set({ taskId: task.id, search: task.label });
  }
  selectSite(site: AutocompleteOption) {
    const current = this.query.values('site');
    this.query.set({
      site: current.includes(site.id)
        ? current.filter((value) => value !== site.id)
        : [...current, site.id],
    });
  }
  selectedCard(states: readonly string[]) {
    const current = this.query.values('status');
    return current.length === states.length && states.every((state) => current.includes(state));
  }
  selectCard(states: readonly string[]) {
    this.query.set({ status: this.selectedCard(states) ? null : states });
  }
  removeSite(site: string) {
    this.query.set({ site: this.query.values('site').filter((value) => value !== site) });
  }
  readonly tableColumns: readonly TableColumn[] = [
    { key: 'title', label: 'Задача', width: 300, required: true, className: 'task-name' },
    { key: 'site', label: 'Сайт', width: 210 },
    { key: 'status', label: 'Состояние', width: 190, required: true },
    { key: 'browser', label: 'Браузер', width: 220, minWidth: 180, sortable: false,
      help: 'Состояние браузера и срок автозакрытия при простое. Просмотр списка не продлевает этот срок.' },
    { key: 'elapsedSeconds', label: 'Длительность задачи', width: 190,
      help: 'От принятия к выполнению до завершения задачи, включая ожидания и паузы. Черновик не учитывается.' },
    { key: 'executionSeconds', label: 'Команды браузера', width: 180, hidden: true,
      help: 'Суммарное время выполнения команд браузера, без ожиданий между командами и работы ChatGPT.' },
    { key: 'manualSeconds', label: 'Человек', width: 150, hidden: true },
    { key: 'mediaSeconds', label: 'Медиа', width: 150, hidden: true },
    { key: 'mediaBytes', label: 'Объём медиа', width: 160, hidden: true },
    { key: 'updatedAt', label: 'Обновлено', width: 190 },
    { key: 'summary', label: 'Текущий шаг / итог', width: 300, className: 'summary-cell' },
    { key: 'actions', label: 'Действия', width: 58, action: true },
  ];
  readonly table = inject(TableViews).create('tasks', this.tableColumns, this.query);
  constructor() {
    effect(() => {
      this.query.params();
      untracked(() => void this.load());
    });
    this.live
      .watch(['task', 'browser'])
      .pipe(takeUntilDestroyed())
      .subscribe((change) => {
        if (change.resource === 'browser' && change.entityId) {
          void this.refreshBrowser(change.entityId);
        } else {
          void this.load(false);
        }
      });
    effect((onCleanup) => {
      const visible = this.table.visible().some((column) => column.key === 'browser');
      const tasks = this.data()?.items ?? [];
      const stale = this.staleBrowsers();
      const synchronized = this.browsersSynchronized();
      const now = Date.now();
      this.browserNow.set(now);
      if (!visible || !synchronized) return;
      const lastDeadline = tasks.reduce((latest, task) => {
        const browser = task.browser;
        return !stale.has(task.id) && browser?.status === 'LIVE' && browser.idleCloseAt
          ? Math.max(latest, Date.parse(browser.idleCloseAt)) : latest;
      }, 0);
      if (lastDeadline <= now) return;
      const timer = setInterval(() => {
        const now = Date.now();
        this.browserNow.set(now);
        if (now >= lastDeadline) clearInterval(timer);
      }, 1000);
      onCleanup(() => clearInterval(timer));
    });
    this.destroy.onDestroy(() => {
      this.generation++;
    });
  }
  private mergeTask(current: Task | undefined, incoming: Task): Task {
    if (!current) return incoming;
    const latest = incoming.version >= current.version ? incoming : current;
    const browser = current.browser?.id === incoming.browser?.id
      ? newestBrowser(current.browser, incoming.browser)
      : latest.browser;
    return { ...latest, browser };
  }
  private async refreshBrowser(browserId: string) {
    const task = this.data()?.items.find((task) => task.browser?.id === browserId);
    if (!task) return;
    const pending = this.browserRefreshes.get(task.id);
    if (pending?.generation === this.generation) {
      pending.again = true;
      return;
    }
    const refresh = { generation: this.generation, again: false };
    this.browserRefreshes.set(task.id, refresh);
    try {
      do {
        refresh.again = false;
        try {
          const incoming = await this.api.get('/api/tasks/' + task.id, taskSchema);
          if (refresh.generation !== this.generation || this.destroy.destroyed) return;
          this.data.update((page) => page ? {
            ...page,
            items: page.items.map((current) => current.id === task.id
              ? this.mergeTask(current, incoming) : current),
          } : page);
          this.staleBrowsers.update((stale) => {
            if (!stale.has(task.id)) return stale;
            const next = new Set(stale);
            next.delete(task.id);
            return next;
          });
          if (!this.staleBrowsers().size) this.browserError.set('');
        } catch (error: unknown) {
          if (refresh.generation !== this.generation || this.destroy.destroyed) return;
          this.staleBrowsers.update((stale) => new Set([...stale, task.id]));
          this.browserError.set(errorMessage(error));
        }
      } while (refresh.again);
    } finally {
      if (this.browserRefreshes.get(task.id) === refresh) this.browserRefreshes.delete(task.id);
    }
  }
  async stop(task: Task) {
    if (this.stopping() !== null) return;
    this.stopping.set(task.id);
    this.error.set('');
    try {
      const updated = await this.taskStop.stop(task);
      if (!updated || this.destroy.destroyed) return;
      // Stopping can change membership, ordering and summary counts for the current filters.
      await this.load(false);
    } catch (error: unknown) {
      if (this.destroy.destroyed) return;
      if (error instanceof ApiError && error.status === 409) await this.load(false);
      if (!this.destroy.destroyed) this.error.set(errorMessage(error));
    } finally {
      if (!this.destroy.destroyed) this.stopping.set(null);
    }
  }
  async load(show = true) {
    const generation = ++this.generation;
    if (show) this.loading.set(true);
    const filters = {
      search: this.query.text('search'),
      taskId: this.query.text('taskId'),
      site: this.query.values('site'),
      source: this.query.values('source'),
      from: this.query.text('from'),
      to: this.query.text('to'),
    };
    const fingerprint = JSON.stringify(filters);
    if (fingerprint !== this.summaryFilters) {
      this.summaryFilters = fingerprint;
      this.summary.set(null);
    }
    const refreshSummary = !show || !this.summary();
    try {
      const [data, summary] = await Promise.all([
        this.api.get('/api/tasks', pageSchema(taskSchema), {
          ...filters,
          status: this.query.values('status'),
          page: this.query.number('page', 1),
          pageSize: this.query.number('pageSize', 5),
          sort: this.query.text('sort', 'updatedAt'),
          direction: this.table.direction('desc'),
        }),
        refreshSummary
          ? this.api.get('/api/tasks/summary', kpiSchema, filters)
          : Promise.resolve(this.summary()),
      ]);
      if (generation !== this.generation) return;
      const current = new Map(this.data()?.items.map((task) => [task.id, task]));
      this.data.set({ ...data, items: data.items.map((task) => this.mergeTask(current.get(task.id), task)) });
      this.staleBrowsers.set(new Set());
      this.browserError.set('');
      this.summary.set(summary);
      this.error.set('');
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
