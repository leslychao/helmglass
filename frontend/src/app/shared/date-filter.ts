import { A11yModule } from '@angular/cdk/a11y';
import {
  Component,
  ElementRef,
  afterRenderEffect,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Icon } from './icon';

export type DateRange = { from: string | null; to: string | null };

@Component({
  selector: 'hg-date-filter',
  imports: [A11yModule, FormsModule, Icon],
  host: { '(document:click)': 'outside($event)', '(keydown.escape)': 'close()' },
  template: `<button
      type="button"
      class="filter"
      [class.selected]="from() || to()"
      [attr.aria-expanded]="open()"
      aria-haspopup="dialog"
      (click)="toggle($event)"
    >
      {{ label() }} <hg-icon name="chevron-down" />
    </button>
    @if (open()) {
      <section
        class="filter-popover"
        role="dialog"
        [attr.aria-label]="label()"
        cdkTrapFocus
        (click)="$event.stopPropagation()"
      >
        <form (ngSubmit)="apply()">
          <label class="field"
            >С <input #startInput name="from" type="date" [(ngModel)]="start"
          /></label>
          <label class="field">По <input name="to" type="date" [(ngModel)]="end" /></label>
          @if (error()) {
            <p class="field-error" role="alert">{{ error() }}</p>
          }
          <footer>
            <button type="button" class="button quiet" (click)="close()">Закрыть</button>
            <button class="button primary" type="submit">Применить</button>
          </footer>
        </form>
      </section>
    }`,
})
export class DateFilter {
  readonly label = input('Период');
  readonly from = input('');
  readonly to = input('');
  readonly changed = output<DateRange>();
  readonly open = signal(false);
  readonly error = signal('');
  start = '';
  end = '';
  private trigger: HTMLElement | null = null;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly startInput = viewChild<ElementRef<HTMLInputElement>>('startInput');

  constructor() {
    afterRenderEffect(() => {
      const field = this.startInput();
      if (this.open()) field?.nativeElement.focus();
    });
    effect(() => {
      this.start = this.calendarDate(this.from(), false);
      this.end = this.calendarDate(this.to(), true);
      this.error.set('');
    });
  }

  private calendarDate(value: string, exclusiveEnd: boolean) {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    if (exclusiveEnd) date.setTime(date.getTime() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  toggle(event: MouseEvent) {
    this.trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.open.update((value) => !value);
  }

  apply() {
    if (this.start && this.end && this.start > this.end) {
      this.error.set('Дата начала должна быть не позже даты окончания.');
      return;
    }
    const start = this.start ? new Date(this.start + 'T00:00:00') : null;
    const end = this.end ? new Date(this.end + 'T00:00:00') : null;
    if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime()))) {
      this.error.set('Укажите корректные даты.');
      return;
    }
    // The API end is exclusive; calendar arithmetic also preserves local DST boundaries.
    if (end) end.setDate(end.getDate() + 1);
    this.changed.emit({ from: start?.toISOString() ?? null, to: end?.toISOString() ?? null });
    this.close();
  }

  close() {
    if (!this.open()) return;
    this.open.set(false);
    this.trigger?.focus();
  }

  outside(event: Event) {
    if (event.target instanceof Node && !this.host.nativeElement.contains(event.target))
      this.open.set(false);
  }
}
