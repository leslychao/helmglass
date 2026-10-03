import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormBuilder, FormControl, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import { Connection, Page } from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { Mutation } from '../../core/api/mutation';
import { TableQuery } from '../../shared/data-table/table-query';
import { Column, DataTable, TableItem } from '../../shared/data-table/data-table';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Dialog } from '../../shared/dialog/dialog';
import { Icon } from '../../shared/icon/icon';
import { Status, LabelPipe } from '../../shared/status/status';
import { BrowserPanel } from '../../shared/browser-panel/browser-panel';
import { BrowserInstance } from '../../shared/browser-panel/browser-instance';
import { AsyncOperation } from '../../shared/async-operation/async-operation';
import { SiteMultiselect } from '../../shared/site-multiselect/site-multiselect';

@Component({
  selector: 'hg-connections',
  imports: [
    RouterLink,
    ReactiveFormsModule,
    DataTable,
    Feedback,
    MutationFeedback,
    Dialog,
    Icon,
    LabelPipe,
    SiteMultiselect,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="sr-only" tabindex="-1">Подключения</h1>
    <div class="h-page-actions">
      <button class="btn h-create" (click)="createOpen.set(true)">
        <span class="h-create-icon"><hg-icon name="plus" /></span>Добавить подключение
      </button>
    </div>
    <section class="panel h-list">
      <div class="h-toolbar">
        <div class="h-filters-left">
          <label class="search h-search h-search-wide"
            ><hg-icon name="search" /><input
              type="search"
              [formControl]="search"
              placeholder="Поиск подключений"
              aria-label="Поиск подключений" /></label
          ><label class="filter-select"
            ><span class="sr-only">Состояние</span
            ><select [value]="query.text('status')" (change)="filter($event)">
              <option value="">Все состояния</option>
              @for (state of states; track state) {
                <option [value]="state">{{ state | label }}</option>
              }
            </select></label
          >
          <details class="filter">
            <summary>Сайт</summary>
            <hg-site-multiselect
              scope="connections"
              [selectedIds]="query.values('siteId')"
              (changed)="query.filter({ siteId: $event })"
            />
          </details>
          @if (query.text('q') || query.text('status') || query.values('siteId').length) {
            <button class="btn quiet" (click)="query.clear()">Сбросить фильтры</button>
          }
        </div>
      </div>
      <hg-feedback
        [loading]="connections.loading()"
        [error]="connections.error()"
        (retry)="connections.refresh()"
      /><hg-data-table
        [columns]="columns"
        [rows]="rows()"
        [page]="connections.data()"
        [actions]="true"
        (changed)="query.change($event)"
        (action)="openConnection($event)"
        emptyTitle="Добавьте первое подключение"
        emptyText="Войдите на нужный сайт один раз и сохраните вход для следующих задач."
        emptyIcon="plug"
      />
    </section>
    <section class="panel h-mcp-card" aria-label="ChatGPT через MCP">
      <div class="integration-symbol"><hg-icon name="chat" /></div>
      <div>
        <strong>ChatGPT через MCP</strong>
        <p class="small muted">Внешний исполнитель</p>
      </div>
      <a class="btn" routerLink="/connections/guide">Настроить</a>
    </section>
    @if (createOpen()) {
      <hg-dialog
        title="Добавить подключение"
        [busy]="action.pending()"
        (closed)="createOpen.set(false)"
        ><form [formGroup]="form" (ngSubmit)="create()" id="create-connection">
          <div class="field">
            <label for="connection-name">Название</label
            ><input
              id="connection-name"
              formControlName="displayName"
              maxlength="200"
              placeholder="Рабочий аккаунт"
            />
          </div>
          <div class="field">
            <label for="connection-url">Адрес сайта</label
            ><input
              id="connection-url"
              type="url"
              formControlName="startUrl"
              required
              placeholder="https://yang.yandex-team.ru"
            /><small>Пароль вводится только в приватном браузере сайта.</small>
          </div>
          <hg-mutation [action]="action" />
        </form>
        <div dialog-actions class="flex">
          <button class="btn" (click)="createOpen.set(false)" [disabled]="action.pending()">
            Отмена</button
          ><button
            class="btn primary"
            type="submit"
            form="create-connection"
            [disabled]="!form.controls.startUrl.value || action.pending() || action.unknown()"
          >
            Добавить подключение
          </button>
        </div></hg-dialog
      >
    }
  `,
})
export class Connections {
  readonly query = new TableQuery();
  readonly connections = new ServerResource<Page<Connection>>(['connections']);
  readonly action = new Mutation();
  readonly createOpen = signal(false);
  readonly search = new FormControl(this.query.text('q'), { nonNullable: true });
  readonly states = [
    'NEEDS_LOGIN',
    'SAVED',
    'AUTHENTICATED',
    'SESSION_ONLY',
    'CHECKING',
    'EXPIRED',
    'DELETING',
  ];
  private router = inject(Router);
  private fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({ displayName: [''], startUrl: [''] });
  readonly columns: Column[] = [
    { key: 'name', title: 'Подключение', sort: 'displayName', width: '28%', kind: 'site' },
    { key: 'state', title: 'Состояние', sort: 'status', kind: 'status' },
    { key: 'lastLogin', title: 'Последний вход', sort: 'lastSuccessfulLoginAt' },
  ];
  readonly rows = computed<TableItem[]>(
    () =>
      this.connections.data()?.items.map((connection) => ({
        id: connection.id,
        link: '/connections/' + connection.id,
        metadata: { name: connection.host },
        values: {
          name: connection.displayName,
          state: connection.status,
          lastLogin: connection.lastSuccessfulLoginAt
            ? new Date(connection.lastSuccessfulLoginAt).toLocaleString('ru-RU')
            : 'Нет данных',
        },
      })) ?? [],
  );
  constructor() {
    effect(() => {
      this.connections.load('/connections', this.query.value());
      this.search.setValue(this.query.text('q'), { emitEvent: false });
    });
    this.search.valueChanges
      .pipe(debounceTime(250), distinctUntilChanged(), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((q) => this.query.filter({ q: q || null }));
  }
  filter(event: Event) {
    if (event.target instanceof HTMLSelectElement)
      this.query.filter({ status: event.target.value || null });
  }
  openConnection(id: string) {
    void this.router.navigate(['/connections', id]);
  }
  create() {
    this.action.run(
      'POST',
      '/connections',
      { ...this.form.getRawValue(), savePreference: 'ASK' },
      (receipt) => {
        this.createOpen.set(false);
        this.form.reset();
        void this.router.navigate(['/connections', receipt.resource.id]);
      },
    );
  }
}

@Component({
  selector: 'hg-connection-detail',
  imports: [
    RouterLink,
    ReactiveFormsModule,
    Feedback,
    MutationFeedback,
    Dialog,
    Icon,
    Status,
    BrowserPanel,
    AsyncOperation,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hg-feedback
      [loading]="connection.loading()"
      [error]="connection.error()"
      (retry)="connection.refresh()"
    />
    @if (connection.data(); as connection) {
      <header class="heading">
        <div>
          <h1 tabindex="-1">{{ connection.displayName }}</h1>
          <p class="description">{{ connection.host }}</p>
        </div>
        <button class="btn" (click)="renameOpen.set(true)">Переименовать</button>
      </header>
      <section class="panel connection-summary">
        <div class="connection-symbol"><hg-icon name="globe" /></div>
        <div>
          <p><hg-status [value]="connection.status" /></p>
        </div>
        <div class="flex">
          @if (connection.currentTaskId) {
            <a class="btn primary" [routerLink]="'/tasks/' + connection.currentTaskId"
              >Открыть браузер</a
            >
          } @else if (connection.loginOperationId) {
            <a class="btn primary" [routerLink]="'/login-operations/' + connection.loginOperationId"
              >Продолжить вход</a
            >
          } @else if (connection.capabilities['login']?.allowed) {
            <button class="btn primary" [disabled]="busy()" (click)="login()">Войти на сайт</button>
          }
          @if (connection.capabilities['check']?.allowed) {
            <button class="btn" [disabled]="busy()" (click)="check()">Проверить вход</button>
          }
          @if (connection.capabilities['delete']?.allowed) {
            <button class="btn danger" [disabled]="busy()" (click)="deleteOpen.set(true)">
              Удалить
            </button>
          }
        </div>
      </section>
      <hg-mutation [action]="action" />
      @if (action.receipt()?.operationId; as operation) {
        <hg-operation [id]="operation" />
      }
      @if (connection.sessionId && !connection.currentTaskId) {
        <hg-browser-panel
          [sessionId]="connection.sessionId"
          (changed)="connectionResourceRefresh()"
        />
      }
      <div class="notice neutral">
        <strong>Сохранённый вход и открытый браузер — разные состояния</strong>
        <p>
          Сохранённый профиль применяется при разрешённом открытии браузера. Проверка страницы сама
          по себе не создаёт новый браузер.
        </p>
      </div>
    }
    @if (renameOpen()) {
      <hg-dialog
        title="Переименовать подключение"
        [busy]="action.pending()"
        (closed)="renameOpen.set(false)"
        ><div class="field">
          <label for="rename">Название</label
          ><input id="rename" [formControl]="name" maxlength="200" />
        </div>
        <hg-mutation [action]="action" /><button
          dialog-actions
          class="btn primary"
          [disabled]="busy() || !name.value.trim()"
          (click)="rename()"
        >
          Сохранить
        </button></hg-dialog
      >
    }
    @if (deleteOpen()) {
      <hg-dialog
        title="Удалить подключение?"
        [busy]="action.pending()"
        (closed)="deleteOpen.set(false)"
        ><p>
          Сохранённый вход будет удалён. Новые команды с этим подключением будут запрещены. История
          задач сохранится.
        </p>
        <hg-mutation [action]="action" />
        <div dialog-actions class="flex">
          <button class="btn" (click)="deleteOpen.set(false)">Отмена</button
          ><button class="btn danger" [disabled]="busy()" (click)="remove()">
            Удалить подключение
          </button>
        </div></hg-dialog
      >
    }
  `,
})
export class ConnectionDetail {
  private router = inject(Router);
  private instance = inject(BrowserInstance);
  readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';
  readonly connection = new ServerResource<Connection>(['connections']);
  readonly action = new Mutation();
  readonly renameOpen = signal(false);
  readonly deleteOpen = signal(false);
  readonly name = new FormControl('', { nonNullable: true });
  readonly busy = computed(() => this.action.pending() || this.action.unknown());
  constructor() {
    this.connection.load('/connections/' + this.id);
    effect(() => {
      const connection = this.connection.data();
      if (connection && !this.name.dirty) this.name.setValue(connection.displayName);
    });
  }
  connectionResourceRefresh() {
    this.connection.refresh();
  }
  login() {
    this.action.run(
      'POST',
      `/connections/${this.id}/login`,
      { controllerInstanceId: this.instance.id },
      (receipt) => void this.router.navigate(['/login-operations', receipt.resource.id]),
    );
  }
  check() {
    this.action.run('POST', `/connections/${this.id}/check`, {}, () => this.connection.refresh());
  }
  rename() {
    this.action.run(
      'PATCH',
      `/connections/${this.id}`,
      { expectedVersion: this.connection.data()?.version, displayName: this.name.value.trim() },
      () => {
        this.renameOpen.set(false);
        this.name.markAsPristine();
        this.connection.refresh();
      },
    );
  }
  remove() {
    this.action.run(
      'DELETE',
      `/connections/${this.id}`,
      { expectedVersion: this.connection.data()?.version },
      () => {
        this.deleteOpen.set(false);
        this.connection.refresh();
      },
    );
  }
}
