import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Directive,
  ElementRef,
  TemplateRef,
  afterNextRender,
  computed,
  contentChildren,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';
import { Tooltip } from './tooltip';
import { TableColumn, TableView } from './table-view';

@Directive({ selector: 'ng-template[hgCell]' })
export class TableCell<T> {
  readonly hgCell = input.required<string>();
  readonly hgCellOf = input.required<readonly T[]>();
  readonly template = inject<TemplateRef<{ $implicit: T }>>(TemplateRef);
  static ngTemplateContextGuard<T>(
    _directive: TableCell<T>,
    context: unknown,
  ): context is { $implicit: T } {
    return true;
  }
}

@Component({
  selector: 'hg-data-table',
  imports: [NgTemplateOutlet, Icon, Tooltip],
  templateUrl: './data-table.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DataTable<T extends object> {
  readonly view = input.required<TableView>();
  readonly rows = input.required<readonly T[]>();
  readonly label = input.required<string>();
  readonly sortable = input(true);
  readonly rowKey = input<keyof T>();
  readonly expanded = input<readonly string[]>([]);
  readonly cells = contentChildren<TableCell<T>>(TableCell);
  readonly templates = computed(
    () => new Map(this.cells().map((cell) => [cell.hgCell(), cell.template])),
  );
  readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');
  readonly available = signal(0);
  readonly moving = signal('');
  readonly drop = signal<{ key: string; after: boolean } | null>(null);
  readonly announcement = signal('');
  readonly dragLabel = signal<{ label: string; x: number; y: number } | null>(null);
  readonly marker = signal<{ label: string; x: number; y: number; height: number } | null>(null);
  readonly geometry = computed(() => {
    const view = this.view(),
      columns = view.visible();
    const widths = columns.map((column) => view.width(column));
    const total = widths.reduce((sum, width) => sum + width, 0);
    const extra = Math.max(0, this.available() - total);
    let flexible = columns.filter(
      (column) => !column.action && view.layout().widths[column.key] === undefined,
    );
    if (!flexible.length) flexible = columns.filter((column) => !column.action);
    const flexibleKeys = new Set(flexible.map((column) => column.key));
    const weight = flexible.reduce((sum, column) => sum + view.width(column), 0);
    return columns.map((column, index) => ({
      column,
      width:
        widths[index] +
        (flexibleKeys.has(column.key) && weight ? (extra * widths[index]) / weight : 0),
    }));
  });
  readonly width = computed(() => this.geometry().reduce((sum, cell) => sum + cell.width, 0));
  private cleanup: (() => void) | null = null;

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      const viewport = this.viewport().nativeElement;
      const observer = new ResizeObserver(() => this.available.set(viewport.clientWidth));
      this.available.set(viewport.clientWidth);
      observer.observe(viewport);
      destroy.onDestroy(() => observer.disconnect());
    });
    destroy.onDestroy(() => this.cleanup?.());
  }
  identity(row: T): unknown {
    const key = this.rowKey();
    return key ? row[key] : 'id' in row ? row.id : row;
  }
  isExpanded(row: T) {
    return this.expanded().includes(String(this.identity(row)));
  }
  resizeKey(event: KeyboardEvent, column: TableColumn, width: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    this.view().resize(
      column,
      event.key === 'Home'
        ? (column.minWidth ?? 100)
        : width + (event.key === 'ArrowLeft' ? -10 : 10),
    );
  }
  moveKey(event: KeyboardEvent, column: TableColumn) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const columns = this.view()
      .visible()
      .filter((candidate) => !candidate.action);
    const delta = event.key === 'ArrowLeft' ? -1 : 1;
    const target = columns[columns.findIndex((candidate) => candidate.key === column.key) + delta];
    if (target) {
      this.view().move(column.key, target.key, delta > 0);
      this.announcement.set('Столбец «' + column.label + '» перемещён.');
    }
  }
  resize(event: PointerEvent, column: TableColumn, width: number) {
    const initial = this.view().draft();
    this.pointer(
      event,
      (x) => this.view().resize(column, width + x - event.clientX),
      (cancel) => {
        if (cancel) this.view().apply(initial);
      },
    );
  }
  drag(event: PointerEvent, column: TableColumn) {
    const viewport = this.viewport().nativeElement;
    let pointerX = event.clientX;
    let frame = 0;
    const update = () => {
      const headers = viewport.querySelectorAll<HTMLElement>(
        ':scope > table > thead > tr > th[data-column]',
      );
      this.drop.set(null);
      this.marker.set(null);
      for (const header of headers) {
        const key = header.dataset['column'];
        const target = this.view()
          .definitions()
          .find((item) => item.key === key);
        const rect = header.getBoundingClientRect();
        if (
          target &&
          !target.action &&
          key !== column.key &&
          pointerX >= rect.left &&
          pointerX <= rect.right
        ) {
          this.drop.set({ key: target.key, after: pointerX > rect.left + rect.width / 2 });
          const viewportRect = viewport.getBoundingClientRect();
          const after = pointerX > rect.left + rect.width / 2;
          this.marker.set({
            label: (after ? 'После «' : 'Перед «') + target.label + '»',
            x: Math.max(
              viewportRect.left,
              Math.min(viewportRect.right, after ? rect.right : rect.left),
            ),
            y: viewportRect.top,
            height: Math.min(viewportRect.height, window.innerHeight - viewportRect.top - 15),
          });
          break;
        }
      }
    };
    const scroll = () => {
      const rect = viewport.getBoundingClientRect();
      const before = viewport.scrollLeft;
      if (pointerX < rect.left + 32) viewport.scrollLeft -= 10;
      else if (pointerX > rect.right - 32) viewport.scrollLeft += 10;
      if (viewport.scrollLeft !== before) update();
      frame = requestAnimationFrame(scroll);
    };
    this.pointer(
      event,
      (x, y) => {
        pointerX = x;
        if (!this.moving() && Math.hypot(x - event.clientX, y - event.clientY) > 5) {
          this.moving.set(column.key);
          frame = requestAnimationFrame(scroll);
        }
        if (this.moving()) {
          this.dragLabel.set({
            label: column.label,
            x: Math.min(x + 16, window.innerWidth - 220),
            y: y + 16,
          });
          update();
        }
      },
      (cancel) => {
        cancelAnimationFrame(frame);
        const target = this.drop();
        if (!cancel && this.moving() && target) {
          this.view().move(column.key, target.key, target.after);
          this.announcement.set('Столбец «' + column.label + '» перемещён.');
        }
        this.moving.set('');
        this.drop.set(null);
        this.dragLabel.set(null);
        this.marker.set(null);
      },
    );
  }
  private pointer(
    event: PointerEvent,
    move: (x: number, y: number) => void,
    finish: (cancel: boolean) => void,
  ) {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    this.cleanup?.();
    const handle = event.currentTarget;
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    const onMove = (next: PointerEvent) => move(next.clientX, next.clientY);
    const end = (cancel: boolean) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onCancel);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      this.cleanup = null;
      finish(cancel);
    };
    const onUp = () => end(false);
    const onCancel = () => end(true);
    const onKey = (key: KeyboardEvent) => {
      if (key.key === 'Escape') {
        key.preventDefault();
        key.stopPropagation();
        end(true);
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onCancel);
    this.cleanup = onCancel;
  }
}
