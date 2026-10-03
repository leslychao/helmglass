import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Page, Query } from '../../core/api/models';
import { Icon } from '../icon/icon';
import { Status } from '../status/status';
import { SiteMark } from '../site-mark/site-mark';
export interface Column {
  key: string;
  title: string;
  sort?: string;
  width?: string;
  kind?: 'text' | 'status' | 'site' | 'person';
}
export interface TableItem {
  id: string;
  values: Readonly<Record<string, string>>;
  metadata?: Readonly<Record<string, string>>;
  link?: string;
  state?: string;
  actionDisabled?: boolean;
}
@Component({
  selector: 'hg-data-table',
  host: { class: 'grid6' },
  imports: [RouterLink, Icon, Status, SiteMark],
  styles: `
    .person-cell {
      display: flex;
      gap: 11px;
      align-items: center;
    }
    .person-cell .avatar {
      width: 34px;
      height: 34px;
      border-radius: 9px;
      flex: none;
    }
    .person-cell .cell-meta {
      white-space: pre-line;
      overflow-wrap: anywhere;
      font-size: 10px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="table-scroll">
      <table class="data-table g6-table">
        <thead>
          <tr>
            @for (column of columns(); track column.key) {
              <th [style.width]="column.width" [attr.aria-sort]="sortState(column)">
                @if (column.sort) {
                  <button
                    class="sort-button"
                    [attr.aria-label]="sortLabel(column)"
                    (click)="sort(column)"
                  >
                    {{ column.title }}<span aria-hidden="true">{{ arrow(column) }}</span>
                  </button>
                } @else {
                  {{ column.title }}
                }
              </th>
            }
            @if (actions()) {
              <th class="action-column"><span class="sr-only">Действия</span></th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.id) {
            <tr>
              @for (column of columns(); track column.key; let first = $first) {
                <td>
                  @if (column.kind === 'status') {
                    <hg-status [value]="row.values[column.key]" />
                  } @else if (column.kind === 'person') {
                    <div class="person-cell">
                      <span class="avatar" aria-hidden="true">{{
                        row.values[column.key].slice(0, 1)
                      }}</span>
                      <div>
                        @if (row.link) {
                          <a class="cell-title" [routerLink]="row.link">{{
                            row.values[column.key]
                          }}</a>
                        } @else {
                          <strong>{{ row.values[column.key] }}</strong>
                        }
                        <small class="cell-meta">{{ row.metadata?.[column.key] }}</small>
                      </div>
                    </div>
                  } @else if (column.kind === 'site') {
                    <div class="service-cell">
                      <hg-site-mark [host]="row.metadata?.[column.key] || row.values[column.key]" />
                      <div>
                        @if (first && row.link) {
                          <a class="cell-title" [routerLink]="row.link">{{
                            row.values[column.key]
                          }}</a>
                        } @else {
                          <strong>{{ row.values[column.key] }}</strong>
                        }
                        @if (row.metadata?.[column.key]; as meta) {
                          <small>{{ meta }}</small>
                        }
                      </div>
                    </div>
                  } @else {
                    @if (first && row.link) {
                      <a class="cell-title" [routerLink]="row.link">{{ row.values[column.key] }}</a>
                    } @else {
                      <span [class.cell-state]="column.key === 'state'">{{
                        row.values[column.key] ?? '—'
                      }}</span>
                    }
                    @if (row.metadata?.[column.key]; as meta) {
                      <span class="cell-meta">{{ meta }}</span>
                    }
                  }
                </td>
              }
              @if (actions()) {
                <td>
                  <button
                    class="icon-btn"
                    [disabled]="row.actionDisabled === true"
                    [attr.aria-label]="'Действия: ' + (row.values[columns()[0].key] ?? row.id)"
                    (click)="action.emit(row.id)"
                  >
                    <hg-icon name="more" />
                  </button>
                </td>
              }
            </tr>
          } @empty {
            @if (page() || showEmpty()) {
              <tr>
                <td [attr.colspan]="columns().length + (actions() ? 1 : 0)">
                  <div class="empty-table">
                    <hg-icon [name]="emptyIcon()" />
                    <h3>{{ emptyTitle() }}</h3>
                    <p>{{ emptyText() }}</p>
                  </div>
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    </div>
    @if (page(); as page) {
      <footer class="table-footer">
        <span>{{ range() }} из {{ page.total }}</span
        ><label class="page-size"
          >На странице
          <select aria-label="Строк на странице" [value]="page.pageSize" (change)="resize($event)">
            @for (size of sizes(); track size) {
              <option [value]="size">{{ size }}</option>
            }
          </select></label
        >
        <nav class="pager" aria-label="Страницы таблицы">
          <button
            class="btn"
            aria-label="Предыдущая страница"
            [disabled]="page.page <= 1"
            (click)="changed.emit({ page: page.page - 1 })"
          >
            ‹
          </button>
          @for (number of pages(); track number) {
            <button
              class="btn"
              [class.current]="number === page.page"
              [attr.aria-current]="number === page.page ? 'page' : null"
              [attr.aria-label]="'Страница ' + number"
              (click)="changed.emit({ page: number })"
            >
              {{ number }}
            </button>
          }
          <button
            class="btn"
            aria-label="Следующая страница"
            [disabled]="page.page * page.pageSize >= page.total"
            (click)="changed.emit({ page: page.page + 1 })"
          >
            ›
          </button>
        </nav>
      </footer>
    }
  `,
})
export class DataTable {
  columns = input.required<readonly Column[]>();
  rows = input.required<TableItem[]>();
  page = input<Pick<Page<unknown>, 'total' | 'page' | 'pageSize' | 'sort'> | null>(null);
  actions = input(false);
  sizes = input([10, 20, 50]);
  emptyIcon = input('search');
  showEmpty = input(false);
  emptyTitle = input('Ничего не найдено');
  emptyText = input('Измените поиск или сбросьте фильтры.');
  changed = output<Query>();
  action = output<string>();
  pages = computed(() => {
    const page = this.page();
    if (!page) return [];
    const count = Math.max(1, Math.ceil(page.total / page.pageSize)),
      start = Math.max(1, Math.min(page.page - 2, count - 4));
    return Array.from({ length: Math.min(5, count) }, (_, i) => start + i);
  });
  range() {
    const p = this.page();
    return !p || !p.total
      ? '0'
      : `${(p.page - 1) * p.pageSize + 1}–${Math.min(p.page * p.pageSize, p.total)}`;
  }
  sortState(c: Column) {
    const sort = this.page()?.sort;
    return sort && sort.field === c.sort
      ? sort.direction === 'asc'
        ? 'ascending'
        : 'descending'
      : 'none';
  }
  arrow(c: Column) {
    return this.sortState(c) === 'ascending' ? '↑' : this.sortState(c) === 'descending' ? '↓' : '↕';
  }
  sortLabel(c: Column) {
    return `${c.title}: ${this.sortState(c) === 'none' ? 'по возрастанию' : this.sortState(c) === 'ascending' ? 'по убыванию' : 'без сортировки'}`;
  }
  sort(c: Column) {
    const state = this.sortState(c);
    this.changed.emit({
      sort: state === 'descending' ? null : c.sort,
      direction: state === 'none' ? 'asc' : state === 'ascending' ? 'desc' : null,
      page: 1,
    });
  }
  resize(event: Event) {
    if (event.target instanceof HTMLSelectElement)
      this.changed.emit({ pageSize: Number(event.target.value), page: 1 });
  }
}
