import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';
import {
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { errorMessage } from '../core/api';
import { Icon } from './icon';
import { Tooltip } from './tooltip';

export interface AutocompleteOption {
  id: string;
  label: string;
  detail?: string;
}

export interface AutocompleteResult {
  items: readonly AutocompleteOption[];
  total: number;
}

@Component({
  selector: 'hg-autocomplete',
  imports: [Icon, OverlayModule, Tooltip],
  styleUrl: './autocomplete.css',
  host: { '[class.multiple]': 'multiple()' },
  template: `
    <label class="autocomplete-field" cdkOverlayOrigin #origin="cdkOverlayOrigin">
      <hg-icon [name]="multiple() ? 'globe' : 'search'" />
      <input
        #field
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        autocomplete="off"
        maxlength="300"
        [attr.aria-label]="label()"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="open() ? listId : null"
        [attr.aria-activedescendant]="active() >= 0 ? listId + '-' + active() : null"
        [attr.aria-describedby]="open() ? listId + '-status' : null"
        [placeholder]="label()"
        [value]="text()"
        [hgTooltip]="
          open()
            ? ''
            : multiple()
              ? 'Найдите сайт. Можно выбрать несколько сайтов.'
              : 'Название или ID задачи. Выбор уточняет фильтр таблицы.'
        "
        (input)="edit($event)"
        (focus)="show()"
        (click)="show()"
        (keydown)="key($event)"
      />
      @if (multiple()) {
        <hg-icon name="chevron-down" />
      } @else if (text()) {
        <button
          type="button"
          class="autocomplete-clear"
          aria-label="Сбросить поиск задач"
          hgTooltip="Сбросить поиск задач"
          (click)="clear()"
        >
          <hg-icon name="close" />
        </button>
      }
    </label>
    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="origin"
      [cdkConnectedOverlayOpen]="open()"
      [cdkConnectedOverlayPositions]="positions"
      [cdkConnectedOverlayViewportMargin]="8"
      [cdkConnectedOverlayPush]="true"
      (overlayOutsideClick)="outside($event)"
      (detach)="hide()"
    >
      <div class="autocomplete-panel">
        <div
          [id]="listId"
          role="listbox"
          [attr.aria-label]="label()"
          [attr.aria-multiselectable]="multiple() ? true : null"
          [attr.aria-busy]="loading()"
        >
          @for (item of items(); track item.id; let index = $index) {
            <div
              class="autocomplete-option"
              role="option"
              [id]="listId + '-' + index"
              [class.active]="active() === index"
              [attr.aria-selected]="selected().includes(item.id)"
              (mousedown)="$event.preventDefault()"
              (click)="choose(item)"
            >
              <hg-icon [name]="multiple() ? 'globe' : 'tasks'" />
              <span
                ><strong>{{ item.label }}</strong>
                @if (item.detail) {
                  <small>{{ item.detail }}</small>
                }
              </span>
              @if (selected().includes(item.id)) {
                <hg-icon name="check" />
              }
            </div>
          }
        </div>
        <div [id]="listId + '-status'" class="autocomplete-status" role="status" aria-live="polite">
          @if (loading()) {
            Загружаем варианты…
          } @else if (error()) {
            <span class="autocomplete-error">{{ error() }}</span>
            <button
              type="button"
              class="text-button"
              tabindex="-1"
              (mousedown)="$event.preventDefault()"
              (click)="request()"
            >
              Повторить
            </button>
            <span class="sr-only">Нажмите Enter, чтобы повторить.</span>
          } @else if (!items().length) {
            Совпадений нет
          } @else if (total() > 3) {
            Показаны 3 совпадения. Уточните запрос.
          } @else {
            {{
              multiple()
                ? 'Можно выбрать несколько сайтов.'
                : 'Выберите задачу для фильтрации таблицы.'
            }}
          }
        </div>
      </div>
    </ng-template>
  `,
})
export class Autocomplete {
  readonly label = input.required<string>();
  readonly load = input.required<(search: string) => Promise<AutocompleteResult>>();
  readonly value = input('');
  readonly selected = input<readonly string[]>([]);
  readonly multiple = input(false);
  readonly searched = output<string>();
  readonly picked = output<AutocompleteOption>();
  readonly text = signal('');
  readonly open = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly items = signal<readonly AutocompleteOption[]>([]);
  readonly total = signal(0);
  readonly active = signal(-1);
  readonly listId = 'autocomplete-' + crypto.randomUUID();
  readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 5 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -5 },
  ];
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingSearch: string | undefined;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  constructor() {
    effect(() => {
      const value = this.value();
      if (this.pendingSearch === undefined) this.text.set(value);
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.timer);
      this.generation++;
    });
  }

  show() {
    if (this.open()) return;
    this.open.set(true);
    this.schedule();
  }

  edit(event: Event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.text.set(event.target.value);
    this.pendingSearch = event.target.value;
    this.open.set(true);
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.generation++;
    this.active.set(-1);
    this.items.set([]);
    this.error.set('');
    this.loading.set(true);
    this.timer = setTimeout(() => {
      this.publishSearch();
      void this.request();
    }, 300);
  }

  async request() {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set('');
    this.active.set(-1);
    try {
      const result = await this.load()(this.text());
      if (generation !== this.generation || !this.open()) return;
      this.items.set(result.items.slice(0, 3));
      this.total.set(result.total);
    } catch (error: unknown) {
      if (generation === this.generation && this.open()) {
        this.items.set([]);
        this.error.set(errorMessage(error));
      }
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  choose(item: AutocompleteOption) {
    this.pendingSearch = undefined;
    this.picked.emit(item);
    if (this.multiple()) {
      this.text.set('');
      this.schedule();
    } else {
      this.text.set(item.label);
      this.hide();
    }
    this.field().nativeElement.focus();
  }

  clear() {
    this.text.set('');
    this.pendingSearch = '';
    this.publishSearch();
    this.field().nativeElement.focus();
    this.show();
    this.schedule();
  }

  key(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      this.hide();
      return;
    }
    if (event.key === 'Escape' && this.open()) {
      event.preventDefault();
      event.stopPropagation();
      this.hide();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.show();
      const count = this.items().length;
      if (!count) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      this.active.set(
        this.active() < 0
          ? direction > 0
            ? 0
            : count - 1
          : (this.active() + direction + count) % count,
      );
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (this.open() && this.error()) {
        void this.request();
        return;
      }
      const item = this.open() ? this.items()[Math.max(0, this.active())] : undefined;
      if (item) this.choose(item);
      else {
        this.publishSearch();
        this.hide();
      }
    }
  }

  hide() {
    this.publishSearch();
    clearTimeout(this.timer);
    this.generation++;
    this.open.set(false);
    this.loading.set(false);
    this.active.set(-1);
  }

  outside(event: MouseEvent) {
    if (event.target instanceof Node && !this.host.nativeElement.contains(event.target))
      this.hide();
  }

  private publishSearch() {
    if (this.pendingSearch === undefined) return;
    this.searched.emit(this.pendingSearch);
    this.pendingSearch = undefined;
  }
}
