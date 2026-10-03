import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import {
  AdminOverview as OverviewDto,
  AdminTask,
  AdminUser as UserDto,
  AdminUserListItem,
  AuditEntry,
  BrowserPool,
  Page,
  Worker,
} from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { Mutation } from '../../core/api/mutation';
import { Identity } from '../../core/identity/identity.service';
import { TableQuery } from '../../shared/data-table/table-query';
import { Column, DataTable, TableItem } from '../../shared/data-table/data-table';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Dialog } from '../../shared/dialog/dialog';
import { Icon } from '../../shared/icon/icon';
import { Status, LabelPipe } from '../../shared/status/status';
import { AsyncOperation } from '../../shared/async-operation/async-operation';
import { Metric } from '../../shared/metric/metric';
import { AdminCleanup } from './admin-cleanup';
import { auditColumns, auditRows, browserAssignment, userColumns, userRows } from './admin-tables';
import { AdminUsage } from './admin-usage';

@Component({
  selector: 'hg-admin-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<nav class="a-admin-nav" aria-label="Администрирование">
      <div class="a-admin-tabs">
        @for (tab of tabs; track tab.path) {
          <a
            class="a-admin-tab"
            [routerLink]="tab.path"
            routerLinkActive="active"
            [routerLinkActiveOptions]="{ exact: tab.path === '/admin' }"
            ariaCurrentWhenActive="page"
            ><hg-icon [name]="tab.icon" />{{ tab.label }}</a
          >
        }
      </div>
    </nav>
    <section class="a-admin-page"><router-outlet /></section>`,
})
export class AdminShell {
  readonly tabs = [
    { path: '/admin', label: 'Обзор', icon: 'chart' },
    { path: '/admin/users', label: 'Пользователи', icon: 'user' },
    { path: '/admin/browsers', label: 'Браузеры', icon: 'browser' },
    { path: '/admin/audit', label: 'Журнал', icon: 'history' },
  ];
}

@Component({
  selector: 'hg-admin-overview',
  styles: `
    .a-platform-flags {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
    }
    .a-platform-flags .badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-weight: 400;
    }
    .a-platform-flags .small {
      margin-left: auto;
    }
  `,
  imports: [
    RouterLink,
    DatePipe,
    Feedback,
    Dialog,
    FormsModule,
    MutationFeedback,
    AsyncOperation,
    Metric,
    DataTable,
    Icon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="heading">
      <h1 tabindex="-1">Обзор платформы</h1>
      @if (overview.data(); as overview) {
        <button
          class="btn"
          [disabled]="action.pending() || action.unknown()"
          (click)="reasonOpen.set(true)"
        >
          <hg-icon [name]="overview.acceptingAllocations ? 'pause' : 'play'" />
          {{
            overview.acceptingAllocations
              ? 'Приостановить новые запуски'
              : 'Разрешить новые запуски'
          }}
        </button>
      }
    </header>
    <hg-feedback
      [loading]="overview.loading()"
      [error]="overview.error()"
      (retry)="overview.refresh()"
    />
    @if (overview.data(); as overview) {
      <div class="metrics a-admin-summary">
        <hg-metric
          label="Занято браузеров"
          [value]="overview.confirmedBusy"
          icon="browser"
          [caption]="
            overview.unconfirmedOccupied
              ? 'Ещё ' + overview.unconfirmedOccupied + ': состояние уточняется'
              : 'Подтверждённые сессии'
          "
        />
        <hg-metric
          label="Свободно браузеров"
          [value]="overview.allocatableFree"
          icon="server"
          tone="green"
          [caption]="
            overview.acceptingAllocations
              ? 'На узлах, принимающих задачи'
              : 'Новые назначения приостановлены'
          "
        />
        <hg-metric
          label="Ожидают задачи"
          [value]="overview.waitingTasks"
          icon="clock"
          [caption]="'Из них в очереди за браузером: ' + overview.queuedForBrowser"
        />
        <hg-metric
          label="Заблокировано"
          [value]="overview.blockedUsers"
          icon="lock"
          caption="Пользователи без доступа"
        />
      </div>
      <div class="a-platform-flags">
        <a class="badge" routerLink="/admin/browsers"
          ><hg-icon name="server" />Недоступно узлов: {{ overview.unavailableWorkers }}</a
        >
        <span class="badge"
          ><hg-icon name="clock" />Незавершённых операций: {{ overview.pendingOperations }}</span
        >
        <span class="small muted"
          >Данные на {{ overview.observedAt | date: 'dd.MM HH:mm:ss' }}</span
        >
      </div>
    }
    <section class="panel a-section">
      <header class="a-section-header">
        <h2>Нагрузка по пользователям</h2>
        <a class="btn quiet" routerLink="/admin/users">Все пользователи</a>
      </header>
      <hg-feedback [loading]="users.loading()" [error]="users.error()" (retry)="users.refresh()" />
      <hg-data-table
        [columns]="userColumns"
        [rows]="userRows()"
        [page]="users.data()"
        [sizes]="[5, 10, 20, 50]"
        (changed)="usersQuery.change($event)"
      />
    </section>
    <section class="panel a-section">
      <header class="a-section-header">
        <h2>Последние действия</h2>
        <a class="btn quiet" routerLink="/admin/audit">Весь журнал</a>
      </header>
      <hg-feedback [loading]="audit.loading()" [error]="audit.error()" (retry)="audit.refresh()" />
      <hg-data-table
        [columns]="auditColumns"
        [rows]="auditRows()"
        [page]="audit.data()"
        [sizes]="[3, 10, 20, 50]"
        (changed)="auditQuery.change($event)"
        emptyTitle="Записей нет"
        emptyText="Административные действия появятся здесь."
      />
    </section>
    <p class="privacy-note">
      <hg-icon name="lock" />Только служебные сведения. Содержимое задач, результаты, документы и
      секреты пользователей здесь недоступны.
    </p>
    @if (action.receipt()?.operationId; as operation) {
      <hg-operation [id]="operation" />
    }
    @if (reasonOpen()) {
      <hg-dialog
        title="Изменить приём браузеров"
        [busy]="action.pending()"
        (closed)="reasonOpen.set(false)"
        ><p>Изменение не завершает работающие браузеры.</p>
        <label class="field"
          >Причина<textarea [(ngModel)]="reason" maxlength="1000" required></textarea></label
        ><hg-mutation [action]="action" /><button
          dialog-actions
          class="btn primary"
          [disabled]="!reason.trim() || action.pending() || action.unknown()"
          (click)="save()"
        >
          Применить
        </button></hg-dialog
      >
    }`,
})
export class AdminOverview {
  readonly usersQuery = new TableQuery({ prefix: 'users', pageSize: 5 });
  readonly auditQuery = new TableQuery({ prefix: 'audit', pageSize: 3 });
  readonly users = new ServerResource<Page<AdminUserListItem>>(['users', 'sessions', 'tasks']);
  readonly audit = new ServerResource<Page<AuditEntry>>(['audit']);
  readonly userColumns = userColumns;
  readonly auditColumns = auditColumns;
  readonly userRows = computed(() => userRows(this.users.data()?.items ?? []));
  readonly auditRows = computed(() => auditRows(this.audit.data()?.items ?? []));
  readonly overview = new ServerResource<OverviewDto>([
    'nodes',
    'sessions',
    'users',
    'tasks',
    'operations',
  ]);
  readonly action = new Mutation();
  readonly reasonOpen = signal(false);
  reason = '';
  constructor() {
    this.overview.load('/admin/overview');
    effect(() => this.users.load('/admin/users', this.usersQuery.value()));
    effect(() => this.audit.load('/admin/audit', this.auditQuery.value()));
  }
  save() {
    const overview = this.overview.data();
    if (!overview) return;
    this.action.run(
      'PATCH',
      '/admin/platform/admission',
      {
        acceptingAllocations: !overview.acceptingAllocations,
        expectedVersion: overview.version,
        reason: this.reason.trim(),
      },
      () => {
        this.reasonOpen.set(false);
        this.reason = '';
        this.overview.refresh();
      },
    );
  }
}

