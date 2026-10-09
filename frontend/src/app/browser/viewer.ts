import { Icon } from '../shared/icon';
import {
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
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Api, ApiError, errorMessage } from '../core/api';
import { BrowserSession, Connection, Task, ticketSchema } from '../core/models';
import { Status } from '../shared/ui';
import { A11yModule } from '@angular/cdk/a11y';
import { Tooltip } from '../shared/tooltip';
import { BrowserSessionPanel } from './session-panel';

export function browserViewerId(): string {
  let id = sessionStorage.getItem('helm-viewer-id');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('helm-viewer-id', id);
  }
  return id;
}
@Component({
  selector: 'hg-browser',
  imports: [Icon, Status, A11yModule, Tooltip, BrowserSessionPanel],
  styleUrl: './viewer.css',
  styles: `
    .viewer-recovery {
      position: absolute;
      inset: 0;
      background: #f7f9fc;
    }
    .browser-step {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  template: ` <section
    class="browser-card"
    [class.browser-expanded]="expanded()"
    [cdkTrapFocus]="expanded()"
    [attr.role]="expanded() ? 'dialog' : null"
    [attr.aria-modal]="expanded() ? true : null"
    aria-label="Браузер"
    (keydown.escape)="collapse()"
  >
    <header class="browser-toolbar">
      <label class="browser-address">
        <hg-icon [name]="browser()?.privateMode ? 'lock' : 'globe'" />
        <input aria-label="Адрес удалённого браузера" [value]="address()"
          [placeholder]="browser()?.privateMode ? 'Защищённый вход · адрес сайта' : 'Адрес появится после запуска'"
          [readOnly]="role() !== 'CONTROLLER' || !connected() || !streamEnabled()"
          (focus)="editingAddress.set(true)" (blur)="editingAddress.set(false)"
          (input)="addressInput($event)" (keydown.enter)="navigate($event)" />
      </label>
      <div class="browser-controls">
        <ng-content />
        @if (sessionPanel()?.canConfirm() && !browser()?.loginConfirmed) {
          <button
            class="button small"
            [disabled]="sessionPanel()?.busy()"
            (click)="sessionPanel()?.confirm()"
          >
            Я завершил вход
          </button>
        }
        @if (browser()?.loginConfirmed) {
          <span
            [hgTooltip]="sessionPanel()?.saveDisabledReason() || ''"
            [attr.tabindex]="sessionPanel()?.saveDisabledReason() ? 0 : null"
          >
            <button
              class="button primary small"
              [disabled]="!!sessionPanel()?.saveDisabledReason()"
              (click)="saveSession()"
            >
              Сохранить сессию
            </button>
          </span>
        }
        <div class="browser-view-tools">
        @if (browser() && !['CLOSED', 'LOST'].includes(browser()?.status || '')) {
          <button class="icon-button" [attr.aria-label]="streamEnabled() ? 'Остановить трансляцию' : 'Возобновить трансляцию'"
            [hgTooltip]="streamEnabled() ? 'Остановить трансляцию' : 'Возобновить трансляцию'"
            [attr.aria-pressed]="!streamEnabled()" (click)="toggleStream()">
            <hg-icon [name]="streamEnabled() ? 'video-off' : 'video'" />
          </button>
        }
        <button #expandButton
          class="icon-button"
          [attr.aria-label]="expanded() ? 'Свернуть браузер' : 'Развернуть браузер'"
          [hgTooltip]="expanded() ? 'Свернуть' : 'Развернуть'"
          (click)="toggleExpanded()"
        >
          <hg-icon [name]="expanded() ? 'collapse' : 'expand'" />
        </button>
        </div>
        @if (canClose()) {
          <button class="button small browser-close" [disabled]="busy() || browser()?.controlOwner === 'TRANSFERRING'"
            (click)="closeBrowser.emit()"><hg-icon name="power" />Закрыть браузер</button>
        }
      </div>
    </header>
    @if (addressError()) { <p class="error-banner" role="alert">{{ addressError() }}</p> }
    @if (role() === 'CONTROLLER' && task()) {
      <div class="browser-inline-notice"><hg-icon name="pause" />Агент на паузе. Вы управляете этим браузером.</div>
    }
    @if (sessionPanel()?.error() || browser()?.profileSaveError) {
      <p class="error-banner" role="alert">
        {{ sessionPanel()?.error() || profileError() }}
        @if (sessionPanel()?.saveDisabledReason()) {
          {{ sessionPanel()?.saveDisabledReason() }}
        }
      </p>
    }
    @if (sessionPanel()?.message()) {
      <p class="sr-only" role="status">{{ sessionPanel()?.message() }}</p>
    }
    <div #stage class="browser-stage" [style.height.px]="expanded() ? null : viewportHeight()">
      <div #viewport class="browser-viewport">
        @if (!browser() || ['CLOSED', 'LOST'].includes(browser()?.status || '')) {
          <div class="viewer-placeholder">
            <span class="viewer-mark"><hg-icon name="browser" /></span>
            <h3>{{ browser() ? 'Браузер закрыт' : 'Браузер ещё не запущен' }}</h3>
            <p>{{ task() ? 'Шаги и результаты задачи сохранены.' : 'Подключение и сохранённый вход доступны.' }}</p>
            @if (canOpen()) {
              <button class="button" [disabled]="busy()" (click)="openBrowser.emit()"><hg-icon name="browser" />Открыть браузер</button>
            }
          </div>
        } @else if (!streamEnabled()) {
          <div class="viewer-placeholder" role="status">
            <span class="viewer-mark"><hg-icon name="video-off" /></span>
            <h3>Трансляция остановлена</h3>
            <p>{{ role() === 'CONTROLLER' ? 'Браузер открыт. Управление остаётся у вас; ввод временно отключён.' : 'Браузер продолжает работать. Состояние задачи не изменено.' }}</p>
            <button class="button" (click)="toggleStream()"><hg-icon name="video" />Возобновить трансляцию</button>
          </div>
        } @else if (!viewAllowed()) {
          <div class="viewer-placeholder">
            <span class="viewer-mark"><hg-icon name="shield" /></span>
            <h3>
              @if (browser()?.status === 'CLOSING') {
                Браузер закрывается
              } @else if (browser()?.status === 'UNREACHABLE') {
                Нет связи с браузером
              } @else {
                {{
                  browser()?.controlOwner === 'TRANSFERRING'
                    ? browser()?.loginConfirmed
                      ? 'Сохраняем сессию'
                      : 'Передаём управление'
                    : browser()?.privateMode
                      ? 'Идёт защищённый вход'
                      : 'Просмотр недоступен'
                }}
              }
            </h3>
            <p>
              @if (browser()?.status === 'CLOSING') {
                Ожидаем сохранения данных и завершения закрытия.
              } @else if (browser()?.status === 'UNREACHABLE') {
                Подключение восстановится автоматически.
              } @else {
                {{
                  browser()?.controlOwner === 'TRANSFERRING'
                    ? browser()?.loginConfirmed
                      ? 'Ожидаем подтверждения записи сессии.'
                      : 'Дождитесь подтверждения браузера.'
                    : browser()?.privateMode
                      ? 'Содержимое защищённой страницы скрыто от других наблюдателей.'
                      : 'Состояние браузера обновляется автоматически. История и результат доступны отдельно.'
                }}
              }
            </p>
          </div>
        } @else if (src(); as url) {
          <iframe
            #frame
            [src]="url"
            [style.visibility]="connected() ? 'visible' : 'hidden'"
            [attr.aria-hidden]="!connected()"
            [attr.tabindex]="connected() ? null : -1"
            (load)="iframeLoaded()"
            title="Удалённый браузер"
            allow="clipboard-read; clipboard-write"
            referrerpolicy="no-referrer"
          ></iframe>
          @if (!connected()) {
            <div class="viewer-placeholder viewer-recovery" role="status">
              <span class="viewer-mark"><hg-icon name="browser" /></span>
              <h3>
                {{ exhausted() ? 'Просмотр временно недоступен' : 'Восстанавливаем просмотр…' }}
              </h3>
              <p>
                {{ error() || 'Последний кадр скрыт. Подключение восстановится автоматически.' }}
              </p>
              @if (exhausted()) {
                <button class="button" [disabled]="connecting()" (click)="retry()">
                  Подключиться снова
                </button>
              }
            </div>
          }
        } @else {
          <div class="viewer-placeholder" role="status">
            <span class="viewer-mark"><hg-icon name="browser" /></span>
            <h3>{{ exhausted() ? 'Просмотр временно недоступен' : 'Подключаем просмотр…' }}</h3>
            <p>
              {{ error() || 'Просмотр подключится автоматически. Сеанс браузера сохраняется.' }}
            </p>
            @if (exhausted()) {
              <button class="button" [disabled]="connecting()" (click)="retry()">
                Подключиться снова
              </button>
            }
          </div>
        }
      </div>
      <aside
        class="browser-drawer"
        [hidden]="!panel()"
        [attr.aria-label]="panel() === 'steps' ? 'Шаги' : 'Сессия'"
      >
        <header>
          <h2>{{ panel() === 'steps' ? 'Шаги' : 'Сессия' }}</h2>
          <button
            class="icon-button"
            aria-label="Закрыть панель"
            hgTooltip="Закрыть панель"
            (click)="togglePanel(panel())"
          >
            <hg-icon name="close" />
          </button>
        </header>
        <div class="browser-drawer-body" [hidden]="panel() !== 'steps'">
          <ng-content select="[browserSteps]" />
        </div>
        @if (browser(); as current) {
          <div class="browser-drawer-body browser-session-body" [hidden]="panel() !== 'session'">
            <hg-browser-session
              [browser]="current"
              [controller]="role() === 'CONTROLLER'"
              [allowed]="allowSession()"
              [active]="panel() === 'session'"
              [connectionContext]="connection() !== null"
              (changed)="sessionChanged.emit($event)"
            />
          </div>
        }
      </aside>
    </div>
    <footer #footer class="browser-footer">
      <span class="connection-dot" [class.online]="connected()"></span
      >{{
        connected()
          ? role() === 'CONTROLLER'
            ? 'Вы управляете'
            : 'Только просмотр'
          : !streamEnabled() ? 'Трансляция остановлена' : 'Просмотр не подключён'
      }}
      @if (browser(); as item) {
        <hg-status [value]="item.status" />
      }
      @if (summary()) {
        <span class="browser-step" [hgTooltip]="summary()">{{ summary() }}</span>
      }
      <span class="spacer"></span>
      @if (steps()) {
        <button
          class="text-button"
          [class.active]="panel() === 'steps'"
          [attr.aria-expanded]="panel() === 'steps'"
          hgTooltip="Шаги выполнения задачи"
          (click)="togglePanel('steps')"
        >
          <hg-icon name="panel-right" />Шаги <b>{{ stepCount() }}</b>
        </button>
      }
      @if (browser()) {
        <button
          class="text-button"
          [class.active]="panel() === 'session'"
          [attr.aria-expanded]="panel() === 'session'"
          hgTooltip="Авторизация и сохранение сессии"
          (click)="togglePanel('session')"
        >
          <hg-icon name="info" />Сессия
        </button>
      }
    </footer>
  </section>`,
})
export class BrowserViewer {
  readonly steps = input(false);
  readonly stepCount = input(0);
  readonly canClose = input(false);
  readonly canOpen = input(false);
  readonly busy = input(false);
  readonly closeBrowser = output<void>();
  readonly openBrowser = output<void>();
  readonly streamEnabled = signal(true);
  readonly address = signal('');
  readonly addressError = signal('');
  readonly editingAddress = signal(false);
  private readonly expandButton = viewChild<ElementRef<HTMLButtonElement>>('expandButton');
  toggleStream() {
    this.streamEnabled.update(value => !value);
    const id = this.browser()?.id;
    if (id) sessionStorage.setItem('helm-stream:' + id, this.streamEnabled() ? 'on' : 'off');
  }
  toggleExpanded() {
    if (this.expanded()) this.collapse();
    else this.expanded.set(true);
  }
  collapse() {
    if (!this.expanded()) return;
    this.expanded.set(false);
    this.expandButton()?.nativeElement.focus();
  }
  addressInput(event: Event) {
    if (event.target instanceof HTMLInputElement) this.address.set(event.target.value);
  }
  navigate(event: Event) {
    event.preventDefault();
    if (this.role() !== 'CONTROLLER' || !this.connected() || !this.viewAllowed()) return;
    try {
      const url = new URL(this.address());
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) throw new Error();
      this.frame()?.nativeElement.contentWindow?.postMessage({ type: 'helm-viewer-navigate', url: url.href, viewerEpoch: String(this.generation) }, location.origin);
      this.addressError.set('');
      this.frame()?.nativeElement.focus();
    } catch {
      this.addressError.set('Введите полный адрес http:// или https:// без логина и пароля.');
    }
  }
  readonly allowSession = input(true);
  readonly stepsOpen = output<boolean>();
  readonly sessionChanged = output<BrowserSession>();
  readonly panel = signal<'steps' | 'session' | null>(null);
  readonly sessionPanel = viewChild(BrowserSessionPanel);
  togglePanel(panel: 'steps' | 'session' | null) {
    this.panel.set(this.panel() === panel ? null : panel);
    this.stepsOpen.emit(this.panel() === 'steps');
  }
  saveSession() {
    void this.sessionPanel()?.save();
  }
  readonly profileError = computed(() => {
    const messages: Record<string, string> = {
      PROFILE_TOO_LARGE: 'Профиль сайта превышает 256 МиБ. Прежняя сессия не изменена.',
      PROFILE_RECORD_TOO_LARGE: 'Отдельная запись сайта превышает 16 МиБ. Прежняя сессия не изменена.',
      PROFILE_COMPLEXITY_LIMIT: 'Структура данных сайта превышает допустимую сложность. Прежняя сессия не изменена.',
      PROFILE_STORAGE_UNAVAILABLE: 'Хранилище сессий временно недоступно. Ожидаем подтверждения сохранения.',
      PROFILE_INVALID: 'Не удалось проверить целостность профиля. Прежняя сессия не изменена.',
      PROFILE_SNAPSHOT_CHANGED: 'Данные сайта изменились во время сохранения. Повторите сохранение.',
      PROFILE_UNSUPPORTED_VALUE: 'Сайт использует неподдерживаемый тип данных. Прежняя сессия не изменена.',
      PROFILE_REVISION_CHANGED: 'Сохранённая сессия изменилась в другом окне. Повторите сохранение.',
    };
    return messages[this.browser()?.profileSaveError ?? ''] ?? 'Не удалось сохранить сессию. Повторите сохранение.';
  });
  readonly summary = input('');
  readonly browser = input<BrowserSession | null>(null);
  readonly connection = input<Connection | null>(null);
  readonly task = input<Pick<Task, 'id' | 'title'> | null>(null);
  readonly role = input<'VIEWER' | 'CONTROLLER'>('VIEWER');
  readonly transport = output<string>();
  readonly src = signal<SafeResourceUrl | null>(null);
  readonly error = signal('');
  readonly controlLost = output<void>();
  readonly connected = signal(false);
  readonly connecting = signal(false);
  readonly expanded = signal(false);
  readonly exhausted = signal(false);
  private readonly frameAspect = signal(1440 / 900);
  private readonly viewportWidth = signal(0);
  private readonly availableHeight = signal(420);
  readonly viewportHeight = computed(() =>
    Math.min(
      this.availableHeight(),
      this.viewportWidth() ? this.viewportWidth() / this.frameAspect() : 420,
    ),
  );
  readonly viewAllowed = computed(() => {
    const browser = this.browser();
    return (
      !!browser?.canView &&
      this.streamEnabled() &&
      browser.status === 'LIVE' &&
      browser.controlOwner !== 'TRANSFERRING' &&
      (!browser.privateMode || this.role() === 'CONTROLLER')
    );
  });
  private readonly api = inject(Api);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroy = inject(DestroyRef);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');
  private readonly footer = viewChild<ElementRef<HTMLElement>>('footer');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private generation = 0;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retrying = false;
  private lastBrowserId = '';
  private preferenceBrowserId = '';
  private loaded = false;
  private pendingReconnectUrl: string | null = null;
  private online = navigator.onLine;
  private readonly identity = computed(() => {
    const browser = this.browser();
    return browser
      ? [browser.id, this.viewAllowed(), browser.controlEpoch, this.role()].join(':')
      : '';
  });
  constructor() {
    effect(() => {
      const browser = this.browser();
      if ((browser?.id ?? '') !== this.preferenceBrowserId) {
        this.preferenceBrowserId = browser?.id ?? '';
        this.streamEnabled.set(!browser || sessionStorage.getItem('helm-stream:' + browser.id) !== 'off');
        this.addressError.set('');
      }
      if (!this.editingAddress()) this.address.set(browser?.currentUrl ?? '');
    });
    effect((onCleanup) => {
      const viewport = this.viewport()?.nativeElement;
      const stage = this.stage()?.nativeElement;
      const footer = this.footer()?.nativeElement;
      if (!viewport || !stage || !footer || this.expanded()) return;
      const measure = () => {
        this.viewportWidth.set(viewport.getBoundingClientRect().width);
        // Restored scroll positions must not reserve space for headings already off screen.
        const top = Math.max(0, stage.getBoundingClientRect().top);
        this.availableHeight.set(
          Math.max(120, window.innerHeight - top - footer.getBoundingClientRect().height - 16),
        );
      };
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      observer.observe(footer);
      // Notices and headings above the viewer can change after live updates.
      for (
        let parent = this.host.nativeElement.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        observer.observe(parent);
        if (parent.tagName === 'MAIN') break;
      }
      window.addEventListener('resize', measure);
      onCleanup(() => {
        observer.disconnect();
        window.removeEventListener('resize', measure);
      });
    });
    effect(() => {
      this.identity();
      untracked(() => {
        const browser = this.browser();
        this.cancel();
        this.connected.set(false);
        this.attempts = 0;
        this.exhausted.set(false);
        this.error.set('');
        if (browser?.id !== this.lastBrowserId || !this.viewAllowed()) {
          this.src.set(null);
          this.loaded = false;
          this.pendingReconnectUrl = null;
        }
        this.lastBrowserId = browser?.id ?? '';
        if (this.viewAllowed()) void this.connect();
      });
    });
    const listener = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== location.origin ||
        !this.online ||
        event.source !== this.frame()?.nativeElement.contentWindow ||
        typeof event.data !== 'object' ||
        event.data === null ||
        !('type' in event.data) ||
        event.data.type !== 'helm-viewer' ||
        !('state' in event.data) ||
        !('viewerEpoch' in event.data) ||
        event.data.viewerEpoch !== String(this.generation) ||
        !this.viewAllowed()
      )
        return;
      const state = event.data.state;
      if (typeof state !== 'string') return;
      if ('width' in event.data && 'height' in event.data) {
        const width = event.data.width;
        const height = event.data.height;
        if (
          typeof width === 'number' &&
          typeof height === 'number' &&
          Number.isInteger(width) &&
          Number.isInteger(height) &&
          width > 0 &&
          width <= 8192 &&
          height > 0 &&
          height <= 8192
        ) {
          this.frameAspect.set(width / height);
        }
      }
      if (state === 'resized') return;
      this.transport.emit(state);
      this.connected.set(state === 'connected');
      if (state === 'connected') {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.retrying = false;
        this.attempts = 0;
        this.exhausted.set(false);
        this.error.set('');
      } else if (state === 'disconnected' || state === 'error') this.scheduleReconnect();
    };
    const recover = () => {
      this.online = navigator.onLine;
      if (!this.online) return;
      if (document.visibilityState !== 'hidden' && this.viewAllowed() && !this.connected())
        this.retry();
    };
    const offline = () => {
      this.online = false;
      this.cancel();
      this.connected.set(false);
      this.src.set(null);
      this.loaded = false;
      this.pendingReconnectUrl = null;
      this.error.set('Нет сети. Последний кадр скрыт; просмотр восстановится после подключения.');
    };
    window.addEventListener('message', listener);
    window.addEventListener('offline', offline);
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    this.destroy.onDestroy(() => {
      this.cancel();
      window.removeEventListener('message', listener);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    });
  }
  retry() {
    this.attempts = 0;
    this.exhausted.set(false);
    void this.connect();
  }
  iframeLoaded() {
    this.loaded = true;
    if (this.pendingReconnectUrl) {
      this.sendReconnect(this.pendingReconnectUrl);
      this.pendingReconnectUrl = null;
    }
  }
  private sendReconnect(url: string) {
    this.frame()?.nativeElement.contentWindow?.postMessage(
      { type: 'helm-viewer-reconnect', url },
      location.origin,
    );
  }
  private cancel() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.retrying = false;
    this.connecting.set(false);
  }
  private scheduleReconnect() {
    this.connected.set(false);
    if (this.retrying && this.timer) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.destroy.destroyed || !this.viewAllowed() || !this.online) return;
    if (this.attempts >= 5) {
      this.exhausted.set(true);
      this.error.set(
        'Связь недоступна. При возвращении на страницу или восстановлении сети повторим подключение.',
      );
      return;
    }
    this.retrying = true;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.retrying = false;
        void this.connect();
      },
      Math.min(1000 * 2 ** this.attempts++, 15000) + Math.random() * 500,
    );
  }
  private async connect() {
    const browser = this.browser();
    if (!browser || !this.viewAllowed() || this.destroy.destroyed || !this.online) return;
    this.cancel();
    const generation = this.generation;
    this.connected.set(false);
    this.connecting.set(true);
    try {
      const ticket = await this.api.mutate(
        '/api/browser-sessions/' + browser.id + '/ticket',
        { role: this.role(), viewerId: browserViewerId() },
        ticketSchema,
      );
      const url = new URL(ticket.url, location.origin);
      if (
        url.origin !== location.origin ||
        url.pathname !== '/browser/novnc/helm.html' ||
        url.username ||
        url.password
      )
        throw new Error('Сервер вернул недопустимый адрес просмотра.');
      if (generation !== this.generation) return;
      url.searchParams.set('viewerEpoch', String(generation));
      if (this.src()) {
        if (this.loaded) this.sendReconnect(url.href);
        else this.pendingReconnectUrl = url.href;
      } else this.src.set(this.sanitizer.bypassSecurityTrustResourceUrl(url.href));
      this.error.set('');
      this.timer = setTimeout(() => {
        this.timer = null;
        if (generation === this.generation && !this.connected()) this.scheduleReconnect();
      }, 10000);
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.error.set(errorMessage(error));
        if (error instanceof ApiError && error.status === 403 && this.role() === 'CONTROLLER') {
          sessionStorage.removeItem('helm-controller:' + browser.id);
          this.controlLost.emit();
        } else this.scheduleReconnect();
      }
    } finally {
      if (generation === this.generation) this.connecting.set(false);
    }
  }
}
