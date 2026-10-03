import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import { ServerResource } from '../../core/api/server-resource';
import { Page, Task, TaskSummary, TaskListItem } from '../../core/api/models';
import { Mutation } from '../../core/api/mutation';
import { TableQuery } from '../../shared/data-table/table-query';
import { Column, DataTable, TableItem } from '../../shared/data-table/data-table';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Icon } from '../../shared/icon/icon';
import { Dialog } from '../../shared/dialog/dialog';
import { DurationPipe, LabelPipe, BytesPipe } from '../../shared/status/status';
import { SiteMultiselect } from '../../shared/site-multiselect/site-multiselect';
import { Metric } from '../../shared/metric/metric';
import { calendarBoundary, calendarDate } from '../../shared/data-table/date-range';
import { readColumns, saveColumns } from '../../shared/data-table/column-preferences';

@Component({
  selector: 'hg-task-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ReactiveFormsModule,
    DataTable,
    Feedback,
    MutationFeedback,
    Icon,
    Dialog,
    SiteMultiselect,
    LabelPipe,
    Metric,
  ],
  templateUrl: './task-list.html',
})
export class TaskList {
  readonly query = new TableQuery();
  readonly tasks = new ServerResource<Page<TaskListItem>>(['tasks']);
  readonly summary = new ServerResource<TaskSummary>(['tasks', 'connections']);
  readonly selected = new ServerResource<Task>(['tasks']);
  readonly action = new Mutation();
  readonly search = new FormControl(this.query.text('q'), { nonNullable: true });
  readonly selectedId = signal<string | null>(null);
  readonly columnsOpen = signal(false);
  readonly visibleColumns = signal(
    readColumns(
      'helm.tasks.columns',
      ['site', 'duration', 'human', 'media', 'bytes', 'updated', 'summary'],
      ['site', 'duration', 'updated', 'summary'],
    ),
  );
  private readonly router = inject(Router);
  readonly states = [
    'DRAFT',
    'WAITING_AGENT',
    'QUEUED',
    'RUNNING',
    'WAITING_USER',
    'PAUSED',
    'INTERRUPTED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ];
  readonly optionalColumns: Column[] = [
    { key: 'site', title: 'Сайт', sort: 'site', width: '150px', kind: 'site' },
    { key: 'duration', title: 'Время выполнения', sort: 'activeSeconds', width: '152px' },
    { key: 'human', title: 'Вход пользователя', sort: 'humanSeconds', width: '140px' },
    { key: 'media', title: 'Медиа', sort: 'mediaSeconds', width: '120px' },
    { key: 'bytes', title: 'Объём медиа', sort: 'mediaBytes', width: '134px' },
    { key: 'updated', title: 'Обновлено', sort: 'updatedAt', width: '115px' },
    { key: 'summary', title: 'Текущий шаг / итог', sort: 'summary', width: '200px' },
  ];
  readonly columns = computed<Column[]>(() => [
    { key: 'title', title: 'Задача', sort: 'title', width: '245px' },
    ...this.optionalColumns.filter(
      (column) => column.key === 'site' && this.visibleColumns().includes(column.key),
    ),
    { key: 'state', title: 'Состояние', sort: 'state', width: '150px', kind: 'status' },
    ...this.optionalColumns.filter(
      (column) => column.key !== 'site' && this.visibleColumns().includes(column.key),
    ),
  ]);
  readonly successRate = computed(() => {
    const summary = this.summary.data();
    return summary && summary.successDenominator > 0
      ? Math.round((summary.successCount / summary.successDenominator) * 100) + '%'
      : null;
  });
  readonly successCaption = computed(() => {
    const summary = this.summary.data();
    return summary
      ? `${summary.successCount} из ${summary.successDenominator} завершённых`
      : 'Состояние ещё не получено';
  });
  readonly connectionCaption = computed(() => {
    const summary = this.summary.data();
    return summary
      ? `Вход сохранён · всего ${summary.totalConnections}`
      : 'Состояние ещё не получено';
  });
  readonly filtered = computed(() =>
    Object.entries(this.query.value()).some(
      ([key, value]) =>
        !['page', 'pageSize', 'sort', 'direction', 'snapshot'].includes(key) &&
        value !== '' &&
        value !== null &&
        value !== undefined &&
        (!Array.isArray(value) || value.length > 0),
    ),
  );
  readonly rows = computed<TableItem[]>(
    () =>
      this.tasks.data()?.items.map((task) => ({
        id: task.id,
        link: '/tasks/' + task.id,
        metadata: {
          title: `#${task.displayNumber} · ${task.origin === 'MCP' ? 'Из ChatGPT' : 'Из кабинета'}`,
        },
        values: {
          title: task.title || task.goal || 'Черновик',
          site: task.site || hostname(task.startUrl),
          state: task.outcome || task.state,
          duration:
            task.state === 'DRAFT'
              ? 'Не запущена'
              : new DurationPipe().transform(task.usage?.activeSeconds),
          human: new DurationPipe().transform(task.usage?.humanSeconds),
          media: new DurationPipe().transform(task.usage?.mediaSeconds),
          bytes: new BytesPipe().transform(task.usage?.mediaBytes),
          updated: new Date(task.updatedAt).toLocaleString('ru-RU', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          }),
          summary: task.summary || task.currentStep || task.reason || '',
        },
      })) ?? [],
  );
  constructor() {
    this.summary.load('/tasks/summary');
    effect(() => {
      this.tasks.load('/tasks', this.query.value());
      this.search.setValue(this.query.text('q'), { emitEvent: false });
    });
    this.search.valueChanges
      .pipe(debounceTime(250), distinctUntilChanged(), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((q) => this.query.filter({ q: q || null }));
  }
  selectedState(state: string) {
    return this.query.values('state').includes(state);
  }
  toggleState(state: string) {
    this.query.toggle('state', state);
  }
  setSites(sites: readonly string[]) {
    this.query.filter({ siteId: sites });
  }
  sourceFilter(event: Event) {
    if (event.target instanceof HTMLSelectElement)
      this.query.filter({ source: event.target.value || null });
  }
  dateFilter(key: string, event: Event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.query.filter({ [key]: calendarBoundary(event.target.value, key === 'createdTo') });
  }
  dateValue(key: string) {
    return calendarDate(this.query.text(key), key === 'createdTo');
  }
  resetFilters() {
    this.query.clear();
  }
  toggleColumn(key: string) {
    this.visibleColumns.update((columns) =>
      columns.includes(key) ? columns.filter((column) => column !== key) : [...columns, key],
    );
    saveColumns('helm.tasks.columns', this.visibleColumns());
  }
  resetColumns() {
    this.visibleColumns.set(['site', 'duration', 'updated', 'summary']);
    saveColumns('helm.tasks.columns', this.visibleColumns());
  }
  openMenu(id: string) {
    this.selectedId.set(id);
    this.selected.load('/tasks/' + id);
  }
  copy(task: Task) {
    this.action.run(
      'POST',
      `/tasks/${task.id}/copy`,
      {},
      (receipt) => void this.router.navigate(['/tasks', receipt.resource.id, 'edit']),
    );
  }
  remove(task: Task) {
    this.action.run('DELETE', `/tasks/${task.id}`, { expectedVersion: task.version }, () => {
      this.selectedId.set(null);
      this.tasks.refresh();
      this.summary.refresh();
    });
  }
  stop(task: Task) {
    this.action.run('POST', `/tasks/${task.id}/stop`, {}, () => {
      this.selectedId.set(null);
      this.tasks.refresh();
    });
  }
}
export function hostname(url: string | null) {
  try {
    return url ? new URL(url).hostname : 'Не указан';
  } catch {
    return 'Не указан';
  }
}
