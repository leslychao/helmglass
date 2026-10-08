import { Icon } from '../shared/icon';
import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { BrowserViewer, browserViewerId } from '../browser/viewer';
import { ConnectionPicker } from '../connections/connection-picker';
import { Api, ApiError, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import {
  Command,
  Page,
  Task,
  connectionSchema,
  eventSchema,
  pageSchema,
  taskSchema,
} from '../core/models';
import { Dialog } from '../shared/dialog';
import { DurationPipe, LabelPipe, Pager, Status } from '../shared/ui';
import { ResultView } from './result-view';
import { MultiFilter } from '../shared/multi-filter';
import { SearchInput } from '../shared/search-input';
import { Session } from '../core/session';
import { QueryState } from '../shared/query-state';

@Component({
  selector: 'hg-task-detail',
  imports: [
    Icon,
    DatePipe,
    FormsModule,
    RouterLink,
    BrowserViewer,
    ResultView,
    DurationPipe,
    LabelPipe,
    Pager,
    Status,
    MultiFilter,
    SearchInput,
    ConnectionPicker,
  ],
  templateUrl: './task-detail.html',
  providers: [QueryState],
})
export class TaskDetail {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private readonly destroy = inject(DestroyRef);
  private readonly answerPrefix = 'helm-answer:' + inject(Session).user()?.id + ':';
  readonly query = inject(QueryState);
  private readonly params = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });
  private generation = 0;
  private historyGeneration = 0;
  readonly task = signal<Task | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly loading = signal(true);
  readonly tab = computed(() =>
    this.query.text(
      'tab',
      this.route.snapshot.data['tab'] === 'result' ||
        (this.task()?.result &&
          ['SUCCEEDED', 'PARTIAL', 'NOT_ACHIEVED', 'FAILED', 'STOPPED'].includes(
            this.task()?.status ?? '',
          ))
        ? 'result'
        : 'overview',
    ),
  );
  private answerRequest = '';
  private answerKey(task: Task) {
    return this.answerPrefix + task.id + ':' + (task.request?.id ?? '');
  }
  readonly history = signal<Page<z.infer<typeof eventSchema>> | null>(null);
  readonly historyPage = signal(1);
  readonly historyBefore = signal<number | undefined>(undefined);
  readonly historyOpen = signal(false);
  readonly newEvents = signal(false);
  readonly historyError = signal('');
  readonly historyLoading = signal(false);
  readonly historySearch = signal('');
  readonly historyTypes = signal<string[]>([]);
  readonly historyOptions = [
    { id: 'CREATED', label: 'Создание' },
    { id: 'ACTION_SUCCEEDED', label: 'Выполненные действия' },
    { id: 'ACTION_FAILED', label: 'Ошибки действий' },
    { id: 'ACTION_UNKNOWN', label: 'Неизвестный исход' },
    { id: 'WAITING_USER', label: 'Запросы участия' },
    { id: 'WAITING_CHATGPT', label: 'Ожидание ChatGPT' },
    { id: 'PAUSED', label: 'Пауза' },
    { id: 'STOPPED', label: 'Остановка' },
    { id: 'SUCCEEDED', label: 'Успешное завершение' },
  ];
  answer = '';
  selectedConnection = '';
  readonly loginConnections = signal<string[]>([]);
  readonly viewerId = browserViewerId();
  readonly controller = signal(false);
  constructor() {
    effect(() => {
      const id = this.params().get('id');
      this.task.set(null);
      const connection = sessionStorage.getItem(this.answerPrefix + id + ':save-connection');
      this.loginConnections.set(connection ? [connection] : []);
      this.answerRequest = '';
      this.historyPage.set(1);
      this.historyBefore.set(undefined);
      this.history.set(null);
      this.historySearch.set('');
      this.historyTypes.set([]);
      this.loading.set(true);
      void this.load();
    });
    effect(() => {
      this.params();
      this.historyPage();
      this.historySearch();
      this.historyTypes();
      if (this.historyOpen()) untracked(() => void this.loadHistory());
    });
    inject(LiveEvents)
      .watch(['task', 'history', 'browser'])
      .pipe(takeUntilDestroyed())
      .subscribe((change) => {
        if (
          change.resource === 'sync' ||
          change.entityId === this.params().get('id') ||
          (change.resource === 'browser' && change.entityId === this.task()?.browser?.id)
        ) {
          if (change.resource !== 'history') void this.load(false);
          if (this.historyOpen() && ['sync', 'history'].includes(change.resource)) {
            if (this.historyPage() === 1) void this.loadHistory();
            else this.newEvents.set(true);
          }
        }
      });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
      this.historyGeneration++;
    });
  }
  can(type: string) {
    return this.task()?.allowedCommands.includes(type) ?? false;
  }
  async load(initial = true) {
    const generation = ++this.generation;
    const id = this.params().get('id');
    if (!id) return;
    try {
      const task = await this.api.get('/api/tasks/' + id, taskSchema);
      if (generation !== this.generation) return;
      const current = this.task();
      if (!current || task.version >= current.version) this.task.set(task);
      if (task.browser)
        this.controller.set(
          sessionStorage.getItem('helm-controller:' + task.browser.id) === 'true',
        );
      if (initial || this.answerRequest !== this.answerKey(task)) {
        this.answerRequest = this.answerKey(task);
        this.answer = sessionStorage.getItem(this.answerRequest) ?? '';
        this.selectedConnection = sessionStorage.getItem(this.answerRequest + ':connection') ?? '';
      }
      this.error.set('');
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
  async command(type: string, extra: Partial<Command> = {}) {
    const task = this.task();
    if (!task || this.busy()) return;
    let submittedFields: Record<string, string> | null = null;
    if (
      type === 'TAKE_CONTROL' &&
      task.browser?.controlOwner === 'USER' &&
      !this.controller() &&
      !(await this.dialog.ask(
        'Передать управление этому окну?',
        'Управление в другом окне будет прекращено.',
        'Передать управление',
      ))
    )
      return;
    if (
      type === 'END_SESSION' &&
      !(await this.dialog.ask(
        'Завершить браузерную сессию?',
        'Браузер закроется. Задача останется на паузе; результаты и история сохранятся. Несохранённый вход и формы будут потеряны. Неизвестный результат действия потребуется проверить перед продолжением.',
        'Завершить сессию',
        [],
        true,
      ))
    )
      return;
    if (
      type === 'STOP' &&
      !(await this.dialog.ask(
        'Остановить задачу?',
        'Браузер будет закрыт после подтверждения остановки. Уже полученные результаты сохранятся.',
        'Остановить',
        [],
        true,
      ))
    )
      return;
    if (type === 'FINISH_LOGIN' && extra.saveConnection) {
      const connectionId = this.loginConnections()[0];
      if (!connectionId) {
        this.error.set('Выберите подключение, в котором нужно сохранить этот вход.');
        return;
      }
      const values = await this.dialog.ask(
        'Сохранить вход',
        'Подтвердите конкретную учётную запись, видимую на сайте.',
        'Сохранить',
        [
          { key: 'accountLabel', label: 'Название учётной записи', required: true, max: 200 },
          { key: 'accountSubject', label: 'Логин или ID на сайте', required: true, max: 500 },
        ],
        false,
        task.id + ':' + connectionId,
        task.version,
      );
      if (!values) return;
      submittedFields = values;
      extra = {
        ...extra,
        expectedVersion: this.dialog.version(values) ?? task.version,
        connectionId,
        accountLabel: values['accountLabel'],
        accountSubject: values['accountSubject'],
      };
    }
    if (
      type === 'RESUME' &&
      (task.status === 'STOPPED' ||
        ['LOST', 'CLOSED', 'OFFLINE'].includes(task.browser?.status ?? ''))
    ) {
      if (
        !(await this.dialog.ask(
          'Открыть новый браузер?',
          (task.status === 'STOPPED' || task.browser?.status === 'CLOSED'
            ? 'Предыдущий браузер закрыт.'
            : 'Предыдущий браузер потерян.') +
            ' Новый начнёт работу без его вкладок и несохранённого состояния.',
          'Открыть новый',
        ))
      )
        return;
      extra = { ...extra, confirmBrowserLoss: true };
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const updated = await this.api.mutate(
        '/api/tasks/' + task.id + '/commands',
        { type, expectedVersion: task.version, ...extra },
        taskSchema,
      );
      if (this.destroy.destroyed || this.params().get('id') !== task.id) return;
      if (submittedFields) this.dialog.complete(submittedFields);
      if (type === 'COPY') {
        await this.router.navigate(['/tasks', updated.id, 'edit'], {
          queryParams: { back: this.query.text('back') || null },
        });
        return;
      }
      if (this.task()?.id === updated.id && updated.version >= (this.task()?.version ?? 0))
        this.task.set(updated);
      if (
        updated.browser &&
        ['TAKE_CONTROL', 'BEGIN_LOGIN', 'RETURN_CONTROL', 'FINISH_LOGIN'].includes(type)
      ) {
        const acquired = ['TAKE_CONTROL', 'BEGIN_LOGIN'].includes(type);
        this.controller.set(acquired);
        if (acquired) sessionStorage.setItem('helm-controller:' + updated.browser.id, 'true');
        else sessionStorage.removeItem('helm-controller:' + updated.browser.id);
      }
      if (['ANSWER', 'CONFIRM', 'REJECT', 'CHOOSE_CONNECTION'].includes(type)) {
        this.answer = '';
        sessionStorage.removeItem(this.answerKey(task));
        sessionStorage.removeItem(this.answerKey(task) + ':connection');
      }
    } catch (error: unknown) {
      if (this.destroy.destroyed || this.params().get('id') !== task.id) return;
      this.error.set(errorMessage(error));
      if (error instanceof ApiError && error.status === 409) {
        await this.load(false);
        this.error.set(
          ['STALE_VERSION', 'STALE_REQUEST'].includes(error.code)
            ? 'Запрос или состояние задачи изменились. Проверьте актуальные данные и повторите действие. Ваш текст сохранён.'
            : error.message,
        );
      }
    } finally {
      this.busy.set(false);
    }
  }
  respond(type: string) {
    const request = this.task()?.request;
    if (!request) return;
    void this.command(type, {
      requestId: request.id,
      requestVersion: request.version,
      ...(type === 'ANSWER' || request.type === 'UNKNOWN_RESULT' ? { text: this.answer } : {}),
      ...(type === 'CHOOSE_CONNECTION' ? { connectionId: this.selectedConnection } : {}),
    });
  }
  loginConnectionChanged(ids: string[]) {
    this.loginConnections.set(ids);
    const key = this.answerPrefix + this.params().get('id') + ':save-connection';
    if (ids[0]) sessionStorage.setItem(key, ids[0]);
    else sessionStorage.removeItem(key);
  }
  async createLoginConnection() {
    const task = this.task();
    if (!task || this.busy()) return;
    const values = await this.dialog.ask(
      'Новое подключение для входа',
      'Вход будет сохранён из текущего браузера задачи. Для другого аккаунта создайте отдельное подключение.',
      'Создать подключение',
      [
        { key: 'name', label: 'Название подключения', required: true, max: 200 },
        {
          key: 'startUrl',
          label: 'Адрес сайта (https://…)',
          value: task.browser?.currentUrl ?? task.startUrl ?? '',
          required: true,
          max: 4096,
        },
      ],
      false,
      task.id,
    );
    if (!values || this.destroy.destroyed || this.params().get('id') !== task.id) return;
    const url = URL.parse(values['startUrl'] ?? '');
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      this.error.set('Укажите полный HTTP(S) адрес сайта без логина и пароля.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const connection = await this.api.mutate(
        '/api/connections',
        { name: values['name'], startUrl: url.href, site: url.hostname },
        connectionSchema,
      );
      this.dialog.complete(values);
      if (!this.destroy.destroyed && this.params().get('id') === task.id)
        this.loginConnectionChanged([connection.id]);
    } catch (error: unknown) {
      if (!this.destroy.destroyed && this.params().get('id') === task.id)
        this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  answerChanged(value: string) {
    this.answer = value;
    const task = this.task();
    if (task) sessionStorage.setItem(this.answerKey(task), value);
  }
  connectionChanged(value: string) {
    this.selectedConnection = value;
    const task = this.task();
    if (task) sessionStorage.setItem(this.answerKey(task) + ':connection', value);
  }
  openHistory() {
    this.historyOpen.set(!this.historyOpen());
  }
  async loadHistory() {
    const id = this.params().get('id');
    if (!id) return;
    const generation = ++this.historyGeneration;
    this.historyLoading.set(true);
    try {
      const data = await this.api.get('/api/tasks/' + id + '/history', pageSchema(eventSchema), {
        page: this.historyPage(),
        pageSize: 10,
        beforeSequence: this.historyPage() > 1 ? this.historyBefore() : undefined,
        search: this.historySearch(),
        type: this.historyTypes(),
      });
      if (generation !== this.historyGeneration) return;
      this.history.set(data);
      if (this.historyPage() === 1) {
        this.historyBefore.set(data.items[0]?.sequence);
        this.newEvents.set(false);
      }
      this.historyError.set('');
    } catch (error: unknown) {
      if (generation === this.historyGeneration) this.historyError.set(errorMessage(error));
    } finally {
      if (generation === this.historyGeneration) this.historyLoading.set(false);
    }
  }
  latestHistory() {
    this.historyPage.set(1);
    this.historyBefore.set(undefined);
  }
  filterHistory(search: string, types: string[]) {
    this.historySearch.set(search);
    this.historyTypes.set(types);
    this.historyPage.set(1);
    this.historyBefore.set(undefined);
  }
  back() {
    const raw = this.route.snapshot.queryParamMap.get('back');
    void this.router.navigateByUrl(raw ? '/tasks?' + raw : '/tasks');
  }
  async deleteDraft() {
    const task = this.task();
    if (
      !task ||
      this.busy() ||
      !(await this.dialog.ask(
        'Удалить черновик?',
        'Этот черновик будет удалён.',
        'Удалить',
        [],
        true,
      ))
    )
      return;
    this.busy.set(true);
    try {
      await this.api.mutate(
        '/api/tasks/' + task.id,
        { expectedVersion: task.version },
        z.unknown(),
        'DELETE',
      );
      this.back();
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
