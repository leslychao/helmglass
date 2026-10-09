import { ColumnPicker } from '../shared/column-picker';
import { TableViews, TableColumn } from '../shared/table-view';
import { DataTable, TableCell } from '../shared/data-table';
import { Icon } from '../shared/icon';
import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DateFilter, DateRange } from '../shared/date-filter';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { usageReportSchema } from '../core/models';
import { QueryState } from '../shared/query-state';
import { DurationPipe, Empty, Pager } from '../shared/ui';
import { Dialog } from '../shared/dialog';
import { Tooltip } from '../shared/tooltip';

@Component({
  selector: 'hg-usage',
  imports: [
    DataTable,
    TableCell,
    ColumnPicker,
    Icon,
    DecimalPipe,
    DateFilter,
    DurationPipe,
    Empty,
    Pager,
    Tooltip,
  ],
  providers: [QueryState],
  template: `
    <h1 class="sr-only">Использование</h1>
    <div class="usage-period">
      <div class="usage-period-presets" role="group" aria-label="Период использования">
        <button
          type="button"
          [class.active]="activePeriod() === 1"
          [attr.aria-pressed]="activePeriod() === 1"
          hgTooltip="Сегодня"
          (click)="period(1)"
        >
          {{ todayLabel }}
        </button>
        <button
          type="button"
          [class.active]="activePeriod() === 7"
          [attr.aria-pressed]="activePeriod() === 7"
          hgTooltip="Последние 7 дней"
          (click)="period(7)"
        >
          7 дней
        </button>
        <button
          type="button"
          [class.active]="activePeriod() === 30"
          [attr.aria-pressed]="activePeriod() === 30"
          hgTooltip="Последние 30 дней"
          (click)="period(30)"
        >
          30 дней
        </button>
      </div>
      <hg-date-filter
        class="usage-date-range"
        appearance="caption"
        label="Период создания задач"
        [captionText]="rangeLabel()"
        [from]="range().from"
        [to]="range().to"
        (changed)="dates($event)"
      />
      <button
        type="button"
        class="icon-button usage-help"
        aria-label="Как считаются показатели"
        hgTooltip="Как считаются показатели"
        (click)="showHelp()"
      >
        <hg-icon name="info" />
      </button>
    </div>
    @if (error()) {
      <div class="error-banner" role="alert">
        {{ error() }}<button class="text-button" (click)="load()">Повторить</button>
      </div>
    }
    @if (data(); as report) {
      <section class="metric-grid usage-kpis" aria-label="Сводка использования">
        <div class="metric">
          <div class="metric-top">
            <span class="metric-label">Всего задач</span>
            <span class="metric-icon"><hg-icon name="tasks" /></span>
          </div>
          <strong class="metric-value">{{ report.totalTasks }}</strong>
          <p class="metric-context">Без черновиков</p>
        </div>
        <div class="metric">
          <div class="metric-top">
            <span class="metric-label">Успешно завершено</span>
            <span class="metric-icon"><hg-icon name="check" /></span>
          </div>
          <strong class="metric-value">{{ report.successfulTasks }}</strong>
          <p class="metric-context">
            {{
              report.successRate === null ? '—' : (report.successRate * 100 | number: '1.0-1') + '%'
            }}
            из {{ report.completedTasks }} завершённых
          </p>
        </div>
        <div class="metric text-value">
          <div class="metric-top">
            <span class="metric-label">Время браузера</span>
            <span class="metric-icon"><hg-icon name="clock" /></span>
          </div>
          <strong class="metric-value">{{ report.usage.browserSeconds | duration }}</strong>
          <p class="metric-context">Вручную: {{ report.usage.manualSeconds | duration }}</p>
        </div>
        <div class="metric text-value">
          <div class="metric-top">
            <span class="metric-label">Длительность медиа</span>
            <span class="metric-icon"><hg-icon name="image" /></span>
          </div>
          <strong class="metric-value">{{ report.usage.mediaSeconds | duration }}</strong>
          <p class="metric-context">Переданные записи</p>
        </div>
        <div class="metric">
          <div class="metric-top">
            <span class="metric-label">Объём медиа</span>
            <span class="metric-icon"><hg-icon name="database" /></span>
          </div>
          <strong class="metric-value">{{
            report.usage.mediaBytes === null ? '—' : (report.usage.mediaBytes | number)
          }}</strong>
          <p class="metric-context">
            {{ report.usage.mediaBytes === null ? 'Нет данных' : 'байт передано' }}
          </p>
        </div>
      </section>
      @if (report.usage.incomplete) {
        <p class="notice warning" role="status">
          Часть измерений неполная. Итоговый расход может уточниться.
        </p>
      }
      <div class="usage-charts">
        <section class="card usage-chart-card">
          <div class="section-heading">
            <h2>Задачи по состояниям</h2>
            <button
              type="button"
              class="icon-button"
              aria-label="Определения состояний"
              hgTooltip="Определения состояний"
              (click)="showStatuses()"
            >
              <hg-icon name="info" />
            </button>
          </div>
          <svg
            class="usage-svg status-svg"
            viewBox="0 0 480 210"
            role="img"
            [attr.aria-label]="statusChartDescription()"
          >
            @for (tick of statusTicks; track tick) {
              <line
                class="chart-gridline"
                x1="28"
                [attr.y1]="155 - tick * 65"
                x2="475"
                [attr.y2]="155 - tick * 65"
              />
              <text x="22" [attr.y]="159 - tick * 65" text-anchor="end">
                {{ (maxStatusTasks() * tick) / 2 | number: '1.0-0' }}
              </text>
            }
            @for (group of statusGroups(); track group.label; let i = $index) {
              <rect
                [attr.x]="42 + i * 72"
                [attr.y]="155 - (group.tasks / maxStatusTasks()) * 130"
                width="36"
                [attr.height]="(group.tasks / maxStatusTasks()) * 130"
                rx="3"
                [attr.fill]="group.color"
                [hgTooltip]="group.label + ': ' + group.tasks"
                [attr.aria-label]="group.label + ': ' + group.tasks"
                tabindex="0"
              />
              <text
                [attr.x]="60 + i * 72"
                [attr.y]="148 - (group.tasks / maxStatusTasks()) * 130"
                text-anchor="middle"
              >
                {{ group.tasks }}
              </text>
              <text [attr.x]="60 + i * 72" y="180" text-anchor="middle" class="chart-axis-label">
                {{ group.label }}
              </text>
            }
          </svg>
          <p class="chart-note">
            Успешность — доля полностью успешных среди завершённых с известным исходом.
          </p>
        </section>
        <section
          class="card usage-chart-card"
          aria-labelledby="usage-days-title"
          [attr.aria-busy]="loading()"
        >
          <div class="section-heading">
            <h2 id="usage-days-title">Время браузера</h2>
            <span>мин</span>
          </div>
          @if (report.days.items.length) {
            <div class="table-scroll">
              <svg
                class="usage-svg time-svg"
                viewBox="0 0 525 190"
                role="img"
                aria-label="Минуты браузера по датам создания задач. Неизвестные измерения показаны пропусками."
                [style.min-width.px]="report.days.items.length * 52"
              >
                <defs>
                  <linearGradient id="usage-time-area" x1="0" y1="0" x2="0" y2="1">
                    <stop stop-color="#d4e3ff" stop-opacity=".65" />
                    <stop offset="1" stop-color="#eff5ff" stop-opacity=".15" />
                  </linearGradient>
                </defs>
                @for (tick of timeTicks; track tick) {
                  <line
                    class="chart-gridline"
                    x1="35"
                    [attr.y1]="145 - tick * 32"
                    x2="510"
                    [attr.y2]="145 - tick * 32"
                  />
                  <text x="27" [attr.y]="149 - tick * 32" text-anchor="end">
                    {{ (((maxBrowserSeconds() * 1.25) / 60) * tick) / 4 | number: '1.0-1' }}
                  </text>
                }
                @for (point of timePoints(); track point.date) {
                  <line
                    class="chart-gridline"
                    [attr.x1]="point.x"
                    y1="17"
                    [attr.x2]="point.x"
                    y2="145"
                  />
                  <text [attr.x]="point.x" y="170" text-anchor="middle">
                    {{ point.date.slice(8, 10) }}.{{ point.date.slice(5, 7) }}
                  </text>
                }
                @for (segment of timeSegments(); track $index) {
                  <path [attr.d]="segment.area" fill="url(#usage-time-area)" />
                  <polyline
                    [attr.points]="segment.line"
                    fill="none"
                    stroke="#4285ff"
                    stroke-width="2"
                  />
                }
                @for (point of timePoints(); track point.date) {
                  @if (point.y !== null) {
                    <circle
                      [attr.cx]="point.x"
                      [attr.cy]="point.y"
                      r="3"
                      fill="#4285ff"
                      [hgTooltip]="point.date + ': ' + (point.seconds | duration)"
                      [attr.aria-label]="point.date + ': ' + (point.seconds | duration)"
                      tabindex="0"
                    />
                  } @else {
                    <text [attr.x]="point.x" y="130" text-anchor="middle" class="chart-axis-label">
                      Нет данных
                    </text>
                  }
                }
              </svg>
            </div>
          } @else {
            <p class="empty-small">
              {{
                report.days.total ? 'На этой странице дней нет.' : 'Нет задач за выбранный период.'
              }}
            </p>
          }
          <hg-pager
            [page]="report.days.page"
            [size]="report.days.pageSize"
            [total]="report.days.total"
            (pageChange)="query.set({ daysPage: $event }, false)"
            (sizeChange)="pageSize($event)"
          />
        </section>
      </div>
      <section
        class="card table-card"
        aria-labelledby="usage-sites-title"
        [attr.aria-busy]="loading()"
      >
        <div class="section-heading padded">
          <h2 id="usage-sites-title">Использование по сайтам</h2>
          @if (report.sites.items.length) {
            <hg-column-picker [view]="table" />
          }
        </div>
        @if (report.sites.items.length) {
          <hg-data-table
            [view]="table"
            [rows]="report.sites.items"
            label="Использование по сайтам"
            rowKey="site"
          >
            <ng-template hgCell="site" [hgCellOf]="report.sites.items" let-site>
              <span class="site-cell"
                ><span class="service-mark"><hg-icon name="globe" /></span
                >{{ site.site || 'Без сайта' }}</span
              >
            </ng-template>
            <ng-template hgCell="browserSeconds" [hgCellOf]="report.sites.items" let-site>
              <div class="site-usage">
                <span>{{ site.browserSeconds | duration }}</span>
                @if (site.browserSeconds !== null && report.usage.browserSeconds !== null) {
                  <i
                    ><b
                      [style.width.%]="
                        report.usage.browserSeconds
                          ? (site.browserSeconds / report.usage.browserSeconds) * 100
                          : 0
                      "
                    ></b
                  ></i>
                }
              </div>
            </ng-template>
            <ng-template hgCell="tasks" [hgCellOf]="report.sites.items" let-site>{{
              site.tasks
            }}</ng-template>
            <ng-template hgCell="mediaSeconds" [hgCellOf]="report.sites.items" let-site>{{
              site.mediaSeconds | duration
            }}</ng-template>
            <ng-template hgCell="mediaBytes" [hgCellOf]="report.sites.items" let-site>
              {{ site.mediaBytes === null ? 'Нет данных' : (site.mediaBytes | number) + ' байт' }}
            </ng-template>
          </hg-data-table>
        } @else {
          <hg-empty
            [title]="
              report.sites.total ? 'На этой странице сайтов нет' : 'Нет данных за этот период'
            "
            [description]="
              report.sites.total
                ? 'Вернитесь на предыдущую страницу.'
                : 'Выберите другой период или создайте задачу.'
            "
          />
        }
        <hg-pager
          [page]="report.sites.page"
          [size]="report.sites.pageSize"
          [total]="report.sites.total"
          (pageChange)="query.set({ sitesPage: $event }, false)"
          (sizeChange)="query.set({ sitesPageSize: $event, sitesPage: null }, false)"
        />
      </section>
      <p class="usage-footnote">
        Выполнение: {{ report.usage.executionSeconds | duration }}. Время браузера включает
        ожидания. Управление человеком может пересекаться с другими категориями. Медиа учитывает
        передачу, а не анализ.
      </p>
    } @else if (loading()) {
      <div class="loading" role="status">Загружаем использование…</div>
    }
  `,
})
export class Usage {
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  readonly todayLabel = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(
    new Date(),
  );
  readonly activePeriod = computed(() => {
    if (this.query.text('period') === 'custom') return 0;
    const days = this.query.number('period', 30);
    return [1, 7, 30].includes(days) ? days : 30;
  });
  readonly range = computed(() => {
    if (!this.activePeriod()) return { from: this.query.text('from'), to: this.query.text('to') };
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    from.setDate(from.getDate() - this.activePeriod() + 1);
    return { from: from.toISOString(), to: to.toISOString() };
  });
  readonly rangeLabel = computed(() => {
    const { from, to } = this.range();
    const start = from ? new Date(from) : null;
    const end = to ? new Date(new Date(to).getTime() - 1) : null;
    if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime())))
      return 'Выбрать даты';
    if (start && end && start > end) return 'Выбрать даты';
    const format = new Intl.DateTimeFormat('ru', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    if (start && end) return format.formatRange(start, end);
    if (start) return 'С ' + format.format(start);
    if (end) return 'По ' + format.format(end);
    return 'Все даты';
  });
  private generation = 0;
  readonly data = signal<z.infer<typeof usageReportSchema> | null>(null);
  readonly error = signal('');
  readonly loading = signal(true);
  readonly maxBrowserSeconds = computed(() =>
    Math.max(
      1,
      ...(this.data()?.days.items ?? []).flatMap((day) =>
        day.browserSeconds === null ? [] : [day.browserSeconds],
      ),
    ),
  );
  readonly statusTicks = [0, 1, 2];
  readonly timeTicks = [0, 1, 2, 3, 4];
  readonly statusGroups = computed(() => {
    const rows = this.data()?.statuses ?? [];
    const groups = [
      { label: 'Готово', statuses: ['SUCCEEDED'], color: '#4a8cff' },
      {
        label: 'В работе',
        statuses: [
          'WAITING_CHATGPT',
          'QUEUED',
          'STARTING',
          'RUNNING',
          'PAUSING',
          'PAUSED',
          'WAITING_USER',
          'STOPPING',
        ],
        color: '#39ba91',
      },
      { label: 'Частично', statuses: ['PARTIAL'], color: '#a396e9' },
      { label: 'Без успеха', statuses: ['NOT_ACHIEVED'], color: '#d7a665' },
      { label: 'Ошибка', statuses: ['FAILED'], color: '#ed7b88' },
      { label: 'Остановлено', statuses: ['STOPPED'], color: '#b6c1d2' },
    ];
    return groups.map((group) => ({
      ...group,
      tasks: rows.reduce(
        (sum, row) => sum + (group.statuses.includes(row.status) ? row.tasks : 0),
        0,
      ),
    }));
  });
  readonly maxStatusTasks = computed(() =>
    Math.max(1, ...this.statusGroups().map((group) => group.tasks)),
  );
  readonly statusChartDescription = computed(() =>
    this.statusGroups()
      .map((group) => group.label + ': ' + group.tasks)
      .join('; '),
  );
  readonly timePoints = computed(() => {
    const days = this.data()?.days.items ?? [];
    return days.map((day, index) => ({
      date: day.date,
      seconds: day.browserSeconds,
      x: days.length === 1 ? 270 : 35 + (index * 470) / (days.length - 1),
      y:
        day.browserSeconds === null
          ? null
          : 145 - (day.browserSeconds / (this.maxBrowserSeconds() * 1.25)) * 128,
    }));
  });
  readonly timeSegments = computed(() => {
    const segments: { line: string; area: string }[] = [];
    let points: { x: number; y: number }[] = [];
    const finish = () => {
      const first = points.at(0),
        last = points.at(-1);
      if (first && last) {
        const line = points.map((point) => point.x + ',' + point.y).join(' ');
        segments.push({
          line,
          area:
            'M' +
            first.x +
            ' 145 ' +
            points.map((point) => 'L' + point.x + ' ' + point.y).join(' ') +
            ' L' +
            last.x +
            ' 145 Z',
        });
      }
      points = [];
    };
    for (const point of this.timePoints()) {
      if (point.y === null) finish();
      else points.push({ x: point.x, y: point.y });
    }
    finish();
    return segments;
  });
  readonly tableColumns: readonly TableColumn[] = [
    { key: 'site', label: 'Сайт', width: 260, required: true },
    { key: 'browserSeconds', label: 'Время браузера', width: 200 },
    { key: 'tasks', label: 'Задачи', width: 140 },
    { key: 'mediaSeconds', label: 'Медиа', width: 170 },
    { key: 'mediaBytes', label: 'Объём медиа', width: 180 },
  ];
  readonly table = inject(TableViews).create('usage-sites', this.tableColumns, this.query, {
    sort: 'sitesSort',
    direction: 'sitesDirection',
    page: 'sitesPage',
    size: 'sitesPageSize',
  });
  constructor() {
    effect(() => {
      this.query.params();
      void this.load();
    });
    inject(LiveEvents)
      .watch(['usage', 'task'])
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load(false));
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }
  period(days: number) {
    this.query.set({ period: days, from: null, to: null, daysPage: null, sitesPage: null }, false);
  }
  showHelp() {
    this.dialog.info(
      'Как считаются показатели',
      'Период относится к дате создания задачи в вашем часовом поясе. Черновики не учитываются. ' +
        'График времени группирует накопленный расход выбранных задач по дате их создания, а не по времени отдельных действий.\n\n' +
        'Успешность — отношение числа полностью успешных задач к числу завершённых с известным исходом: полный успех, частичный результат, недостигнутая цель, ошибка или остановка. ' +
        'Задачи с операцией неизвестного исхода не входят в число завершённых для этого расчёта.\n\n' +
        'Задача и весь её расход относятся к стартовому сайту. Это не измерение посещений отдельных доменов. Таблица сайтов и общие показатели используют один набор задач.\n\n' +
        'Время браузера включает ожидания. Ручное управление может пересекаться с другими категориями времени. Медиа учитывает готовые переданные файлы, а не их анализ. ' +
        'Неизвестные измерения показаны как «Нет данных» или «—»; неполные измерения отдельно отмечены.',
    );
  }
  showStatuses() {
    this.dialog.info(
      'Определения состояний',
      'Готово — задача полностью выполнена. Частично — получен частичный результат. Без успеха — цель не достигнута. Ошибка — выполнение завершилось с ошибкой. Остановлено — задача остановлена.\n\n' +
        'В работе — все незавершённые задачи, включая ожидание ChatGPT, очередь, запуск, выполнение, паузу, ожидание пользователя и остановку в процессе. Каждая задача относится к одной группе.',
    );
  }
  dates(range: DateRange) {
    this.query.set({ period: 'custom', ...range, daysPage: null, sitesPage: null }, false);
  }
  pageSize(size: number) {
    this.query.set({ pageSize: size, daysPage: null }, false);
  }
  async load(show = true) {
    const generation = ++this.generation;
    if (show) this.loading.set(true);
    try {
      const data = await this.api.get('/api/usage', usageReportSchema, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        daysPage: this.query.number('daysPage', 1),
        sitesPage: this.query.number('sitesPage', 1),
        pageSize: this.query.number('pageSize', 10),
        sitesPageSize: this.query.number('sitesPageSize', 5),
        sitesSort: this.query.text('sitesSort', 'site'),
        sitesDirection: this.table.direction(),
        ...this.range(),
      });
      if (generation === this.generation) {
        this.data.set(data);
        this.error.set('');
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
