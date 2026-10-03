import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuditEntry, Page } from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { DataTable } from '../../shared/data-table/data-table';
import { TableQuery } from '../../shared/data-table/table-query';
import { Dialog } from '../../shared/dialog/dialog';
import { Feedback } from '../../shared/feedback/feedback';
import { Icon } from '../../shared/icon/icon';
import { adminActions, auditColumns, auditRows } from './admin-tables';

@Component({
  selector: 'hg-admin-audit',
  imports: [FormsModule, DataTable, Feedback, Icon, Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!embedded) {
      <h1 class="sr-only" tabindex="-1">
        {{ userId ? 'Журнал пользователя' : 'Журнал действий' }}
      </h1>
    }
    <section class="panel a-section">
      <header class="a-section-header">
        <h2>{{ userId ? 'Журнал пользователя' : 'Журнал действий' }}</h2>
        <button class="btn quiet" aria-haspopup="dialog" (click)="openFilters()">
          <hg-icon name="filter" />Поиск и фильтры
        </button>
      </header>
      @if (filters().length) {
        <div class="a-filter-feedback">
          @for (filter of filters(); track filter) {
            <span class="chip">{{ filter }}</span>
          }
          <button class="btn quiet" (click)="query.clear()">Сбросить фильтры</button>
        </div>
      }
      <hg-feedback [loading]="audit.loading()" [error]="audit.error()" (retry)="audit.refresh()" />
      <hg-data-table
        [columns]="columns"
        [rows]="rows()"
        [page]="audit.data()"
        [sizes]="embedded ? [3, 10, 20, 50] : [10, 20, 50, 100]"
        (changed)="query.change($event)"
        emptyTitle="Записей нет"
        emptyText="Изменения администраторов фиксируются с причиной и временем."
      />
    </section>
    @if (filtersOpen()) {
      <hg-dialog title="Поиск и фильтры журнала" (closed)="filtersOpen.set(false)">
        <label class="field"
          >Поиск<input
            type="search"
            [(ngModel)]="draftQuery"
            maxlength="200"
            placeholder="Имя, причина, название узла или ID"
        /></label>
        <label class="field"
          >Действие<select [(ngModel)]="draftAction">
            <option value="">Все действия</option>
            @for (action of actions; track action.value) {
              <option [value]="action.value">{{ action.label }}</option>
            }
          </select></label
        >
        <button dialog-actions class="btn" (click)="filtersOpen.set(false)">Отмена</button>
        <button dialog-actions class="btn primary" (click)="applyFilters()">Применить</button>
      </hg-dialog>
    }`,
})
export class AdminAudit {
  private readonly route = inject(ActivatedRoute);
  readonly userId = this.route.snapshot.paramMap.get('id');
  readonly embedded = this.route.snapshot.routeConfig?.path === '';
  readonly query = new TableQuery({
    prefix: this.embedded ? 'audit' : undefined,
    pageSize: this.embedded ? 3 : 10,
  });
  readonly audit = new ServerResource<Page<AuditEntry>>(['audit']);
  readonly columns = auditColumns;
  readonly rows = computed(() => auditRows(this.audit.data()?.items ?? []));
  readonly actions = Object.entries(adminActions).map(([value, label]) => ({ value, label }));
  readonly filtersOpen = signal(false);
  readonly filters = computed(() =>
    [
      this.query.text('q') ? 'Поиск: ' + this.query.text('q') : '',
      adminActions[this.query.text('action')] ?? '',
    ].filter(Boolean),
  );
  draftQuery = '';
  draftAction = '';

  constructor() {
    effect(() =>
      this.audit.load(
        this.userId ? '/admin/users/' + this.userId + '/audit' : '/admin/audit',
        this.query.value(),
      ),
    );
  }
  openFilters() {
    this.draftQuery = this.query.text('q');
    this.draftAction = this.query.text('action');
    this.filtersOpen.set(true);
  }
  applyFilters() {
    this.query.filter({ q: this.draftQuery.trim() || null, action: this.draftAction || null });
    this.filtersOpen.set(false);
  }
}
