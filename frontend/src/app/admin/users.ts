import * as z from 'zod/mini';
import { Audit } from './audit';
import { Icon } from '../shared/icon';
import { SearchInput } from '../shared/search-input';
import { DatePipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { AdminUser, Page, adminUserSchema, pageSchema } from '../core/models';
import { MultiFilter } from '../shared/multi-filter';
import { QueryState } from '../shared/query-state';
import { Empty, Pager, Status } from '../shared/ui';

const adminSummarySchema = z.object({
  users: z.number(),
  blocked: z.number(),
  waitingTasks: z.number(),
});

@Component({
  selector: 'hg-admin-users',
  imports: [
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
  ],
  providers: [QueryState],
  template: ` <section class="admin-summary" aria-label="Сводка администрирования">
      <div class="admin-summary-card">
        <span class="metric-mark blue"><hg-icon name="user" /></span>
        <div>
          <small>Пользователей</small><strong>{{ summary()?.users ?? '—' }}</strong
          ><span>Без удалённых аккаунтов</span>
        </div>
      </div>
      <div class="admin-summary-card">
        <span class="metric-mark blue"><hg-icon name="lock" /></span>
        <div>
          <small>Заблокировано</small><strong>{{ summary()?.blocked ?? '—' }}</strong
          ><span>Пользователи с закрытым доступом</span>
        </div>
      </div>
      <div class="admin-summary-card">
        <span class="metric-mark blue"><hg-icon name="clock" /></span>
        <div>
          <small>Ожидающих задач</small><strong>{{ summary()?.waitingTasks ?? '—' }}</strong
          ><span>Очередь, ChatGPT или участие пользователя</span>
        </div>
      </div>
    </section>
    @if (summaryError()) {
      <div class="error-banner" role="alert">
        {{ summaryError() }}<button class="text-button" (click)="loadSummary()">Повторить</button>
      </div>
    }
    <section class="card table-card">
      <div class="section-heading padded"><h2>Пользователи</h2></div>
      <div class="toolbar">
        <label class="search"
          ><hg-icon name="search" /><input
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
            <table class="admin-users-table">
              <thead>
                <tr>
                  <th [attr.aria-sort]="query.ariaSort('name', 'lastAccessAt')">
                    <button (click)="query.sort('name', 'lastAccessAt')">
                      Пользователь <hg-icon name="chevron-down" />
                    </button>
                  </th>
                  <th>Состояние</th>
                  <th>Браузеры</th>
                  <th>Ожидающие задачи</th>
                  <th [attr.aria-sort]="query.ariaSort('lastAccessAt', 'lastAccessAt')">
                    <button (click)="query.sort('lastAccessAt', 'lastAccessAt')">
                      Последний вход <hg-icon name="chevron-down" />
                    </button>
                  </th>
                  <th><span class="sr-only">Открыть пользователя</span></th>
                </tr>
              </thead>
              <tbody>
                @for (user of page.items; track user.id) {
                  <tr>
                    <td>
                      <a
                        class="admin-user-cell"
                        [routerLink]="['/admin/users', user.id]"
                        [queryParams]="{ back: query.context() }"
                        ><span class="user-initial">{{ user.name.slice(0, 1).toUpperCase() }}</span
                        ><span
                          ><strong>{{ user.name }}</strong
                          ><small>{{ user.email }}</small></span
                        ></a
                      >
                    </td>
                    <td>
                      <hg-status [value]="user.status" />
                      @if (user.pendingOperations) {
                        <small class="warning-text"
                          >{{ user.pendingOperations }} незавершённых</small
                        >
                      }
                    </td>
                    <td>
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
                    </td>
                    <td>
                      <div
                        class="admin-quota-cell"
                        [class.over-limit]="
                          user.waitingLimit !== null && user.waitingCount > user.waitingLimit
                        "
                      >
                        <strong>Ожидают: {{ user.waitingCount }}</strong
                        ><small>{{
                          user.waitingLimit === null
                            ? 'Лимит не задан'
                            : 'Лимит: ' + user.waitingLimit
                        }}</small>
                        @if (user.waitingLimit !== null && user.waitingLimit > 0) {
                          <span class="quota-bar"
                            ><i
                              [style.width.%]="
                                Math.min(100, (user.waitingCount / user.waitingLimit) * 100)
                              "
                            ></i
                          ></span>
                        }
                      </div>
                    </td>
                    <td>
                      {{ user.lastAccessAt ? (user.lastAccessAt | date: 'dd.MM.yyyy HH:mm') : '—' }}
                    </td>
                    <td>
                      <a
                        class="icon-button"
                        [routerLink]="['/admin/users', user.id]"
                        [queryParams]="{ back: query.context() }"
                        aria-label="Открыть пользователя"
                        title="Открыть пользователя"
                        ><hg-icon name="chevron-right"
                      /></a>
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
    </section>
    <hg-audit #auditSection id="admin-audit" />
    <p class="admin-privacy-note">
      Только служебные сведения. Содержимое задач, результаты, документы и секреты пользователей
      здесь недоступны. Административные действия выполняются только из веб-кабинета, не через MCP.
    </p>`,
})
export class AdminUsers {
  readonly Math = Math;
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private generation = 0;
  readonly data = signal<Page<AdminUser> | null>(null);
  readonly error = signal('');
  readonly summary = signal<z.infer<typeof adminSummarySchema> | null>(null);
  readonly summaryError = signal('');
  private summaryGeneration = 0;
  private readonly auditSection = viewChild<ElementRef<HTMLElement>>('auditSection', {
    read: ElementRef,
  });
  private readonly audit = viewChild(Audit);
  private auditSectionOpened = false;
  private readonly section = computed(() => this.query.text('section'));
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
  readonly flags = [
    { id: 'waiting', label: 'Есть ожидающие задачи' },
    { id: 'pending', label: 'Есть незавершённые операции' },
  ];
  constructor() {
    void this.loadSummary();
    afterRenderEffect(() => {
      if (this.section() !== 'audit') {
        this.auditSectionOpened = false;
        return;
      }
      if (this.data() && this.audit()?.data() && !this.auditSectionOpened) {
        this.auditSection()?.nativeElement.scrollIntoView({ block: 'start' });
        this.auditSectionOpened = true;
      }
    });
    effect(() => {
      this.filterKey();
      untracked(() => void this.load());
    });
    inject(LiveEvents)
      .watch(['admin-user', 'admin-operation'])
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        void this.load();
        void this.loadSummary();
      });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
      this.summaryGeneration++;
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
