import { Icon } from '../shared/icon';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { BrowserNode, nodeSchema } from '../core/models';
import { Dialog } from '../shared/dialog';
import { MultiFilter } from '../shared/multi-filter';
import { Empty, Pager, Status } from '../shared/ui';
import { QueryState } from '../shared/query-state';

@Component({
  selector: 'hg-nodes',
  imports: [Icon, FormsModule, RouterLink, MultiFilter, Empty, Pager, Status],
  providers: [QueryState],
  template: `
    @if (error()) {
      <div class="error-banner" role="alert">
        {{ error() }}<button class="text-button" (click)="load()">Повторить</button>
      </div>
    }
    <h2 class="sr-only">Браузеры</h2>
    <section class="card table-card">
      <div class="toolbar">
        <label class="search"
          ><hg-icon name="search" /><input
            aria-label="Поиск узлов"
            placeholder="Найти узел"
            [ngModel]="query.text('search')"
            (ngModelChange)="query.set({ search: $event || null })" /></label
        ><hg-multi-filter
          label="Состояние"
          [options]="statuses"
          [value]="query.values('status')"
          (changed)="query.set({ status: $event })"
        />
      </div>
      @if (nodes() !== null) {
        @if (visible().length) {
          <div class="table-scroll">
            <table class="admin-nodes-table">
              <thead>
                <tr>
                  <th>Узел</th>
                  <th>Состояние</th>
                  <th>Занято / всего</th>
                  <th><span class="sr-only">Действия</span></th>
                </tr>
              </thead>
              <tbody>
                @for (node of pageItems(); track node.id) {
                  <tr>
                    <td>
                      <button
                        class="node-name"
                        [attr.aria-expanded]="expanded().includes(node.id)"
                        (click)="toggle(node.id)"
                      >
                        <hg-icon
                          [name]="expanded().includes(node.id) ? 'chevron-down' : 'chevron-right'"
                        /><hg-icon name="database" /><span [title]="node.id">{{ node.name }}</span>
                      </button>
                    </td>
                    <td><hg-status [value]="node.status" /></td>
                    <td>{{ node.occupied ?? '—' }} / {{ node.capacity }}</td>
                    <td>
                      <details class="action-menu">
                        <summary class="icon-button" aria-label="Действия с узлом" title="Действия">
                          <hg-icon name="more" />
                        </summary>
                        <div class="menu-popover">
                          <button (click)="info(node)">Сведения об узле</button>
                          @if (node.status === 'DRAINING') {
                            <button (click)="command(node, 'ENABLE')">
                              Разрешить новые запуски
                            </button>
                          } @else {
                            <button (click)="command(node, 'DRAIN')">
                              Не принимать новые запуски
                            </button>
                          }
                        </div>
                      </details>
                    </td>
                  </tr>
                  @if (expanded().includes(node.id)) {
                    <tr>
                      <td colspan="4" class="nested-cell">
                        @if (node.browsers.length) {
                          <table class="nested-table">
                            <thead>
                              <tr>
                                <th>Браузер / задача</th>
                                <th>Пользователь</th>
                                <th>Состояние</th>
                                <th><span class="sr-only">Остановить</span></th>
                              </tr>
                            </thead>
                            <tbody>
                              @for (browser of node.browsers; track browser.id) {
                                <tr>
                                  <td>
                                    <code [title]="browser.id">{{ browser.id.slice(0, 8) }}</code
                                    ><small [title]="browser.taskId || 'Отдельный вход на сайт'">{{
                                      browser.taskId
                                        ? 'Задача #' + browser.taskId.slice(0, 8)
                                        : 'Отдельный вход на сайт'
                                    }}</small>
                                  </td>
                                  <td>
                                    <a
                                      [routerLink]="['/admin/users', browser.ownerId]"
                                      [queryParams]="{ return: '/admin/nodes?' + query.context() }"
                                      >{{ browser.ownerName }}</a
                                    >
                                  </td>
                                  <td><hg-status [value]="browser.status" /></td>
                                  <td>
                                    @if (browser.taskId) {
                                      <button
                                        class="icon-button danger-soft"
                                        [attr.aria-label]="
                                          browser.taskId
                                            ? 'Остановить браузер задачи'
                                            : 'Закрыть браузер входа'
                                        "
                                        [title]="
                                          browser.taskId
                                            ? 'Остановить браузер задачи'
                                            : 'Закрыть браузер входа'
                                        "
                                        [disabled]="busy() === browser.id"
                                        (click)="stop(browser.id, browser.taskId)"
                                      >
                                        <hg-icon name="stop" />
                                      </button>
                                    }
                                  </td>
                                </tr>
                              }
                            </tbody>
                          </table>
                        } @else {
                          <p class="empty-small">На узле нет браузеров</p>
                        }
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        } @else {
          <hg-empty
            title="Узлы не найдены"
            description="Проверьте выбранные фильтры или регистрацию узлов."
          />
        }
        <hg-pager
          [page]="page()"
          [size]="query.number('pageSize', 20)"
          [total]="visible().length"
          (pageChange)="query.set({ page: $event }, false)"
          (sizeChange)="query.set({ pageSize: $event })"
        />
      } @else if (!error()) {
        <div class="loading" role="status">Загружаем узлы…</div>
      }
    </section>
  `,
})
export class Nodes {
  readonly query = inject(QueryState);
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private generation = 0;
  readonly nodes = signal<BrowserNode[] | null>(null);
  readonly error = signal('');
  readonly busy = signal('');
  readonly expanded = computed(() => this.query.values('expanded'));
  readonly statuses = [
    { id: 'ONLINE', label: 'В сети' },
    { id: 'DRAINING', label: 'Без новых запусков' },
    { id: 'OFFLINE', label: 'Нет связи' },
  ];
  readonly visible = computed(() =>
    (this.nodes() ?? []).filter(
      (node) =>
        (!this.query.values('status').length ||
          this.query.values('status').includes(node.status)) &&
        (node.name + ' ' + node.id)
          .toLocaleLowerCase()
          .includes(this.query.text('search').toLocaleLowerCase()),
    ),
  );
  readonly page = computed(() =>
    Math.min(
      this.query.number('page', 1),
      Math.max(1, Math.ceil(this.visible().length / this.query.number('pageSize', 20))),
    ),
  );
  readonly pageItems = computed(() =>
    this.visible().slice(
      (this.page() - 1) * this.query.number('pageSize', 20),
      this.page() * this.query.number('pageSize', 20),
    ),
  );
  constructor() {
    void this.load();
    inject(LiveEvents)
      .watch(['node', 'browser', 'admin-user'])
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load());
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }
  async load() {
    const generation = ++this.generation;
    try {
      const nodes = await this.api.get('/api/admin/nodes', z.array(nodeSchema));
      if (generation === this.generation) {
        this.nodes.set(nodes);
        this.error.set('');
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    }
  }
  toggle(id: string) {
    const ids = this.expanded();
    this.query.set(
      { expanded: ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id] },
      false,
    );
  }
  info(node: BrowserNode) {
    void this.dialog.ask(
      'Узел ' + node.name,
      'ID: ' +
        node.id +
        '\nСостояние: ' +
        node.status +
        '\nЗанято: ' +
        (node.occupied ?? 'нет данных') +
        ' / ' +
        node.capacity +
        '\nЗапрет новых запусков сохраняет работающие браузеры.',
      'Закрыть',
    );
  }
  async command(node: BrowserNode, type: string) {
    const values = await this.dialog.ask(
      type === 'DRAIN' ? 'Не принимать новые запуски?' : 'Разрешить новые запуски?',
      'Существующие браузеры сохраняются.',
      'Применить',
      [{ key: 'reason', label: 'Причина', type: 'textarea', required: true, max: 1000 }],
      false,
      node.id,
    );
    if (!values) return;
    try {
      const updated = await this.api.mutate(
        '/api/admin/nodes/' + node.id + '/commands',
        { type, ...values },
        nodeSchema,
      );
      this.dialog.complete(values);
      this.nodes.update(
        (nodes) => nodes?.map((item) => (item.id === updated.id ? updated : item)) ?? null,
      );
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    }
  }
  async stop(id: string, taskId: string) {
    if (
      this.busy() ||
      !(await this.dialog.ask(
        'Остановить задачу #' + taskId + '?',
        'Браузер будет закрыт. Остановка завершится после подтверждения узлом.',
        'Остановить',
        [],
        true,
      ))
    )
      return;
    this.busy.set(id);
    try {
      await this.api.mutate('/api/admin/browsers/' + id + '/stop', {}, z.unknown());
      await this.load();
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set('');
    }
  }
}
