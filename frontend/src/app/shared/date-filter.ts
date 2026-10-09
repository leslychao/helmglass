import { A11yModule } from '@angular/cdk/a11y';
import {
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Icon } from './icon';
import { Tooltip } from './tooltip';

export type DateRange = { from: string | null; to: string | null };

@Component({
  selector: 'hg-date-filter',
  imports: [A11yModule, FormsModule, Icon, Tooltip],
  host: { '(document:click)': 'outside($event)', '(keydown.escape)': 'close()' },
  template: `<button
      type="button"
      [class]="appearance() === 'caption' ? 'date-range-caption' : 'filter'"
      [class.selected]="
        appearance() !== 'caption' && (presetDays() !== null ? presetDays() !== 7 : from() || to())
      "
      [hgTooltip]="appearance() === 'caption' ? 'Выбрать диапазон дат' : label()"
      [attr.aria-expanded]="open()"
      aria-haspopup="dialog"
      (click)="toggle($event)"
    >
      @if (appearance() !== 'caption') {
        <hg-icon name="calendar" />
      }
      {{ captionText() || caption() }}
      @if (appearance() !== 'caption') {
        <hg-icon name="chevron-down" />
      }
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
          @if (presetDays() !== null) {
            <div class="date-presets" aria-label="Быстрый выбор периода">
              <button
                #firstPreset
                type="button"
                class="button"
                [class.selected]="draftDays === 7"
                [attr.aria-pressed]="draftDays === 7"
                (click)="draftDays = 7"
              >
                7 дней
              </button>
              <button
                type="button"
                class="button"
                [class.selected]="draftDays === 30"
                [attr.aria-pressed]="draftDays === 30"
                (click)="draftDays = 30"
              >
                30 дней
              </button>
              <button
                type="button"
                class="button"
                [class.selected]="draftDays === 0"
                [attr.aria-pressed]="draftDays === 0"
                (click)="draftDays = 0"
              >
                Выбрать даты
              </button>
            </div>
          }
          @if (presetDays() === null || draftDays === 0) {
            <label class="field"
              >С <input #startInput name="from" type="date" [(ngModel)]="start"
            /></label>
            <label class="field">По <input name="to" type="date" [(ngModel)]="end" /></label>
          }
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
  readonly appearance = input<'filter' | 'caption'>('filter');
  readonly captionText = input('');
  readonly from = input('');
  readonly to = input('');
  readonly presetDays = input<number | null>(null);
  readonly presetSelected = output<number>();
  readonly changed = output<DateRange>();
  readonly open = signal(false);
  readonly error = signal('');
  start = '';
  end = '';
  draftDays = 0;
  readonly caption = computed(() => {
    const days = this.presetDays();
    if (days === null) return this.label();
    if (days === 7 || days === 30) return `Последние ${days} дней`;
    const from = this.calendarDate(this.from(), false).split('-').reverse().join('.');
    const to = this.calendarDate(this.to(), true).split('-').reverse().join('.');
    return from && to ? `${from} — ${to}` : from ? `С ${from}` : to ? `По ${to}` : 'Все даты';
  });
  private trigger: HTMLElement | null = null;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly startInput = viewChild<ElementRef<HTMLInputElement>>('startInput');
  private readonly firstPreset = viewChild<ElementRef<HTMLButtonElement>>('firstPreset');

  constructor() {
    afterRenderEffect(() => {
      const field = this.startInput() ?? this.firstPreset();
      if (this.open()) field?.nativeElement.focus();
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
    if (this.open()) this.close();
    else {
      this.start = this.calendarDate(this.from(), false);
      this.end = this.calendarDate(this.to(), true);
      this.draftDays = this.presetDays() ?? 0;
      this.error.set('');
      this.open.set(true);
    }
  }

  apply() {
    if (this.presetDays() !== null && (this.draftDays === 7 || this.draftDays === 30)) {
      this.presetSelected.emit(this.draftDays);
      this.close();
      return;
    }
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
