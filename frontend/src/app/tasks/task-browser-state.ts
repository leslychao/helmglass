import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BrowserSession } from '../core/models';
import { Status } from '../shared/ui';

@Component({
  selector: 'hg-task-browser-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Status],
  styles: `
    :host { display: grid; justify-items: start; gap: 6px; min-width: 0; }
    .browser-note {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .browser-note.warning { color: var(--amber); }
  `,
  template: `
    @if (browser(); as browser) {
      <hg-status [value]="browser.status" />
    } @else {
      <span class="badge"><i></i>Нет браузера</span>
    }
    @if (note(); as note) {
      <span class="browser-note" [class.warning]="warning()">{{ note }}</span>
    }
  `,
})
export class TaskBrowserState {
  readonly browser = input<BrowserSession | null>(null);
  readonly now = input.required<number>();
  readonly synchronized = input.required<boolean>();
  private readonly deadline = computed(() => {
    const deadline = this.browser()?.idleCloseAt;
    return deadline ? Date.parse(deadline) : null;
  });
  private readonly warningAt = computed(() => {
    const warning = this.browser()?.idleWarningAt;
    return warning ? Date.parse(warning) : null;
  });
  readonly warning = computed(() => {
    const warning = this.warningAt();
    return this.synchronized() && this.browser()?.status === 'LIVE'
      && warning !== null && this.now() >= warning;
  });
  readonly note = computed(() => {
    if (!this.synchronized()) return 'Данные обновляются';
    const browser = this.browser();
    if (!browser) return '';
    switch (browser.status) {
      case 'LIVE': {
        const deadline = this.deadline();
        if (deadline === null) return 'Автозакрытие временно отложено';
        const seconds = Math.ceil((deadline - this.now()) / 1000);
        if (seconds <= 0) return 'Ожидаем закрытия';
        const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
        const remainder = String(seconds % 60).padStart(2, '0');
        return `До автозакрытия ${minutes}:${remainder}`;
      }
      case 'CLOSING':
        return 'Ожидаем подтверждения';
      case 'CLOSED':
        if (browser.closeReason === 'IDLE_TIMEOUT') return 'Из-за простоя';
        return browser.closeReason === 'USER' ? 'По вашему запросу' : '';
      case 'UNREACHABLE':
        return 'Состояние уточняется';
      default:
        return '';
    }
  });
}
