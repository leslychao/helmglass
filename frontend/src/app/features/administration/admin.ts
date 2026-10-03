import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AdminOverview as OverviewDto,
  AdminTask,
  AdminUser as UserDto,
  AuditEntry,
  Page,
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
import { auditColumns, auditRows, browserAssignment } from './admin-tables';
import { AdminUsage } from './admin-usage';
import { AdminUsers } from './admin-users';
import { AdminAudit } from './admin-audit';

@Component({
  selector: 'hg-admin-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<nav class="a-admin-nav" aria-label="Администрирование">
    <div class="a-admin-tabs">
      <a class="a-admin-tab" routerLink="/admin" [class.active]="!browsers.isActive"
        [attr.aria-current]="!browsers.isActive ? 'page' : null"><hg-icon name="user" />Пользователи и журнал</a>
      <a class="a-admin-tab" routerLink="/admin/browsers" routerLinkActive="active"
        #browsers="routerLinkActive" ariaCurrentWhenActive="page"><hg-icon name="browser" />Браузеры</a>
    </div>
  </nav><section class="a-admin-page"><router-outlet /></section>`,
})
export class AdminShell {}

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

export { AdminUsers } from './admin-users';
export { AdminAudit } from './admin-audit';

@Component({
  selector: 'hg-admin-overview',
  imports: [AdminUsers, AdminAudit, Feedback, Metric, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<h1 class="sr-only" tabindex="-1">Администрирование</h1>
    <hg-feedback [loading]="overview.loading()" [error]="overview.error()" (retry)="overview.refresh()" />
    @if (overview.data(); as overview) {
      <div class="metrics a-user-summary">
        <hg-metric label="Пользователей" [value]="overview.totalUsers" icon="user" caption="Без удалённых аккаунтов" />
        <hg-metric label="Заблокировано" [value]="overview.blockedUsers" icon="lock" caption="Пользователи с закрытым доступом" />
        <hg-metric label="Ожидающих задач" [value]="overview.waitingTasks" icon="clock" caption="Очередь, ChatGPT или участие пользователя" />
      </div>
    }
    <hg-admin-users /><hg-admin-audit />
    <p class="privacy-note"><hg-icon name="lock" />Только служебные сведения. Содержимое задач, результаты, документы и секреты пользователей здесь недоступны.</p>`,
})
export class AdminOverview {
  readonly overview = new ServerResource<OverviewDto>(['nodes', 'sessions', 'users', 'tasks', 'operations']);
  constructor() { this.overview.load('/admin/overview'); }
}

export { AdminBrowsers } from './admin-browsers';
