import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { Icon } from '../icon/icon';
@Component({
  selector: 'hg-dialog',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<dialog
    #dialog
    class="dialog"
    [attr.aria-labelledby]="titleId"
    (cancel)="cancel($event)"
  >
    <header class="dialog-head">
      <h2 [id]="titleId">{{ title() }}</h2>
      <button
        class="icon-btn"
        aria-label="Закрыть диалог"
        [disabled]="busy()"
        (click)="closed.emit()"
      >
        <hg-icon name="close" />
      </button>
    </header>
    <div class="dialog-body"><ng-content /></div>
    <footer class="dialog-footer"><ng-content select="[dialog-actions]" /></footer>
  </dialog>`,
})
export class Dialog {
  readonly titleId = 'dialog-title-' + crypto.randomUUID();
  title = input.required<string>();
  busy = input(false);
  closed = output<void>();
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  constructor() {
    const previouslyFocused = document.activeElement;
    afterNextRender(() => this.dialog().nativeElement.showModal());
    inject(DestroyRef).onDestroy(() => {
      this.dialog().nativeElement.close();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected)
        previouslyFocused.focus();
      else document.querySelector<HTMLElement>('h1[tabindex]')?.focus();
    });
  }
  cancel(event: Event) {
    event.preventDefault();
    if (!this.busy()) this.closed.emit();
  }
}
