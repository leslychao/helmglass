import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ServerResource } from '../../core/api/server-resource';
import { BrowserOpen, Page, Query, Result, ResultRow, Task } from '../../core/api/models';
import { Mutation } from '../../core/api/mutation';
import { BrowserPanel } from '../../shared/browser-panel/browser-panel';
import { BrowserInstance } from '../../shared/browser-panel/browser-instance';
import { AsyncOperation } from '../../shared/async-operation/async-operation';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Icon } from '../../shared/icon/icon';
import { Status, DurationPipe, BytesPipe, LabelPipe } from '../../shared/status/status';
import { Column, DataTable, TableItem } from '../../shared/data-table/data-table';
import { Dialog } from '../../shared/dialog/dialog';
import { hostname } from './task-list';
import { TaskUsage } from '../usage/task-usage';

@Component({
  selector: 'hg-task-detail',
  imports: [
    RouterLink,
    DatePipe,
    FormsModule,
    BrowserPanel,
    AsyncOperation,
    Feedback,
    MutationFeedback,
    Icon,
    Status,
    DurationPipe,
    BytesPipe,
    LabelPipe,
    DataTable,
    Dialog,
    TaskUsage,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hg-feedback
      [loading]="task.loading() && !task.data()"
      [error]="task.error()"
      (retry)="task.refresh()"
    />
    @if (task.data(); as task) {
      <div class="task-page">
        <header class="heading">
          <h1 tabindex="-1">{{ task.title || task.goal || 'Черновик' }}</h1>
          <div class="flex">
            @if (task.state === 'DRAFT') {
              <a class="btn primary" [routerLink]="'/tasks/' + task.id + '/edit'">Редактировать</a>
            } @else {
              <button
                class="btn quiet"
                [disabled]="action.pending() || action.unknown()"
                (click)="copy()"
              >
                <hg-icon name="plus" />Создать похожую
              </button>
            }
            @if (can('pause')) {
              <button
                class="btn"
                [disabled]="action.pending() || action.unknown()"
                (click)="act('pause')"
              >
                <hg-icon name="pause" />Пауза
              </button>
            }
            @if (can('resume')) {
              <button
                class="btn primary"
                [disabled]="action.pending() || action.unknown()"
                (click)="resumeDialog.set(true)"
              >
                <hg-icon name="play" />Продолжить
              </button>
            }
            @if (can('stop')) {
              <button
                class="btn danger"
                [disabled]="action.pending() || action.unknown()"
                (click)="stopDialog.set(true)"
              >
                <hg-icon name="stop" />Остановить
              </button>
            }
          </div>
        </header>
        <div class="task-meta-v">
          <hg-status [value]="task.outcome || task.state" /><span
            ><hg-icon name="clock" />Время выполнения:
            {{ task.usage?.executionSeconds | duration }}</span
          ><span><hg-icon name="globe" />{{ hostname(task.startUrl) }}</span
          ><span><hg-icon name="chat" />{{ task.origin === 'MCP' ? 'ChatGPT' : 'Кабинет' }}</span
          ><span>{{ task.createdAt | date: 'dd.MM.yyyy, HH:mm' }}</span>
        </div>
        @if (task.state !== 'DRAFT') {
          <nav class="tabs h-run-tabs" aria-label="Разделы задачи">
            <a [routerLink]="'/tasks/' + task.id" class="tab" [class.active]="!resultTab"
              >Выполнение</a
            ><a
              [routerLink]="'/tasks/' + task.id + '/result'"
              class="tab"
              [class.active]="resultTab"
              >Результат</a
            >
          </nav>
        }
        @if (!resumeDialog() && !openDialog()) {
          <hg-mutation [action]="action" />
        }
        @if (operationId(); as operation) {
          <hg-operation [id]="operation" />
        }
        @if (task.state === 'DRAFT') {
          <div class="notice neutral">
            <strong>Черновик не запущен</strong>
            <p>Дополните поручение и подготовьте его для ChatGPT.</p>
          </div>
        } @else if (resultTab) {
          <section class="panel result-panel">
            <hg-feedback
              [loading]="result.loading()"
              [error]="result.error()"
              (retry)="result.refresh()"
            />
            @if (result.data(); as result) {
              <div class="panel-body">
                <header class="between">
                  <h2>Результат</h2>
                  <span class="small muted">Редакция {{ result.revision }}</span>
                  <button
                    type="button"
                    class="btn small quiet"
                    [disabled]="copyPending()"
                    (click)="copyConclusion()"
                  >
                    <hg-icon name="copy" />Скопировать вывод
                  </button>
                </header>
                <p class="small muted" role="status">{{ copyNotice() }}</p>
                <p class="report-text">{{ result.conclusion }}</p>
                @if (result.limitations.length || result.missing.length) {
                  <div class="notice warning">
                    <strong>Ограничения результата</strong>
                    <ul>
                      @for (item of result.limitations; track $index) {
                        <li>{{ item }}</li>
                      }
                      @for (item of result.missing; track $index) {
                        <li>{{ item }}</li>
                      }
                    </ul>
                  </div>
                }
                @for (section of result.sections; track $index) {
                  <h3>{{ section.title }}</h3>
                  <p class="report-text">{{ section.text }}</p>
                }
                @for (file of result.files; track file.id) {
                  <div class="report-file">
                    <hg-icon name="download" />
                    <div>
                      <strong>{{ file.filename }}</strong
                      ><small>{{ file.bytes | bytes }} · {{ file.mimeType }}</small>
                    </div>
                    @if (file.state === 'READY') {
                      <a class="btn" [href]="'/api/v1/artifacts/' + file.id + '/content'" download
                        >Скачать</a
                      >
                    } @else {
                      <hg-status [value]="file.state" />
                    }
                  </div>
                }
              </div>
              @if (result.outputFormat === 'TABLE') {
                <div class="table-toolbar">
                  <label class="search"
                    ><hg-icon name="search" /><input
                      type="search"
                      aria-label="Поиск в результате"
                      placeholder="Поиск в результате"
                      [(ngModel)]="resultSearch"
                      (keydown.enter)="readRows({ page: 1 })" /></label
                  ><button class="btn" (click)="readRows({ page: 1 })">Найти</button>
                </div>
                <hg-feedback
                  [loading]="rows.loading()"
                  [error]="rows.error()"
                  (retry)="rows.refresh()"
                /><hg-data-table
                  [columns]="resultColumns()"
                  [rows]="resultRows()"
                  [page]="rows.data()"
                  [actions]="true"
                  (changed)="readRows($event)"
                  (action)="openRow($event)"
                />
              }
              @if (result.sources.length) {
                <div class="panel-body">
                  <h3>Источники</h3>
                  <ul class="sources">
                    @for (source of result.sources; track $index) {
                      <li>
                        <a [href]="source.url" target="_blank" rel="noopener noreferrer">{{
                          source.title || source.url
                        }}</a>
                      </li>
                    }
                  </ul>
                </div>
              }
            } @else if (!result.loading() && !result.error()) {
              <div class="empty-table">
                <hg-icon name="tasks" />
                <h3>Результата пока нет</h3>
                <p>Он появится после подтверждённой публикации агентом.</p>
              </div>
            }
          </section>
        } @else {
          @if (task.activeRequest; as request) {
            <section class="notice warning">
              <h2>
                {{
                  request.kind === 'CONFIRMATION'
                    ? 'Подтвердите действие'
                    : request.kind === 'LOGIN'
                      ? 'Требуется вход'
                      : 'Нужен ваш ответ'
                }}
              </h2>
              <p class="report-text">{{ request.prompt }}</p>
              @if (request.kind === 'LOGIN') {
                <button
                  class="btn primary"
                  [disabled]="!request.connectionId || action.pending() || action.unknown()"
                  (click)="beginLogin()"
                >
                  <hg-icon name="lock" />Войти на сайт
                </button>
              } @else if (request.kind === 'CONFIRMATION') {
                <p class="small">Подтверждение относится только к указанному действию.</p>
                <div class="flex">
                  <button
                    class="btn primary"
                    [disabled]="action.pending() || action.unknown()"
                    (click)="answer('APPROVE')"
                  >
                    Подтвердить действие</button
                  ><button
                    class="btn"
                    [disabled]="action.pending() || action.unknown()"
                    (click)="answer('DENY')"
                  >
                    Отклонить
                  </button>
                </div>
              } @else if (request.purpose === 'CONNECTION_SELECTION') {
                <fieldset [disabled]="action.pending() || action.unknown()">
                  <legend>Выберите подключение</legend>
                  @for (choice of request.choices; track choice.id) {
                    <label class="check-row">
                      <input
                        type="radio"
                        name="connection-answer"
                        [value]="choice.id"
                        [(ngModel)]="selectedConnectionId"
                      />
                      <span
                        >{{ choice.label }}
                        @if (choice.accountLabel) {
                          — {{ choice.accountLabel }}
                        }
                      </span>
                    </label>
                  }
                </fieldset>
                @if (request.hasMoreChoices) {
                  <p class="small">
                    Показана часть подходящих подключений. Если нужного нет в списке, уточните
                    задачу.
                  </p>
                }
                <button
                  class="btn primary"
                  [disabled]="!selectedConnectionId || action.pending() || action.unknown()"
                  (click)="answer('ANSWER')"
                >
                  Использовать подключение
                </button>
              } @else {
                <label class="field"
                  >Ваш ответ<textarea [(ngModel)]="answerText" maxlength="16000"></textarea></label
                ><button
                  class="btn primary"
                  [disabled]="!answerText.trim() || action.pending() || action.unknown()"
                  (click)="answer('ANSWER')"
                >
                  Ответить
                </button>
              }
            </section>
          }
          @if (task.waitReason || task.failureCode) {
            <p class="notice neutral" role="status">{{ task.waitReason || task.failureCode }}</p>
          }
          @if (task.mutationBarrier) {
            <section class="notice warning">
              <h2>Результат действия неизвестен</h2>
              <p>
                Продолжение заблокировано до подтверждения результата. Проверка не повторяет
                исходное действие.
              </p>
              @if (can('reconcile') && reconciliationTarget()) {
                <button
                  class="btn"
                  [disabled]="action.pending() || action.unknown()"
                  (click)="reconcile()"
                >
                  Проверить результат действия
                </button>
              }
            </section>
          }
          <div class="task-layout-v h-task-layout">
            <div>
              @if (sessionId(); as sessionId) {
                <hg-browser-panel
                  [sessionId]="sessionId"
                  [taskId]="task.id"
                  (changed)="refresh()"
                />
              } @else {
                <section class="browser-panel">
                  <header class="browser-head"><strong>Браузер</strong></header>
                  <div class="viewer-empty">
                    <div>
                      <hg-icon name="browser" />
                      <h3>
                        {{
                          task.state === 'WAITING_AGENT' ? 'Ожидаем ChatGPT' : 'Браузер не открыт'
                        }}
                      </h3>
                      <p>Просмотр страницы не запускает браузер и не возобновляет задачу.</p>
                      @if (can('openBrowser')) {
                        <button class="btn primary" (click)="openDialog.set(true)">
                          Открыть новый браузер
                        </button>
                      }
                      <a class="btn" routerLink="/connections/guide">Как подключить ChatGPT</a>
                    </div>
                  </div>
                </section>
              }
              <section class="panel clarification">
                <header class="panel-head">
                  <h2>Уточнить поручение</h2>
                  <span class="small muted">Редакция {{ task.instructionRevision }}</span>
                </header>
                <div class="panel-body">
                  <label class="field">
                    <span class="sr-only">Уточнение задачи</span>
                    <textarea
                      [(ngModel)]="clarification"
                      maxlength="4096"
                      placeholder="Дополните требования. Пароли и коды сюда не вставляйте."
                    ></textarea>
                  </label>
                  <p class="small muted">
                    Уточнение сохраняется в этой задаче и применяется на допустимой границе команды.
                  </p>
                  <button
                    class="btn"
                    [disabled]="!clarification.trim() || action.pending() || action.unknown()"
                    (click)="clarify()"
                  >
                    Сохранить уточнение
                  </button>
                </div>
              </section>
            </div>
            <aside class="task-aside-v">
              <section class="panel">
                <header class="panel-head">
                  <h2>Текущий шаг</h2>
                  <hg-icon name="clock" />
                </header>
                <div class="panel-body">
                  <strong>{{ task.outstandingCommand?.kind || task.state | label }}</strong>
                  <p class="small muted">{{ task.waitReason || task.failureCode }}</p>
                </div>
              </section>
              <section class="panel">
                <header class="panel-head"><h2>Ресурсы задачи</h2></header>
                <div class="panel-body">
                  <div class="resource-main">
                    <span>Время браузера</span
                    ><strong>{{ task.usage?.browserSeconds | duration }}</strong>
                  </div>
                  <dl class="pairs">
                    <dt>Время выполнения</dt>
                    <dd>{{ task.usage?.executionSeconds | duration }}</dd>
                    <dt>Вход пользователя</dt>
                    <dd>{{ task.usage?.humanSeconds | duration }}</dd>
                    <dt>Ручное управление</dt>
                    <dd>{{ task.usage?.humanControlSeconds | duration }}</dd>
                    <dt>Медиа</dt>
                    <dd>{{ task.usage?.mediaSeconds | duration }}</dd>
                    <dt>Объём медиа</dt>
                    <dd>{{ task.usage?.mediaBytes | bytes }}</dd>
                  </dl>
                  <p class="small muted">
                    {{
                      task.usage?.completeness === 'UNKNOWN'
                        ? 'Нет подтверждённых данных'
                        : (task.usage?.completeness | label)
                    }}
                  </p>
                  <button class="btn quiet" (click)="usageOpen.set(true)">
                    Подробнее об использовании
                  </button>
                </div>
              </section>
              <section class="panel">
                <header class="panel-head"><h2>Продолжение в ChatGPT</h2></header>
                <div class="panel-body">
                  @if (task.continuation; as continuation) {
                    <hg-status [value]="continuation.state" />
                    <p>{{ continuation.reason | label }}</p>
                    <p>
                      {{
                        continuation.mode === 'WIDGET_RETURN'
                          ? 'Продолжение через активный виджет в исходном чате'
                          : 'Продолжение вручную в исходном чате'
                      }}
                    </p>
                    <p class="small muted">
                      Получение управления и отправка сообщения не означают, что ChatGPT уже начал
                      следующий шаг.
                    </p>
                  }
                </div>
              </section>
            </aside>
          </div>
        }
        <details class="details task-parameters">
          <summary>Исходное задание и параметры</summary>
          <p class="report-text">{{ task.goal || 'Задание ещё не заполнено.' }}</p>
          <dl class="pairs">
            <dt>Начальная страница</dt>
            <dd>{{ task.startUrl || 'Не указана' }}</dd>
            <dt>Формат результата</dt>
            <dd>{{ task.outputFormat }}</dd>
            <dt>Идентификатор</dt>
            <dd>{{ task.id }}</dd>
            <dt>Создана</dt>
            <dd>{{ task.createdAt | date: 'dd.MM.yyyy, HH:mm' }}</dd>
          </dl>
        </details>
      </div>
    }
    @if (stopDialog()) {
      <hg-dialog
        title="Остановить задачу?"
        [busy]="action.pending()"
        (closed)="stopDialog.set(false)"
        ><p>
          Новые команды будут запрещены, браузер будет закрыт. Уже принятое внешним сайтом действие
          может завершиться.
        </p>
        <div dialog-actions class="flex">
          <button class="btn" (click)="stopDialog.set(false)">Отмена</button
          ><button
            class="btn danger"
            [disabled]="action.pending() || action.unknown()"
            (click)="act('stop'); stopDialog.set(false)"
          >
            Остановить
          </button>
        </div></hg-dialog
      >
    }
    @if (resumeDialog() || openDialog()) {
      <hg-dialog
        [title]="openDialog() ? 'Открыть новый браузер?' : 'Продолжить задачу?'"
        [busy]="action.pending()"
        (closed)="resumeDialog.set(false); openDialog.set(false)"
        ><p>
          Если прежний браузер закрыт, его страницы и несохранённый контекст не восстановятся.
          Подтверждённые результаты задачи сохраняются.
        </p>
        <hg-mutation [action]="action" />
        @if (openDialog() && task.data()?.connectionIds?.length) {
          <label class="checkbox"
            ><input type="checkbox" [(ngModel)]="saveNewBrowser" />Сохранять изменения входа при
            закрытии браузера</label
          >
        }
        <div dialog-actions class="flex">
          <button class="btn" (click)="resumeDialog.set(false); openDialog.set(false)">
            Отмена</button
          ><button
            class="btn primary"
            [disabled]="action.pending() || action.unknown()"
            (click)="openDialog() ? openBrowser() : act('resume')"
          >
            Подтвердить
          </button>
        </div></hg-dialog
      >
    }
    @if (usageOpen()) {
      <hg-dialog title="Ресурсы задачи" (closed)="usageOpen.set(false)"
        ><hg-task-usage [taskId]="id"
      /></hg-dialog>
    }
    @if (rowOpen()) {
      <hg-dialog title="Строка результата" (closed)="rowOpen.set(false)"
        ><hg-feedback
          [loading]="rowDetail.loading()"
          [error]="rowDetail.error()"
          (retry)="rowDetail.refresh()"
        />
        @if (rowDetail.data(); as row) {
          <dl class="pairs">
            @for (column of result.data()?.columns ?? []; track column.key) {
              <dt>{{ column.label }}</dt>
              <dd>{{ row.data[column.key] ?? '—' }}</dd>
            }
          </dl>
        }
      </hg-dialog>
    }
  `,
})
export class TaskDetail {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly browserInstance = inject(BrowserInstance);
  readonly id = this.route.snapshot.paramMap.get('id') ?? '';
  readonly resultTab = this.route.snapshot.data['result'] === true;
  readonly task = new ServerResource<Task>(['tasks']);
  readonly result = new ServerResource<Result>(['result', 'artifacts']);
  readonly rows = new ServerResource<Page<ResultRow>>(['result']);
  readonly rowDetail = new ServerResource<ResultRow>(['result']);
  readonly action = new Mutation();
  readonly stopDialog = signal(false);
  readonly resumeDialog = signal(false);
  readonly openDialog = signal(false);
  readonly rowOpen = signal(false);
  readonly usageOpen = signal(false);
  readonly copyPending = signal(false);
  readonly copyNotice = signal('');
  readonly operationId = computed(() => this.action.receipt()?.operationId);
  private readonly activeRequestId = computed(() => this.task.data()?.activeRequest?.id ?? null);
  readonly sessionId = computed(() => this.task.data()?.currentSession?.id);
  readonly reconciliationTarget = computed(() => {
    const task = this.task.data();
    const command = task?.outstandingCommand ?? task?.lastCommand;
    if (command?.state === 'UNKNOWN') return { commandId: command.id };
    return task?.unresolvedHumanOperationId
      ? { humanOperationId: task.unresolvedHumanOperationId }
      : null;
  });
  readonly hostname = hostname;
  clarification = '';
  answerText = '';
  selectedConnectionId = '';
  resultSearch = '';
  saveNewBrowser = true;
  private rowQuery: Query = { page: 1, pageSize: 10 };
  readonly resultColumns = computed<Column[]>(
    () =>
      this.result
        .data()
        ?.columns.map((column) => ({ key: column.key, title: column.label, sort: column.key })) ??
      [],
  );
  readonly resultRows = computed<TableItem[]>(
    () =>
      this.rows.data()?.items.map((row) => ({
        id: row.id,
        values: Object.fromEntries(
          Object.entries(row.data).map(([key, value]) => [
            key,
            value === null ? '—' : String(value),
          ]),
        ),
      })) ?? [],
  );
  constructor() {
    this.task.load(`/tasks/${this.id}`);
    if (this.resultTab) this.result.load(`/tasks/${this.id}/result`);
    effect(() => {
      if (this.result.data()?.outputFormat === 'TABLE') this.readRows({ page: 1 });
      this.copyNotice.set('');
    });
    effect(() => {
      this.activeRequestId();
      this.answerText = '';
      this.selectedConnectionId = '';
    });
  }
  can(key: string) {
    return this.task.data()?.capabilities[key]?.allowed ?? false;
  }
  refresh() {
    this.task.refresh();
  }
  act(action: string) {
    const task = this.task.data();
    if (!task) return;
    this.action.run(
      'POST',
      `/tasks/${task.id}/${action}`,
      action === 'resume' ? { expectedTaskVersion: task.version } : {},
      () => {
        this.resumeDialog.set(false);
        this.refresh();
      },
    );
  }
  copy() {
    this.action.run(
      'POST',
      `/tasks/${this.id}/copy`,
      {},
      (receipt) => void this.router.navigate(['/tasks', receipt.resource.id, 'edit']),
    );
  }
  async copyConclusion() {
    const result = this.result.data();
    if (!result || this.copyPending()) return;
    this.copyNotice.set('');
    this.copyPending.set(true);
    let notice = 'Вывод скопирован';
    try {
      await navigator.clipboard.writeText(result.conclusion);
    } catch {
      notice = 'Не удалось скопировать вывод. Выделите текст и скопируйте его вручную.';
    }
    if (this.destroy.destroyed) return;
    this.copyPending.set(false);
    if (this.result.data() === result) this.copyNotice.set(notice);
  }
  reconcile() {
    const task = this.task.data();
    const target = this.reconciliationTarget();
    if (!task || !target) return;
    this.action.run(
      'POST',
      `/tasks/${task.id}/reconcile`,
      {
        expectedTaskVersion: task.version,
        ...target,
      },
      () => this.refresh(),
    );
  }
  clarify() {
    const task = this.task.data();
    if (!task) return;
    this.action.run(
      'POST',
      `/tasks/${this.id}/clarifications`,
      {
        clarificationId: crypto.randomUUID(),
        text: this.clarification,
        expectedInstructionRevision: task.instructionRevision,
        expectedTaskVersion: task.version,
      },
      () => {
        this.clarification = '';
        this.refresh();
      },
    );
  }
  beginLogin() {
    const request = this.task.data()?.activeRequest;
    if (request?.kind !== 'LOGIN' || !request.connectionId) return;
    this.action.run(
      'POST',
      `/connections/${request.connectionId}/login`,
      { taskId: this.id, controllerInstanceId: this.browserInstance.id },
      (receipt) => void this.router.navigate(['/login-operations', receipt.resource.id]),
    );
  }
  answer(decision: 'APPROVE' | 'DENY' | 'ANSWER') {
    const request = this.task.data()?.activeRequest;
    if (!request) return;
    this.action.run(
      'POST',
      `/action-requests/${request.id}/answer`,
      {
        expectedVersion: request.version,
        intentHash: request.intentHash,
        decision,
        ...(request.purpose === 'CONNECTION_SELECTION'
          ? { selectedConnectionId: this.selectedConnectionId }
          : { text: this.answerText }),
      },
      () => {
        this.answerText = '';
        this.selectedConnectionId = '';
        this.refresh();
      },
    );
  }
  openBrowser() {
    const task = this.task.data();
    if (!task) return;
    const input: BrowserOpen = {
      expectedVersion: task.version,
      purpose: 'TASK',
      savePolicy:
        task.connectionIds.length && this.saveNewBrowser ? 'SAVE_ON_CLOSE' : 'DISCARD_CHANGES',
      observedPreviousSessionId: task.lastSessionId ?? null,
      consentNewBrowser: true,
    };
    this.action.run('POST', `/tasks/${this.id}/browser-sessions`, input, () => {
      this.openDialog.set(false);
      this.refresh();
    });
  }
  readRows(query: Query) {
    const result = this.result.data();
    if (!result) return;
    this.rowQuery = { ...this.rowQuery, ...query, q: this.resultSearch };
    this.rows.load(`/results/${result.id}/rows`, this.rowQuery);
  }
  openRow(rowId: string) {
    const result = this.result.data();
    if (!result) return;
    this.rowDetail.load(`/results/${result.id}/rows/${rowId}`);
    this.rowOpen.set(true);
  }
}
