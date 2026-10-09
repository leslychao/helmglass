import { ColumnPicker } from '../shared/column-picker';
import { TableViews, TableColumn } from '../shared/table-view';
import { DataTable, TableCell } from '../shared/data-table';
import { Icon } from '../shared/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { Api, ApiError, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { adminDetailSchema, adminUserSchema } from '../core/models';
import { Session } from '../core/session';
import { PageContext, pageReturnLabel, pageReturnUrl } from '../core/page-context';
import { Dialog, DialogField } from '../shared/dialog';
import { DurationPipe, Empty, LabelPipe, Pager, Status, states } from '../shared/ui';
import { QueryState } from '../shared/query-state';
import { Tooltip } from '../shared/tooltip';
import { AdminAuditTable, adminActionLabel, auditColumns } from './audit-table';

@Component({
  selector: 'hg-user-detail',
  imports: [
    DataTable,
    TableCell,
    ColumnPicker,
    Icon,
    CdkMenuModule,
    DatePipe,
    DurationPipe,
    Empty,
    LabelPipe,
    Pager,
    Status,
    RouterLink,
    AdminAuditTable,
    Tooltip,
  ],
  templateUrl: './user-detail.html',
  providers: [QueryState],
  styles: `
    .quota-rows dd {
      font-size: 12px;
      min-width: 82px;
      text-align: right;
    }
    .quota-rows dd strong {
      font-size: 12px;
    }
    .quota-rows dd .quota-bar {
      margin-left: auto;
      width: 54px;
    }
    .quota-note {
      margin: 0;
      padding: 13px 20px;
      border-top: 1px solid var(--line);
      background: #f8faff;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.7;
    }
    .quota-note strong {
      display: block;
      color: #997637;
      font-weight: 550;
    }
    .quota-card .section-heading {
      margin: 0;
    }
    .quota-card .section-heading .button {
      white-space: nowrap;
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
    .admin-usage-period {
      color: var(--muted);
      margin: 0;
      padding: 0 20px;
      font-size: 11px;
    }
    .admin-usage-days {
      padding: 13px 20px;
      font-size: 11px;
      color: var(--muted);
    }
    .admin-usage-days summary {
      cursor: pointer;
      padding: 4px 0;
    }
    #user-audit {
      scroll-margin-top: 88px;
    }
    @media (max-width: 580px) {
      .quota-note {
        padding: 12px 15px;
      }
      .section-heading.padded {
        flex-wrap: wrap;
        gap: 8px;
      }
    }
  `,
})
export class UserDetail {
  readonly Math = Math;
  readonly actionLabel = adminActionLabel;
  private readonly usageDateFormatter = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
  });
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  readonly session = inject(Session);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly pageContext = inject(PageContext);
  private readonly live = inject(LiveEvents);
  readonly query = inject(QueryState);
  private readonly params = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });
  private readonly id = computed(() => this.params().get('id') ?? '');
  private generation = 0;
  readonly data = signal<z.infer<typeof adminDetailSchema> | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly unavailable = computed(() => this.live.state() !== 'ready' || !!this.error());
  readonly taskPage = computed(() => this.query.number('taskPage', 1));
  readonly auditPage = computed(() => this.query.number('auditPage', 1));
  readonly taskPageSize = computed(() => this.query.number('taskPageSize', 5));
  readonly auditPageSize = computed(() => this.query.number('auditPageSize', 5));
  readonly sortKey = computed(() =>
    [
      'taskSort',
      'taskDirection',
      'auditSort',
      'auditDirection',
      'usageSort',
      'usageDirection',
      'usagePage',
      'usagePageSize',
    ]
      .map((key) => this.query.text(key))
      .join('|'),
  );
  readonly nodeReturn = computed(() => {
    const destination = this.query.text('return');
    return destination.startsWith('/admin/nodes?') ? destination : null;
  });
  readonly taskTableColumns: readonly TableColumn[] = [
    { key: 'id', label: 'ID задачи', width: 150, required: true },
    { key: 'status', label: 'Состояние', width: 190 },
    { key: 'browserId', label: 'Браузер', width: 150 },
    { key: 'reason', label: 'Причина ожидания / ошибка', width: 270 },
    { key: 'createdAt', label: 'Создана', width: 170 },
    { key: 'actions', label: 'Действие', width: 145, action: true },
  ];
  readonly taskTable = inject(TableViews).create(
    () => 'admin-user-tasks:' + this.id(),
    this.taskTableColumns,
    this.query,
    { sort: 'taskSort', direction: 'taskDirection', page: 'taskPage', size: 'taskPageSize' },
  );
  readonly daysTableColumns: readonly TableColumn[] = [
    { key: 'date', label: 'Дата', width: 190, required: true },
    { key: 'commands', label: 'Команды', width: 150 },
    { key: 'browserSeconds', label: 'Браузеры', width: 200 },
  ];
  readonly daysTable = inject(TableViews).create(
    () => 'admin-user-days:' + this.id(),
    this.daysTableColumns,
    this.query,
    { sort: 'usageSort', direction: 'usageDirection', page: 'usagePage', size: 'usagePageSize' },
  );
  readonly auditTable = inject(TableViews).create(
    () => 'admin-user-audit:' + this.id(),
    auditColumns,
    this.query,
    { sort: 'auditSort', direction: 'auditDirection', page: 'auditPage', size: 'auditPageSize' },
  );
  constructor() {
    effect(() => {
      this.id();
      this.taskPage();
      this.auditPage();
      this.taskPageSize();
      this.auditPageSize();
      this.sortKey();
      untracked(() => void this.load());
    });
    inject(LiveEvents)
      .watch(['admin-user', 'admin-operation', 'admin-audit'])
      .pipe(takeUntilDestroyed())
      .subscribe((change) => {
        if (change.resource === 'sync' || change.entityId === this.id()) void this.load();
      });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }
  back() {
    void this.router.navigateByUrl(pageReturnUrl(this.route, this.router, '/admin/users'));
  }
  returnUrl() {
    return this.router.url;
  }
  usageDate(value: string) {
    return this.usageDateFormatter.format(new Date(value + 'T12:00:00'));
  }
  backLabel() {
    return pageReturnLabel(
      this.router.serializeUrl(pageReturnUrl(this.route, this.router, '/admin/users')),
    );
  }
  async load() {
    const generation = ++this.generation;
    if (this.data()?.user.id !== this.id()) this.data.set(null);
    try {
      const data = await this.api.get('/api/admin/users/' + this.id(), adminDetailSchema, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        taskPage: this.taskPage(),
        auditPage: this.auditPage(),
        taskPageSize: this.taskPageSize(),
        auditPageSize: this.auditPageSize(),
        usageSort: this.query.text('usageSort', 'date'),
        usageDirection: this.daysTable.direction(),
        usagePage: this.query.number('usagePage', 1),
        usagePageSize: this.query.number('usagePageSize', 5),
        taskSort: this.query.text('taskSort', 'createdAt'),
        taskDirection: this.taskTable.direction('desc'),
        auditSort: this.query.text('auditSort', 'createdAt'),
        auditDirection: this.auditTable.direction('desc'),
      });
      if (generation === this.generation) {
        this.data.set(data);
        this.error.set('');
        this.pageContext.setResource('users', data.user.id, data.user.name);
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    }
  }
  async limits() {
    const user = this.data()?.user;
    if (!user || this.unavailable() || this.busy()) return;
    const fields: DialogField[] = [
      {
        key: 'browserLimitMode',
        label: 'Способ ограничения',
        group: 'browsers',
        type: 'select',
        value: user.browserLimitMode,
        options: [
          { value: 'PLATFORM', label: 'Стандартный · 2' },
          { value: 'CUSTOM', label: 'Задать число' },
          { value: 'UNLIMITED', label: 'Весь общий пул' },
        ],
      },
      {
        key: 'browserLimit',
        label: 'Количество',
        group: 'browsers',
        type: 'number',
        min: 1,
        required: true,
        visibleWhen: { key: 'browserLimitMode', value: 'CUSTOM' },
        value: String(user.browserLimit ?? 2),
      },
      {
        key: 'waitingLimitMode',
        label: 'Способ ограничения',
        group: 'waiting',
        type: 'select',
        value: user.waitingLimit === null ? 'UNLIMITED' : 'CUSTOM',
        options: [
          { value: 'UNLIMITED', label: 'Без ограничения' },
          { value: 'CUSTOM', label: 'Задать число' },
        ],
      },
      {
        key: 'waitingLimit',
        label: 'Количество',
        group: 'waiting',
        type: 'number',
        min: 0,
        required: true,
        visibleWhen: { key: 'waitingLimitMode', value: 'CUSTOM' },
        value: user.waitingLimit === null ? '' : String(user.waitingLimit),
      },
      { key: 'reason', label: 'Причина изменения', type: 'textarea', required: true, max: 1000 },
    ];
    const values = await this.dialog.ask(
      'Квоты пользователя',
      '',
      'Сохранить квоты',
      fields,
      false,
      user.id,
      user.version,
      {
        subject: { name: user.name, detail: user.email },
        groups: [
          {
            key: 'browsers',
            label: 'Одновременные браузеры',
            caption: 'Весь общий пул не даёт приоритета перед другими пользователями.',
          },
          {
            key: 'waiting',
            label: 'Подготовленные задачи в ожидании',
            caption:
              'Ожидают запуска, агента или действий пользователя. Черновики не учитываются. По умолчанию ограничения нет.',
          },
        ],
        note: 'Изменения действуют без повторного входа. Уменьшение квоты не обрывает браузеры и не отменяет уже принятые задачи.',
      },
    );
    if (!values) return;
    if (
      await this.command(
        { id: user.id, version: this.dialog.version(values) ?? user.version },
        'LIMITS',
        {
          reason: values['reason'],
          browserLimitMode: values['browserLimitMode'],
          ...(values['browserLimitMode'] === 'CUSTOM'
            ? { browserLimit: Number(values['browserLimit']) }
            : {}),
          waitingLimit:
            values['waitingLimitMode'] === 'CUSTOM' ? Number(values['waitingLimit']) : null,
        },
      )
    )
      this.dialog.complete(values);
  }
  async change(type: string) {
    const user = this.data()?.user;
    if (!user || this.busy() || this.unavailable()) return;
    const descriptions: Record<string, { title: string; text: string; confirm: string }> = {
      BLOCK: {
        title: 'Заблокировать пользователя?',
        text: 'Доступ закроется сразу, ожидающая работа получит запрос остановки. Активные браузеры перейдут в остановку. Разблокировка не возобновит задачи автоматически.',
        confirm: 'Заблокировать',
      },
      UNBLOCK: {
        title: 'Разблокировать пользователя?',
        text: 'Пользователю потребуется войти заново. Прежние сессии входа и остановленные задачи не будут восстановлены автоматически.',
        confirm: 'Разблокировать',
      },
      REQUEST_DELETION: {
        title: 'Удалить аккаунт?',
        text: 'Доступ закроется сразу. Отменить удаление можно в течение семи суток с момента подтверждения. После этого восстановление недоступно; необратимая очистка начинается после подтверждённой остановки браузеров.',
        confirm: 'Запросить удаление',
      },
      CANCEL_DELETION: {
        title: 'Отменить удаление аккаунта?',
        text:
          'Будет восстановлено прежнее состояние аккаунта: «' +
          (states[user.previousStatus || ''] ?? user.previousStatus ?? '—') +
          '». Задачи автоматически не запускаются.',
        confirm: 'Отменить удаление',
      },
      STOP_ALL: {
        title: 'Остановить все задачи пользователя?',
        text: 'Задачи и отдельные браузеры входа получат запрос остановки. Черновики и результаты сохранятся.',
        confirm: 'Остановить задачи',
      },
    };
    const description = descriptions[type];
    if (!description) return;
    const values = await this.dialog.ask(
      description.title,
      description.text,
      description.confirm,
      type === 'STOP_ALL'
        ? []
        : [{ key: 'reason', label: 'Причина', type: 'textarea', required: true, max: 1000 }],
      ['BLOCK', 'REQUEST_DELETION', 'STOP_ALL'].includes(type),
      user.id,
      user.version,
      type === 'STOP_ALL'
        ? { compact: true }
        : {
            subject: { name: user.name, detail: user.email },
            facts: [
              ...(type === 'CANCEL_DELETION' && user.deleteUntil
                ? [
                    {
                      label: 'Отменить можно до',
                      value: new Date(user.deleteUntil).toLocaleString('ru-RU'),
                    },
                  ]
                : []),
              ...(type === 'REQUEST_DELETION'
                ? [
                    {
                      label: 'Состояние при восстановлении',
                      value: states[user.status] ?? user.status,
                    },
                  ]
                : []),
              ...(['BLOCK', 'REQUEST_DELETION'].includes(type)
                ? [
                    { label: 'Занято браузеров', value: String(user.browserCount ?? 'Нет данных') },
                    { label: 'Подготовленные в ожидании', value: String(user.waitingCount) },
                  ]
                : []),
            ],
          },
    );
    if (
      values &&
      (await this.command(
        { id: user.id, version: this.dialog.version(values) ?? user.version },
        type,
        values,
      ))
    )
      this.dialog.complete(values);
  }
  private async command(user: { id: string; version: number }, type: string, values: object) {
    if (this.id() !== user.id || this.busy()) return false;
    this.busy.set(true);
    try {
      const updated = await this.api.mutate(
        '/api/admin/users/' + user.id + '/commands',
        { type, expectedVersion: user.version, ...values },
        adminUserSchema,
      );
      if (this.id() !== user.id) return true;
      this.data.update((data) =>
        data && updated.version >= data.user.version ? { ...data, user: updated } : data,
      );
      await this.load();
      return true;
    } catch (error: unknown) {
      if (this.id() !== user.id) return false;
      if (error instanceof ApiError && error.status === 409) await this.load();
      this.error.set(errorMessage(error));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
  async stop(taskId: string) {
    if (this.busy() || this.unavailable()) return;
    if (
      !(await this.dialog.ask(
        'Остановить задачу #' + taskId.slice(0, 8) + '?',
        'Задача останется в состоянии остановки до подтверждения закрытия браузера.',
        'Остановить',
        [],
        true,
        taskId,
        undefined,
        { compact: true },
      ))
    )
      return;
    this.busy.set(true);
    try {
      await this.api.mutate(
        '/api/admin/users/' + this.id() + '/tasks/' + taskId + '/stop',
        {},
        z.unknown(),
      );
      await this.load();
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  taskPageChange(page: number) {
    this.query.set({ taskPage: page }, false);
  }
  auditPageChange(page: number) {
    this.query.set({ auditPage: page }, false);
  }
  taskSizeChange(size: number) {
    this.query.set({ taskPage: 1, taskPageSize: size }, false);
  }
  auditSizeChange(size: number) {
    this.query.set({ auditPage: 1, auditPageSize: size }, false);
  }
}
