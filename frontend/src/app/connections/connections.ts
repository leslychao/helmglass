import { ColumnPicker } from '../shared/column-picker';
import { TableViews, TableColumn } from '../shared/table-view';
import { DataTable, TableCell } from '../shared/data-table';
import { Icon } from '../shared/icon';
import { FilterReset } from '../shared/filter-reset';
import { Autocomplete, AutocompleteOption } from '../shared/autocomplete';
import { DatePipe } from '@angular/common';
import { CdkMenuModule } from '@angular/cdk/menu';
import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { Connection, Page, connectionSchema, integrationSchema, pageSchema } from '../core/models';
import { Dialog } from '../shared/dialog';
import { MultiFilter } from '../shared/multi-filter';
import { QueryState } from '../shared/query-state';
import { Tooltip } from '../shared/tooltip';
import { Empty, Pager, Status } from '../shared/ui';

@Component({
  selector: 'hg-connections',
  imports: [
    DataTable,
    TableCell,
    ColumnPicker,
    Icon,
    FilterReset,
    Autocomplete,
    DatePipe,
    CdkMenuModule,
    MultiFilter,
    Empty,
    Pager,
    Status,
    Tooltip,
  ],
  providers: [QueryState],
  template: `
    <h1 class="sr-only">Подключения</h1>
    <header class="page-actions">
      <button
        class="button primary page-create-action"
        (click)="create()"
        aria-label="Добавить подключение"
        hgTooltip="Добавить подключение"
      >
        <span class="page-create-icon"><hg-icon name="plus" /></span>
        Добавить подключение
      </button>
    </header>
    @if (error()) {
      <div class="error-banner" role="alert">
        {{ error() }}<button class="text-button" (click)="load()">Повторить</button>
      </div>
    }
    <section class="card table-card" [attr.aria-busy]="loading()">
      @if (query.values('site').length) {
        <div class="selected-chips">
          @for (site of query.values('site'); track site) {
            <button
              class="site-chip"
              [attr.aria-label]="'Снять фильтр сайта ' + site"
              (click)="removeSite(site)"
            >
              {{ site }} <hg-icon name="close" />
            </button>
          }
        </div>
      }
      <div class="toolbar">
        <hg-autocomplete
          label="Сайт"
          [multiple]="true"
          [selected]="query.values('site')"
          [load]="siteSuggestions"
          (picked)="selectSite($event)"
        />
        <hg-multi-filter
          label="Состояние"
          [options]="statuses"
          [value]="query.values('status')"
          (changed)="query.set({ status: $event })"
        />
        <hg-filter-reset [keys]="['status', 'site']" /><hg-column-picker [view]="table" />
      </div>
      @if (data(); as page) {
        @if (page.items.length) {
          <hg-data-table [view]="table" [rows]="page.items" label="Подключения">
            <ng-template hgCell="name" [hgCellOf]="page.items" let-connection>
              <button class="connection-title" (click)="login(connection)">
                <span class="service-mark"><hg-icon name="globe" /></span
                ><span
                  ><strong>{{ connection.name }}</strong
                  ><small
                    >{{ connection.site }}
                    @if (connection.accountLabel) {
                      · {{ connection.accountLabel }}
                    }
                  </small></span
                >
              </button>
            </ng-template>
            <ng-template hgCell="status" [hgCellOf]="page.items" let-connection>
              <hg-status
                [value]="connection.status === 'READY' ? 'CONNECTION_READY' : connection.status"
              />
            </ng-template>
            <ng-template hgCell="lastUsedAt" [hgCellOf]="page.items" let-connection>
              {{
                connection.lastUsedAt
                  ? (connection.lastUsedAt | date: 'dd.MM.yyyy HH:mm')
                  : 'Ещё не использовалось'
              }}
            </ng-template>
            <ng-template hgCell="actions" [hgCellOf]="page.items" let-connection>
              <div class="actions">
                <button
                  class="icon-button"
                  aria-label="Открыть браузер"
                  hgTooltip="Открыть браузер"
                  [disabled]="busy() === connection.id"
                  (click)="login(connection)"
                >
                  <hg-icon name="browser" />
                </button>
                <button
                  class="icon-button"
                  aria-label="Действия с подключением"
                  hgTooltip="Действия"
                  [cdkMenuTriggerFor]="connectionMenu"
                >
                  <hg-icon name="more" />
                </button>
                <ng-template #connectionMenu>
                  <div cdkMenu class="menu-popover anchored-menu">
                    <button cdkMenuItem (click)="rename(connection)">Переименовать…</button
                    ><button cdkMenuItem class="danger-text" (click)="remove(connection)">
                      Удалить подключение…
                    </button>
                  </div>
                </ng-template>
              </div>
            </ng-template>
          </hg-data-table>
        } @else {
          <hg-empty
            [title]="hasFilters() ? 'Подключения не найдены' : 'Подключений пока нет'"
            [description]="
              hasFilters()
                ? 'Измените выбранные фильтры.'
                : 'Добавьте сайт и сохраните вход в защищённом браузере.'
            "
            ><button
              class="icon-button primary"
              (click)="create()"
              aria-label="Добавить подключение"
              hgTooltip="Добавить подключение"
            >
              <hg-icon name="plus" /></button
          ></hg-empty>
        }
        <hg-pager
          [page]="page.page"
          [size]="page.pageSize"
          [total]="page.total"
          (pageChange)="query.set({ page: $event }, false)"
          (sizeChange)="query.set({ pageSize: $event })"
        />
      } @else if (loading()) {
        <div class="loading" role="status">Загружаем подключения…</div>
      }
    </section>
    <details class="card chatgpt-connection">
      <summary class="integration-header">
        <span class="service-mark chatgpt"><hg-icon name="gpt" /></span
        ><span class="integration-name"
          ><strong>ChatGPT</strong><small>Работа с задачами через MCP</small></span
        >
        @if (integration(); as integration) {
          <span class="badge" [class.success]="integration.connected">{{
            integration.connected ? 'Доступ подключён' : 'Нет активного доступа'
          }}</span>
        }
        <span class="integration-toggle">Настроить <hg-icon name="chevron-down" /></span>
      </summary>
      <div class="integration-body">
        <div>
          <p class="muted">
            Добавьте Helm Glass в подключениях ChatGPT как MCP-сервер и пройдите авторизацию своей
            учётной записью.
          </p>
          <label class="field"
            >Адрес MCP-сервера<input [value]="mcpUrl()" readonly (click)="selectAddress($event)"
          /></label>
          <p class="muted">
            В открытом чате включите Helm Glass и поручите работу. Вход в кабинет и доступ ChatGPT
            независимы.
          </p>
        </div>
        <div class="actions">
          <button class="button" (click)="copyMcp()">Скопировать адрес</button
          ><button
            class="text-button danger-text"
            [disabled]="
              revoking() ||
              (integration()?.connected === false &&
                !integration()?.viewerClosePending &&
                !integration()?.viewerCloseFailed)
            "
            (click)="revokeMcp()"
          >
            {{
              integration()?.viewerClosePending || integration()?.viewerCloseFailed
                ? 'Повторить закрытие просмотров'
                : 'Отозвать доступ ChatGPT'
            }}
          </button>
        </div>
        @if (mcpMessage()) {
          <p class="notice" role="status">{{ mcpMessage() }}</p>
        }
        @if (integration()?.viewerClosePending || integration()?.viewerCloseFailed) {
          <p class="notice warning" role="status">
            Новые команды ChatGPT запрещены. Закрытие прежних просмотров
            {{
              integration()?.viewerCloseFailed
                ? 'не подтверждено; повторите закрытие'
                : 'ещё выполняется'
            }}.
          </p>
        }
        @if (integrationError()) {
          <p class="error-banner" role="alert">
            {{ integrationError() }}
            <button class="text-button" (click)="loadIntegration()">Повторить</button>
          </p>
        }
      </div>
    </details>
  `,
})
export class Connections {
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private readonly router = inject(Router);
  private generation = 0;
  readonly data = signal<Page<Connection> | null>(null);
  readonly error = signal('');
  readonly loading = signal(true);
  readonly busy = signal('');
  readonly integration = signal<z.infer<typeof integrationSchema> | null>(null);
  readonly integrationError = signal('');
  readonly mcpUrl = computed(() => this.integration()?.endpoint ?? location.origin + '/mcp');
  readonly hasFilters = computed(() => this.query.hasFilters(['status', 'site']));
  readonly siteSuggestions = async (search: string) => {
    const page = await this.api.get('/api/connections/sites', pageSchema(z.string()), {
      search,
      suggestions: 'true',
    });
    return { total: page.total, items: page.items.map((site) => ({ id: site, label: site })) };
  };
  selectSite(site: AutocompleteOption) {
    const current = this.query.values('site');
    this.query.set({
      site: current.includes(site.id)
        ? current.filter((value) => value !== site.id)
        : [...current, site.id],
    });
  }
  readonly revoking = signal(false);
  readonly mcpMessage = signal('');
  selectAddress(event: Event) {
    if (event.target instanceof HTMLInputElement) event.target.select();
  }
  async copyMcp() {
    try {
      await navigator.clipboard.writeText(this.mcpUrl());
      this.mcpMessage.set('Адрес скопирован.');
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    }
  }
  async loadIntegration() {
    try {
      this.integration.set(await this.api.get('/api/integrations/chatgpt', integrationSchema));
      this.integrationError.set('');
    } catch (error: unknown) {
      this.integrationError.set(errorMessage(error));
    }
  }
  async revokeMcp() {
    if (
      this.revoking() ||
      !(await this.dialog.ask(
        'Отозвать доступ ChatGPT?',
        'Ранее подключённые чаты не смогут отправлять новые команды. Задачи и результаты сохранятся; вход в кабинет продолжит работать.',
        'Отозвать доступ',
        [],
        true,
      ))
    )
      return;
    this.revoking.set(true);
    try {
      const result = await this.api.mutate(
        '/api/integrations/chatgpt/revoke',
        {},
        z.object({
          revoked: z.literal(true),
          status: z.enum(['COMPLETED', 'PENDING']),
          message: z.nullable(z.string()),
        }),
      );
      this.integration.update((value) =>
        value
          ? {
              ...value,
              connected: false,
              viewerClosePending: result.status === 'PENDING',
              viewerCloseFailed: false,
            }
          : value,
      );
      this.mcpMessage.set(
        result.message ??
          (result.status === 'PENDING'
            ? 'Доступ к новым командам отозван; закрытие прежних просмотров ещё не подтверждено.'
            : 'Доступ ChatGPT отозван. Для новых команд подключите Helm Glass заново.'),
      );
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    } finally {
      this.revoking.set(false);
    }
  }
  removeSite(site: string) {
    this.query.set({ site: this.query.values('site').filter((value) => value !== site) });
  }
  readonly statuses = [
    { id: 'READY', label: 'Вход сохранён' },
    { id: 'LOGIN_REQUIRED', label: 'Нужен вход' },
  ];
  readonly tableColumns: readonly TableColumn[] = [
    { key: 'name', label: 'Подключение', width: 340, required: true, className: 'entity-cell' },
    { key: 'status', label: 'Состояние', width: 230 },
    { key: 'lastUsedAt', label: 'Последнее использование', width: 240 },
    { key: 'actions', label: 'Действия', width: 102, action: true },
  ];
  readonly table = inject(TableViews).create('connections', this.tableColumns, this.query);
  constructor() {
    void this.loadIntegration();
    effect(() => {
      this.query.params();
      if (this.query.values('search').length) {
        this.query.set({ search: null });
        return;
      }
      void this.load();
    });
    inject(LiveEvents)
      .watch(['connection', 'browser'])
      .pipe(takeUntilDestroyed())
      .subscribe((change) => {
        if (
          change.resource !== 'browser' ||
          this.data()?.items.some((connection) => connection.browser?.id === change.entityId)
        )
          void this.load(false);
      });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }
  async load(show = true) {
    const generation = ++this.generation;
    if (show) this.loading.set(true);
    try {
      const data = await this.api.get('/api/connections', pageSchema(connectionSchema), {
        status: this.query.values('status'),
        site: this.query.values('site'),
        page: this.query.number('page', 1),
        pageSize: this.query.number('pageSize', 5),
        sort: this.query.text('sort', 'updatedAt'),
        direction: this.table.direction('desc'),
      });
      if (generation === this.generation) {
        this.data.set(data);
        this.error.set('');
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
  async create() {
    const values = await this.dialog.ask(
      'Добавить подключение',
      'Вход выполняется в отдельном защищённом браузере.',
      'Добавить',
      [
        { key: 'name', label: 'Название', required: true, max: 200 },
        { key: 'startUrl', label: 'Адрес сайта (https://…)', required: true },
      ],
    );
    if (!values) return;
    let url: URL;
    try {
      url = new URL(values['startUrl'] ?? '');
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
    } catch {
      this.error.set('Укажите полный HTTP(S) адрес сайта.');
      return;
    }
    try {
      const connection = await this.api.mutate(
        '/api/connections',
        { name: values['name'], startUrl: url.href, site: url.hostname },
        connectionSchema,
      );
      this.dialog.complete(values);
      await this.login(connection);
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    }
  }
  async login(connection: Connection) {
    if (this.busy()) return;
    this.busy.set(connection.id);
    try {
      await this.router.navigate(['/connections', connection.id, 'login'], {
        queryParams: { back: this.query.context() },
      });
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set('');
    }
  }
  async rename(connection: Connection) {
    const values = await this.dialog.ask(
      'Переименовать подключение',
      'Название поможет отличить учётные записи одного сайта.',
      'Сохранить',
      [{ key: 'name', label: 'Название', value: connection.name, required: true, max: 200 }],
      false,
      connection.id,
      connection.version,
    );
    if (!values) return;
    try {
      const updated = await this.api.mutate(
        '/api/connections/' + connection.id,
        {
          name: values['name'],
          expectedVersion: this.dialog.version(values) ?? connection.version,
        },
        connectionSchema,
        'PATCH',
      );
      this.dialog.complete(values);
      this.data.update((page) =>
        page
          ? { ...page, items: page.items.map((item) => (item.id === updated.id ? updated : item)) }
          : page,
      );
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    }
  }
  async remove(connection: Connection) {
    if (
      !(await this.dialog.ask(
        'Удалить подключение?',
        'Сохранённый вход будет отозван. История и результаты останутся; зависимые задачи могут запросить другой вход.',
        'Удалить',
        [],
        true,
      ))
    )
      return;
    try {
      await this.api.mutate(
        '/api/connections/' + connection.id,
        { expectedVersion: connection.version },
        z.unknown(),
        'DELETE',
      );
      await this.load(false);
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    }
  }
}
