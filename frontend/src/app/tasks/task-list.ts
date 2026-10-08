import { SearchInput } from '../shared/search-input';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DateFilter } from '../shared/date-filter';
import { RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { Page, Task, kpiSchema, pageSchema, taskSchema } from '../core/models';
import { MultiFilter, Option } from '../shared/multi-filter';
import { QueryState } from '../shared/query-state';
import { DurationPipe, Empty, Pager, Status, states } from '../shared/ui';

@Component({
  selector: 'hg-task-list',
  imports: [
    SearchInput,
    DatePipe,
    DateFilter,
    RouterLink,
    MultiFilter,
    DurationPipe,
    Empty,
    Pager,
    Status,
  ],
  providers: [QueryState],
  templateUrl: './task-list.html',
})
export class TaskList {
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private readonly live = inject(LiveEvents);
  private readonly destroy = inject(DestroyRef);
  private generation = 0;
  readonly data = signal<Page<Task> | null>(null);
  readonly summary = signal<z.infer<typeof kpiSchema> | null>(null);
  private summaryFilters = '';
  readonly error = signal('');
  readonly loading = signal(true);
  readonly columns = signal(['site', 'executionSeconds', 'updatedAt', 'summary']);
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
  readonly columnOptions: Option[] = [
    { id: 'site', label: 'Сайт' },
    { id: 'executionSeconds', label: 'Выполнение' },
    { id: 'manualSeconds', label: 'Управление человеком' },
    { id: 'mediaSeconds', label: 'Медиа' },
    { id: 'mediaBytes', label: 'Объём медиа' },
    { id: 'updatedAt', label: 'Обновлена' },
    { id: 'summary', label: 'Краткий итог' },
  ];
  readonly sourceOptions: Option[] = [
    { id: 'WEB', label: 'Веб-интерфейс' },
    { id: 'MCP', label: 'ChatGPT' },
  ];
  readonly activeStates = ['STARTING', 'RUNNING', 'PAUSING', 'STOPPING'];
  readonly successStates = ['SUCCEEDED'];
  readonly attentionStates = ['WAITING_USER'];
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
  constructor() {
    effect(() => {
      this.query.params();
      untracked(() => void this.load());
    });
    this.live
      .watch(['task'])
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load(false));
    this.destroy.onDestroy(() => {
      this.generation++;
    });
  }
  async load(show = true) {
    const generation = ++this.generation;
    if (show) this.loading.set(true);
    const filters = {
      search: this.query.text('search'),
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
          pageSize: this.query.number('pageSize', 20),
          sort: this.query.text('sort', 'updatedAt'),
          direction: this.query.text('direction', 'desc'),
        }),
        refreshSummary
          ? this.api.get('/api/tasks/summary', kpiSchema, filters)
          : Promise.resolve(this.summary()),
      ]);
      if (generation !== this.generation) return;
      this.data.set(data);
      this.summary.set(summary);
      this.error.set('');
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
  clear() {
    this.query.set({ search: null, status: null, site: null, source: null, from: null, to: null });
  }
}
