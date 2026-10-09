import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Api, errorMessage } from '../core/api';
import { BrowserSession, browserSchema } from '../core/models';
import { SavedCredentials } from '../connections/saved-credentials';
import { browserViewerId } from './viewer';
import { Tooltip } from '../shared/tooltip';
import { Icon } from '../shared/icon';
import { DatePipe } from '@angular/common';

const browserStates: Record<string, string> = {
  LIVE: 'Работает', QUEUED: 'Ожидает запуска', STARTING: 'Запускается',
  CLOSING: 'Закрывается', CLOSED: 'Закрыт', LOST: 'Утрачен', UNREACHABLE: 'Нет связи',
};

@Component({
  selector: 'hg-browser-session',
  imports: [SavedCredentials, Tooltip, Icon, DatePipe],
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .session-field-label {
      display: block;
      font-size: 11px;
      line-height: 1.6;
      color: #7b8da3;
      margin-bottom: 8px;
    }
    .session-id {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 8px 10px 11px;
      border: 1px solid #e6ebf2;
      border-radius: 6px;
      background: #f8fafc;
      min-width: 0;
    }
    .session-id code {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
      font:
        11px/1.7 ui-monospace,
        SFMono-Regular,
        Consolas,
        monospace;
      color: #526985;
      user-select: all;
    }
    .session-id .icon-button {
      width: 28px;
      height: 28px;
      min-width: 28px;
      margin: -2px -2px -2px 0;
    }
    .session-id hg-icon {
      width: 14px;
      height: 14px;
    }
    .session-facts { margin: 14px 0; font-size: 11px; }
    .session-facts > div { display: grid; grid-template-columns: 94px minmax(0, 1fr); gap: 12px; padding: 11px 0; border-bottom: 1px solid #edf0f5; }
    .session-facts dt { color: #7b8da3; }
    .session-facts dd { margin: 0; color: #344b67; overflow-wrap: anywhere; }
    .session-elapsed { font-variant-numeric: tabular-nums; }
  `,
  template: `
    <span class="session-field-label">Идентификатор браузера</span>
    <div class="session-id">
      <code>{{ browser().id }}</code>
      <button
        type="button"
        class="icon-button"
        [attr.aria-label]="
          copied() ? 'Идентификатор скопирован' : 'Копировать идентификатор браузера'
        "
        [hgTooltip]="copied() ? 'Идентификатор скопирован' : 'Копировать идентификатор браузера'"
        (click)="copyId()"
      >
        <hg-icon [name]="copied() ? 'check' : 'copy'" />
      </button>
    </div>
    <span class="sr-only" role="status">{{
      copied() ? 'Идентификатор браузера скопирован' : ''
    }}</span>
    @if (copyError()) {
      <p class="error-banner" role="alert">{{ copyError() }}</p>
    }
    <dl class="session-facts">
      <div><dt>Состояние</dt><dd>{{ state() }}</dd></div>
      <div><dt>Запущен</dt><dd>{{ browser().startedAt ? (browser().startedAt | date: 'dd.MM.yyyy HH:mm:ss') : 'Нет данных' }}</dd></div>
      @if (browser().closedAt) {
        <div><dt>Закрыт</dt><dd>{{ browser().closedAt | date: 'dd.MM.yyyy HH:mm:ss' }}</dd></div>
      }
      <div><dt>Длительность</dt><dd class="session-elapsed">{{ elapsed() }}</dd></div>
      <div><dt>Управление</dt><dd>{{ control() }}</dd></div>
    </dl>
    @if (connectionContext()) {
      <hg-saved-credentials [browserId]="browser().id" [enabled]="active() && canConfirm()" />
    }
  `,
})
export class BrowserSessionPanel {
  readonly browser = input.required<BrowserSession>();
  readonly controller = input(false);
  readonly allowed = input(true);
  readonly active = input(false);
  readonly connectionContext = input(false);
  private readonly now = signal(Date.now());
  readonly state = computed(() => browserStates[this.browser().status] ?? 'Нет свежих данных');
  readonly control = computed(() => {
    const browser = this.browser();
    if (['CLOSED', 'LOST', 'QUEUED'].includes(browser.status)) return '—';
    if (browser.controlOwner === 'TRANSFERRING') return 'Передача управления';
    if (browser.controlOwner === 'USER') return this.controller() ? 'Вы' : 'Другое окно';
    return browser.controlOwner === 'CHATGPT' ? 'Агент' : 'Не передано';
  });
  readonly elapsed = computed(() => {
    const browser = this.browser();
    if (!browser.startedAt) return 'Нет данных';
    const seconds = Math.max(0, Math.floor(((browser.closedAt ? Date.parse(browser.closedAt) : this.now()) - Date.parse(browser.startedAt)) / 1000));
    if (!Number.isFinite(seconds)) return 'Нет данных';
    return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
  });
  readonly changed = output<BrowserSession>();
  readonly busy = signal(false);
  readonly error = signal('');
  readonly copied = signal(false);
  readonly copyError = signal('');
  private readonly submitted = signal<{
    id: string;
    type: 'CONFIRM_LOGIN' | 'SAVE_SESSION';
  } | null>(null);
  readonly message = computed(() => {
    const submitted = this.submitted(),
      browser = this.browser();
    if (!submitted || submitted.id !== browser.id || this.error() || browser.profileSaveError)
      return '';
    if (submitted.type === 'CONFIRM_LOGIN')
      return browser.loginConfirmed ? 'Завершение входа подтверждено.' : '';
    if (!browser.loginConfirmed) return 'Сессия сохранена.';
    return browser.controlOwner === 'TRANSFERRING' ? '' : 'Сохранение ещё не подтверждено.';
  });
  private readonly accessReason = computed(() => {
    if (this.browser().controlOwner === 'TRANSFERRING')
      return 'Дождитесь подтверждения операции браузером.';
    if (this.browser().status !== 'LIVE') return 'Дождитесь доступности браузера.';
    if (!this.controller() || this.browser().controlOwner !== 'USER')
      return 'Возьмите управление, чтобы сохранить новый вход.';
    if (!this.browser().privateMode) return 'Откройте защищённый вход, чтобы сохранить сессию.';
    return this.allowed() ? '' : 'Сохранение сейчас недоступно для этой задачи.';
  });
  readonly canConfirm = computed(() => !this.accessReason());
  readonly saveDisabledReason = computed(() =>
    this.busy() ? 'Дождитесь завершения текущего действия.' : this.accessReason(),
  );
  private readonly api = inject(Api);
  private readonly destroy = inject(DestroyRef);

  constructor() {
    effect(onCleanup => {
      if (!this.active() || !this.browser().startedAt || this.browser().closedAt) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    let previousId = '';
    effect(() => {
      const id = this.browser().id;
      if (id === previousId) return;
      previousId = id;
      this.busy.set(false);
      this.error.set('');
      this.submitted.set(null);
      this.copied.set(false);
      this.copyError.set('');
    });
  }

  async copyId() {
    const id = this.browser().id;
    this.copyError.set('');
    try {
      await navigator.clipboard.writeText(id);
      if (!this.destroy.destroyed && this.browser().id === id) this.copied.set(true);
    } catch {
      if (!this.destroy.destroyed && this.browser().id === id)
        this.copyError.set(
          'Не удалось скопировать. Выделите идентификатор и скопируйте его вручную.',
        );
    }
  }

  async confirm() {
    if (!this.canConfirm() || this.busy()) return;
    await this.submit('CONFIRM_LOGIN');
  }
  async save() {
    if (!this.canConfirm() || !this.browser().loginConfirmed || this.busy()) return;
    await this.submit('SAVE_SESSION');
  }
  private async submit(
    type: 'CONFIRM_LOGIN' | 'SAVE_SESSION',
    epoch = this.browser().controlEpoch,
  ) {
    const id = this.browser().id;
    this.busy.set(true);
    this.error.set('');
    this.submitted.set(null);
    try {
      const updated = await this.api.mutate(
        '/api/browser-sessions/' + id + '/login',
        {
          type,
          viewerId: browserViewerId(),
          controlEpoch: epoch,
        },
        browserSchema,
      );
      if (this.destroy.destroyed || this.browser().id !== id) return;
      this.changed.emit(updated);
      this.submitted.set({ id, type });
    } catch (error: unknown) {
      if (!this.destroy.destroyed && this.browser().id === id) this.error.set(errorMessage(error));
    } finally {
      if (!this.destroy.destroyed && this.browser().id === id) this.busy.set(false);
    }
  }
}
