import { ColumnPicker } from '../shared/column-picker';
import { TableViews, TableColumn, TableView } from '../shared/table-view';
import { DataTable, TableCell } from '../shared/data-table';
import { CdkMenuModule } from '@angular/cdk/menu';
import {
  Component,
  DestroyRef,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { BrowserNode, Page, adminBrowserSchema, nodeSchema, pageSchema } from '../core/models';
import { Dialog } from '../shared/dialog';
import { FilterReset } from '../shared/filter-reset';
import { Icon } from '../shared/icon';
import { MultiFilter } from '../shared/multi-filter';
import { QueryState } from '../shared/query-state';
import { SearchInput } from '../shared/search-input';
import { Tooltip } from '../shared/tooltip';
import { Empty, Pager, Status, states } from '../shared/ui';

const admissionSchema = z.object({
  paused: z.boolean(),
  deploymentDrain: z.boolean(),
  version: z.number(),
});
type AdminBrowser = z.infer<typeof adminBrowserSchema>;

@Component({
  selector: 'hg-nodes',
  imports: [
    DataTable,
    TableCell,
    ColumnPicker,
    Icon,
    CdkMenuModule,
    FilterReset,
    RouterLink,
    MultiFilter,
    Empty,
    Pager,
    Status,
    SearchInput,
    Tooltip,
  ],
  providers: [QueryState],
  host: { class: 'admin-nodes-page' },
  encapsulation: ViewEncapsulation.None,
  styleUrl: './nodes.css',
  templateUrl: './nodes.html',
})
export class Nodes {
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private readonly router = inject(Router);
  private readonly live = inject(LiveEvents);
  private generation = 0;
  private admissionGeneration = 0;
  private browserGeneration = 0;
  private destroyed = false;
  private readonly browserGenerations = new Map<string, number>();
  readonly data = signal<Page<BrowserNode> | null>(null);
  readonly browserPages = signal<Record<string, Page<AdminBrowser>>>({});
  readonly browserErrors = signal<Record<string, string>>({});
  readonly admission = signal<z.infer<typeof admissionSchema> | null>(null);
  readonly admissionError = signal('');
  readonly error = signal('');
  readonly busy = signal('');
  readonly available = computed(() => this.live.state() === 'ready' && !this.error());
  readonly expanded = computed(() => this.query.values('expanded'));
  private readonly visibleExpanded = computed(() =>
    (this.data()?.items ?? [])
      .filter((node) => this.expanded().includes(node.id))
      .map((node) => node.id),
  );
  readonly statuses = [
    { id: 'ONLINE', label: 'В сети' },
    { id: 'DRAINING', label: 'Без новых запусков' },
    { id: 'OFFLINE', label: 'Нет связи' },
  ];
  private readonly filterKey = computed(() =>
    ['search', 'status', 'sort', 'direction', 'page', 'pageSize']
      .map((key) => this.query.values(key).join('\u0000'))
      .join('\u0001'),
  );
  private readonly browserKey = computed(() =>
    this.visibleExpanded()
      .map((id) =>
        [
          id,
          this.query.text('browserPage.' + id),
          this.query.text('browserSize.' + id),
          this.query.text('browserSort.' + id),
          this.query.text('browserDirection.' + id),
        ].join('\u0000'),
      )
      .join('\u0001'),
  );
  readonly tableColumns: readonly TableColumn[] = [
    { key: 'name', label: 'Узел', width: 300, required: true, className: 'entity-cell' },
    { key: 'status', label: 'Состояние', width: 240 },
    { key: 'occupied', label: 'Занято / всего', width: 190 },
    { key: 'actions', label: 'Действия', width: 58, action: true },
  ];
  readonly table = inject(TableViews).create('admin-nodes', this.tableColumns, this.query);
  private readonly tableViews = inject(TableViews);
  private readonly browserViews = new Map<string, TableView>();
  browserView(id: string) {
    let view = this.browserViews.get(id);
    if (!view) {
      view = this.tableViews.create(
        'node-browsers:' + id,
        [
          { key: 'id', label: 'Браузер / задача', width: 220, required: true },
          { key: 'ownerName', label: 'Пользователь', width: 240 },
          { key: 'status', label: 'Состояние', width: 230 },
          { key: 'actions', label: 'Остановить', width: 145, action: true },
        ],
        this.query,
        {
          sort: 'browserSort.' + id,
          direction: 'browserDirection.' + id,
          page: 'browserPage.' + id,
          size: 'browserSize.' + id,
        },
      );
      this.browserViews.set(id, view);
    }
    return view;
  }
  constructor() {
    effect(() => {
      this.filterKey();
      untracked(() => void this.load());
    });
    effect(() => {
      this.browserKey();
      untracked(() => {
        for (const id of this.visibleExpanded()) void this.loadBrowsers(id);
      });
    });
    void this.loadAdmission();
    this.live
      .watch(['node', 'browser', 'admin-user', 'admin-operation', 'admission'])
      .pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event.resource === 'admission') {
          void this.loadAdmission();
          return;
        }
        void this.load();
        for (const id of this.visibleExpanded()) void this.loadBrowsers(id);
        if (event.resource === 'sync') void this.loadAdmission();
      });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.generation++;
      this.admissionGeneration++;
    });
  }
  returnUrl() {
    return this.router.url;
  }
  async load() {
    const generation = ++this.generation;
    try {
      const page = await this.api.get('/api/admin/nodes/page', pageSchema(nodeSchema), {
        search: this.query.text('search'),
        status: this.query.values('status'),
        sort: this.query.text('sort', 'name'),
        direction: this.table.direction(),
        page: this.query.number('page', 1),
        pageSize: this.query.number('pageSize', 5),
      });
      if (generation !== this.generation) return;
      this.data.set(page);
      this.error.set('');
      const visibleIds = new Set(page.items.map((node) => node.id));
      this.browserPages.update((pages) =>
        Object.fromEntries(Object.entries(pages).filter(([id]) => visibleIds.has(id))),
      );
      this.browserErrors.update((errors) =>
        Object.fromEntries(Object.entries(errors).filter(([id]) => visibleIds.has(id))),
      );
      for (const id of this.browserGenerations.keys())
        if (!visibleIds.has(id)) this.browserGenerations.delete(id);
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    }
  }
  async loadAdmission() {
    const generation = ++this.admissionGeneration;
    try {
      const state = await this.api.get('/api/admin/admission', admissionSchema);
      if (generation !== this.admissionGeneration) return;
      this.admission.set(state);
      this.admissionError.set('');
    } catch (error: unknown) {
      if (generation === this.admissionGeneration) this.admissionError.set(errorMessage(error));
    }
  }
  async loadBrowsers(id: string) {
    const generation = ++this.browserGeneration;
    this.browserGenerations.set(id, generation);
    try {
      const page = await this.api.get(
        '/api/admin/nodes/' + id + '/browsers',
        pageSchema(adminBrowserSchema),
        {
          page: this.query.number('browserPage.' + id, 1),
          pageSize: this.query.number('browserSize.' + id, 5),
          sort: this.query.text('browserSort.' + id, 'id'),
          direction: this.browserView(id).direction(),
        },
      );
      if (this.destroyed || generation !== this.browserGenerations.get(id)) return;
      this.browserPages.update((pages) => ({ ...pages, [id]: page }));
      this.browserErrors.update((errors) => ({ ...errors, [id]: '' }));
    } catch (error: unknown) {
      if (!this.destroyed && generation === this.browserGenerations.get(id))
        this.browserErrors.update((errors) => ({ ...errors, [id]: errorMessage(error) }));
    }
  }
  toggle(id: string) {
    const ids = this.expanded();
    this.query.set(
      { expanded: ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id] },
      false,
    );
  }
  browserPage(id: string, page: number) {
    this.query.set({ ['browserPage.' + id]: page }, false);
  }
  browserSize(id: string, pageSize: number) {
    this.query.set({ ['browserSize.' + id]: pageSize, ['browserPage.' + id]: null }, false);
  }
  browserState(node: BrowserNode, browser: AdminBrowser) {
    return node.status === 'OFFLINE' ? 'UNREACHABLE' : browser.taskStatus || browser.status;
  }
  stopped(browser: AdminBrowser) {
    return (
      ['CLOSING', 'CLOSED', 'RELEASING'].includes(browser.status) ||
      ['STOPPING', 'SUCCEEDED', 'PARTIAL', 'NOT_ACHIEVED', 'STOPPED', 'FAILED'].includes(
        browser.taskStatus || '',
      )
    );
  }
  info(node: BrowserNode) {
    this.dialog.info('Браузерный узел', '', {
      facts: [
        { label: 'Название', value: node.name },
        { label: 'ID узла', value: node.id },
        { label: 'Статус', value: states[node.status] ?? node.status, status: node.status },
        { label: 'Мест для браузеров', value: String(node.capacity) },
        { label: 'Версия ПО', value: 'Не передана узлом' },
      ],
      note: 'Секреты инфраструктуры и содержимое браузеров не выводятся.',
    });
  }
  async command(node: BrowserNode, type: string) {
    if (!this.available() || this.busy()) return;
    const values = await this.dialog.ask(
      type === 'DRAIN' ? 'Вывести узел из назначений?' : 'Вернуть узел в назначения?',
      'Изменяется назначение новых браузерных сессий на узел ' +
        node.name +
        '. Уже работающие браузеры и принятые задачи не отменяются.',
      type === 'DRAIN' ? 'Приостановить' : 'Разрешить',
      [{ key: 'reason', label: 'Причина', type: 'textarea', required: true, max: 1000 }],
      false,
      node.id,
      node.version,
    );
    if (!values) return;
    this.busy.set(node.id);
    try {
      const updated = await this.api.mutate(
        '/api/admin/nodes/' + node.id + '/commands',
        {
          type,
          reason: values['reason'],
          expectedVersion: this.dialog.version(values) ?? node.version,
        },
        nodeSchema,
      );
      this.dialog.complete(values);
      this.data.update((page) =>
        page
          ? { ...page, items: page.items.map((item) => (item.id === updated.id ? updated : item)) }
          : page,
      );
      await this.load();
    } catch (error: unknown) {
      await this.load();
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set('');
    }
  }
  async changeAdmission() {
    const state = this.admission();
    if (!state || !this.available() || this.busy() || this.admissionError()) return;
    const values = await this.dialog.ask(
      state.paused ? 'Разрешить новые запуски?' : 'Приостановить новые запуски?',
      'Работающие браузеры сохраняются. Принятые задачи останутся в очереди.' +
        (state.deploymentDrain ? '\nТехническая пауза развёртывания продолжит действовать.' : ''),
      state.paused ? 'Разрешить запуски' : 'Приостановить',
      [{ key: 'reason', label: 'Причина', type: 'textarea', required: true, max: 1000 }],
      false,
      'platform',
      state.version,
    );
    if (!values) return;
    this.busy.set('admission');
    try {
      const result = await this.api.mutate(
        '/api/admin/admission/commands',
        {
          type: state.paused ? 'RESUME' : 'PAUSE',
          reason: values['reason'],
          expectedVersion: this.dialog.version(values) ?? state.version,
        },
        admissionSchema,
      );
      this.dialog.complete(values);
      this.admission.set(result);
    } catch (error: unknown) {
      await this.loadAdmission();
      this.admissionError.set(errorMessage(error));
    } finally {
      this.busy.set('');
    }
  }
  async stop(browser: AdminBrowser, nodeId: string) {
    if (this.busy() || !this.available() || !browser.taskId || this.stopped(browser)) return;
    if (
      !(await this.dialog.ask(
        'Остановить задачу #' + browser.taskId.slice(0, 8) + '?',
        'Браузер будет закрыт. Остановка завершится после подтверждения узлом.',
        'Остановить',
        [],
        true,
        browser.taskId,
        undefined,
        { compact: true },
      ))
    )
      return;
    this.busy.set(browser.id);
    try {
      await this.api.mutate('/api/admin/browsers/' + browser.id + '/stop', {}, z.unknown());
      await Promise.all([this.load(), this.loadBrowsers(nodeId)]);
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set('');
    }
  }
}