@Component({
  selector: 'hg-admin-users',
  imports: [DataTable, Feedback, Icon, ReactiveFormsModule, LabelPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="heading"><h1 tabindex="-1">Пользователи</h1></header>
    <section class="panel a-section">
      <div class="h-toolbar">
        <label class="search h-search"
          ><hg-icon name="search" /><input
            type="search"
            [formControl]="search"
            placeholder="Имя, email или ID"
            aria-label="Поиск пользователей" /></label
        ><select
          aria-label="Состояние аккаунта"
          [value]="query.text('accountState')"
          (change)="filter($event)"
        >
          <option value="">Все состояния</option>
          @for (state of states; track state) {
            <option [value]="state">{{ state | label }}</option>
          }</select
        ><button class="btn quiet" (click)="query.clear()">Сбросить фильтры</button>
      </div>
      <hg-feedback
        [loading]="users.loading()"
        [error]="users.error()"
        (retry)="users.refresh()"
      /><hg-data-table
        [columns]="columns"
        [rows]="rows()"
        [page]="users.data()"
        (changed)="query.change($event)"
      />
    </section>
    <p class="privacy-note">
      <hg-icon name="lock" />Администратору доступны служебные сведения, без содержания задач и
      секретов пользователей.
    </p>`,
})
export class AdminUsers {
  readonly query = new TableQuery();
  readonly users = new ServerResource<Page<AdminUserListItem>>(['users']);
  readonly search = new FormControl(this.query.text('q'), { nonNullable: true });
  readonly states = ['ACTIVE', 'BLOCKED', 'DELETING'];
  readonly columns = userColumns;
  readonly rows = computed(() => userRows(this.users.data()?.items ?? []));
  constructor() {
    effect(() => {
      this.users.load('/admin/users', this.query.value());
      this.search.setValue(this.query.text('q'), { emitEvent: false });
    });
    this.search.valueChanges
      .pipe(debounceTime(250), distinctUntilChanged(), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((q) => this.query.filter({ q: q || null }));
  }
  filter(event: Event) {
    if (event.target instanceof HTMLSelectElement)
      this.query.filter({ accountState: event.target.value || null });
  }
}

interface AdminIntent {
  title: string;
  path: string;
  method: 'POST' | 'PATCH';
  body: Readonly<Record<string, unknown>>;
  danger: boolean;
}
@Component({
  selector: 'hg-admin-user',
  imports: [
    AdminCleanup,
    RouterLink,
    DatePipe,
    FormsModule,
    DataTable,
    Feedback,
    MutationFeedback,
    Dialog,
    Icon,
    Status,
    AdminUsage,
    AsyncOperation,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<hg-feedback
      [loading]="user.loading()"
      [error]="user.error()"
      (retry)="user.refresh()"
    />
    @if (user.data(); as user) {
      <header class="a-user-head">
        <span class="avatar">{{ user.displayName.slice(0, 2).toUpperCase() }}</span>
        <div class="a-user-title">
          <h1 tabindex="-1">{{ user.displayName }}</h1>
          <p class="description">
            {{ user.email }} · {{ user.id }}
            @if (isSelf()) {
              <span class="badge">Это вы</span>
            }
          </p>
        </div>
        <div class="a-user-actions">
          @if (user.accountState !== 'DELETED') {
            <button class="btn" (click)="start('stop-all', 'Остановить все задачи', true)">
              Остановить задачи
            </button>
          }
          @if (!isSelf() && user.accountState === 'ACTIVE') {
            <button class="btn danger" (click)="start('block', 'Заблокировать пользователя', true)">
              Заблокировать
            </button>
          }
          @if (!isSelf() && user.accountState === 'BLOCKED') {
            <button class="btn" (click)="start('unblock', 'Разблокировать пользователя')">
              Разблокировать
            </button>
          }
          @if (!isSelf() && !['DELETING', 'DELETED', 'PURGING'].includes(user.accountState)) {
            <button
              class="btn danger"
              (click)="start('deletion-requests', 'Удалить аккаунт через 7 суток', true)"
            >
              Удалить
            </button>
          }
        </div>
      </header>
      <div class="a-user-facts">
        <hg-status [value]="user.accountState" /><span
          >Последнее обращение: {{ user.lastActivityAt | date: 'dd.MM.yyyy HH:mm' }}</span
        >
      </div>
      @if (user.deletionRequestId && user.accountState === 'DELETING') {
        <section class="notice warning">
          <strong>Аккаунт ожидает удаления</strong>
          <p>
            Доступ закрыт. Отменить удаление можно до
            {{ user.deletionDeadline | date: 'dd.MM.yyyy HH:mm' }}. После истечения срока начинается
            необратимая очистка.
          </p>
          <button class="btn" (click)="restore()">Отменить удаление</button>
        </section>
      }
      @if (user.purgeOperationId) {
        <hg-admin-cleanup [id]="user.purgeOperationId" />
      }
      <div class="a-user-grid">
        <section class="panel live7-quotas">
          <header class="panel-head">
            <h2>Квоты и текущая нагрузка</h2>
            @if (user.limits && !['DELETED', 'PURGING'].includes(user.accountState)) {
              <button class="btn quiet" (click)="editLimits()">Изменить лимиты</button>
            }
          </header>
          @if (user.limits; as limits) {
            <div class="a-quota-row">
              <div>
                <strong>Одновременные браузеры</strong>
                <p>
                  Назначено: {{ browserAssignment(limits) }}
                  @if (limits.personalBrowserLimit !== null) {
                    <br />Личное ограничение: {{ limits.personalBrowserLimit }}
                  }
                </p>
              </div>
              <div>
                <span class="a-big-use">{{ user.occupiedBrowsers }}</span>
                <span class="muted"> / {{ limits.quotas.effectiveBrowserLimit ?? 'пул' }}</span>
              </div>
            </div>
            <div class="a-quota-row">
              <div>
                <strong>Подготовленные задачи в ожидании</strong>
                <p>
                  Назначено: {{ limits.quotas.assignedQueuedLimit ?? 'без ограничения' }}
                  @if (limits.personalQueuedLimit !== null) {
                    <br />Личное ограничение: {{ limits.personalQueuedLimit }}
                  }
                </p>
              </div>
              <div>
                <span class="a-big-use">{{ user.queuedTasks }}</span>
                <span class="muted"> / {{ limits.quotas.effectiveQueuedLimit ?? '∞' }}</span>
              </div>
            </div>
            <div class="a-effective-note">
              @if (
                limits.quotas.effectiveBrowserLimit !== null &&
                user.occupiedBrowsers > limits.quotas.effectiveBrowserLimit
              ) {
                <strong>Новый предел ниже текущего числа браузеров.</strong>
                Они не прерываются; новые сессии ждут освобождения.<br />
              }
              @if (
                limits.quotas.effectiveQueuedLimit !== null &&
                user.queuedTasks > limits.quotas.effectiveQueuedLimit
              ) {
                <strong>Число принятых ожидающих задач выше нового предела.</strong>
                Они сохранены, новые не принимаются до освобождения квоты.<br />
              }
              Очередь, ожидание агента и действий пользователя учитываются вместе. Черновики не
              учитываются. Весь пул не даёт приоритета.
            </div>
          } @else {
            <p class="panel-body muted">Квоты удалены вместе с аккаунтом.</p>
          }
        </section>
        <hg-admin-usage [userId]="user.id" />
      </div>
      <section class="panel">
        <header class="panel-head">
          <h2>Последние задачи</h2>
          <small>Не более 50 · только служебные сведения</small>
        </header>
        <hg-feedback
          [loading]="tasks.loading()"
          [error]="tasks.error()"
          (retry)="tasks.refresh()"
        /><hg-data-table
          [columns]="taskColumns"
          [rows]="taskRows()"
          [page]="tasks.data()"
          [sizes]="[10, 20, 50]"
          (changed)="tasksQuery.change($event)"
          [actions]="true"
          (action)="stopTask($event)"
          emptyTitle="Задач нет"
          emptyText="Служебные сведения появятся после создания задач."
        />
      </section>
      <section class="panel a-section">
        <header class="a-section-header">
          <h2>Действия с пользователем</h2>
          <a class="btn quiet" [routerLink]="'/admin/users/' + user.id + '/audit'"
            >Весь журнал пользователя</a
          >
        </header>
        <hg-feedback
          [loading]="audit.loading()"
          [error]="audit.error()"
          (retry)="audit.refresh()"
        />
        <hg-data-table
          [columns]="auditColumns"
          [rows]="auditRows()"
          [page]="audit.data()"
          [sizes]="[5, 10, 20, 50]"
          (changed)="auditQuery.change($event)"
          emptyTitle="Записей нет"
          emptyText="Административные действия появятся здесь."
        />
      </section>
      <p class="privacy-note">
        <hg-icon name="lock" />Содержание поручений, результаты, cookies и медиа недоступны
        администратору.
      </p>
    }
    @if (action.receipt()?.operationId; as operation) {
      <hg-operation [id]="operation" />
    }
    @if (intent(); as intent) {
      <hg-dialog [title]="intent.title" [busy]="action.pending()" (closed)="closeIntent()">
        @if (limitsOpen()) {
          <fieldset>
            <legend>Лимит браузеров</legend>
            <select aria-label="Режим лимита браузеров" [(ngModel)]="browserMode">
              <option value="STANDARD">Стандартный</option>
              <option value="CUSTOM">Заданный</option>
              <option value="POOL">Весь пул</option>
            </select>
            @if (browserMode === 'CUSTOM') {
              <label class="field"
                >Браузеров<input type="number" min="1" [(ngModel)]="browserLimit"
              /></label>
            }
          </fieldset>
          <fieldset>
            <legend>Задачи в очереди</legend>
            <select aria-label="Режим лимита очереди" [(ngModel)]="queueMode">
              <option value="UNLIMITED">Без ограничения</option>
              <option value="CUSTOM">Заданный</option>
            </select>
            @if (queueMode === 'CUSTOM') {
              <label class="field"
                >Задач<input type="number" min="0" [(ngModel)]="queueLimit"
              /></label>
            }
          </fieldset>
          <p class="small muted">
            Снижение лимита запрещает новые выделения сверх квоты, но не завершает текущие браузеры.
          </p>
        }
        <label class="field"
          >Причина<textarea
            [(ngModel)]="reason"
            maxlength="1000"
            required
            placeholder="Укажите причину действия"
          ></textarea></label
        ><hg-mutation [action]="action" />
        <div dialog-actions class="flex">
          <button class="btn" [disabled]="action.pending()" (click)="closeIntent()">Отмена</button
          ><button
            class="btn"
            [class.danger]="intent.danger"
            [class.primary]="!intent.danger"
            [disabled]="!reason.trim() || action.pending() || action.unknown()"
            (click)="apply()"
          >
            Подтвердить
          </button>
        </div></hg-dialog
      >
    } `,
})
export class AdminUser {
  readonly browserAssignment = browserAssignment;
  readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';
  readonly user = new ServerResource<UserDto>(['users']);
  readonly audit = new ServerResource<Page<AuditEntry>>(['audit']);
  readonly auditQuery = new TableQuery({ prefix: 'audit', pageSize: 5 });
  readonly auditColumns = auditColumns;
  readonly auditRows = computed(() => auditRows(this.audit.data()?.items ?? []));
  readonly tasks = new ServerResource<Page<AdminTask>>(['userTasks']);
  readonly tasksQuery = new TableQuery({ prefix: 'tasks' });
  readonly action = new Mutation();
  readonly intent = signal<AdminIntent | null>(null);
  readonly limitsOpen = signal(false);
  private identity = inject(Identity);
  readonly isSelf = computed(() => this.identity.me()?.id === this.id);
  reason = '';
  browserMode = 'STANDARD';
  browserLimit: number | null = null;
  queueMode = 'UNLIMITED';
  queueLimit: number | null = null;
  readonly taskColumns: Column[] = [
    { key: 'id', title: 'ID задачи', sort: 'id' },
    { key: 'state', title: 'Состояние', sort: 'state' },
    { key: 'reason', title: 'Причина ожидания / код ошибки' },
    { key: 'created', title: 'Создана', sort: 'createdAt' },
  ];
  readonly taskRows = computed<TableItem[]>(
    () =>
      this.tasks.data()?.items.map((task) => ({
        id: task.id,
        values: {
          id: task.id,
          state: new LabelPipe().transform(task.state),
          reason: task.waitReason || task.failureCode || '—',
          created: new Date(task.createdAt).toLocaleString('ru-RU'),
        },
      })) ?? [],
  );
  constructor() {
    this.user.load('/admin/users/' + this.id);
    effect(() => this.tasks.load(`/admin/users/${this.id}/tasks`, this.tasksQuery.value()));
    effect(() => this.audit.load(`/admin/users/${this.id}/audit`, this.auditQuery.value()));
  }
  start(path: string, title: string, danger = false) {
    this.limitsOpen.set(false);
    this.reason = '';
    this.intent.set({
      title,
      path: `/admin/users/${this.id}/${path}`,
      method: 'POST',
      body: path === 'stop-all' ? {} : { expectedVersion: this.user.data()?.version },
      danger,
    });
  }
  restore() {
    const user = this.user.data();
    if (!user?.deletionRequestId) return;
    this.limitsOpen.set(false);
    this.reason = '';
    this.intent.set({
      title: 'Отменить удаление',
      path: `/admin/deletion-requests/${user.deletionRequestId}/cancel`,
      method: 'POST',
      body: { expectedVersion: user.deletionRequestVersion },
      danger: false,
    });
  }
  editLimits() {
    const user = this.user.data();
    if (!user?.limits) return;
    this.browserMode = user.limits.browserMode;
    this.browserLimit = user.limits.browserCustom;
    this.queueMode = user.limits.queuedMode;
    this.queueLimit = user.limits.queuedCustom;
    this.reason = '';
    this.limitsOpen.set(true);
    this.intent.set({
      title: 'Изменить лимиты',
      path: `/admin/users/${this.id}/limits`,
      method: 'PATCH',
      body: { expectedVersion: user.limits.version },
      danger: false,
    });
  }
  stopTask(id: string) {
    this.limitsOpen.set(false);
    this.reason = '';
    this.intent.set({
      title: 'Остановить задачу ' + id,
      path: `/admin/tasks/${id}/stop`,
      method: 'POST',
      body: {},
      danger: true,
    });
  }
  closeIntent() {
    this.intent.set(null);
  }
  apply() {
    const intent = this.intent();
    if (!intent) return;
    const limits = this.limitsOpen()
      ? {
          browserMode: this.browserMode,
          browserCustom: this.browserMode === 'CUSTOM' ? this.browserLimit : null,
          queuedMode: this.queueMode,
          queuedCustom: this.queueMode === 'CUSTOM' ? this.queueLimit : null,
        }
      : {};
    this.action.run(
      intent.method,
      intent.path,
      { ...intent.body, ...limits, reason: this.reason.trim() },
      () => {
        this.intent.set(null);
        this.reason = '';
        this.user.refresh();
        this.tasks.refresh();
      },
    );
  }
}

@Component({
  selector: 'hg-admin-browsers',
  imports: [
    DatePipe,
    Feedback,
    MutationFeedback,
    Status,
    Dialog,
    FormsModule,
    Icon,
    DataTable,
    AsyncOperation,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="heading"><h1 tabindex="-1">Браузерный пул</h1></header>
    <hg-feedback [loading]="pool.loading()" [error]="pool.error()" (retry)="pool.refresh()" />
    @if (pool.data(); as pool) {
      <section class="panel">
        <header class="panel-head"><h2>Узлы исполнения</h2></header>
        @for (worker of pool.workers; track worker.id) {
          <article class="worker-row">
            <hg-icon name="browser" />
            <div>
              <h3>{{ worker.id }}</h3>
              <p class="small muted">
                Heartbeat: {{ worker.heartbeatAt | date: 'dd.MM HH:mm:ss' }}
              </p>
            </div>
            <hg-status [value]="worker.observedState" /><span
              >{{ occupied().get(worker.id) ?? 0 }} / {{ worker.capacity }}</span
            ><button class="btn" (click)="selected.set(worker); reason = ''">
              {{ worker.desiredMode === 'DRAINING' ? 'Вернуть в работу' : 'Вывести из работы' }}
            </button>
          </article>
        } @empty {
          <p class="panel-body muted">Узлы ещё не зарегистрированы.</p>
        }
      </section>
      <section class="panel">
        <header class="panel-head"><h2>Сессии браузеров</h2></header>
        <hg-data-table
          [columns]="columns"
          [rows]="rows()"
          [showEmpty]="true"
          emptyTitle="Нет активных сессий"
          emptyText="Сессии появляются после подтверждённого выделения браузера."
        />
      </section>
      <div class="notice neutral">
        <strong>Вывод узла из работы</strong>
        <p>
          Новые браузеры на узле не создаются. Существующие сессии продолжают работу до обычного
          завершения.
        </p>
      </div>
    }
    @if (action.receipt()?.operationId; as operation) {
      <hg-operation [id]="operation" />
    }
    @if (selected(); as worker) {
      <hg-dialog
        [title]="
          worker.desiredMode === 'DRAINING' ? 'Вернуть узел в работу' : 'Вывести узел из работы'
        "
        [busy]="action.pending()"
        (closed)="selected.set(null)"
        ><label class="field"
          >Причина<textarea [(ngModel)]="reason" maxlength="1000" required></textarea></label
        ><hg-mutation [action]="action" /><button
          dialog-actions
          class="btn primary"
          [disabled]="!reason.trim() || action.pending() || action.unknown()"
          (click)="apply()"
        >
          Применить
        </button></hg-dialog
      >
    }`,
})
export class AdminBrowsers {
  readonly occupied = computed(() => {
    const counts = new Map<string, number>();
    for (const item of this.pool.data()?.allocations ?? []) {
      counts.set(item.workerId, (counts.get(item.workerId) ?? 0) + 1);
    }
    return counts;
  });
  readonly pool = new ServerResource<BrowserPool>(['nodes', 'sessions']);
  readonly selected = signal<Worker | null>(null);
  readonly action = new Mutation();
  reason = '';
  readonly columns: Column[] = [
    { key: 'id', title: 'Сессия' },
    { key: 'user', title: 'Пользователь' },
    { key: 'worker', title: 'Узел' },
    { key: 'state', title: 'Состояние' },
  ];
  readonly rows = computed<TableItem[]>(
    () =>
      this.pool.data()?.allocations.map((session) => ({
        id: session.id,
        values: {
          id: session.sessionId,
          user: session.userId,
          worker: session.workerId,
          state: new LabelPipe().transform(session.state),
        },
      })) ?? [],
  );
  constructor() {
    this.pool.load('/admin/browsers');
  }
  apply() {
    const worker = this.selected();
    if (!worker) return;
    this.action.run(
      'POST',
      `/admin/workers/${worker.id}/${worker.desiredMode === 'DRAINING' ? 'enable' : 'drain'}`,
      { expectedVersion: worker.version, reason: this.reason.trim() },
      () => {
        this.selected.set(null);
        this.pool.refresh();
      },
    );
  }
}

@Component({
  selector: 'hg-admin-audit',
  imports: [ReactiveFormsModule, DataTable, Feedback, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="heading">
      <h1 tabindex="-1">{{ userId ? 'Журнал пользователя' : 'Журнал действий' }}</h1>
    </header>
    <section class="panel">
      <div class="table-toolbar">
        <label class="search"
          ><hg-icon name="search" /><input
            type="search"
            [formControl]="search"
            placeholder="Поиск по журналу"
            aria-label="Поиск по журналу" /></label
        ><button class="btn quiet" (click)="query.clear()">Сбросить фильтры</button>
      </div>
      <hg-feedback
        [loading]="audit.loading()"
        [error]="audit.error()"
        (retry)="audit.refresh()"
      /><hg-data-table
        [columns]="columns"
        [rows]="rows()"
        [page]="audit.data()"
        (changed)="query.change($event)"
        emptyTitle="Записей нет"
        emptyText="Изменения администраторов фиксируются с причиной и временем."
      />
    </section>`,
})
export class AdminAudit {
  readonly userId = inject(ActivatedRoute).snapshot.paramMap.get('id');
  readonly query = new TableQuery();
  readonly audit = new ServerResource<Page<AuditEntry>>(['audit']);
  readonly search = new FormControl(this.query.text('q'), { nonNullable: true });
  readonly columns = auditColumns;
  readonly rows = computed(() => auditRows(this.audit.data()?.items ?? []));
  constructor() {
    effect(() => {
      this.audit.load(
        this.userId ? `/admin/users/${this.userId}/audit` : '/admin/audit',
        this.query.value(),
      );
      this.search.setValue(this.query.text('q'), { emitEvent: false });
    });
    this.search.valueChanges
      .pipe(debounceTime(250), distinctUntilChanged(), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((q) => this.query.filter({ q: q || null }));
  }
}
