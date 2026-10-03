import { ChangeDetectionStrategy, Component, effect, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { CalendarUsage } from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { Feedback } from '../../shared/feedback/feedback';
import { calendarBoundary, calendarDate } from '../../shared/data-table/date-range';
import { usageValue } from '../../shared/status/usage-value';

@Component({
  selector: 'hg-admin-usage',
  imports: [DatePipe, Feedback],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="panel">
    <header class="a-section-header">
      <h2>Использование за 7 суток</h2>
      <small>{{ from | date: 'dd.MM' }} – {{ today | date: 'dd.MM' }}</small>
    </header>
    <hg-feedback [loading]="usage.loading()" [error]="usage.error()" (retry)="usage.refresh()" />
    @if (usage.data(); as usage) {
      <div class="a-usage-pair">
        <div>
          <span>Команды</span
          ><strong>{{ format(usage.metrics.command_count, 'count', true) }}</strong
          ><small
            >Измерено {{ usage.metrics.command_count.measuredCount }} из
            {{ usage.metrics.command_count.expectedCount }} дней</small
          >
        </div>
        <div>
          <span>Время браузеров</span
          ><strong>{{ format(usage.metrics.browser_seconds, 'seconds', true) }}</strong
          ><small
            >Измерено {{ usage.metrics.browser_seconds.measuredCount }} из
            {{ usage.metrics.browser_seconds.expectedCount }} дней</small
          >
        </div>
      </div>
      <details class="a-usage-days">
        <summary>Показать измерения по дням</summary>
        <div class="table-scroll">
          <table class="data-table">
            <caption class="sr-only">
              Календарные измерения пользователя
            </caption>
            <thead>
              <tr>
                <th>День</th>
                <th>Команды</th>
                <th>Время браузеров</th>
              </tr>
            </thead>
            <tbody>
              @for (day of usage.daily; track day.date) {
                <tr>
                  <td [title]="day.from + ' — ' + day.to">{{ day.date | date: 'dd.MM.yyyy' }}</td>
                  <td>{{ format(day.metrics.command_count, 'count', true) }}</td>
                  <td>{{ format(day.metrics.browser_seconds, 'seconds', true) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </details>
      <p class="a-effective-note small muted">
        «≥» показывает только известную часть. Отсутствующие измерения не считаются нулём. Часовой
        пояс: {{ usage.timezone }}. Данные на {{ usage.asOf | date: 'dd.MM HH:mm:ss' }}.
      </p>
    }
  </section>`,
})
export class AdminUsage {
  readonly userId = input.required<string>();
  readonly usage = new ServerResource<CalendarUsage>(['usage']);
  readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  readonly today = calendarDate(new Date().toISOString(), false);
  readonly from = (() => {
    const date = new Date();
    date.setDate(date.getDate() - 6);
    return calendarDate(date.toISOString(), false);
  })();
  readonly format = usageValue;
  constructor() {
    effect(() =>
      this.usage.load(`/admin/users/${this.userId()}/usage`, {
        from: calendarBoundary(this.from, false),
        to: calendarBoundary(this.today, true),
        timezone: this.timezone,
      }),
    );
  }
}
