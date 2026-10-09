import { A11yModule } from '@angular/cdk/a11y';
import {
  Component,
  ElementRef,
  inject,
  computed,
  input,
  model,
  output,
  signal,
  afterRenderEffect,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Icon, IconName } from './icon';
import { Tooltip } from './tooltip';
export interface Option {
  id: string;
  label: string;
}
@Component({
  selector: 'hg-multi-filter',
  imports: [FormsModule, A11yModule, Icon, Tooltip],
  host: { '(document:click)': 'outside($event)', '(keydown.escape)': 'close()' },
  template: ` <button
      type="button"
      [class]="icon() ? 'icon-button control-button' : 'filter'"
      [class.selected]="icon() ? open() : value().length"
      [attr.aria-label]="icon() ? label() : null"
      [hgTooltip]="label()"
      [attr.aria-expanded]="open()"
      aria-haspopup="dialog"
      (click)="toggle($event)"
    >
      @if (icon(); as glyph) {
        <hg-icon [name]="glyph" />
      } @else {
        {{ caption() }}
        @if (value().length > 1) {
          <b>{{ value().length }}</b>
        }
        <hg-icon name="chevron-down" />
      }
    </button>
    @if (open()) {
      <div
        class="filter-popover"
        role="dialog"
        [attr.aria-label]="label()"
        cdkTrapFocus
        (click)="$event.stopPropagation()"
      >
        <header>
          <strong
            >{{ label() }}
            @if (!icon() && value().length) {
              · {{ value().length }}
            }</strong
          ><button
            class="icon-button"
            aria-label="Закрыть фильтр"
            hgTooltip="Закрыть фильтр"
            (click)="close()"
          >
            <hg-icon name="close" />
          </button>
        </header>
        <input
          #filterSearch
          class="filter-search"
          type="search"
          [attr.aria-label]="'Поиск: ' + label()"
          placeholder="Найти значение"
          maxlength="300"
          [ngModel]="search()"
          (ngModelChange)="searchChanged($event)"
        />
        <div class="filter-options">
          @for (option of options(); track option.id) {
            <label [hidden]="!matches(option)"
              ><input
                type="checkbox"
                [checked]="value().includes(option.id)"
                (change)="select(option.id)"
              />{{ option.label }}</label
            >
          }
          @if (!visibleCount()) {
            <p class="empty-small">Ничего не найдено</p>
          }
        </div>
        <footer>
          <button class="button quiet" [disabled]="!value().length" (click)="clear()">
            Снять выбор</button
          ><button class="button primary" (click)="close()">Готово</button>
        </footer>
      </div>
    }`,
})
export class MultiFilter {
  readonly label = input.required<string>();
  readonly icon = input<IconName | null>(null);
  readonly options = input<readonly Option[]>([]);
  readonly value = model<string[]>([]);
  readonly changed = output<string[]>();
  readonly open = signal(false);
  readonly search = signal('');
  private trigger: HTMLElement | null = null;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('filterSearch');
  constructor() {
    afterRenderEffect(() => {
      const field = this.searchInput();
      if (this.open()) field?.nativeElement.focus();
    });
  }
  readonly caption = computed(() =>
    this.value().length === 1
      ? (this.options().find((item) => item.id === this.value()[0])?.label ?? this.label())
      : this.label(),
  );
  readonly visibleCount = computed(
    () => this.options().filter((option) => this.matches(option)).length,
  );
  matches(option: Option) {
    return option.label.toLocaleLowerCase('ru').includes(this.search().toLocaleLowerCase('ru'));
  }
  toggle(event: MouseEvent) {
    this.trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (this.open()) this.close();
    else {
      this.open.set(true);
    }
  }
  searchChanged(value: string) {
    this.search.set(value);
  }
  select(id: string) {
    const selected = this.value().includes(id)
      ? this.value().filter((item) => item !== id)
      : [...this.value(), id];
    this.value.set(selected);
    this.changed.emit(selected);
  }
  clear() {
    this.value.set([]);
    this.changed.emit([]);
  }
  close() {
    if (this.open()) {
      this.hide();
      this.trigger?.focus();
    }
  }
  private hide() {
    this.open.set(false);
  }
  outside(event: Event) {
    if (event.target instanceof Node && !this.host.nativeElement.contains(event.target))
      this.hide();
  }
}
