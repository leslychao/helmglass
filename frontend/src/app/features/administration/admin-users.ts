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
import { AdminUserListItem, Page } from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { DataTable } from '../../shared/data-table/data-table';
import { TableQuery } from '../../shared/data-table/table-query';
import { Dialog } from '../../shared/dialog/dialog';
import { Feedback } from '../../shared/feedback/feedback';
import { Icon } from '../../shared/icon/icon';
import { LabelPipe } from '../../shared/status/status';
import { userColumns, userRows } from './admin-tables';

@Component({
  selector: 'hg-admin-users',
  imports: [DataTable, Feedback, Icon, FormsModule, Dialog, LabelPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!embedded) {
      <h1 class="sr-only" tabindex="-1">Пользователи</h1>
    }
    <section class="panel a-section">
      <header class="a-section-header">
        <h2>Пользователи</h2>
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
      <hg-feedback [loading]="users.loading()" [error]="users.error()" (retry)="users.refresh()" />
      <hg-data-table
        [columns]="columns"
        [rows]="rows()"
        [page]="users.data()"
        [sizes]="embedded ? [5, 10, 20, 50] : [10, 20, 50, 100]"
        (changed)="query.change($event)"
      />
      <p class="a-effective-note">
        «Занято» — браузеры пользователя, включая запускаемые и завершаемые. «Ожидают» — задачи в
        очереди, ожидающие ChatGPT или участия пользователя. Лимит задаёт допустимое количество;
        черновики не учитываются.
      </p>
    </section>
    @if (filtersOpen()) {
      <hg-dialog title="Поиск и фильтры пользователей" (closed)="filtersOpen.set(false)">
        <label class="field"
          >Поиск<input
            type="search"
            [(ngModel)]="draftQuery"
            maxlength="200"
            placeholder="Имя, email или ID"
        /></label>
        <fieldset class="a-filter-group">
          <legend>Состояние аккаунта</legend>
          @for (state of states; track state) {
            <label class="h-option"
              ><input
                type="checkbox"
                [checked]="draftStates.includes(state)"
                (change)="toggleState(state)"
              /><span>{{ state | label }}</span></label
            >
          }
        </fieldset>
        <fieldset class="a-filter-group">
          <legend>Задачи и операции пользователя</legend>
          <label class="h-option"
            ><input type="checkbox" [(ngModel)]="draftPending" /><span
              >Есть незавершённые операции</span
            ></label
          >
          <label class="h-option"
            ><input type="checkbox" [(ngModel)]="draftWaiting" /><span
              >Есть ожидающие задачи</span
            ></label
          >
          <p class="small muted">
            Операции — остановка задач или очистка аккаунта, которые ещё не подтверждены.
          </p>
        </fieldset>
        <button dialog-actions class="btn" (click)="filtersOpen.set(false)">Отмена</button>
        <button dialog-actions class="btn primary" (click)="applyFilters()">Применить</button>
      </hg-dialog>
    }`,
})
export class AdminUsers {
  readonly embedded = inject(ActivatedRoute).snapshot.routeConfig?.path === '';
  readonly query = new TableQuery({
    prefix: this.embedded ? 'users' : undefined,
    pageSize: this.embedded ? 5 : 10,
  });
  readonly users = new ServerResource<Page<AdminUserListItem>>([
    'users',
    'sessions',
    'tasks',
    'operations',
  ]);
  readonly states = ['ACTIVE', 'BLOCKED', 'DELETING', 'PURGING', 'DELETED'];
  readonly columns = userColumns;
  readonly rows = computed(() => userRows(this.users.data()?.items ?? []));
  readonly filtersOpen = signal(false);
  readonly filters = computed(() =>
    [
      this.query.text('q') ? 'Поиск: ' + this.query.text('q') : '',
      ...this.query.values('accountState').map((state) => new LabelPipe().transform(state)),
      this.query.text('pending') === 'true' ? 'Есть незавершённые операции' : '',
      this.query.text('waiting') === 'true' ? 'Есть ожидающие задачи' : '',
    ].filter(Boolean),
  );
  draftQuery = '';
  draftStates: string[] = [];
  draftPending = false;
  draftWaiting = false;

  constructor() {
    effect(() => this.users.load('/admin/users', this.query.value()));
  }
  openFilters() {
    this.draftQuery = this.query.text('q');
    this.draftStates = [...this.query.values('accountState')];
    this.draftPending = this.query.text('pending') === 'true';
    this.draftWaiting = this.query.text('waiting') === 'true';
    this.filtersOpen.set(true);
  }
  toggleState(state: string) {
    this.draftStates = this.draftStates.includes(state)
      ? this.draftStates.filter((item) => item !== state)
      : [...this.draftStates, state];
  }
  applyFilters() {
    this.query.filter({
      q: this.draftQuery.trim() || null,
      accountState: this.draftStates,
      pending: this.draftPending ? 'true' : null,
      waiting: this.draftWaiting ? 'true' : null,
    });
    this.filtersOpen.set(false);
  }
}
