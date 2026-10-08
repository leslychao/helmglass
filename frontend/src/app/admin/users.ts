import { SearchInput } from '../shared/search-input';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { AdminUser, Page, adminUserSchema, pageSchema } from '../core/models';
import { MultiFilter } from '../shared/multi-filter';
import { QueryState } from '../shared/query-state';
import { Empty, Pager, Status } from '../shared/ui';

@Component({
  selector: 'hg-admin-users',
  imports: [SearchInput, DatePipe, FormsModule, RouterLink, MultiFilter, Empty, Pager, Status],
  providers: [QueryState],
  template: ` <section class="card table-card">
    <div class="toolbar">
      <label class="search"
        ><input
          hgSearch
          aria-label="Поиск пользователей"
          placeholder="Имя или email"
          [value]="query.text('search')"
          (searchChange)="query.set({ search: $event || null })" /></label
      ><hg-multi-filter
        label="Состояние"
        [options]="statuses"
        [value]="query.values('status')"
        (changed)="query.set({ status: $event })"
      /><hg-multi-filter
        label="Дополнительно"
        [options]="flags"
        [value]="query.values('flag')"
        (changed)="query.set({ flag: $event })"
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
                <th [attr.aria-sort]="query.ariaSort('name', 'lastAccessAt')">
                  <button (click)="query.sort('name', 'lastAccessAt')">Пользователь ↕</button>
                </th>
                <th>Состояние</th>
                <th>Браузеры</th>
                <th>Ожидающие задачи</th>
                <th>Лимит браузеров</th>
                <th [attr.aria-sort]="query.ariaSort('lastAccessAt', 'lastAccessAt')">
                  <button (click)="query.sort('lastAccessAt', 'lastAccessAt')">
                    Последний вход ↕
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              @for (user of page.items; track user.id) {
                <tr>
                  <td>
                    <a
                      [routerLink]="['/admin/users', user.id]"
                      [queryParams]="{ back: query.context() }"
                      >{{ user.name }}</a
                    ><small>{{ user.email }}</small>
                    @if (user.pendingOperations) {
                      <small class="warning-text"
                        >Незавершённых операций: {{ user.pendingOperations }}</small
                      >
                    }
                  </td>
                  <td><hg-status [value]="user.status" /></td>
                  <td>{{ user.browserCount ?? '—' }}</td>
                  <td>{{ user.waitingCount }}</td>
                  <td>
                    {{
                      user.browserLimitMode === 'UNLIMITED'
                        ? 'Без лимита'
                        : user.browserLimitMode === 'PLATFORM'
                          ? 'По умолчанию (' + (user.browserLimit ?? 2) + ')'
                          : user.browserLimit
                    }}
                  </td>
                  <td>
                    {{ user.lastAccessAt ? (user.lastAccessAt | date: 'dd.MM.yyyy HH:mm') : '—' }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <hg-empty title="Пользователи не найдены" description="Измените поиск или фильтры." />
      }
      <hg-pager
        [page]="page.page"
        [size]="page.pageSize"
        [total]="page.total"
        (pageChange)="query.set({ page: $event }, false)"
        (sizeChange)="query.set({ pageSize: $event })"
      />
    } @else if (!error()) {
      <div class="loading" role="status">Загружаем пользователей…</div>
    }
  </section>`,
})
export class AdminUsers {
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private generation = 0;
  readonly data = signal<Page<AdminUser> | null>(null);
  readonly error = signal('');
  readonly statuses = [
    { id: 'ACTIVE', label: 'Активен' },
    { id: 'BLOCKED', label: 'Заблокирован' },
    { id: 'DELETION_PENDING', label: 'Ожидает удаления' },
    { id: 'PURGING', label: 'Очистка данных' },
    { id: 'DELETED', label: 'Удалён' },
  ];
  readonly flags = [
    { id: 'waiting', label: 'Есть ожидающие задачи' },
    { id: 'pending', label: 'Есть незавершённые операции' },
  ];
  constructor() {
    effect(() => {
      this.query.params();
      void this.load();
    });
    inject(LiveEvents)
      .watch(['admin-user', 'admin-operation'])
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load());
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }
  async load() {
    const generation = ++this.generation;
    try {
      const data = await this.api.get('/api/admin/users', pageSchema(adminUserSchema), {
        search: this.query.text('search'),
        status: this.query.values('status'),
        flag: this.query.values('flag'),
        page: this.query.number('page', 1),
        pageSize: this.query.number('pageSize', 20),
        sort: this.query.text('sort', 'lastAccessAt'),
        direction: this.query.text('direction', 'desc'),
      });
      if (generation === this.generation) {
        this.data.set(data);
        this.error.set('');
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    }
  }
}
