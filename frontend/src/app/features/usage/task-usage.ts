import { ChangeDetectionStrategy, Component, computed, effect, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TaskUsage as TaskUsageDto, UsageMetrics } from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { TableQuery } from '../../shared/data-table/table-query';
import { Column, DataTable, TableItem } from '../../shared/data-table/data-table';
import { Feedback } from '../../shared/feedback/feedback';
import { LabelPipe } from '../../shared/status/status';
import { measuredValue, UsageUnit, usageValue } from '../../shared/status/usage-value';

const metrics: readonly { key: keyof UsageMetrics; label: string; unit: UsageUnit }[] = [
  { key: 'browser_seconds', label: 'Время браузера', unit: 'seconds' },
  { key: 'execution_seconds', label: 'Выполнение команд', unit: 'seconds' },
  { key: 'human_login_seconds', label: 'Приватный вход', unit: 'seconds' },
  { key: 'human_control_seconds', label: 'Ручное управление', unit: 'seconds' },
  { key: 'media_seconds', label: 'Медиа', unit: 'seconds' },
  { key: 'media_bytes', label: 'Сохранённые медиа', unit: 'bytes' },
  { key: 'audio_analyzed_seconds', label: 'Обработанное аудио', unit: 'seconds' },
  { key: 'command_count', label: 'Команды', unit: 'count' },
];

@Component({
  selector: 'hg-task-usage',
  imports: [DatePipe, DataTable, Feedback, LabelPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hg-feedback [loading]="usage.loading()" [error]="usage.error()" (retry)="usage.refresh()" />
    @if (usage.data(); as data) {
      <dl class="pairs usage-totals">
        @for (metric of metrics; track metric.key) {
          <dt>{{ metric.label }}</dt>
          <dd>
            {{ format(data.metrics[metric.key], metric.unit)
            }}<small class="cell-meta"
              >{{ data.metrics[metric.key].completeness | label }} · измерено
              {{ data.metrics[metric.key].measuredCount }} из
              {{ data.metrics[metric.key].expectedCount }}</small
            >
          </dd>
        }
      </dl>
      <p class="small muted">
        Данные на {{ data.asOf | date: 'dd.MM.yyyy HH:mm:ss' }}. Время мышления ChatGPT не
        измеряется. Длительности браузера, команд, входа и медиа не складываются.
      </p>
    }
    <nav class="tabs" aria-label="Детализация ресурсов">
      <button
        class="tab"
        [class.active]="!unknown()"
        [attr.aria-pressed]="!unknown()"
        (click)="switchView(false)"
      >
        Измерения
      </button>
      <button
        class="tab"
        [class.active]="unknown()"
        [attr.aria-pressed]="unknown()"
        (click)="switchView(true)"
      >
        Неподтверждённые интервалы
      </button>
    </nav>
    <hg-data-table
      [columns]="unknown() ? unknownColumns : measurementColumns"
      [rows]="rows()"
      [page]="page()"
      (changed)="query.change($event)"
      [emptyTitle]="unknown() ? 'Неподтверждённых интервалов нет' : 'Измерений пока нет'"
      emptyText="Показаны данные, подтверждённые сервером."
    />
  `,
})
export class TaskUsage {
  readonly taskId = input.required<string>();
  readonly query = new TableQuery({ prefix: 'resources' });
  readonly unknown = computed(() => this.query.text('view') === 'unknown');
  readonly usage = new ServerResource<TaskUsageDto>(['usage'], (data) =>
    this.unknown() ? data.unknownIntervals : data.measurements,
  );
  readonly page = computed(() => {
    const data = this.usage.data();
    return data ? (this.unknown() ? data.unknownIntervals : data.measurements) : null;
  });
  readonly metrics = metrics;
  readonly format = usageValue;
  readonly measurementColumns: Column[] = [
    { key: 'metric', title: 'Показатель', sort: 'metric' },
    { key: 'value', title: 'Значение' },
    { key: 'state', title: 'Полнота', kind: 'status' },
    { key: 'interval', title: 'Интервал', sort: 'intervalStart' },
  ];
  readonly unknownColumns: Column[] = [
    { key: 'interval', title: 'Интервал' },
    { key: 'reason', title: 'Причина' },
    { key: 'session', title: 'Браузерная сессия' },
  ];
  readonly rows = computed<TableItem[]>(() => {
    const data = this.usage.data();
    if (!data) return [];
    if (this.unknown())
      return data.unknownIntervals.items.map((interval) => ({
        id: interval.sessionId,
        values: {
          interval: this.time(interval.from) + ' — ' + this.time(interval.to),
          reason:
            interval.reason === 'UNCONFIRMED_TAIL'
              ? 'Конец сессии не подтверждён'
              : interval.reason === 'MEASUREMENT_PENDING'
                ? 'Ожидается измерение'
                : interval.reason,
          session: interval.sessionId,
        },
      }));
    return data.measurements.items.map((item) => ({
      id: item.id,
      values: {
        metric: metrics.find((metric) => metric.key === item.metric)?.label ?? item.metric,
        value: measuredValue(item.value, item.unit),
        state: item.completeness,
        interval: this.time(item.intervalStart) + ' — ' + this.time(item.intervalEnd),
      },
    }));
  });
  constructor() {
    effect(() => {
      const { view, ...parameters } = this.query.value();
      this.usage.load('/tasks/' + this.taskId() + '/usage', parameters);
    });
  }
  switchView(unknown: boolean) {
    this.query.replace({ view: unknown ? 'unknown' : null });
  }
  private time(value: string | null): string {
    return value === null ? 'Начало неизвестно' : new Date(value).toLocaleString('ru-RU');
  }
}
