import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  BrowserNavigation,
  BrowserClose,
  BrowserSave,
  BrowserSavePolicy,
  BrowserSession,
  BrowserSnapshot,
  Operation,
  TaskEvent,
  TaskEventPage,
  ViewTicket,
} from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { Mutation } from '../../core/api/mutation';
import { BrowserInstance } from './browser-instance';
import { RemoteBrowser, ViewerState } from '../remote-browser/remote-browser';
import { Icon } from '../icon/icon';
import { Status, LabelPipe } from '../status/status';
import { Feedback, MutationFeedback } from '../feedback/feedback';
import { Dialog } from '../dialog/dialog';
import { Column, DataTable, TableItem } from '../data-table/data-table';
import { AsyncOperation } from '../async-operation/async-operation';
import { Realtime } from '../../core/realtime/realtime.service';
import { BrowserClock, newerClock, sessionClock } from '../../core/realtime/browser-clock';

@Component({
  selector: 'hg-browser-panel',
  imports: [
    RemoteBrowser,
    Icon,
    Status,
    LabelPipe,
    Feedback,
    MutationFeedback,
    Dialog,
    DataTable,
    FormsModule,
    AsyncOperation,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="browser-panel" #panel>
      <header class="browser-head">
        <div class="flex">
          <hg-icon name="browser" /><strong>Браузер</strong>
          @if (session.data(); as browser) {
            <hg-status [value]="viewStatus()" />
          }
        </div>
        <div class="flex">
          @if (primary(); as primary) {
            <button
              class="btn primary"
              [disabled]="!can(primary.key) || busy()"
              [attr.title]="session.data()?.capabilities?.[primary.key]?.reason || null"
              (click)="perform(primary.key)"
            >
              {{ primary.label }}
            </button>
          }
          <button class="icon-btn" aria-label="Развернуть браузер" (click)="fullscreen(panel)">
            <hg-icon name="expand" /></button
          ><button
            class="icon-btn"
            aria-label="Меню браузера"
            [attr.aria-expanded]="menu()"
            (click)="menu.set(!menu())"
          >
            <hg-icon name="more" />
          </button>
        </div>
      </header>
      @if (menu()) {
        <div class="browser-menu">
          <button class="btn" (click)="paused.set(!paused()); menu.set(false)">
            {{ paused() ? 'Продолжить просмотр' : 'Приостановить просмотр' }}</button
          ><button class="btn" (click)="copyUrl()">Копировать адрес</button>
          @if (visible('login') && primary()?.key !== 'login') {
            <button class="btn" [disabled]="!can('login') || busy()" (click)="perform('login')">
              Войти на сайт
            </button>
          }
          @if (visible('save')) {
            <button class="btn" [disabled]="!can('save') || busy()" (click)="perform('save')">
              Сохранить вход
            </button>
          }
          @if (visible('savePolicy')) {
            <fieldset>
              <legend>При закрытии браузера</legend>
              @for (policy of savePolicies; track policy.value) {
                <button
                  class="btn"
                  [attr.aria-pressed]="browserSavePolicy() === policy.value"
                  [disabled]="!can('savePolicy') || busy() || browserSavePolicy() === policy.value"
                  (click)="setSavePolicy(policy.value)"
                >
                  {{ policy.label }}
                </button>
              }
            </fieldset>
          }
          @if (visible('snapshot')) {
            <button
              class="btn"
              [disabled]="!can('snapshot') || busy()"
              (click)="perform('snapshot')"
            >
              Сделать снимок
            </button>
          }
          @if (visible('close')) {
            <button class="btn danger" [disabled]="!can('close') || busy()" (click)="openClose()">
              Закрыть браузер
            </button>
          }
        </div>
      }
      @if (session.data(); as browser) {
        <div class="browser-address">
          <button
            class="icon-btn"
            aria-label="Назад на сайте"
            [disabled]="!can('back') || !live() || busy()"
            (click)="navigate('BACK')"
          >
            ‹</button
          ><button
            class="icon-btn"
            aria-label="Вперёд на сайте"
            [disabled]="!can('forward') || !live() || busy()"
            (click)="navigate('FORWARD')"
          >
            ›</button
          ><button
            class="icon-btn"
            aria-label="Обновить сайт"
            [disabled]="!can('reload') || !live() || busy()"
            (click)="navigate('RELOAD')"
          >
            <hg-icon name="refresh" /></button
          ><hg-icon name="lock" /><input
            aria-label="Адрес удалённой страницы"
            [(ngModel)]="url"
            [readOnly]="!can('navigate') || !live() || busy()"
            (keydown.enter)="navigate('GOTO')"
          />
        </div>
        @if (browser.privacyMode === 'LOGIN_PRIVATE') {
          <div class="secure-banner">
            <hg-icon name="lock" />Приватный вход. ChatGPT не видит экран и вводимые секреты.
          </div>
        }
      }
      <div
        class="browser-content"
        [class.with-history]="historyOpen()"
        [class.history-overlay]="historyOpen() && compactHistory()"
      >
        <div class="browser-video" [inert]="historyOpen() && compactHistory()">
          @if (session.data(); as browser) {
            <hg-remote-browser
              [session]="browser"
              [instanceId]="viewerInstanceId() || instance.id"
              [surface]="surface()"
              [ticket]="providedTicket()"
              [taskId]="taskId()"
              [paused]="paused()"
              (refresh)="refreshSnapshot()"
              (live)="live.set($event)"
              (stateChanged)="viewState.set($event)"
            />
          } @else {
            <ng-content />
          }
        </div>
        @if (historyOpen()) {
          <aside
            class="browser-history"
            aria-label="Ход выполнения"
            (keydown.escape)="closeHistory($event)"
          >
            <header>
              <h2>Ход выполнения</h2>
              <button class="icon-btn" aria-label="Закрыть ход выполнения" (click)="closeHistory()">
                <hg-icon name="close" />
              </button>
            </header>
            @if (taskId()) {
              <div class="history-controls">
                <label class="search"
                  ><hg-icon name="search" /><input
                    type="search"
                    aria-label="Поиск по событиям"
                    [(ngModel)]="eventQuery"
                    maxlength="200"
                    (keydown.enter)="searchEvents()"
                    (search)="searchEvents()"
                    placeholder="Найти событие"
                /></label>
                <details class="history-types">
                  <summary>Тип{{ eventTypes().length ? ' · ' + eventTypes().length : '' }}</summary>
                  <fieldset>
                    <legend class="sr-only">Тип событий</legend>
                    @for (type of historyTypes; track type.value) {
                      <label
                        ><input
                          type="checkbox"
                          [checked]="eventTypes().includes(type.value)"
                          (change)="toggleEventType(type.value)"
                        />{{ type.label }}</label
                      >
                    }
                  </fieldset>
                </details>
                <span class="muted">Новые сверху</span>
              </div>
              @if (events.invalidated()) {
                <button class="btn history-update" (click)="refreshEvents()">
                  Есть новые события · Обновить
                </button>
              }
              <hg-feedback
                [loading]="events.loading()"
                [error]="events.error()"
                (retry)="refreshEvents()"
              /><hg-data-table
                [columns]="eventColumns"
                [rows]="eventRows()"
                [page]="events.data()"
                [sizes]="[10]"
                (changed)="eventPage($event)"
                emptyTitle="Событий пока нет"
                emptyText="Подтверждённые действия появятся здесь."
              />
            } @else {
              <p class="panel-body muted">История приватного ввода не сохраняется.</p>
            }
          </aside>
        }
      </div>
      <footer class="browser-foot">
        @if (session.data(); as browser) {
          <span>{{ controlStatus() | label }}</span
          ><span>·</span><span>{{ browser.siteAccess | label }}</span>
        }
        <span class="spacer"></span>
        @if (countdown(); as countdown) {
          <span aria-label="Оставшееся время браузера"
            >{{ countdown.label }} {{ countdown.text }}</span
          >
          <span>·</span>
        }
        @if (session.data()) {
          <span role="status">{{ live() ? 'Живой просмотр' : (viewStatus() | label) }}</span>
        }
        @if (surface() === 'WEB' && taskId()) {
          <button
            class="btn"
            aria-label="Ход выполнения"
            [attr.aria-expanded]="historyOpen()"
            #historyTrigger
            (click)="toggleHistory(historyTrigger)"
          >
            <hg-icon name="history" />Шаги
          </button>
        }
      </footer>
      @if (countdown(); as countdown) {
        @if (countdown.warning) {
          <div class="notice warning">
            <strong>{{
              countdown.budget
                ? 'Заканчивается время работы браузера'
                : 'Браузер закроется при простое'
            }}</strong>
            <p>
              {{
                countdown.budget
                  ? 'Время работы ограничено бюджетом задачи. Переподключение не увеличивает лимит.'
                  : 'Продолжите работу на странице. Просмотр и переподключение не продлевают ожидание; выполняемая команда завершится до закрытия по простою.'
              }}
            </p>
            @if (countdown.expired) {
              <p role="status">Срок истёк. Ожидаем подтверждения состояния от сервера.</p>
            }
          </div>
        }
      }
      <hg-feedback
        [loading]="session.loading() && !session.data()"
        [error]="session.error()"
        (retry)="refreshSnapshot()"
      /><hg-mutation [action]="action" />
      @if (action.receipt()?.operationId; as operationId) {
        <hg-operation [id]="operationId" (stateChanged)="operation.set($event)" />
      }
      @if (notice()) {
        <p class="panel-body muted" role="status">{{ notice() }}</p>
      }
    </section>
    @if (closeDialog()) {
      <hg-dialog title="Закрыть браузер" [busy]="busy()" (closed)="closeDialog.set(false)"
        ><p>Задача останется на паузе. Память открытых страниц будет потеряна.</p>
        @if (can('save')) {
          <label class="checkbox"
            ><input type="checkbox" [(ngModel)]="saveChanges" />Сохранить изменения входа в
            подключение</label
          >
        } @else {
          <p class="small muted">Текущие изменения входа не сохранятся.</p>
        }
        <hg-mutation [action]="action" />
        <div dialog-actions class="flex">
          <button class="btn" [disabled]="busy()" (click)="closeDialog.set(false)">Отмена</button
          ><button class="btn danger" [disabled]="busy()" (click)="close()">Закрыть браузер</button>
        </div></hg-dialog
      >
    }
  `,
})
export class BrowserPanel {
  surface = input<'WEB' | 'WIDGET'>('WEB');
  providedSession = input<BrowserSession | null>(null);
  providedClock = input<BrowserClock | null>(null);
  providedTicket = input<ViewTicket | null>(null);
  viewerInstanceId = input<string>();
  sessionId = input<string | undefined>();
  taskId = input<string | undefined>();
  activeLoginOperationId = input<string>();
  changed = output<void>();
  openTask = output<void>();
  readonly instance = inject(BrowserInstance);
  private router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly clock = signal<BrowserClock | null>(null);
  private readonly hasClock = computed(() => this.clock() !== null);
  private readonly now = signal(Date.now());
  readonly countdown = computed(() => {
    const session = this.session.data();
    const clock = this.clock();
    if (
      !session ||
      session.state !== 'ACTIVE' ||
      !clock ||
      clock.browserSessionId !== session.id ||
      clock.allocationEpoch !== session.allocationEpoch ||
      clock.privacyEpoch !== session.privacyEpoch
    )
      return null;
    const budget = Date.parse(clock.budgetDeadlineAt) <= Date.parse(clock.idleDeadlineAt);
    const deadline = Date.parse(budget ? clock.budgetDeadlineAt : clock.idleDeadlineAt);
    const seconds = Math.max(0, Math.ceil((deadline - this.now()) / 1000));
    return {
      budget,
      label: budget ? 'Лимит работы:' : 'Без действий:',
      text: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
      warning: seconds <= 120,
      expired: seconds === 0,
    };
  });
  readonly session = new ServerResource<BrowserSession>(['tasks', 'sessions', 'connections']);
  readonly events = new ServerResource<TaskEventPage>(['events'], (value) => value, {
    invalidation: 'notify',
    resourceId: () => this.taskId(),
  });
  readonly action = new Mutation();
  readonly menu = signal(false);
  readonly paused = signal(false);
  readonly live = signal(false);
  readonly viewState = signal<ViewerState>('CONNECTING');
  readonly viewStatus = computed(() => {
    const browser = this.session.data();
    if (browser?.state !== 'ACTIVE') return browser?.state;
    if (!browser.capabilities['view']?.allowed) return 'VIEW_UNAVAILABLE';
    return this.viewState() === 'LIVE' ? 'VIEW_LIVE' : `VIEW_${this.viewState()}`;
  });
  readonly controlStatus = computed(() => {
    const browser = this.session.data();
    if (browser?.controlState !== 'ACTIVE') return 'NONE';
    if (browser.controlMode !== 'HUMAN') return browser.controlMode;
    return browser.controllerRelation === 'SELF'
      ? 'HUMAN'
      : browser.controllerRelation === 'OTHER'
        ? 'OTHER_CONTROLLER'
        : 'NONE';
  });
  readonly historyOpen = signal(false);
  readonly compactHistory = signal(false);
  private readonly panelElement = viewChild<ElementRef<HTMLElement>>('panel');
  readonly closeDialog = signal(false);
  readonly notice = signal('');
  readonly operation = signal<Pick<Operation, 'id' | 'state'> | null>(null);
  readonly busy = computed(() => {
    if (this.action.pending() || this.action.unknown()) return true;
    const receipt = this.action.receipt();
    if (!receipt) return false;
    const operation = this.operation();
    return (
      operation?.id !== receipt.operationId ||
      !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(operation.state)
    );
  });
  url = '';
  private addressBinding = '';
  eventQuery = '';
  private eventSearch = '';
  private historyTask = '';
  private historyTrigger?: HTMLButtonElement;
  readonly eventTypes = signal<readonly TaskEvent['type'][]>([]);
  readonly historyTypes: readonly { value: TaskEvent['type']; label: string }[] = [
    { value: 'BROWSER', label: 'Браузер' },
    { value: 'SYSTEM', label: 'Система' },
    { value: 'AGENT', label: 'Агент' },
  ];
  saveChanges = true;
  readonly browserSavePolicy = computed(() => this.session.data()?.savePolicy);
  readonly savePolicies: readonly { value: BrowserSavePolicy['policy']; label: string }[] = [
    { value: 'SAVE_ON_CLOSE', label: 'Сохранять изменения входа' },
    { value: 'DISCARD_CHANGES', label: 'Не сохранять изменения входа' },
  ];
  readonly eventColumns: Column[] = [
    { key: 'event', title: 'Событие' },
    { key: 'time', title: 'Время' },
  ];
  readonly eventRows = computed<TableItem[]>(
    () =>
      this.events.data()?.items.map((event) => ({
        id: event.id,
        values: {
          event: event.summary,
          time: new Date(event.occurredAt).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
      })) ?? [],
  );
  readonly primary = computed(() => {
    const browser = this.session.data();
    if (!browser) return null;
    const candidates =
      this.surface() === 'WIDGET'
        ? [
            { key: 'openLogin', label: 'Войти на сайт' },
            { key: 'openControl', label: 'Взять управление' },
          ]
        : [
            {
              key: 'release',
              label: browser.taskId ? 'Вернуть агенту' : 'Завершить ручное управление',
            },
            { key: 'continueLogin', label: 'Продолжить вход' },
            { key: 'transfer', label: 'Перенести управление сюда' },
            { key: 'login', label: 'Войти на сайт' },
            {
              key: 'acquire',
              label:
                browser.privacyMode === 'LOGIN_PRIVATE'
                  ? 'Восстановить управление'
                  : 'Взять управление',
            },
            { key: 'check', label: 'Проверить вход' },
          ].filter(
            (candidate) =>
              candidate.key !== 'continueLogin' ||
              browser.loginOperationId !== this.activeLoginOperationId(),
          );
    return (
      candidates.find(
        (candidate) =>
          browser.capabilities[candidate.key]?.visible !== false &&
          browser.capabilities[candidate.key]?.allowed,
      ) ??
      candidates.find((candidate) => browser.capabilities[candidate.key]?.visible) ??
      null
    );
  });
  constructor() {
    effect((cleanup) => {
      const panel = this.panelElement()?.nativeElement;
      if (!panel) return;
      const observer = new ResizeObserver(([entry]) => {
        if (entry) this.compactHistory.set(entry.contentRect.width < 680);
      });
      observer.observe(panel);
      cleanup(() => observer.disconnect());
    });
    effect(() => {
      const provided = this.providedClock();
      const session = this.session.data();
      if (
        this.surface() === 'WIDGET' &&
        session?.state === 'ACTIVE' &&
        provided &&
        provided.browserSessionId === session.id &&
        provided.allocationEpoch === session.allocationEpoch &&
        provided.privacyEpoch === session.privacyEpoch
      )
        this.clock.update((current) => newerClock(current, provided));
    });
    inject(Realtime)
      .browserClocks.pipe(takeUntilDestroyed(this.destroy))
      .subscribe((clock) => {
        const session = this.session.data();
        if (
          clock.browserSessionId === this.sessionId() &&
          (!session ||
            (session.state === 'ACTIVE' &&
              session.allocationEpoch === clock.allocationEpoch &&
              session.privacyEpoch === clock.privacyEpoch))
        )
          this.clock.update((current) => newerClock(current, clock));
      });
    effect(() => {
      const session = this.session.data();
      const sessionId = this.sessionId();
      if (!session) {
        this.clock.update((current) => (current?.browserSessionId === sessionId ? current : null));
        return;
      }
      const clock = sessionClock(session);
      this.clock.update((current) => (clock ? newerClock(current, clock) : null));
    });
    effect((cleanup) => {
      if (!this.hasClock()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      cleanup(() => clearInterval(timer));
    });
    effect(() => {
      if (this.surface() === 'WEB' && this.sessionId())
        this.session.load(`/browser-sessions/${this.sessionId()}`, {
          controllerInstanceId: this.instance.id,
        });
      else if (this.surface() === 'WIDGET') this.session.data.set(this.providedSession());
      else this.session.clear();
    });
    effect(() => {
      const session = this.session.data();
      if (!session) return;
      const address = session.currentUrl ?? '';
      const binding = `${session.id}:${address}`;
      // Lease and capability refreshes must not erase an address being edited.
      if (binding !== this.addressBinding) {
        this.addressBinding = binding;
        this.url = address;
      }
    });
    effect(() => {
      const task = this.taskId() ?? '';
      const visible = this.surface() === 'WEB' && this.historyOpen();
      untracked(() => {
        if (task !== this.historyTask) {
          this.historyTask = task;
          this.events.clear();
          this.eventQuery = '';
          this.eventSearch = '';
          this.eventTypes.set([]);
        }
        if (visible && task) this.readEvents(this.events.data()?.page ?? 1);
        else this.events.cancelRead();
      });
    });
  }
  refreshSnapshot() {
    if (this.surface() === 'WEB') this.session.refresh();
    else this.changed.emit();
  }
  can(key: string) {
    if (this.surface() === 'WIDGET' && key !== 'openLogin' && key !== 'openControl') return false;
    return this.session.data()?.capabilities[key]?.allowed ?? false;
  }
  visible(key: string) {
    if (this.surface() === 'WIDGET') return false;
    const capability = this.session.data()?.capabilities[key];
    return capability?.visible ?? capability?.allowed ?? false;
  }
  perform(key: string) {
    const session = this.session.data();
    if (!session || !this.can(key) || this.busy()) return;
    this.menu.set(false);
    if (this.surface() === 'WIDGET') {
      this.openTask.emit();
      return;
    }
    if (key === 'continueLogin' && session.loginOperationId) {
      void this.router.navigate(['/login-operations', session.loginOperationId]);
      return;
    }
    if (key === 'login' && session.connectionId) {
      this.action.run(
        'POST',
        `/connections/${session.connectionId}/login`,
        { taskId: this.taskId(), controllerInstanceId: this.instance.id },
        (receipt) => void this.router.navigate(['/login-operations', receipt.resource.id]),
      );
      return;
    }
    let body: object;
    if (key === 'release') {
      body = {
        controlEpoch: session.controlEpoch,
        controllerInstanceId: this.instance.id,
        intent: 'CONTINUE_IF_ALLOWED',
      };
    } else if (key === 'acquire' || key === 'transfer') {
      body = {
        expectedVersion: session.version,
        controlEpoch: session.controlEpoch,
        controllerInstanceId: this.instance.id,
        privateLogin: session.privacyMode === 'LOGIN_PRIVATE',
        transferExistingController: key === 'transfer',
      };
    } else if (key === 'save') {
      body = this.saveInput(session);
    } else if (key === 'snapshot') {
      body = this.controlInput(session);
    } else {
      body = { expectedProfileVersion: session.currentProfileVersion ?? null };
    }
    const suffix =
      key === 'acquire' || key === 'transfer'
        ? 'control/acquire'
        : key === 'release'
          ? 'control/release'
          : key === 'snapshot'
            ? 'snapshots'
            : key;
    const path =
      key === 'check' && session.connectionId
        ? `/connections/${session.connectionId}/check`
        : `/browser-sessions/${session.id}/${suffix}`;
    this.action.run('POST', path, body, () => {
      this.session.refresh();
      this.changed.emit();
    });
  }
  navigate(action: BrowserNavigation['action']) {
    const session = this.session.data();
    const capability = action === 'GOTO' ? 'navigate' : action.toLowerCase();
    if (!session || !this.can(capability) || !this.live() || this.busy()) return;
    const input: BrowserNavigation = {
      ...this.controlInput(session),
      action,
      url: action === 'GOTO' ? this.url : undefined,
    };
    this.action.run('POST', `/browser-sessions/${session.id}/navigation`, input, () =>
      this.session.refresh(),
    );
  }
  close() {
    const session = this.session.data();
    if (!session || !this.can('close') || this.busy()) return;
    const input: BrowserClose = {
      ...this.saveInput(session),
      saveChanges: this.saveChanges,
    };
    this.action.run('POST', `/browser-sessions/${session.id}/close`, input, () => {
      this.closeDialog.set(false);
      this.session.refresh();
      this.changed.emit();
    });
  }
  openClose() {
    this.saveChanges = this.can('save') && this.session.data()?.savePolicy === 'SAVE_ON_CLOSE';
    this.closeDialog.set(true);
    this.menu.set(false);
  }
  setSavePolicy(policy: BrowserSavePolicy['policy']) {
    const session = this.session.data();
    if (!session || session.connectionVersion == null || !this.can('savePolicy') || this.busy())
      return;
    const input: BrowserSavePolicy = {
      expectedVersion: session.version,
      expectedConnectionVersion: session.connectionVersion,
      policy,
    };
    this.action.run('PATCH', `/browser-sessions/${session.id}/save-policy`, input, () => {
      this.session.refresh();
      this.changed.emit();
    });
  }
  private saveInput(session: BrowserSession): BrowserSave {
    return {
      ...this.controlInput(session),
      expectedProfileVersion: session.currentProfileVersion ?? null,
    };
  }
  private controlInput(session: BrowserSession): BrowserSnapshot {
    return {
      expectedVersion: session.version,
      controlEpoch: session.controlEpoch,
      pageEpoch: session.pageEpoch,
      controllerInstanceId: this.instance.id,
    };
  }
  readEvents(page: number) {
    if (this.taskId())
      this.events.load(`/tasks/${this.taskId()}/events`, {
        page,
        pageSize: 10,
        q: this.eventSearch,
        type: this.eventTypes(),
        sort: 'sequence',
        direction: 'desc',
      });
  }
  eventPage(query: Readonly<Record<string, unknown>>) {
    this.readEvents(typeof query['page'] === 'number' ? query['page'] : 1);
  }
  searchEvents() {
    this.eventSearch = this.eventQuery.trim();
    this.readEvents(1);
  }
  toggleEventType(type: TaskEvent['type']) {
    this.eventTypes.update((types) =>
      types.includes(type) ? types.filter((value) => value !== type) : [...types, type].sort(),
    );
    this.readEvents(1);
  }
  refreshEvents() {
    this.events.refresh({ page: 1 });
  }
  toggleHistory(trigger: HTMLButtonElement) {
    this.historyTrigger = trigger;
    if (this.historyOpen()) this.closeHistory();
    else this.historyOpen.set(true);
  }
  closeHistory(event?: Event) {
    event?.stopPropagation();
    if (event?.target instanceof HTMLElement) {
      const filter = event.target.closest('details');
      if (filter instanceof HTMLDetailsElement && filter.open) {
        filter.open = false;
        filter.querySelector('summary')?.focus();
        return;
      }
    }
    this.historyOpen.set(false);
    this.historyTrigger?.focus();
  }
  fullscreen(element: HTMLElement) {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void element
        .requestFullscreen()
        .catch(() => this.notice.set('Полноэкранный просмотр недоступен в этом окне.'));
  }
  copyUrl() {
    void navigator.clipboard
      .writeText(this.session.data()?.currentUrl ?? '')
      .then(() => this.notice.set('Адрес скопирован'))
      .catch(() => this.notice.set('Копирование недоступно. Выделите адрес в строке браузера.'));
  }
}
