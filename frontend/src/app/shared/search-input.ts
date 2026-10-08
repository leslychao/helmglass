import { Directive, DestroyRef, inject, output } from '@angular/core';

@Directive({
  selector: 'input[hgSearch]',
  host: { maxlength: '300', '(input)': 'schedule($event)', '(keydown.enter)': 'flush($event)' },
})
export class SearchInput {
  readonly searchChange = output<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private value = '';
  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }
  schedule(event: Event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.value = event.target.value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.searchChange.emit(this.value), 300);
  }
  flush(event: Event) {
    event.preventDefault();
    clearTimeout(this.timer);
    if (event.target instanceof HTMLInputElement) this.value = event.target.value;
    this.searchChange.emit(this.value);
  }
}
