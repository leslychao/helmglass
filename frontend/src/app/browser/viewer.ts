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
import { BrowserSession, ticketSchema } from '../core/models';
import { Status } from '../shared/ui';
import { A11yModule } from '@angular/cdk/a11y';

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
  imports: [Icon, Status, A11yModule],
  template: ` <section
    class="browser-card"
    [class.browser-expanded]="expanded()"
    [cdkTrapFocus]="expanded()"
    (keydown.escape)="expanded.set(false)"
  >
    <div class="browser-title">
      <strong>Браузер агента</strong>
    </div>
    <header class="browser-toolbar">
      <span class="browser-address"
        ><hg-icon [name]="browser()?.privateMode ? 'lock' : 'globe'" />{{
          browser()?.privateMode ? 'Защищённый вход' : browser()?.currentUrl || 'Браузер задачи'
        }}</span
      >
      <div class="browser-controls"><ng-content /></div>
      <button
        class="icon-button"
        [attr.aria-label]="expanded() ? 'Свернуть браузер' : 'Развернуть браузер'"
        [title]="expanded() ? 'Свернуть' : 'Развернуть'"
        (click)="expanded.set(!expanded())"
      >
        <hg-icon [name]="expanded() ? 'close' : 'expand'" />
      </button>
    </header>
    @if (error()) {
      <div class="error-banner" role="alert">
        {{ error() }} <button class="text-button" (click)="retry()">Подключиться снова</button>
      </div>
    }
    <div class="browser-stage">
      <div class="browser-viewport">
        @if (!browser()) {
          <div class="viewer-placeholder">
            <span class="viewer-mark"><hg-icon name="browser" /></span>
            <h3>Браузер ещё не запущен</h3>
            <p>Здесь появится просмотр, когда браузер будет запущен.</p>
          </div>
        } @else if (!viewAllowed()) {
          <div class="viewer-placeholder">
            <span class="viewer-mark"><hg-icon name="shield" /></span>
            <h3>
              {{
                browser()?.controlOwner === 'TRANSFERRING'
                  ? 'Передаём управление'
                  : browser()?.privateMode
                    ? 'Идёт защищённый вход'
                    : 'Просмотр недоступен'
              }}
            </h3>
            <p>
              {{
                browser()?.controlOwner === 'TRANSFERRING'
                  ? 'Дождитесь подтверждения браузера.'
                  : browser()?.privateMode
                    ? 'Содержимое защищённой страницы скрыто от других наблюдателей.'
                    : 'Состояние браузера обновляется автоматически. История и результат доступны отдельно.'
              }}
            </p>
          </div>
        } @else if (src(); as url) {
          <iframe
            #frame
            [src]="url"
            (load)="iframeLoaded()"
            title="Удалённый браузер задачи"
            allow="clipboard-read; clipboard-write"
            referrerpolicy="no-referrer"
          ></iframe>
        } @else {
          <div class="viewer-placeholder" role="status">
            <h3>{{ connecting() ? 'Подключаем просмотр…' : 'Браузер готов к просмотру' }}</h3>
            <p>Сеанс браузера сохраняется при разрыве просмотра.</p>
            <button class="button" [disabled]="connecting()" (click)="retry()">
              Открыть просмотр
            </button>
          </div>
        }
      </div>
      <ng-content select="[browserHistory]" />
    </div>
    <footer class="browser-footer">
      <span class="connection-dot" [class.online]="connected()"></span
      >{{ connected() ? 'Просмотр подключён' : 'Просмотр не подключён' }}
      @if (browser(); as item) {
        <hg-status [value]="item.status" />
      }
      <span class="spacer"></span><ng-content select="[browserFooter]" />
    </footer>
  </section>`,
})
export class BrowserViewer {
  readonly browser = input<BrowserSession | null>(null);
  readonly role = input<'VIEWER' | 'CONTROLLER'>('VIEWER');
  readonly transport = output<string>();
  readonly src = signal<SafeResourceUrl | null>(null);
  readonly error = signal('');
  readonly controlLost = output<void>();
  readonly connected = signal(false);
  readonly connecting = signal(false);
  readonly expanded = signal(false);
  readonly viewAllowed = computed(() => {
    const browser = this.browser();
    return (
      !!browser?.canView &&
      browser.controlOwner !== 'TRANSFERRING' &&
      (!browser.privateMode || this.role() === 'CONTROLLER')
    );
  });
  private readonly api = inject(Api);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroy = inject(DestroyRef);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private generation = 0;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastBrowserId = '';
  private loaded = false;
  private pendingReconnectUrl: string | null = null;
  private readonly identity = computed(() => {
    const browser = this.browser();
    return browser
      ? [browser.id, this.viewAllowed(), browser.controlEpoch, this.role()].join(':')
      : '';
  });
  constructor() {
    effect(() => {
      this.identity();
      untracked(() => {
        const browser = this.browser();
        this.cancel();
        this.connected.set(false);
        this.attempts = 0;
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
        event.source !== this.frame()?.nativeElement.contentWindow ||
        typeof event.data !== 'object' ||
        event.data === null ||
        !('type' in event.data) ||
        event.data.type !== 'helm-viewer' ||
        !('state' in event.data)
      )
        return;
      const state = event.data.state;
      if (typeof state !== 'string') return;
      this.transport.emit(state);
      this.connected.set(state === 'connected');
      if (state === 'connected') {
        this.attempts = 0;
        this.error.set('');
      } else if (
        (state === 'disconnected' || state === 'error') &&
        !this.timer &&
        this.viewAllowed()
      ) {
        if (this.attempts >= 5) {
          this.error.set('Соединение просмотра потеряно. Сеанс браузера сохранён.');
          return;
        }
        this.timer = setTimeout(
          () => {
            this.timer = null;
            void this.connect();
          },
          Math.min(1000 * 2 ** this.attempts++, 15000),
        );
      }
    };
    window.addEventListener('message', listener);
    this.destroy.onDestroy(() => {
      this.cancel();
      window.removeEventListener('message', listener);
    });
  }
  retry() {
    this.attempts = 0;
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
  }
  private async connect() {
    const browser = this.browser();
    if (!browser || !this.viewAllowed()) return;
    const generation = ++this.generation;
    this.connecting.set(true);
    try {
      const ticket = await this.api.mutate(
        '/api/browser-sessions/' + browser.id + '/ticket',
        { role: this.role(), viewerId: browserViewerId() },
        ticketSchema,
      );
      const url = new URL(ticket.url, location.origin);
      if (url.origin !== location.origin || url.pathname !== '/browser/novnc/helm.html')
        throw new Error('Сервер вернул недопустимый адрес просмотра.');
      if (generation !== this.generation) return;
      if (this.src()) {
        if (this.loaded) this.sendReconnect(url.href);
        else this.pendingReconnectUrl = url.href;
      } else this.src.set(this.sanitizer.bypassSecurityTrustResourceUrl(url.href));
      this.error.set('');
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.error.set(errorMessage(error));
        if (error instanceof ApiError && error.status === 403 && this.role() === 'CONTROLLER') {
          sessionStorage.removeItem('helm-controller:' + browser.id);
          this.controlLost.emit();
        }
      }
    } finally {
      if (generation === this.generation) this.connecting.set(false);
    }
  }
}
