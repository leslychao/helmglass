import { Injectable, WritableSignal, computed, inject, signal } from '@angular/core';
import { Session } from '../core/session';
import { QueryState, TableQueryKeys, tableQueryKeys } from './query-state';

export interface TableColumn {
  key: string;
  label: string;
  width?: number;
  minWidth?: number;
  required?: boolean;
  hidden?: boolean;
  action?: boolean;
  help?: string;
  className?: string;
}

export interface TableLayout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}

@Injectable({ providedIn: 'root' })
export class TableViews {
  private readonly session = inject(Session);
  private readonly layouts = new Map<string, WritableSignal<TableLayout>>();

  create(
    key: string | (() => string),
    columns: readonly TableColumn[] | (() => readonly TableColumn[]),
    query: QueryState,
    keys = tableQueryKeys,
  ) {
    const definitions = typeof columns === 'function' ? columns : () => columns;
    const layout = () => {
      const identity = JSON.stringify([
        this.session.user()?.id,
        typeof key === 'function' ? key() : key,
      ]);
      let state = this.layouts.get(identity);
      if (!state) {
        state = signal<TableLayout>({ order: [], hidden: [], widths: {} });
        this.layouts.set(identity, state);
      }
      return state;
    };
    return new TableView(definitions, layout, query, keys);
  }
}

export class TableView {
  constructor(
    readonly definitions: () => readonly TableColumn[],
    private readonly state: () => WritableSignal<TableLayout>,
    readonly query: QueryState,
    readonly keys: TableQueryKeys,
  ) {}

  readonly layout = computed(() => this.state()());
  readonly columns = computed(() => {
    const definitions = this.definitions();
    const layout = this.layout();
    const order = layout.order.length ? layout.order : definitions.map((column) => column.key);
    const byKey = new Map(definitions.map((column) => [column.key, column]));
    const result: TableColumn[] = [];
    for (const key of order) {
      const column = byKey.get(key);
      if (column) {
        result.push(column);
        byKey.delete(key);
      }
    }
    return [...result, ...byKey.values()];
  });
  readonly hidden = computed(() =>
    this.layout().order.length
      ? this.layout().hidden
      : this.definitions()
          .filter((column) => column.hidden)
          .map((column) => column.key),
  );
  readonly visible = computed(() =>
    this.columns().filter(
      (column) => column.required || column.action || !this.hidden().includes(column.key),
    ),
  );
  readonly modified = computed(() => {
    const defaults = this.defaults();
    const state = this.layout();
    return (
      this.columns().some((column, index) => column.key !== defaults.order[index]) ||
      this.hidden().length !== defaults.hidden.length ||
      defaults.hidden.some((key) => !this.hidden().includes(key)) ||
      Object.keys(state.widths).length > 0 ||
      !!this.query.text(this.keys.sort) ||
      this.query.number(this.keys.page, 1) !== 1 ||
      this.query.number(this.keys.size, 5) !== 5
    );
  });

  defaults(): TableLayout {
    return {
      order: this.definitions().map((column) => column.key),
      hidden: this.definitions()
        .filter((column) => column.hidden)
        .map((column) => column.key),
      widths: {},
    };
  }
  draft(): TableLayout {
    return {
      order: this.columns().map((column) => column.key),
      hidden: [...this.hidden()],
      widths: { ...this.layout().widths },
    };
  }
  apply(layout: TableLayout) {
    this.state().set(layout);
  }
  reset() {
    this.apply(this.defaults());
    this.query.set(
      {
        [this.keys.sort]: null,
        [this.keys.direction]: null,
        [this.keys.page]: null,
        [this.keys.size]: null,
      },
      false,
    );
  }
  sort(key: string) {
    this.query.sort(key, this.keys);
  }
  ariaSort(key: string) {
    return this.query.ariaSort(key, this.keys);
  }
  direction(defaultDirection: 'asc' | 'desc' = 'asc'): 'asc' | 'desc' {
    const selected = this.query.text(this.keys.sort);
    if (!selected) return defaultDirection;
    return this.ariaSort(selected) === 'ascending' ? 'asc' : 'desc';
  }
  width(column: TableColumn) {
    return this.layout().widths[column.key] ?? column.width ?? 180;
  }
  resize(column: TableColumn, width: number) {
    const draft = this.draft();
    draft.widths[column.key] = Math.max(column.minWidth ?? 100, Math.min(700, Math.round(width)));
    this.apply(draft);
  }
  move(key: string, target: string, after: boolean) {
    if (key === target) return;
    const columns = this.definitions();
    if (
      columns.find((column) => column.key === key)?.action ||
      columns.find((column) => column.key === target)?.action
    )
      return;
    const draft = this.draft();
    draft.order = draft.order.filter((id) => id !== key);
    const index = draft.order.indexOf(target);
    if (index < 0) return;
    draft.order.splice(index + Number(after), 0, key);
    this.apply(draft);
  }
}
