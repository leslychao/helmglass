import { ColumnPicker } from '../shared/column-picker';
import { TableViews, TableColumn } from '../shared/table-view';
import { DataTable, TableCell } from '../shared/data-table';
import * as z from 'zod/mini';
import { Audit } from './audit';
import { Icon } from '../shared/icon';
import { FilterReset } from '../shared/filter-reset';
import { SearchInput } from '../shared/search-input';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { AdminUser, Page, adminUserSchema, pageSchema } from '../core/models';
import { MultiFilter } from '../shared/multi-filter';
import { QueryState } from '../shared/query-state';
import { Tooltip } from '../shared/tooltip';
import { Empty, Pager, Status } from '../shared/ui';

const adminSummarySchema = z.object({
  users: z.number(),
  blocked: z.number(),
  waitingTasks: z.number(),
});

@Component({
  selector: 'hg-admin-users',
  imports: [
    DataTable,
    TableCell,
    ColumnPicker,
    FilterReset,
    Audit,
    Icon,
    SearchInput,
    DatePipe,
    FormsModule,
    RouterLink,
    MultiFilter,
    Empty,
    Pager,
    Status,
    Tooltip,
  ],
  providers: [QueryState],
  styles: `
    .admin-effective-note {
      padding: 12px 16px;
      margin: 0;
      border-top: 1px solid var(--line);
      background: #f8faff;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.7;
    }
    .admin-privacy-note {
      display: flex;
      align-items: flex-start;
      gap: 7px;
    }
    .admin-privacy-note hg-icon {
      flex: none;
      width: 14px;
      height: 14px;
      margin-top: 3px;
    }
  `,
  template: `<h1 class="sr-only">{{ overview ? 'Администрирование' : 'Пользователи' }}</h1>
    @if (overview) {
      <section class="metric-grid" aria-label="Сводка администрирования">
        <div class="metric">
          <div class="metric-top">
            <span class="metric-label">Пользователей</span>
            <span class="metric-icon"><hg-icon name="user" /></span>
          </div>
          <strong class="metric-value">{{ summary()?.users ?? '—' }}</strong>
          <p class="metric-context">Без удалённых аккаунтов</p>
        </div>
        <div class="metric">
          <div class="metric-top">
            <span class="metric-label">Заблокировано</span>
            <span class="metric-icon"><hg-icon name="lock" /></span>
          </div>
          <strong class="metric-value">{{ summary()?.blocked ?? '—' }}</strong>
          <p class="metric-context">Пользователи с закрытым доступом</p>
        </div>
        <div class="metric">
          <div class="metric-top">
            <span class="metric-label">Ожидающих задач</span>
            <span class="metric-icon"><hg-icon name="clock" /></span>
          </div>
          <strong class="metric-value">{{ summary()?.waitingTasks ?? '—' }}</strong>
          <p class="metric-context">Очередь, ChatGPT или участие пользователя</p>
        </div>
      </section>
      @if (summaryError()) {
        <div class="error-banner" role="alert">
          {{ summaryError() }}<button class="text-button" (click)="loadSummary()">Повторить</button>
        </div>
      }
    }
    <section class="card table-card">
      <div class="section-heading padded"><h2>Пользователи</h2></div>
      <div class="toolbar">
        <label class="search"
          ><hg-icon name="search" /><input
            hgSearch
            aria-label="Поиск пользователей"
            placeholder="Имя, email или ID"
            [value]="query.text('search')"
            (searchChange)="query.set({ search: $event || null })" /></label
        ><hg-multi-filter
          label="Состояние"
          [options]="statuses"
          [value]="query.values('status')"
          (changed)="query.set({ status: $event })"
        />
        <button
          class="button quiet small admin-filter-toggle"
          [attr.aria-pressed]="query.values('flag').includes('pending')"
          (click)="toggleFlag('pending')"
        >
          Незавершённые операции
        </button>
        <button
          class="button quiet small admin-filter-toggle"
          [attr.aria-pressed]="query.values('flag').includes('waiting')"
          (click)="toggleFlag('waiting')"
        >
          Ожидающие задачи
        </button>
        <hg-column-picker [view]="table" /><hg-filter-reset [keys]="['status', 'flag']" />
      </div>
      @if (error()) {
        <div class="error-banner" role="alert">
          {{ error() }}<button class="text-button" (click)="load()">Повторить</button>
        </div>
      }
      @if (data(); as page) {
        @if (page.items.length) {
          <hg-data-table [view]="table" [rows]="page.items" label="Пользователи">
            <ng-template hgCell="name" [hgCellOf]="page.items" let-user>
              <a
                class="admin-user-cell"
                [routerLink]="['/admin/users', user.id]"
                [queryParams]="{ return: returnUrl() }"
                ><span class="user-initial">{{ user.name.slice(0, 1).toUpperCase() }}</span
                ><span
                  ><strong>{{ user.name }}</strong
                  ><small [hgTooltip]="user.email">{{ user.email }}</small></span
                ></a
              >
            </ng-template>
            <ng-template hgCell="status" [hgCellOf]="page.items" let-user>
              <hg-status [value]="user.status" />
              @if (user.pendingOperations) {
                <small class="warning-text">{{ user.pendingOperations }} незавершённых</small>
              }
            </ng-template>
            <ng-template hgCell="browserCount" [hgCellOf]="page.items" let-user>
              <div
                class="admin-quota-cell"
                [class.over-limit]="
                  user.browserCount !== null &&
                  user.browserLimitMode !== 'UNLIMITED' &&
                  user.browserCount > (user.browserLimit ?? 2)
                "
              >
                <strong>Занято: {{ user.browserCount ?? '—' }}</strong
                ><small>{{
                  user.browserLimitMode === 'UNLIMITED'
                    ? 'Без индивидуального лимита: в пределах свободных мест'
                    : 'Лимит: ' + (user.browserLimit ?? 2)
                }}</small>
                @if (
                  user.browserCount !== null &&
                  user.browserLimitMode !== 'UNLIMITED' &&
                  (user.browserLimit ?? 2) > 0
                ) {
                  <span class="quota-bar"
                    ><i
                      [style.width.%]="
                        Math.min(100, (user.browserCount / (user.browserLimit ?? 2)) * 100)
                      "
                    ></i
                  ></span>
                }
                @if (
                  user.browserCount !== null &&
                  user.browserLimitMode !== 'UNLIMITED' &&
                  user.browserCount > (user.browserLimit ?? 2)
                ) {
                  <small>Лимит снижен; текущая работа сохранена</small>
                }
              </div>
            </ng-template>
            <ng-template hgCell="waitingCount" [hgCellOf]="page.items" let-user>
              <div
                class="admin-quota-cell"
                [class.over-limit]="
                  user.waitingLimit !== null && user.waitingCount > user.waitingLimit
                "
              >
                <strong>Ожидают: {{ user.waitingCount }}</strong
                ><small>{{
                  user.waitingLimit === null ? 'Лимит не задан' : 'Лимит: ' + user.waitingLimit
                }}</small>
                @if (user.waitingLimit !== null && user.waitingLimit > 0) {
                  <span class="quota-bar"
                    ><i
                      [style.width.%]="Math.min(100, (user.waitingCount / user.waitingLimit) * 100)"
                    ></i
                  ></span>
                }
              </div>
            </ng-template>
            <ng-template hgCell="lastAccessAt" [hgCellOf]="page.items" let-user>
              {{ user.lastAccessAt ? (user.lastAccessAt | date: 'dd.MM.yyyy HH:mm') : '—' }}
            </ng-template>
            <ng-template hgCell="actions" [hgCellOf]="page.items" let-user>
              <a
                class="icon-button"
                [routerLink]="['/admin/users', user.id]"
                [queryParams]="{ return: returnUrl() }"
                aria-label="Открыть пользователя"
                hgTooltip="Открыть пользователя"
                ><hg-icon name="chevron-right"
              /></a>
            </ng-template>
          </hg-data-table>
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
      <p class="admin-effective-note">
        «Занято» — браузеры пользователя, включая запускаемые и завершаемые. «Ожидают» — задачи в
        очереди, ожидающие ChatGPT или участия пользователя. Лимиты назначает администратор;
        черновики не учитываются.
      </p>
    </section>
    @if (overview) {
      <hg-audit [overview]="true" id="admin-audit" />
    }
    <p class="admin-privacy-note">
      <hg-icon name="shield" /><span
        >Только служебные сведения. Содержимое задач, результаты, документы и секреты пользователей
        здесь недоступны. Административные действия выполняются только из веб-кабинета, не через
        MCP.</span
      >
    </p>`,
})
export class AdminUsers {
  readonly Math = Math;
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly overview = inject(ActivatedRoute).snapshot.routeConfig?.path === '';
  readonly defaultSort = this.overview ? 'browserCount' : 'name';
  readonly defaultDirection = this.overview ? 'desc' : 'asc';
  private generation = 0;
  readonly data = signal<Page<AdminUser> | null>(null);
  readonly error = signal('');
  readonly summary = signal<z.infer<typeof adminSummarySchema> | null>(null);
  readonly summaryError = signal('');
  private summaryGeneration = 0;
  private readonly filterKey = computed(() =>
    ['search', 'status', 'flag', 'page', 'pageSize', 'sort', 'direction']
      .map((key) => this.query.values(key).join('\u0000'))
      .join('\u0001'),
  );
  readonly statuses = [
    { id: 'ACTIVE', label: 'Активен' },
    { id: 'BLOCKED', label: 'Заблокирован' },
    { id: 'DELETION_PENDING', label: 'Ожидает удаления' },
    { id: 'PURGING', label: 'Очистка данных' },
    { id: 'DELETED', label: 'Удалён' },
  ];
  readonly tableColumns: readonly TableColumn[] = [
    { key: 'name', label: 'Пользователь', width: 270, required: true, className: 'entity-cell' },
    { key: 'status', label: 'Состояние', width: 190 },
    { key: 'browserCount', label: 'Браузеры', width: 230, className: 'entity-cell' },
    { key: 'waitingCount', label: 'Ожидающие задачи', width: 220, className: 'entity-cell' },
    { key: 'lastAccessAt', label: 'Последнее обращение', width: 190 },
    { key: 'actions', label: 'Открыть пользователя', width: 58, action: true },
  ];
  readonly table = inject(TableViews).create(
    () => (this.overview ? 'admin-overview-users' : 'admin-users'),
    this.tableColumns,
    this.query,
  );
  constructor() {
    if (this.overview) void this.loadSummary();
    effect(() => {
      this.filterKey();
      untracked(() => void this.load());
    });
    inject(LiveEvents)
      .watch(['admin-user', 'admin-operation'])
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        void this.load();
        if (this.overview) void this.loadSummary();
      });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
      this.summaryGeneration++;
    });
  }
  returnUrl() {
    return this.router.url;
  }
  toggleFlag(flag: string) {
    const selected = this.query.values('flag');
    this.query.set({
      flag: selected.includes(flag)
        ? selected.filter((value) => value !== flag)
        : [...selected, flag],
    });
  }
  async loadSummary() {
    const generation = ++this.summaryGeneration;
    try {
      const value = await this.api.get('/api/admin/users/summary', adminSummarySchema);
      if (generation === this.summaryGeneration) {
        this.summary.set(value);
        this.summaryError.set('');
      }
    } catch (error: unknown) {
      if (generation === this.summaryGeneration) this.summaryError.set(errorMessage(error));
    }
  }
  async load() {
    const generation = ++this.generation;
    try {
      const data = await this.api.get('/api/admin/users', pageSchema(adminUserSchema), {
        search: this.query.text('search'),
        status: this.query.values('status'),
        flag: this.query.values('flag'),
        page: this.query.number('page', 1),
        pageSize: this.query.number('pageSize', 5),
        sort: this.query.text('sort', this.defaultSort),
        direction: this.table.direction(this.defaultDirection),
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
