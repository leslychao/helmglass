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
import { BrowserSession, Connection, Task, browserSchema, ticketSchema } from '../core/models';
import { Status } from '../shared/ui';
import { A11yModule } from '@angular/cdk/a11y';
import { Tooltip } from '../shared/tooltip';
import { BrowserSessionPanel } from './session-panel';
import { BrowserPageLifetime } from './page-lifetime';

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
        <div class="browser-control-actions">
          @if (connection() && !loginSaved() && !sessionPanel()?.completed()) {
            <button
              class="button primary small"
              [disabled]="busy() || !sessionPanel()?.canFinish() || sessionPanel()?.busy()"
              [hgTooltip]="busy() ? 'Дождитесь завершения действия с браузером.' : (sessionPanel() ? (sessionPanel()?.finishDisabledReason() || 'Сохранить сессию и вернуться в подключение') : 'Дождитесь доступности браузера.')"
              (click)="sessionPanel()?.finish()"
            >
              {{ sessionPanel()?.finishing() || sessionPanel()?.busy() ? 'Сохраняем…' : 'Завершить вход' }}
            </button>
          }
          <ng-content />
        </div>
        <div class="browser-view-tools">
        @if (role() === 'CONTROLLER' && viewAllowed()) {
          <button #clipboardButton class="icon-button" aria-label="Буфер обмена" hgTooltip="Буфер обмена"
            [attr.aria-expanded]="clipboardOpen()" [disabled]="!connected()"
            (click)="toggleClipboard()"><hg-icon name="copy" /></button>
        }
        @if (allowStreamPause() && browser() && !['CLOSED', 'LOST'].includes(browser()?.status || '')) {
          <button class="icon-button" [attr.aria-label]="streamEnabled() ? 'Остановить трансляцию' : 'Возобновить трансляцию'"
            [hgTooltip]="streamEnabled() ? 'Остановить трансляцию' : 'Возобновить трансляцию'"
            [attr.aria-pressed]="!streamEnabled()" (click)="toggleStream()">
            <hg-icon [name]="streamEnabled() ? 'video-off' : 'video'" />
          </button>
        }
        @if (canClose()) {
          <button class="icon-button browser-close"
            aria-label="Закрыть браузер" hgTooltip="Закрыть браузер"
            [disabled]="busy()"
            (click)="closeBrowser.emit()"><hg-icon name="power" /></button>
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
      </div>
    </header>
    @if (clipboardOpen() && role() === 'CONTROLLER' && connected() && viewAllowed()) {
      <section class="browser-clipboard" aria-label="Буфер обмена" (keydown.escape)="closeClipboard($event)">
        <header><strong>Буфер обмена</strong><button class="icon-button" aria-label="Закрыть буфер обмена"
          hgTooltip="Закрыть" (click)="closeClipboard()"><hg-icon name="close" /></button></header>
        <p>Текст до 256 КиБ. Вставьте текст сюда или скопируйте его в удалённом браузере.</p>
        <label>Передать в браузер<textarea #clipboardInput aria-label="Текст для вставки в браузер"
          [value]="clipboardInputText()" (input)="clipboardInputChanged($event)" rows="3"></textarea></label>
        <button class="button small" [disabled]="clipboardBusy()" (click)="pasteClipboard()">Вставить в браузер</button>
        <label>Из браузера<textarea #clipboardOutput aria-label="Текст из удалённого браузера"
          readonly [value]="clipboardRemoteText() ?? ''" rows="3"
          placeholder="Выделите текст в удалённом браузере и нажмите Ctrl+C"></textarea></label>
        <button class="button small" [disabled]="clipboardRemoteText() === null || clipboardBusy()"
          (click)="copyClipboard()">Скопировать на компьютер</button>
        @if (clipboardBusy()) { <p role="status">Передаём текст…</p> }
        @if (clipboardError()) { <p class="error-banner" role="alert">{{ clipboardError() }}</p> }
      </section>
    }
    @if (addressError()) { <p class="error-banner" role="alert">{{ addressError() }}</p> }
    @if (role() === 'CONTROLLER' && task()) {
      <div class="browser-inline-notice"><hg-icon name="pause" />Вы управляете браузером. При выходе управление вернётся агенту; незавершённый вход и другие запросы сохранятся.</div>
    }
    @if (idleSeconds(); as seconds) {
      <div class="browser-inline-notice" role="status">
        Браузер закроется из-за простоя через {{ idleCountdown() }}. Задача сохранится; несохранённая страница будет потеряна.
        <button class="button small" [disabled]="busy() || extending()" (click)="keepOpen()">Оставить ещё на {{ (browser()?.idleTimeoutSeconds ?? 300) / 60 }} минут</button>
      </div>
    }
    @if (idleError()) { <p class="error-banner" role="alert">{{ idleError() }}</p> }
    @if (browser()?.cleanupState === 'FAILED') {
      <p class="error-banner" role="alert">
        @if (browser()?.cleanupError === 'CLEANUP_FAILED') {
          Браузер освобождён, результаты сохранены, но временные данные не удалены. Администратор может повторить очистку.
        } @else {
          Браузер освобождён, но проверка результатов не завершена. Исходные данные сохранены; администратор может повторить обработку.
        }
      </p>
    } @else if (browser()?.status === 'CLOSED' && browser()?.cleanupState === 'PENDING') {
      <p class="browser-inline-notice" role="status">Браузер освобождён. Проверяем результаты и удаляем временные данные.</p>
    }
    @if (sessionPanel()?.error() || browser()?.profileSaveError) {
      <p class="error-banner" role="alert">
        @if (browser()?.status === 'CLOSED' && browser()?.profileSaveError) {
          Браузер закрыт. Последние изменения сессии не удалось сохранить.
          Доступна прежняя сохранённая версия; при следующем запуске может потребоваться повторный вход.
        } @else {
          {{ sessionPanel()?.error() || profileError() }}
          @if (sessionPanel()?.finishDisabledReason()) {
            {{ sessionPanel()?.finishDisabledReason() }}
          }
        }
      </p>
    }
    @if (sessionPanel()?.message()) {
      <p class="sr-only" role="status">{{ sessionPanel()?.message() }}</p>
    }
    <div class="browser-stage" [style.height.px]="expanded() ? null : viewportHeight()">
      <div #viewport class="browser-viewport">
        @if (!browser() || ['CLOSED', 'LOST'].includes(browser()?.status || '')) {
          <div class="viewer-placeholder">
            <span class="viewer-mark"><hg-icon name="browser" /></span>
            <h3>
              @if (!browser()) { Браузер ещё не запущен }
              @else if (browser()?.status === 'LOST') { Браузер утрачен }
              @else { Браузер закрыт }
            </h3>
            <p>
              @if (task()) { Шаги и результаты задачи сохранены. }
              @else if (connection()?.profileSavedAt) { Подключение и сохранённый вход доступны. }
              @else { Откройте браузер и войдите на сайт, чтобы сохранить сессию. }
            </p>
            @if (browser()?.closeReason === 'IDLE_TIMEOUT') { <p>Браузер закрыт по истечении срока бездействия.</p> }
            @if (canOpen()) {
              <button class="button" [disabled]="busy()" (click)="openBrowser.emit()"><hg-icon name="browser" />{{ browser() ? 'Возобновить браузер' : 'Открыть браузер' }}</button>
            }
          </div>
        } @else if (!streamEnabled()) {
          <div class="viewer-placeholder" role="status">
            <span class="viewer-mark"><hg-icon name="video-off" /></span>
            <h3>Трансляция остановлена</h3>
            <p>{{ role() === 'CONTROLLER' ? 'Браузер открыт. Управление остаётся у вас; ввод временно отключён.' : 'Браузер продолжает работать.' }}</p>
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
                    ? sessionPanel()?.finishing() || browser()?.loginConfirmed
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
                    ? sessionPanel()?.finishing() || browser()?.loginConfirmed
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
              (finished)="loginFinished.emit($event)"
            />
          </div>
        }
      </aside>
    </div>
    <footer class="browser-footer">
      <span class="connection-dot" [class.online]="connected()"></span>
      {{
        connected()
          ? role() === 'CONTROLLER'
            ? 'Вы управляете'
            : 'Только просмотр'
          : !streamEnabled() ? 'Трансляция остановлена' : 'Просмотр не подключён'
      }}
      @if (browser(); as item) {
        <hg-status [value]="item.status" />
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
          hgTooltip="Сведения о сессии браузера"
          (click)="togglePanel('session')"
        >
          <hg-icon name="info" />Сессия
        </button>
      }
    </footer>
  </section>`,
})
export class BrowserViewer {
  private readonly pageLifetime = inject(BrowserPageLifetime);
  private readonly idleNow = signal(Date.now());
  readonly extending = signal(false);
  readonly idleError = signal('');
  readonly idleSeconds = computed(() => {
    const browser = this.browser();
    if (browser?.status !== 'LIVE' || !browser.idleCloseAt) return null;
    const seconds = Math.max(1, Math.ceil((Date.parse(browser.idleCloseAt) - this.idleNow()) / 1000));
    return browser.idleWarningAt && Date.parse(browser.idleWarningAt) <= this.idleNow() ? seconds : null;
  });
  readonly idleCountdown = computed(() => {
    const seconds = this.idleSeconds() ?? 0;
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  });

  async keepOpen() {
    const browser = this.browser();
    if (!browser || this.extending()) return;
    this.extending.set(true);
    this.idleError.set('');
    try {
      const updated = await this.api.mutate('/api/browser-sessions/' + browser.id + '/keep-open', {}, browserSchema);
      if (!this.destroy.destroyed && this.browser()?.id === browser.id) this.sessionChanged.emit(updated);
    } catch (error: unknown) {
      if (!this.destroy.destroyed && this.browser()?.id === browser.id) this.idleError.set(errorMessage(error));
    } finally {
      if (!this.destroy.destroyed) this.extending.set(false);
    }
  }
  readonly steps = input(false);
  readonly stepCount = input(0);
  readonly canClose = input(false);
  readonly canOpen = input(false);
  readonly busy = input(false);
  readonly allowStreamPause = input(true);
  readonly closeBrowser = output<void>();
  readonly openBrowser = output<void>();
  readonly streamEnabled = signal(true);
  readonly address = signal('');
  readonly addressError = signal('');
  readonly editingAddress = signal(false);
  readonly clipboardOpen = signal(false);
  readonly clipboardInputText = signal('');
  readonly clipboardRemoteText = signal<string | null>(null);
  readonly clipboardBusy = signal(false);
  readonly clipboardError = signal('');
  private readonly clipboardButton = viewChild<ElementRef<HTMLButtonElement>>('clipboardButton');
  private readonly clipboardInput = viewChild<ElementRef<HTMLTextAreaElement>>('clipboardInput');
  private readonly clipboardOutput = viewChild<ElementRef<HTMLTextAreaElement>>('clipboardOutput');

  toggleClipboard() {
    if (this.clipboardOpen()) this.closeClipboard();
    else {
      this.clipboardOpen.set(true);
      requestAnimationFrame(() => this.clipboardInput()?.nativeElement.focus());
    }
  }
  closeClipboard(event?: Event) {
    event?.stopPropagation();
    this.clipboardOpen.set(false);
    this.clipboardButton()?.nativeElement.focus();
  }
  clipboardInputChanged(event: Event) {
    if (event.target instanceof HTMLTextAreaElement) this.clipboardInputText.set(event.target.value);
  }
  pasteClipboard() {
    if (this.role() !== 'CONTROLLER' || !this.connected() || !this.viewAllowed() || this.clipboardBusy()) return;
    const text = this.clipboardInputText();
    if (!this.clipboardTextAllowed(text)) {
      this.clipboardError.set('Допустим текст до 256 КиБ UTF-8 без нулевых символов.');
      return;
    }
    this.manualActivity();
    this.frame()?.nativeElement.contentWindow?.postMessage({ type: 'helm-viewer-paste', text,
      viewerEpoch: String(this.generation) }, location.origin);
    this.frame()?.nativeElement.focus();
  }
  async copyClipboard() {
    const text = this.clipboardRemoteText();
    if (text === null || this.role() !== 'CONTROLLER' || !this.connected() || !this.viewAllowed()) return;
    const generation = this.generation;
    this.clipboardError.set('');
    this.manualActivity();
    try { await navigator.clipboard.writeText(text); }
    catch {
      if (generation !== this.generation || this.destroy.destroyed) return;
      this.clipboardError.set('Браузер ограничил доступ к буферу компьютера. Скопируйте выделенный текст обычным Ctrl+C.');
      this.clipboardOutput()?.nativeElement.focus();
      this.clipboardOutput()?.nativeElement.select();
    }
  }
  private clipboardTextAllowed(text: string): boolean {
    return text.length <= 262144 && !text.includes('\0') && new TextEncoder().encode(text).length <= 262144;
  }
  private clearClipboard() {
    this.clipboardOpen.set(false);
    this.clipboardInputText.set('');
    this.clipboardRemoteText.set(null);
    this.clipboardBusy.set(false);
    this.clipboardError.set('');
  }
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
  private manualActivity() {
    const browser = this.browser();
    if (browser) void this.pageLifetime.activity(browser).catch((error: unknown) => {
      this.idleError.set(errorMessage(error));
    });
  }
  addressInput(event: Event) {
    if (event.isTrusted) this.manualActivity();
    if (event.target instanceof HTMLInputElement) this.address.set(event.target.value);
  }
  navigate(event: Event) {
    event.preventDefault();
    if (event.isTrusted) this.manualActivity();
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
  readonly loginFinished = output<BrowserSession>();
  readonly panel = signal<'steps' | 'session' | null>(null);
  private readonly sessionPanelRef = viewChild(BrowserSessionPanel);
  readonly sessionPanel = computed(() => {
    const panel = this.sessionPanelRef();
    return panel?.initialized() ? panel : undefined;
  });
  readonly loginSaved = input(false);
  togglePanel(panel: 'steps' | 'session' | null) {
    this.panel.set(this.panel() === panel ? null : panel);
    this.stepsOpen.emit(this.panel() === 'steps');
  }
  readonly profileError = computed(() => {
    const messages: Record<string, string> = {
      PROFILE_TOO_LARGE: 'Профиль сайта превышает 256 МиБ. Прежняя сессия не изменена.',
      PROFILE_RECORD_TOO_LARGE: 'Отдельная запись сайта превышает 16 МиБ. Прежняя сессия не изменена.',
      PROFILE_COMPLEXITY_LIMIT: 'Не удалось сохранить новый вход: данные сайта превысили ограничение сохранения сессии. Прежний сохранённый вход не изменён.',
      PROFILE_ORIGIN_LIMIT: 'Не удалось сохранить вход: сессия содержит более 50 доменов с данными. Прежняя сохранённая сессия не изменена.',
      PROFILE_STORAGE_UNAVAILABLE: 'Хранилище сессий временно недоступно. Сохранение и восстановление требуют связи с хранилищем.',
      PROFILE_UNAVAILABLE: 'Сохранённый профиль недоступен. Откройте новый вход для этого подключения.',
      PROFILE_INVALID: 'Не удалось проверить целостность профиля. Прежняя сессия не изменена.',
      PROFILE_SNAPSHOT_CHANGED: 'Данные сайта изменились во время сохранения. Повторите сохранение.',
      PROFILE_UNSUPPORTED_VALUE: 'Сайт использует неподдерживаемый тип данных. Прежняя сессия не изменена.',
      PROFILE_REVISION_CHANGED: 'Сохранённая сессия изменилась в другом окне. Повторите сохранение.',
    };
    return messages[this.browser()?.profileSaveError ?? ''] ?? 'Не удалось сохранить сессию. Повторите сохранение.';
  });
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
  readonly viewportHeight = computed(() =>
    this.viewportWidth() ? this.viewportWidth() / this.frameAspect() : 388.8,
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
    effect(cleanup => {
      const browser = this.browser();
      if (browser?.status !== 'LIVE' || !browser.idleCloseAt) return;
      this.idleNow.set(Date.now());
      const timer = setInterval(() => this.idleNow.set(Date.now()), 1000);
      cleanup(() => clearInterval(timer));
    });
    effect(() => {
      const browser = this.browser();
      if ((browser?.id ?? '') !== this.preferenceBrowserId) {
        this.preferenceBrowserId = browser?.id ?? '';
        this.streamEnabled.set(!this.allowStreamPause() || !browser || sessionStorage.getItem('helm-stream:' + browser.id) !== 'off');
        this.addressError.set('');
      }
      if (!this.editingAddress()) this.address.set(browser?.currentUrl ?? '');
    });
    effect((onCleanup) => {
      const viewport = this.viewport()?.nativeElement;
      if (!viewport || this.expanded()) return;
      const measure = () => {
        this.viewportWidth.set(viewport.getBoundingClientRect().width);
      };
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      onCleanup(() => observer.disconnect());
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
      if (state === 'clipboard') {
        if (this.role() !== 'CONTROLLER' || !this.connected()) return;
        if ('text' in event.data && typeof event.data.text === 'string' && this.clipboardTextAllowed(event.data.text))
          this.clipboardRemoteText.set(event.data.text);
        if ('busy' in event.data && typeof event.data.busy === 'boolean') this.clipboardBusy.set(event.data.busy);
        if ('error' in event.data && typeof event.data.error === 'string' && event.data.error.length <= 300)
          this.clipboardError.set(event.data.error);
        if ('manual' in event.data && event.data.manual === true) {
          const copy = 'direction' in event.data && event.data.direction === 'copy';
          this.clipboardOpen.set(true);
          requestAnimationFrame(() => {
            const input = copy ? this.clipboardOutput() : this.clipboardInput();
            input?.nativeElement.focus();
            if (copy) input?.nativeElement.select();
          });
        }
        return;
      }
      if (state === 'activity') {
        if (this.role() === 'CONTROLLER') this.manualActivity();
        return;
      }
      if (state === 'escape') {
        this.collapse();
        return;
      }
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
      } else if (state === 'disconnected' || state === 'error') {
        this.clearClipboard();
        this.scheduleReconnect();
      }
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
    this.clearClipboard();
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
