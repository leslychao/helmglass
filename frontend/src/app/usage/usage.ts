import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DateFilter, DateRange } from '../shared/date-filter';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { usageReportSchema } from '../core/models';
import { QueryState } from '../shared/query-state';
import { DurationPipe, Empty, Pager, Status } from '../shared/ui';

@Component({
  selector: 'hg-usage',
  imports: [DecimalPipe, DateFilter, DurationPipe, Empty, Pager, Status],
  providers: [QueryState],
  template: `
    <header class="page-heading">
      <div>
        <h1>Использование</h1>
        <p>Накопленный расход задач, созданных за выбранный период. Черновики не учитываются.</p>
      </div>
      <div class="actions">
        <button
          class="button"
          [class.selected]="query.text('period', '7') === '7'"
          (click)="period(7)"
        >
          7 дней</button
        ><button
          class="button"
          [class.selected]="query.text('period') === '30'"
          (click)="period(30)"
        >
          30 дней
        </button>
        <hg-date-filter
          label="Свой период"
          [from]="query.text('from')"
          [to]="query.text('to')"
          (changed)="dates($event)"
        />
      </div>
    </header>
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
      <section class="kpis usage-kpis">
        <div class="kpi">
          <span
            ><small>Всего задач</small><strong>{{ report.totalTasks }}</strong></span
          >
        </div>
        <div class="kpi">
          <span
            ><small>Успешность</small
            ><strong>{{
              report.successRate === null ? '—' : (report.successRate * 100 | number: '1.0-1') + '%'
            }}</strong
            ><small
              >{{ report.successfulTasks }} из {{ report.completedTasks }} завершённых</small
            ></span
          >
        </div>
        <div class="kpi">
          <span
            ><small>Время браузера</small
            ><strong class="metric-time">{{ report.usage.browserSeconds | duration }}</strong></span
          >
        </div>
        <div class="kpi">
          <span
            ><small>Выполнение</small
            ><strong class="metric-time">{{
              report.usage.executionSeconds | duration
            }}</strong></span
          >
        </div>
      </section>
      <div class="usage-grid">
        <section class="card" aria-labelledby="usage-days-title" [attr.aria-busy]="loading()">
          <h2 id="usage-days-title">Задачи по дням</h2>
          @if (report.days.items.length) {
            <div class="table-scroll">
              <div
                class="chart"
                [style.min-width.px]="report.days.items.length * 72"
                role="img"
                aria-label="Количество задач по датам текущей страницы. Точные значения приведены в подписях."
              >
                @for (day of report.days.items; track day.date) {
                  <div class="chart-column">
                    <span>{{ day.tasks }}</span>
                    <div class="chart-bar" [style.height.%]="(day.tasks / maxTasks()) * 100"></div>
                    <small>{{ day.date }}</small>
                  </div>
                }
              </div>
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
        <section class="card">
          <h2>Ресурсы</h2>
          <dl class="metrics">
            <div>
              <dt>Управление человеком</dt>
              <dd>{{ report.usage.manualSeconds | duration }}</dd>
            </div>
            <div>
              <dt>Длительность медиа</dt>
              <dd>{{ report.usage.mediaSeconds | duration }}</dd>
            </div>
            <div>
              <dt>Объём медиа</dt>
              <dd>
                {{
                  report.usage.mediaBytes === null
                    ? 'Нет данных'
                    : (report.usage.mediaBytes | number) + ' байт'
                }}
              </dd>
            </div>
          </dl>
          <p class="muted">
            Время браузера включает ожидания. Управление человеком может пересекаться с другими
            категориями. Медиа учитывает передачу, а не анализ.
          </p>
        </section>
      </div>
      <section
        class="card table-card"
        aria-labelledby="usage-sites-title"
        [attr.aria-busy]="loading()"
      >
        <div class="section-heading padded"><h2 id="usage-sites-title">По сайтам</h2></div>
        @if (report.sites.items.length) {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Начальный сайт</th>
                  <th>Задачи</th>
                  <th>Браузер</th>
                  <th>Медиа</th>
                  <th>Объём медиа</th>
                </tr>
              </thead>
              <tbody>
                @for (site of report.sites.items; track site.site) {
                  <tr>
                    <td>{{ site.site || 'Без сайта' }}</td>
                    <td>{{ site.tasks }}</td>
                    <td>{{ site.browserSeconds | duration }}</td>
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
      <section class="card">
        <h2>Состояния задач</h2>
        <div class="status-distribution">
          @for (item of report.statuses; track item.status) {
            <div>
              <hg-status [value]="item.status" /><strong>{{ item.tasks }}</strong>
            </div>
          }
        </div>
        <p class="muted">
          Успешность считается по полностью успешным задачам среди завершённых с известным исходом.
          Активные задачи и неизвестные исходы не входят в знаменатель.
        </p>
      </section>
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
  readonly maxTasks = computed(() =>
    Math.max(1, ...(this.data()?.days.items ?? []).map((day) => day.tasks)),
  );
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
