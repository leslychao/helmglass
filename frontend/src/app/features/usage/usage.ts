import { ChangeDetectionStrategy, Component, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ServerResource } from '../../core/api/server-resource';
import { Page, Query, SiteUsage, Usage as UsageDto, UsageMetric } from '../../core/api/models';
import { TableQuery } from '../../shared/data-table/table-query';
import { Column, DataTable, TableItem } from '../../shared/data-table/data-table';
import { Feedback } from '../../shared/feedback/feedback';
import { DurationPipe, BytesPipe, LabelPipe } from '../../shared/status/status';
import { Metric } from '../../shared/metric/metric';
import { calendarBoundary } from '../../shared/data-table/date-range';
import { UsageChart, UsagePoint } from './usage-chart';
import { Icon } from '../../shared/icon/icon';
import { Dialog } from '../../shared/dialog/dialog';
import { SiteMultiselect } from '../../shared/site-multiselect/site-multiselect';
function date(daysAgo: number) {
  const value = new Date();
  value.setDate(value.getDate() - daysAgo);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
@Component({
  selector: 'hg-usage',
  imports: [
    FormsModule,
    DataTable,
    Feedback,
    Metric,
    UsageChart,
    Icon,
    Dialog,
    SiteMultiselect,
    LabelPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<h1 class="sr-only" tabindex="-1">Использование</h1>
    <div class="h-usage-toolbar">
      <div class="period-control-v">
        @for (period of periods; track period.days) {
          <button
            type="button"
            [class.active]="days() === period.days"
            [attr.aria-pressed]="days() === period.days"
            (click)="periodChange(period.days)"
          >
            {{ period.label }}
          </button>
        }
      </div>
      <label class="date-range-field"
        >С <input type="date" [(ngModel)]="from" (change)="customPeriod()" /></label
      ><label class="date-range-field"
        >По <input type="date" [(ngModel)]="to" (change)="customPeriod()" /></label
      ><span class="h-period-label">{{ timezone }}</span>
      <details class="filter">
        <summary>Фильтры</summary>
        <div class="filter-options">
          <fieldset>
            <legend>Состояния</legend>
            @for (state of states; track state) {
              <label class="checkbox-row"
                ><input
                  type="checkbox"
                  [checked]="query.values('state').includes(state)"
                  (change)="query.toggle('state', state)"
                />{{ state | label }}</label
              >
            }
          </fieldset>
          <hg-site-multiselect
            [selectedIds]="query.values('siteId')"
            (changed)="setSites($event)"
          />
          @if (query.values('state').length || query.values('siteId').length) {
            <button type="button" class="btn quiet" (click)="resetFilters()">
              Сбросить фильтры
            </button>
          }
        </div>
      </details>
      <div class="h-view-actions">
        <button
          type="button"
          class="icon-btn"
          aria-label="Как считаются показатели"
          (click)="definitions.set(true)"
        >
          <hg-icon name="info" />
        </button>
      </div>
    </div>
    @if (validation() || rangeError()) {
      <p class="notice error" role="alert">{{ validation() || rangeError() }}</p>
    }
    <hg-feedback [loading]="usage.loading()" [error]="usage.error()" (retry)="usage.refresh()" />
    @if (usage.data(); as usage) {
      @if (usage.taskCount === 0) {
        <div class="empty">
          <hg-icon name="chart" />
          <h2>За выбранный период нет данных</h2>
          <p>Выберите другой период или измените фильтры.</p>
        </div>
      } @else {
        <div class="metrics usage-metrics-v">
          <hg-metric
            label="Всего задач"
            [value]="usage.taskCount"
            icon="tasks"
            caption="Без черновиков"
          />
          <hg-metric
            label="Успешно завершено"
            [value]="usage.successfulCount"
            [caption]="successCaption()"
            icon="check"
            tone="green"
          />
          <hg-metric
            label="Время браузера"
            [value]="format(usage.metrics.browser_seconds, 'duration')"
            [caption]="'Вход включён: ' + format(usage.metrics.human_login_seconds, 'duration')"
            icon="clock"
          />
          <hg-metric
            label="Медиа"
            [value]="format(usage.metrics.media_seconds, 'duration')"
            [caption]="coverage(usage.metrics.media_seconds)"
            icon="image"
            tone="violet"
          />
          <hg-metric
            label="Объём медиа"
            [value]="format(usage.metrics.media_bytes, 'bytes')"
            [caption]="coverage(usage.metrics.media_bytes)"
            icon="database"
          />
        </div>
        <div class="usage-grid-v">
          <section class="panel chart-panel-v">
            <header class="h-chart-head">
              <h2>Задачи по состояниям</h2>
              <button
                type="button"
                class="icon-btn"
                aria-label="Определения состояний"
                (click)="definitions.set(true)"
              >
                <hg-icon name="info" />
              </button>
            </header>
            <hg-usage-chart [points]="statePoints()" />
          </section>
          <section class="panel chart-panel-v">
            <header class="h-chart-head">
              <h2>Время браузера</h2>
              <span>мин</span>
            </header>
            <hg-usage-chart kind="line" [points]="browserPoints()" />
          </section>
        </div>
      }
    }
    @if (definitions()) {
      <hg-dialog title="Как считаются показатели" (closed)="definitions.set(false)">
        <p>
          Показатели относятся к задачам, созданным в выбранный период, в часовом поясе
          {{ timezone }}. Черновики и отдельные входы в подключения не входят в эту сводку.
          Успешность — доля задач с успешным итогом среди всех завершённых, ошибочных и
          остановленных задач. Прерванные задачи до окончательного завершения не входят в
          знаменатель. Неизвестные измерения не считаются нулём. Время выполнения — непересекающиеся
          интервалы команд на workers, без очереди, пауз, ручного управления и времени мышления
          ChatGPT. Эти интервалы не складываются со временем браузера или медиа.
        </p>
        <p>
          График времени группирует накопленный расход по дате создания задач. Пропуск означает
          отсутствие полного измерения. Каждая задача относится ровно к одному стартовому сайту.
          Объём медиа — сохранённые объекты, а не трафик просмотра браузера.
        </p>
      </hg-dialog>
    }
    <section class="panel h-usage-sites">
      <header class="h-section-header"><h2>Использование по сайтам</h2></header>
      <hg-feedback
        [loading]="sites.loading()"
        [error]="sites.error()"
        (retry)="sites.refresh()"
      /><hg-data-table
        [columns]="columns"
        [rows]="rows()"
        [page]="sites.data()"
        (changed)="query.change($event)"
        emptyTitle="За этот период нет данных"
        emptyText="Выберите другой диапазон дат."
      />
    </section>
    <div class="h-usage-bottom">
      <span><hg-icon name="info" />По дате создания · группировка по стартовому сайту</span>
    </div>`,
})
export class Usage {
  readonly query = new TableQuery();
  readonly usage = new ServerResource<UsageDto>(['usage']);
  readonly sites = new ServerResource<Page<SiteUsage>>(['usage']);
  private readonly defaultFrom = date(29);
  private readonly defaultTo = date(0);
  readonly fromDate = computed(() => this.query.text('from') || this.defaultFrom);
  readonly toDate = computed(() => this.query.text('to') || this.defaultTo);
  readonly days = computed(() =>
    this.toDate() === date(0)
      ? (this.periods.find((period) => this.fromDate() === date(period.days - 1))?.days ?? 0)
      : 0,
  );
  readonly validation = signal('');
  readonly rangeError = computed(() => periodError(this.fromDate(), this.toDate()));
  readonly definitions = signal(false);
  readonly states = [
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
  private readonly label = new LabelPipe();
  private readonly duration = new DurationPipe();
  private readonly bytes = new BytesPipe();
  readonly periods = [
    { days: 1, label: 'Сегодня' },
    { days: 7, label: '7 дней' },
    { days: 30, label: '30 дней' },
  ];
  from = this.fromDate();
  to = this.toDate();
  readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  readonly range = computed<Query>(
    () => ({
      from: calendarBoundary(this.fromDate(), false),
      to: calendarBoundary(this.toDate(), true),
      timezone: this.timezone,
      basis: 'TASK_CREATED',
      state: this.query.values('state'),
      siteId: this.query.values('siteId'),
    }),
    { equal: equalRange },
  );
  readonly columns: Column[] = [
    { key: 'site', title: 'Сайт', sort: 'host' },
    { key: 'browser', title: 'Время браузера', sort: 'browserSeconds' },
    { key: 'tasks', title: 'Задачи', sort: 'taskCount' },
    { key: 'media', title: 'Медиа', sort: 'mediaSeconds' },
    { key: 'bytes', title: 'Объём медиа', sort: 'mediaBytes' },
  ];
  readonly rows = computed<TableItem[]>(
    () =>
      this.sites.data()?.items.map((site) => ({
        id: site.id ?? 'without-start-site',
        values: {
          site: site.host ?? 'Без начального сайта',
          tasks: String(site.taskCount),
          browser: this.format(site.metrics.browser_seconds, 'duration'),
          media: this.format(site.metrics.media_seconds, 'duration'),
          bytes: this.format(site.metrics.media_bytes, 'bytes'),
        },
      })) ?? [],
  );
  readonly statePoints = computed<UsagePoint[]>(() =>
    (this.usage.data()?.states ?? []).map((item) => ({
      key: item.state,
      label: this.label.transform(item.state),
      value: item.count,
      description: `${this.label.transform(item.state)}: ${item.count}`,
      color: item.state === 'FAILED' ? '#ed7b88' : item.state === 'RUNNING' ? '#39ba91' : '#4a8cff',
    })),
  );
  readonly browserPoints = computed<UsagePoint[]>(() =>
    (this.usage.data()?.daily ?? []).map((day) => ({
      key: day.date,
      label: day.date.slice(5),
      value:
        day.metrics.browser_seconds.value === null ? null : day.metrics.browser_seconds.value / 60,
      description: `${day.date}: ${this.format(day.metrics.browser_seconds, 'duration')}`,
    })),
  );
  readonly successCaption = computed(() => {
    const usage = this.usage.data();
    if (!usage) return '';
    const rate =
      usage.successRate === null ? 'Нет итогов' : Math.round(usage.successRate * 100) + '%';
    return `${rate} · ${usage.successfulCount} из ${usage.terminalCount}`;
  });
  constructor() {
    effect(() => {
      this.from = this.fromDate();
      this.to = this.toDate();
    });
    effect(() => {
      if (this.rangeError()) this.usage.clear();
      else this.usage.load('/usage', this.range());
    });
    effect(() => {
      if (this.rangeError()) {
        this.sites.clear();
        return;
      }
      const query = {
        sort: 'browserSeconds',
        direction: 'desc',
        ...this.query.value(),
        ...this.range(),
      };
      this.sites.load('/usage/sites', query);
    });
  }
  format(metric: UsageMetric, kind: 'duration' | 'bytes') {
    if (metric.value === null)
      return metric.completeness === 'PARTIAL' ? 'Нет полных данных' : 'Нет данных';
    return kind === 'duration'
      ? this.duration.transform(metric.value)
      : this.bytes.transform(metric.value);
  }
  coverage(metric: UsageMetric) {
    return metric.completeness === 'COMPLETE'
      ? 'Полные данные'
      : `Измерено ${metric.measuredCount} из ${metric.expectedCount}`;
  }
  periodChange(days: number) {
    this.from = date(days - 1);
    this.to = date(0);
    this.updateRange();
  }
  customPeriod() {
    this.updateRange();
  }
  private updateRange() {
    const error = periodError(this.from, this.to);
    this.validation.set(error);
    if (error) return;
    this.query.filter({ from: this.from, to: this.to });
  }
  setSites(sites: readonly string[]) {
    this.query.filter({ siteId: sites });
  }
  resetFilters() {
    this.query.filter({ state: null, siteId: null });
  }
}

function periodError(fromDate: string, toDate: string): string {
  const from = calendarBoundary(fromDate, false);
  const to = calendarBoundary(toDate, true);
  // Calendar span, independent of daylight-saving changes in the selected timezone.
  const days = (Date.parse(toDate) - Date.parse(fromDate)) / 86400000 + 1;
  return !from || !to || from >= to || days > 366
    ? 'Укажите период не длиннее 366 дней; дата начала должна предшествовать окончанию.'
    : '';
}

function equalRange(left: Query, right: Query): boolean {
  return Object.keys(left).every((key) => {
    const a = left[key],
      b = right[key];
    return Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((value, index) => value === b[index])
      : a === b;
  });
}
