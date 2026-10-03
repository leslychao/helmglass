import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
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
  Page,
  TaskEvent,
  ViewTicket,
} from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { Mutation } from '../../core/api/mutation';
import { BrowserInstance } from './browser-instance';
import { RemoteBrowser } from '../remote-browser/remote-browser';
import { Icon } from '../icon/icon';
import { Status, LabelPipe } from '../status/status';
import { Feedback, MutationFeedback } from '../feedback/feedback';
import { Dialog } from '../dialog/dialog';
import { Column, DataTable, TableItem } from '../data-table/data-table';
import { AsyncOperation } from '../async-operation/async-operation';

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
            <hg-status [value]="browser.state" />
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
          @if (surface() === 'WEB') {
            <button
              class="icon-btn"
              aria-label="Ход выполнения"
              [attr.aria-expanded]="historyOpen()"
              (click)="historyOpen.set(!historyOpen())"
            >
              <hg-icon name="history" />
            </button>
          }
        </div>
        @if (browser.privacyMode === 'LOGIN_PRIVATE') {
          <div class="secure-banner">
            <hg-icon name="lock" />Приватный вход. ChatGPT не видит экран и вводимые секреты.
          </div>
        }
        <div class="browser-content" [class.with-history]="historyOpen()">
          <div class="browser-video">
            <hg-remote-browser
              [session]="browser"
              [instanceId]="viewerInstanceId() || instance.id"
              [surface]="surface()"
              [ticket]="providedTicket()"
              [taskId]="taskId()"
              [paused]="paused()"
              (refresh)="refreshSnapshot()"
              (live)="live.set($event)"
            />
          </div>
          @if (historyOpen()) {
            <aside class="browser-history">
              <header>
                <h2>Ход выполнения</h2>
                <button
                  class="icon-btn"
                  aria-label="Закрыть ход выполнения"
                  (click)="historyOpen.set(false)"
                >
                  <hg-icon name="close" />
                </button>
              </header>
              @if (taskId()) {
                <label class="search"
                  ><hg-icon name="search" /><input
                    type="search"
                    aria-label="Поиск по событиям"
                    [(ngModel)]="eventQuery"
                    (keydown.enter)="readEvents(1)"
                    placeholder="Поиск событий" /></label
                ><hg-feedback
                  [loading]="events.loading()"
                  [error]="events.error()"
                  (retry)="events.refresh()"
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
          <span>{{ browser.controlMode | label }}</span
          ><span>·</span><span>{{ browser.siteAccess | label }}</span
          ><span class="spacer"></span
          ><span role="status">{{
            live() ? 'Живой просмотр' : paused() ? 'Просмотр на паузе' : 'Ожидание кадров'
          }}</span>
        </footer>
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
  providedTicket = input<ViewTicket | null>(null);
  viewerInstanceId = input<string>();
  sessionId = input.required<string>();
  taskId = input<string | undefined>();
  changed = output<void>();
  openTask = output<void>();
  readonly instance = inject(BrowserInstance);
  private router = inject(Router);
  readonly session = new ServerResource<BrowserSession>(['tasks', 'sessions', 'connections']);
  readonly events = new ServerResource<Page<TaskEvent>>(['events']);
  readonly action = new Mutation();
  readonly menu = signal(false);
  readonly paused = signal(false);
  readonly live = signal(false);
  readonly historyOpen = signal(false);
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
          ];
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
    effect(() => {
      if (this.surface() === 'WEB')
        this.session.load(`/browser-sessions/${this.sessionId()}`, {
          controllerInstanceId: this.instance.id,
        });
      else this.session.data.set(this.providedSession());
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
      if (this.surface() === 'WEB' && this.historyOpen() && this.taskId()) this.readEvents(1);
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
        q: this.eventQuery,
        sort: 'sequence',
        direction: 'desc',
      });
  }
  eventPage(query: Readonly<Record<string, unknown>>) {
    this.readEvents(typeof query['page'] === 'number' ? query['page'] : 1);
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
