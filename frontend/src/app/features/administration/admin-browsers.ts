import { ChangeDetectionStrategy, Component, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminOverview, BrowserPool } from '../../core/api/models';
import { Mutation } from '../../core/api/mutation';
import { ServerResource } from '../../core/api/server-resource';
import { AsyncOperation } from '../../shared/async-operation/async-operation';
import { Column, DataTable, TableItem } from '../../shared/data-table/data-table';
import { TableQuery } from '../../shared/data-table/table-query';
import { Dialog } from '../../shared/dialog/dialog';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Icon } from '../../shared/icon/icon';
import { Metric } from '../../shared/metric/metric';
import { LabelPipe } from '../../shared/status/status';

interface BrowserIntent {
  title: string;
  explanation: string;
  method: 'POST' | 'PATCH';
  path: string;
  body: Readonly<Record<string, unknown>>;
}

@Component({
  selector: 'hg-admin-browsers',
  imports: [
    FormsModule,
    DataTable,
    Dialog,
    Feedback,
    MutationFeedback,
    Icon,
    Metric,
    AsyncOperation,
    LabelPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="heading">
      <div>
        <h1 tabindex="-1">Браузеры</h1>
        <p class="muted">Доступные места, узлы исполнения и выделенные браузеры.</p>
      </div>
      @if (overview.data(); as overview) {
        <button
          class="btn"
          [disabled]="action.pending() || action.unknown()"
          (click)="changeAdmission()"
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
      <div class="metrics a-browser-summary">
        <hg-metric
          label="Доступно для запуска"
          [value]="overview.allocatableFree"
          icon="server"
          tone="green"
          [caption]="
            overview.acceptingAllocations
              ? 'Свободно на узлах, принимающих задачи'
              : 'Новые запуски приостановлены'
          "
        />
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
      </div>
      @if (!overview.acceptingAllocations) {
        <div class="notice warning">
          Новые запуски приостановлены. Работающие браузеры продолжают работу, задачи остаются в
          очереди.
        </div>
      }
    }
    <hg-feedback [loading]="pool.loading()" [error]="pool.error()" (retry)="pool.refresh()" />
    @if (pool.data(); as pool) {
      <section class="panel a-section">
        <header class="a-section-header">
          <h2>Узлы исполнения</h2>
          <button class="btn quiet" aria-haspopup="dialog" (click)="openFilters()">
            <hg-icon name="filter" />Поиск и фильтры
          </button>
        </header>
        @if (filters().length) {
          <div class="a-filter-feedback">
            @for (filter of filters(); track filter) {
              <span class="chip">{{ filter }}</span>
            }
            <button class="btn quiet" (click)="query.clear()">Сбросить фильтры</button>
          </div>
        }
        <p class="a-effective-note">
          Узел — сервис, который запускает браузеры. Вместимость показывает, сколько браузеров он
          может держать одновременно.
        </p>
        <hg-data-table
          [page]="pool.workers" (changed)="query.change($event)" [columns]="workerColumns"
          [rows]="workerRows()"
          [showEmpty]="true"
          [actions]="true"
          (action)="changeWorker($event)"
          emptyTitle="Узлов нет"
          emptyText="Нет узлов, соответствующих фильтрам."
        />
      </section>
      <section class="panel a-section">
        <header class="a-section-header">
          <h2>Выделенные браузеры</h2>
          <small>Одна строка — один браузер</small>
        </header>
        <hg-data-table
          [page]="pool.allocations" (changed)="allocationQuery.change($event)" [columns]="allocationColumns"
          [rows]="allocationRows()"
          [showEmpty]="true"
          [actions]="true"
          (action)="stopAllocationTask($event)"
          emptyTitle="Нет выделенных браузеров"
          emptyText="Сессии появятся после выделения браузера."
        />
      </section>
      <section class="panel a-section">
        <header class="a-section-header">
          <h2>Очередь на браузер</h2>
          <small>Браузер ещё не выделен</small>
        </header>
        <hg-data-table
          [page]="pool.queue" (changed)="queueQuery.change($event)" [columns]="queueColumns"
          [rows]="queueRows()"
          [showEmpty]="true"
          emptyTitle="Очередь пуста"
          emptyText="Нет задач, ожидающих выделения браузера."
        />
      </section>
    }
    @if (action.receipt()?.operationId; as operation) {
      <hg-operation [id]="operation" />
    }
    @if (intent(); as intent) {
      <hg-dialog [title]="intent.title" [busy]="action.pending()" (closed)="this.intent.set(null)">
        <p>{{ intent.explanation }}</p>
        <label class="field"
          >Причина<textarea [(ngModel)]="reason" maxlength="1000" required></textarea>
        </label>
        <hg-mutation [action]="action" />
        <button
          dialog-actions
          class="btn primary"
          [disabled]="!reason.trim() || action.pending() || action.unknown()"
          (click)="apply()"
        >
          Применить
        </button>
      </hg-dialog>
    }
    @if (filtersOpen()) {
      <hg-dialog title="Поиск и фильтры узлов" (closed)="filtersOpen.set(false)">
        <label class="field"
          >Поиск<input type="search" [(ngModel)]="draftQuery" maxlength="200" placeholder="ID узла"
        /></label>
        <fieldset class="a-filter-group">
          <legend>Состояние узла</legend>
          @for (state of states; track state) {
            <label class="h-option"
              ><input
                type="checkbox"
                [checked]="draftStates.includes(state)"
                (change)="toggleState(state)"
              /><span>{{ state | label }}</span></label
            >
          }
        </fieldset>
        <button dialog-actions class="btn" (click)="filtersOpen.set(false)">Отмена</button>
        <button dialog-actions class="btn primary" (click)="applyFilters()">Применить</button>
      </hg-dialog>
    }`,
})
export class AdminBrowsers {
  readonly query = new TableQuery({ prefix: 'workers' });
  readonly allocationQuery = new TableQuery({ prefix: 'allocations' });
  readonly queueQuery = new TableQuery({ prefix: 'queue' });
  readonly pool = new ServerResource<BrowserPool>(['nodes', 'sessions', 'userTasks', 'users']);
  readonly overview = new ServerResource<AdminOverview>([
    'nodes',
    'sessions',
    'users',
    'userTasks',
  ]);
  readonly action = new Mutation();
  readonly intent = signal<BrowserIntent | null>(null);
  readonly filtersOpen = signal(false);
  readonly states = ['READY', 'DRAINING', 'OFFLINE'];
  readonly filters = computed(() =>
    [
      this.query.text('q') ? 'Поиск: ' + this.query.text('q') : '',
      ...this.query.values('state').map((state) => new LabelPipe().transform(state)),
    ].filter(Boolean),
  );
  draftQuery = '';
  draftStates: string[] = [];
  reason = '';
  readonly workerColumns: Column[] = [
    { key: 'id', sort: 'id', title: 'Узел' },
    { key: 'state', sort: 'state', title: 'Состояние', kind: 'status' },
    { key: 'occupied', sort: 'occupied', title: 'Занято' },
    { key: 'capacity', sort: 'capacity', title: 'Вместимость' },
    { key: 'free', sort: 'free', title: 'Доступно для запуска' },
  ];
  readonly workerRows = computed<TableItem[]>(
    () =>
      this.pool.data()?.workers.items.map((worker) => ({
        id: worker.id,
        values: {
          id: worker.id,
          state: worker.state,
          occupied: worker.occupied === null ? 'Неизвестно' : String(worker.occupied),
          capacity: String(worker.capacity),
          free: worker.free === null ? 'Неизвестно' : String(worker.free),
        },
        metadata: {
          id: 'Последняя связь: ' + new Date(worker.heartbeatAt).toLocaleString('ru-RU'),
          occupied:
            worker.occupied === null ? 'Последнее известное: ' + worker.lastKnownOccupied : '',
        },
      })) ?? [],
  );
  readonly allocationColumns: Column[] = [
    { key: 'user', title: 'Пользователь', kind: 'person', sort: 'userName' },
    { key: 'session', title: 'Браузер', sort: 'sessionId' },
    { key: 'state', title: 'Состояние', kind: 'status' },
    { key: 'worker', title: 'Узел', sort: 'workerId' },
    { key: 'task', title: 'Задача', sort: 'taskId' },
  ];
  readonly allocationRows = computed<TableItem[]>(
    () =>
      this.pool.data()?.allocations.items.map((allocation) => ({
        id: allocation.id,
        link: '/admin/users/' + allocation.userId,
        actionDisabled: allocation.taskId === null,
        values: {
          user: allocation.userName,
          session: allocation.sessionId,
          state: allocation.sessionState,
          worker: allocation.workerId,
          task: allocation.taskId ?? 'Без задачи',
        },
        metadata: { user: allocation.userId },
      })) ?? [],
  );
  readonly queueColumns: Column[] = [
    { key: 'user', title: 'Пользователь', kind: 'person' },
    { key: 'task', title: 'Задача', sort: 'taskId' },
    { key: 'reason', title: 'Причина ожидания', sort: 'waitReason' },
  ];
  readonly queueRows = computed<TableItem[]>(
    () =>
      this.pool.data()?.queue.items.map((task) => ({
        id: task.taskId,
        link: '/admin/users/' + task.userId,
        values: {
          user: task.userName,
          task: task.taskId,
          reason: browserWaitReason(task.waitReason),
        },
        metadata: { user: task.userId },
      })) ?? [],
  );

  constructor() {
    this.overview.load('/admin/overview');
    effect(() => {
      const queries = { workers: this.query.value(), allocations: this.allocationQuery.value(), queue: this.queueQuery.value() };
      this.pool.load('/admin/browsers', Object.fromEntries(Object.entries(queries).flatMap(([prefix, query]) =>
        Object.entries(query).map(([name, value]) => [prefix + '.' + name, value]))));
    });
  }
  openFilters() {
    this.draftQuery = this.query.text('q');
    this.draftStates = [...this.query.values('state')];
    this.filtersOpen.set(true);
  }
  toggleState(state: string) {
    this.draftStates = this.draftStates.includes(state)
      ? this.draftStates.filter((value) => value !== state)
      : [...this.draftStates, state];
  }
  applyFilters() {
    this.query.filter({ q: this.draftQuery.trim() || null, state: this.draftStates });
    this.filtersOpen.set(false);
  }
  changeAdmission() {
    const overview = this.overview.data();
    if (!overview || this.action.pending() || this.action.unknown()) return;
    this.reason = '';
    this.intent.set({
      title: overview.acceptingAllocations
        ? 'Приостановить новые запуски'
        : 'Разрешить новые запуски',
      explanation: 'Изменение не завершает работающие браузеры и не отменяет задачи.',
      method: 'PATCH',
      path: '/admin/platform/admission',
      body: {
        acceptingAllocations: !overview.acceptingAllocations,
        expectedVersion: overview.version,
      },
    });
  }
  changeWorker(id: string) {
    const worker = this.pool.data()?.workers.items.find((item) => item.id === id);
    if (!worker || this.action.pending() || this.action.unknown()) return;
    const enable = worker.desiredMode === 'DRAINING';
    this.reason = '';
    this.intent.set({
      title: enable ? 'Вернуть узел в работу' : 'Вывести узел из работы',
      explanation:
        'Вывод из работы запрещает новые назначения. Существующие браузеры продолжают работу до обычного завершения.',
      method: 'POST',
      path: '/admin/workers/' + id + (enable ? '/enable' : '/drain'),
      body: { expectedVersion: worker.version },
    });
  }
  stopAllocationTask(id: string) {
    const taskId = this.pool.data()?.allocations.items.find((item) => item.id === id)?.taskId;
    if (!taskId || this.action.pending() || this.action.unknown()) return;
    this.reason = '';
    this.intent.set({
      title: 'Остановить задачу',
      method: 'POST',
      path: '/admin/tasks/' + taskId + '/stop',
      body: {},
      explanation:
        'Задача будет остановлена. Место в пуле освободится после подтверждённого закрытия браузера.',
    });
  }
  apply() {
    const intent = this.intent();
    if (!intent || !this.reason.trim()) return;
    this.action.run(
      intent.method,
      intent.path,
      { ...intent.body, reason: this.reason.trim() },
      () => {
        this.intent.set(null);
        this.pool.refresh();
        this.overview.refresh();
      },
    );
  }
}

function browserWaitReason(reason: string | null): string {
  const labels: Readonly<Record<string, string>> = {
    USER_BROWSER_LIMIT: 'Достигнут лимит браузеров пользователя',
    POOL_EXHAUSTED: 'Нет свободного места в пуле',
    PLATFORM_PAUSED: 'Новые запуски приостановлены',
    CONNECTION_BUSY: 'Подключение используется другим браузером',
  };
  return reason
    ? (labels[reason] ?? 'Ожидается доступный браузер')
    : 'Ожидается выделение браузера';
}
