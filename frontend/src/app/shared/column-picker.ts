import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';
import { Tooltip } from './tooltip';
import { TableLayout, TableView } from './table-view';

@Component({
  selector: 'hg-column-picker',
  imports: [Icon, Tooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view().modified()) {
      <button
        type="button"
        class="button reset-view"
        (click)="view().reset()"
        hgTooltip="Вернуть исходные столбцы, ширины, сортировку и размер страницы. Поиск и фильтры сохранятся."
      >
        <hg-icon name="reset-view" />Сбросить вид
      </button>
    }
    <button
      type="button"
      class="icon-button control-button"
      (click)="open()"
      aria-label="Настроить столбцы"
      hgTooltip="Настроить столбцы"
    >
      <hg-icon name="columns" />
    </button>
    <dialog
      #dialog
      class="table-columns-dialog"
      aria-label="Столбцы таблицы"
      (cancel)="cancel($event)"
    >
      <header>
        <h2>Столбцы таблицы</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="Закрыть"
          hgTooltip="Закрыть"
          (click)="close()"
        >
          <hg-icon name="close" />
        </button>
      </header>
      <div class="table-columns-body">
        <p class="muted">
          Состав и порядок сохраняются для этой таблицы. Ширину меняйте за границу заголовка.
        </p>
        @for (column of choices(); track column.key; let i = $index) {
          <div class="table-column-choice">
            <label
              ><input
                type="checkbox"
                [checked]="!draft().hidden.includes(column.key)"
                [disabled]="
                  column.required || (!draft().hidden.includes(column.key) && visibleCount() === 1)
                "
                (change)="toggle(column.key, $event)"
              />{{ column.label }}</label
            >
            <button
              type="button"
              class="icon-button"
              [disabled]="i === 0"
              [attr.aria-label]="'Выше: ' + column.label"
              hgTooltip="Переместить выше"
              (click)="move(column.key, -1)"
            >
              <hg-icon name="arrow-up" />
            </button>
            <button
              type="button"
              class="icon-button"
              [disabled]="i === choices().length - 1"
              [attr.aria-label]="'Ниже: ' + column.label"
              hgTooltip="Переместить ниже"
              (click)="move(column.key, 1)"
            >
              <hg-icon name="arrow-down" />
            </button>
          </div>
        }
      </div>
      <footer>
        <button type="button" class="button quiet" (click)="draft.set(view().defaults())">
          По умолчанию</button
        ><span class="spacer"></span
        ><button type="button" class="button" (click)="close()">Отмена</button
        ><button type="button" class="button primary" (click)="apply()">Применить</button>
      </footer>
    </dialog>
  `,
})
export class ColumnPicker {
  readonly view = input.required<TableView>();
  readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  readonly draft = signal<TableLayout>({ order: [], hidden: [], widths: {} });
  readonly choices = computed(() => {
    const definitions = new Map(
      this.view()
        .definitions()
        .map((column) => [column.key, column]),
    );
    return this.draft().order.flatMap((key) => {
      const column = definitions.get(key);
      return column && !column.action ? [column] : [];
    });
  });
  readonly visibleCount = computed(
    () => this.choices().filter((column) => !this.draft().hidden.includes(column.key)).length,
  );
  private origin: HTMLElement | null = null;
  open() {
    this.origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.draft.set(this.view().draft());
    this.dialog().nativeElement.showModal();
  }
  close() {
    this.dialog().nativeElement.close();
    this.origin?.focus();
  }
  cancel(event: Event) {
    event.preventDefault();
    this.close();
  }
  apply() {
    if (this.visibleCount()) {
      this.view().apply(this.draft());
      this.close();
    }
  }
  toggle(key: string, event: Event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const hidden = this.draft().hidden.filter((value) => value !== key);
    if (!event.target.checked) hidden.push(key);
    this.draft.update((draft) => ({ ...draft, hidden }));
  }
  move(key: string, delta: number) {
    const choices = this.choices();
    const target = choices[choices.findIndex((column) => column.key === key) + delta];
    if (!target) return;
    const order = this.draft().order.filter((id) => id !== key);
    order.splice(order.indexOf(target.key) + Number(delta > 0), 0, key);
    this.draft.update((draft) => ({ ...draft, order }));
  }
}
