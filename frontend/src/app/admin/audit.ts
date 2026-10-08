import { SearchInput } from '../shared/search-input';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DateFilter } from '../shared/date-filter';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { Page, auditSchema, pageSchema } from '../core/models';
import { Dialog } from '../shared/dialog';
import { MultiFilter } from '../shared/multi-filter';
import { QueryState } from '../shared/query-state';
import { Empty, Pager, Status } from '../shared/ui';

@Component({
  selector: 'hg-audit',
  imports: [SearchInput, DatePipe, DateFilter, MultiFilter, Empty, Pager, Status],
  providers: [QueryState],
  template: `
    <section class="card table-card">
      <div class="toolbar">
        <label class="search"
          ><input
            hgSearch
            aria-label="Поиск аудита"
            placeholder="Администратор, объект или причина"
            [value]="query.text('search')"
            (searchChange)="query.set({ search: $event || null })" /></label
        ><hg-multi-filter
          label="Действие"
          [options]="actions"
          [value]="query.values('action')"
          (changed)="query.set({ action: $event })"
        /><hg-multi-filter
          label="Результат"
          [options]="statuses"
          [value]="query.values('status')"
          (changed)="query.set({ status: $event })"
        />
        <hg-date-filter
          [from]="query.text('from')"
          [to]="query.text('to')"
          (changed)="query.set($event)"
        />
      </div>
      @if (error()) {
        <div class="error-banner" role="alert">
          {{ error() }}<button class="text-button" (click)="load()">Повторить</button>
        </div>
      }
      @if (data(); as page) {
        @if (page.items.length) {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Администратор</th>
                  <th>Объект</th>
                  <th>Действие</th>
                  <th>Причина</th>
                  <th>Результат</th>
                  <th><span class="sr-only">Подробнее</span></th>
                </tr>
              </thead>
              <tbody>
                @for (event of page.items; track event.id) {
                  <tr>
                    <td class="nowrap">{{ event.createdAt | date: 'dd.MM.yyyy HH:mm' }}</td>
                    <td>{{ event.actor }}</td>
                    <td>
                      <code>{{ event.target }}</code>
                    </td>
                    <td>{{ event.action }}</td>
                    <td class="summary-cell">{{ event.reason || '—' }}</td>
                    <td><hg-status [value]="event.status" /></td>
                    <td>
                      <button
                        class="icon-button"
                        aria-label="Подробности изменения"
                        title="Подробности изменения"
                        (click)="details(event)"
                      >
                        ↗
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <hg-empty
            title="Записей не найдено"
            description="Измените поиск или период. Журнал хранится 365 дней."
          />
        }
        <hg-pager
          [page]="page.page"
          [size]="page.pageSize"
          [total]="page.total"
          (pageChange)="query.set({ page: $event }, false)"
          (sizeChange)="query.set({ pageSize: $event })"
        />
      } @else if (!error()) {
        <div class="loading" role="status">Загружаем аудит…</div>
      }
    </section>
  `,
})
export class Audit {
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private generation = 0;
  readonly data = signal<Page<z.infer<typeof auditSchema>> | null>(null);
  readonly error = signal('');
  readonly actions = [
    'LIMITS',
    'BLOCK',
    'UNBLOCK',
    'REQUEST_DELETION',
    'CANCEL_DELETION',
    'STOP_ALL',
    'STOP_TASK',
    'DRAIN',
    'ENABLE',
  ].map((id) => ({ id, label: id }));
  readonly statuses = [
    { id: 'PENDING', label: 'Ожидается' },
    { id: 'SUCCEEDED', label: 'Подтверждено' },
    { id: 'FAILED', label: 'Ошибка' },
    { id: 'UNKNOWN', label: 'Неизвестно' },
  ];
  constructor() {
    effect(() => {
      this.query.params();
      void this.load();
    });
    inject(LiveEvents)
      .watch(['admin-audit'])
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load());
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }
  async load() {
    const generation = ++this.generation;
    try {
      const data = await this.api.get('/api/admin/audit', pageSchema(auditSchema), {
        search: this.query.text('search'),
        action: this.query.values('action'),
        status: this.query.values('status'),
        from: this.query.text('from'),
        to: this.query.text('to'),
        page: this.query.number('page', 1),
        pageSize: this.query.number('pageSize', 20),
      });
      if (generation === this.generation) {
        this.data.set(data);
        this.error.set('');
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    }
  }
  details(event: z.infer<typeof auditSchema>) {
    void this.dialog.ask(
      'Изменение ' + event.action,
      'Причина: ' +
        (event.reason ?? '—') +
        '\n\nДо:\n' +
        (event.before ?? '—') +
        '\n\nПосле:\n' +
        (event.after ?? '—'),
      'Закрыть',
    );
  }
}
