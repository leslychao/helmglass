import { TableViews } from '../shared/table-view';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { Page, adminDetailSchema, auditSchema, pageSchema } from '../core/models';
import { Dialog } from '../shared/dialog';
import { Icon } from '../shared/icon';
import { QueryState } from '../shared/query-state';
import { Pager } from '../shared/ui';
import { AdminAuditTable, adminActionLabel, auditColumns } from './audit-table';
export { adminActionLabel } from './audit-table';

@Component({
  selector: 'hg-audit',
  imports: [Icon, RouterLink, Pager, AdminAuditTable],
  providers: [QueryState],
  template: `
    @if (!overview()) { <h1 class="sr-only">Журнал действий</h1> }
    <section class="card table-card">
      <div class="section-heading padded">
        <h2>Журнал действий</h2>
        <button class="button quiet small" aria-haspopup="dialog" (click)="filters()">
          <hg-icon name="filter" />Поиск и фильтры
        </button>
      </div>
      @if (query.text('user')) {
        <div class="admin-filter-feedback">
          Пользователь: {{ userName() || query.text('user') }}
          <a class="text-button" routerLink="/admin/audit">Весь журнал</a>
        </div>
      }
      @if (query.text('auditSearch') || query.values('auditAction').length) {
        <div class="admin-filter-feedback">
          @if (query.text('auditSearch')) {
            <span class="chip">Поиск: {{ query.text('auditSearch') }}</span>
          }
          @for (action of query.values('auditAction'); track action) {
            <span class="chip">{{ actionLabel(action) }}</span>
          }
          <button
            class="text-button"
            (click)="query.clearFilters(['auditSearch', 'auditAction'], 'auditPage')"
          >
            Сбросить
          </button>
        </div>
      }
      @if (error()) {
        <div class="error-banner" role="alert">
          {{ error() }}<button class="text-button" (click)="load()">Повторить</button>
        </div>
      }
      @if (data(); as page) {
        <hg-admin-audit-table [items]="page.items" [view]="table" [returnUrl]="returnUrl()" />
        <hg-pager
          [page]="page.page"
          [size]="page.pageSize"
          [total]="page.total"
          (pageChange)="query.set({ auditPage: $event }, false)"
          (sizeChange)="query.set({ auditPageSize: $event, auditPage: null }, false)"
        />
      } @else if (!error()) {
        <div class="loading" role="status">Загружаем журнал…</div>
      }
    </section>
  `,
})
export class Audit {
  readonly actionLabel = adminActionLabel;
  readonly query = inject(QueryState);
  readonly overview = input(false);
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private readonly router = inject(Router);
  private generation = 0;
  private nameOwner = '';
  readonly data = signal<Page<z.infer<typeof auditSchema>> | null>(null);
  readonly userName = signal('');
  readonly error = signal('');
  private readonly filterKey = computed(() =>
    [
      'user',
      'auditSearch',
      'auditAction',
      'auditStatus',
      'auditFrom',
      'auditTo',
      'auditPage',
      'auditPageSize',
      'auditSort',
      'auditDirection',
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
    'PAUSE_ADMISSION',
    'RESUME_ADMISSION',
    'PURGE',
  ].map((value) => ({ value, label: adminActionLabel(value) }));
  readonly table = inject(TableViews).create(
    () => 'audit:' + this.query.text('user'),
    auditColumns,
    this.query,
    { sort: 'auditSort', direction: 'auditDirection', page: 'auditPage', size: 'auditPageSize' },
  );
  constructor() {
    effect(() => {
      this.filterKey();
      this.overview();
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
  returnUrl() {
    return this.router.url;
  }
  async load() {
    const generation = ++this.generation;
    const user = this.query.text('user');
    try {
      const [data, detail] = await Promise.all([
        this.api.get('/api/admin/audit', pageSchema(auditSchema), {
          user,
          search: this.query.text('auditSearch'),
          action: this.query.values('auditAction'),
          status: this.query.values('auditStatus'),
          from: this.query.text('auditFrom'),
          to: this.query.text('auditTo'),
          sort: this.query.text('auditSort', 'createdAt'),
          direction: this.table.direction('desc'),
          page: this.query.number('auditPage', 1),
          pageSize: this.query.number('auditPageSize', 5),
        }),
        user && this.nameOwner !== user
          ? this.api.get('/api/admin/users/' + user, adminDetailSchema)
          : Promise.resolve(null),
      ]);
      if (generation !== this.generation) return;
      this.data.set(data);
      this.error.set('');
      if (detail) {
        this.userName.set(detail.user.name);
        this.nameOwner = user;
      }
      if (!user) {
        this.userName.set('');
        this.nameOwner = '';
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    }
  }
  async filters() {
    const values = await this.dialog.ask('Поиск и фильтры журнала', '', 'Применить', [
      {
        key: 'search',
        label: 'Поиск',
        placeholder: 'Имя, причина, название узла или ID',
        value: this.query.text('auditSearch'),
        max: 300,
      },
      {
        key: 'action',
        label: 'Действие',
        type: 'select',
        value: this.query.text('auditAction'),
        options: [{ value: '', label: 'Все действия' }, ...this.actions],
      },
    ]);
    if (!values) return;
    this.dialog.complete(values);
    this.query.set(
      {
        auditSearch: values['search'] || null,
        auditAction: values['action'] || null,
        auditStatus: null,
        auditFrom: null,
        auditTo: null,
        auditPage: null,
      },
      false,
    );
  }
}
