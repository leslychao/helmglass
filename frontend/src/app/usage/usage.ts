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

@Component({
  selector: 'hg-usage',
  imports: [Icon, DecimalPipe, DateFilter, DurationPipe, Empty, Pager],
  providers: [QueryState],
  template: `
    <header class="page-heading"><h1 class="sr-only">Использование</h1></header>
    <div class="usage-period">
      <div class="period-options">
        <button [class.selected]="query.text('period', '7') === '7'" (click)="period(7)">
          7 дней</button
        ><button [class.selected]="query.text('period') === '30'" (click)="period(30)">
          30 дней</button
        ><hg-date-filter
          label="Свой период"
          [from]="query.text('from')"
          [to]="query.text('to')"
          (changed)="dates($event)"
        />
      </div>
      <span class="usage-period-description"
        ><hg-icon name="info" />Расход задач, созданных за выбранный период</span
      >
    </div>
    @if (error()) {
      <div class="error-banner" role="alert">
        {{ error() }}<button class="text-button" (click)="load()">Повторить</button>
      </div>
    }
    @if (data(); as report) {
      @if (report.usage.incomplete) {
        <div class="notice warning">
          Некоторые измерения ещё не подтверждены. Неизвестные значения показаны отдельно от нуля.
        </div>
      }
      <section class="usage-kpis v12-usage-kpis">
        <div class="usage-metric">
          <span class="metric-mark"><hg-icon name="tasks" /></span>
          <div>
            <small>Всего задач</small><strong>{{ report.totalTasks }}</strong
            ><span>Без черновиков</span>
          </div>
        </div>
        <div class="usage-metric">
          <span class="metric-mark green"><hg-icon name="check" /></span>
          <div>
            <small>Успешно завершено</small><strong>{{ report.successfulTasks }}</strong
            ><span
              >{{
                report.successRate === null
                  ? '—'
                  : (report.successRate * 100 | number: '1.0-1') + '%'
              }}
              из {{ report.completedTasks }} завершённых</span
            >
          </div>
        </div>
        <div class="usage-metric">
          <span class="metric-mark blue"><hg-icon name="clock" /></span>
          <div>
            <small>Время браузера</small
            ><strong>{{ report.usage.browserSeconds | duration }}</strong
            ><span>Вручную: {{ report.usage.manualSeconds | duration }}</span>
          </div>
        </div>
        <div class="usage-metric">
          <span class="metric-mark violet"><hg-icon name="image" /></span>
          <div>
            <small>Длительность медиа</small
            ><strong>{{ report.usage.mediaSeconds | duration }}</strong
            ><span>Переданные записи</span>
          </div>
        </div>
        <div class="usage-metric">
          <span class="metric-mark cyan"><hg-icon name="database" /></span>
          <div>
            <small>Объём медиа</small
            ><strong>{{
              report.usage.mediaBytes === null ? '—' : (report.usage.mediaBytes | number)
            }}</strong
            ><span>{{ report.usage.mediaBytes === null ? 'Нет данных' : 'байт передано' }}</span>
          </div>
        </div>
      </section>
      <div class="usage-charts">
        <section class="card usage-chart-card">
          <h2>Задачи по состояниям</h2>
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
              >
                <title>{{ group.label }}: {{ group.tasks }}</title>
              </rect>
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
                    <circle [attr.cx]="point.x" [attr.cy]="point.y" r="3" fill="#4285ff">
                      <title>{{ point.date }}: {{ point.seconds | duration }}</title>
                    </circle>
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
        </div>
        @if (report.sites.items.length) {
          <div class="table-scroll">
            <table class="usage-sites-table">
              <thead>
                <tr>
                  <th>Сайт</th>
                  <th>Время браузера</th>
                  <th>Задачи</th>
                  <th>Медиа</th>
                  <th>Объём медиа</th>
                </tr>
              </thead>
              <tbody>
                @for (site of report.sites.items; track site.site) {
                  <tr>
                    <td>
                      <span class="site-cell"
                        ><span class="service-mark"><hg-icon name="globe" /></span
                        >{{ site.site || 'Без сайта' }}</span
                      >
                    </td>
                    <td>
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
                    </td>
                    <td>{{ site.tasks }}</td>
                    <td>{{ site.mediaSeconds | duration }}</td>
                    <td>
                      {{
                        site.mediaBytes === null
                          ? 'Нет данных'
                          : (site.mediaBytes | number) + ' байт'
                      }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
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
          (sizeChange)="pageSize($event)"
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
  dates(range: DateRange) {
    this.query.set({ period: 'custom', ...range, daysPage: null, sitesPage: null }, false);
  }
  pageSize(size: number) {
    this.query.set({ pageSize: size, daysPage: null, sitesPage: null }, false);
  }
  async load(show = true) {
    const generation = ++this.generation;
    if (show) this.loading.set(true);
    const days = this.query.number('period', 7);
    const beginning = new Date();
    beginning.setHours(0, 0, 0, 0);
    beginning.setDate(beginning.getDate() - days + 1);
    try {
      const data = await this.api.get('/api/usage', usageReportSchema, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        daysPage: this.query.number('daysPage', 1),
        sitesPage: this.query.number('sitesPage', 1),
        pageSize: this.query.number('pageSize', 10),
        from: this.query.text(
          'from',
          this.query.text('period') === 'custom' ? '' : beginning.toISOString(),
        ),
        to: this.query.text('to'),
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
