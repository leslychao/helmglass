import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import * as z from 'zod/mini';
import { Api, ApiError, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { adminDetailSchema, adminUserSchema } from '../core/models';
import { Session } from '../core/session';
import { Dialog, DialogField } from '../shared/dialog';
import { DurationPipe, LabelPipe, Pager, Status } from '../shared/ui';
import { QueryState } from '../shared/query-state';

@Component({
  selector: 'hg-user-detail',
  imports: [DatePipe, DurationPipe, LabelPipe, Pager, Status],
  templateUrl: './user-detail.html',
  providers: [QueryState],
})
export class UserDetail {
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  readonly session = inject(Session);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly query = inject(QueryState);
  private readonly params = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });
  private readonly id = computed(() => this.params().get('id') ?? '');
  private generation = 0;
  readonly data = signal<z.infer<typeof adminDetailSchema> | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly taskPage = computed(() => this.query.number('taskPage', 1));
  readonly auditPage = computed(() => this.query.number('auditPage', 1));
  readonly taskPageSize = computed(() => this.query.number('taskPageSize', 20));
  readonly auditPageSize = computed(() => this.query.number('auditPageSize', 20));
  readonly nodeReturn = computed(() => {
    const destination = this.query.text('return');
    return destination.startsWith('/admin/nodes?') ? destination : null;
  });
  constructor() {
    effect(() => {
      this.id();
      this.taskPage();
      this.auditPage();
      this.taskPageSize();
      this.auditPageSize();
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
    const destination = this.nodeReturn();
    if (destination) {
      void this.router.navigateByUrl(destination);
      return;
    }
    const back = this.route.snapshot.queryParamMap.get('back');
    void this.router.navigateByUrl('/admin/users' + (back ? '?' + back : ''));
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
      });
      if (generation === this.generation) {
        this.data.set(data);
        this.error.set('');
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    }
  }
  async limits() {
    const user = this.data()?.user;
    if (!user) return;
    const fields: DialogField[] = [
      {
        key: 'browserLimitMode',
        label: 'Лимит одновременных браузеров',
        type: 'select',
        value: user.browserLimitMode,
        options: [
          { value: 'PLATFORM', label: 'Стандартный (2)' },
          { value: 'CUSTOM', label: 'Свой лимит' },
          { value: 'UNLIMITED', label: 'Без лимита' },
        ],
      },
      {
        key: 'browserLimit',
        label: 'Свой лимит браузеров (от 1)',
        type: 'number',
        min: 1,
        value: String(user.browserLimit ?? 2),
      },
      {
        key: 'waitingLimit',
        label: 'Лимит ожидания (пусто — без лимита)',
        type: 'number',
        min: 0,
        value: user.waitingLimit === null ? '' : String(user.waitingLimit),
      },
      { key: 'reason', label: 'Причина изменения', type: 'textarea', required: true, max: 1000 },
    ];
    const values = await this.dialog.ask(
      'Изменить лимиты',
      'Снижение лимита не останавливает уже принятые задачи.',
      'Сохранить',
      fields,
      false,
      user.id,
      user.version,
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
          waitingLimit: values['waitingLimit'] ? Number(values['waitingLimit']) : null,
        },
      )
    )
      this.dialog.complete(values);
  }
  async change(type: string) {
    const user = this.data()?.user;
    if (!user || this.busy()) return;
    const descriptions: Record<string, { title: string; text: string; confirm: string }> = {
      BLOCK: {
        title: 'Заблокировать пользователя?',
        text: 'Новые действия будут запрещены, активные задачи и браузеры получат запрос остановки.',
        confirm: 'Заблокировать',
      },
      UNBLOCK: {
        title: 'Разблокировать пользователя?',
        text: 'Доступ вернётся после подтверждения операции.',
        confirm: 'Разблокировать',
      },
      REQUEST_DELETION: {
        title: 'Запланировать удаление пользователя?',
        text: 'Доступ будет закрыт. Удаление данных начнётся через 168 часов после запроса и подтверждённой остановки браузеров.',
        confirm: 'Запланировать удаление',
      },
      CANCEL_DELETION: {
        title: 'Отменить удаление?',
        text: 'Восстановится состояние пользователя до запроса удаления, включая прежнюю блокировку.',
        confirm: 'Отменить удаление',
      },
      STOP_ALL: {
        title: 'Остановить все браузеры пользователя?',
        text: 'Задачи и отдельные браузеры входа получат запрос остановки. Черновики и результаты сохранятся.',
        confirm: 'Остановить всё',
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
  async stop(browserId: string, taskId: string) {
    if (
      !(await this.dialog.ask(
        'Остановить задачу #' + taskId + '?',
        'Задача останется в состоянии остановки до подтверждения закрытия браузера.',
        'Остановить',
        [],
        true,
      ))
    )
      return;
    try {
      await this.api.mutate('/api/admin/browsers/' + browserId + '/stop', {}, z.unknown());
      await this.load();
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
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
