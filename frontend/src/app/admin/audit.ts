import { Icon } from '../shared/icon';
import { SearchInput } from '../shared/search-input';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
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
  imports: [Icon, SearchInput, DatePipe, DateFilter, MultiFilter, Empty, Pager, Status],
  providers: [QueryState],
  template: `
    <section class="card table-card">
      <div class="section-heading padded">
        <h2>Журнал действий</h2>
        <button
          class="button small"
          [attr.aria-expanded]="filtersOpen()"
          (click)="filtersOpen.set(!filtersOpen())"
        >
          <hg-icon name="filter" />Поиск и фильтры
        </button>
      </div>
      @if (filtersOpen()) {
        <div class="toolbar">
          <label class="search"
            ><hg-icon name="search" /><input
              hgSearch
              aria-label="Поиск аудита"
              placeholder="Администратор, объект или причина"
              [value]="query.text('auditSearch')"
              (searchChange)="
                query.set({ auditSearch: $event || null, auditPage: null }, false)
              " /></label
          ><hg-multi-filter
            label="Действие"
            [options]="actions"
            [value]="query.values('auditAction')"
            (changed)="query.set({ auditAction: $event, auditPage: null }, false)"
          /><hg-multi-filter
            label="Результат"
            [options]="statuses"
            [value]="query.values('auditStatus')"
            (changed)="query.set({ auditStatus: $event, auditPage: null }, false)"
          />
          <hg-date-filter
            [from]="query.text('auditFrom')"
            [to]="query.text('auditTo')"
            (changed)="
              query.set({ auditFrom: $event.from, auditTo: $event.to, auditPage: null }, false)
            "
          />
        </div>
      }
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
                        <hg-icon name="chevron-right" />
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
          (pageChange)="query.set({ auditPage: $event }, false)"
          (sizeChange)="query.set({ auditPageSize: $event, auditPage: null }, false)"
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
  readonly filtersOpen = signal(
    ['auditSearch', 'auditAction', 'auditStatus', 'auditFrom', 'auditTo'].some(
      (key) => this.query.text(key) !== '',
    ),
  );
  readonly filterKey = computed(() =>
    [
      'auditSearch',
      'auditAction',
      'auditStatus',
      'auditFrom',
      'auditTo',
      'auditPage',
      'auditPageSize',
    ]
      .map((key) => this.query.values(key).join('\u0000'))
      .join('\u0001'),
  );
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
      this.filterKey();
      untracked(() => void this.load());
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
        search: this.query.text('auditSearch'),
        action: this.query.values('auditAction'),
        status: this.query.values('auditStatus'),
        from: this.query.text('auditFrom'),
        to: this.query.text('auditTo'),
        page: this.query.number('auditPage', 1),
        pageSize: this.query.number('auditPageSize', 20),
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
