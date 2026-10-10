import { TableViews } from '../shared/table-view';
import { DataTable, TableCell } from '../shared/data-table';
import { Icon } from '../shared/icon';
import { SearchInput } from '../shared/search-input';
import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { Page, Task, artifactSchema, pageSchema, resultRowSchema } from '../core/models';
import { ColumnPicker } from '../shared/column-picker';
import { Dialog } from '../shared/dialog';
import { Empty, MegabytesPipe, Pager, Status } from '../shared/ui';
import { QueryState } from '../shared/query-state';
import { TextArtifact } from './text-artifact';
import { AudioAnalysis } from './audio-analysis';
import { Tooltip } from '../shared/tooltip';

@Component({
  selector: 'hg-result',
  imports: [
    DataTable,
    TableCell,
    Icon,
    SearchInput,
    ColumnPicker,
    Empty,
    MegabytesPipe,
    Pager,
    Status,
    RouterLink,
    TextArtifact,
    AudioAnalysis,
    Tooltip,
  ],
  providers: [QueryState],
  styleUrl: './result-view.css',
  template: `
    @if (task().result; as result) {
      <section class="card result-report">
        <section class="result-summary">
          <div class="section-heading">
            <h2>Итог</h2>
            <button
              class="text-button copy-result"
              (click)="copy()"
              aria-label="Скопировать вывод"
              hgTooltip="Скопировать вывод"
            >
              <hg-icon name="copy" />Скопировать вывод
            </button>
          </div>
          <p class="preserve-lines">{{ result.summary }}</p>
          @if (result.limitations.length) {
            <div class="result-limitations">
              <h2>Что осталось неизвестным</h2>
              <ul>
                @for (item of result.limitations; track $index) {
                  <li>{{ item }}</li>
                }
              </ul>
            </div>
          }
        </section>
        <div class="result-facts">
          @if (rows(); as page) {
            <span
              >Строк в выборке: <strong>{{ page.total }}</strong></span
            >
          }
          <span
            >Источников: <strong>{{ result.sources.length }}</strong></span
          >
          @if (result.artifactCount) {
            <span
              >Файлов: <strong>{{ result.artifactCount }}</strong></span
            >
          }
        </div>
        @if (result.columns.length) {
          <section class="result-data" [attr.aria-busy]="loading()">
            <h2>Данные</h2>
            <div class="toolbar">
              <label class="search"
                ><hg-icon name="search" /><input
                  hgSearch
                  aria-label="Поиск по результату"
                  placeholder="Поиск по всем строкам"
                  [value]="search()"
                  (searchChange)="set({ resultSearch: $event || null })" /></label
              ><span class="spacer"></span><hg-column-picker [view]="table" />
            </div>
            @if (rows(); as data) {
              @if (data.items.length) {
                <hg-data-table [view]="table" [rows]="data.items" label="Результат задачи">
                  @for (column of result.columns; track column.key) {
                    <ng-template [hgCell]="column.key" [hgCellOf]="data.items" let-row>
                      @if (cellUrl(column.type, row.cells[column.key]); as url) {
                        <a [href]="url" target="_blank" rel="noopener noreferrer">{{ url }}</a>
                      } @else {
                        {{ row.cells[column.key] ?? '—' }}
                      }
                    </ng-template>
                  }
                  <ng-template hgCell="$actions" [hgCellOf]="data.items" let-row>
                    <button
                      class="icon-button"
                      hgTooltip="Показать всю строку"
                      aria-label="Показать всю строку"
                      (click)="openRow(row)"
                    >
                      <hg-icon name="expand" />
                    </button>
                  </ng-template>
                </hg-data-table>
              } @else {
                <hg-empty
                  title="Строки не найдены"
                  description="Измените поиск. Полученный вывод и файлы остаются доступны."
                />
              }
              <hg-pager
                [page]="data.page"
                [size]="data.pageSize"
                [total]="data.total"
                (pageChange)="query.set({ resultPage: $event }, false)"
                (sizeChange)="set({ resultPageSize: $event })"
              />
            } @else if (loading()) {
              <p class="loading" role="status">Загружаем строки результата…</p>
            }
          </section>
        }
        @if (result.artifactCount) {
          <section class="result-files">
            <h2>Файлы · {{ files()?.total ?? result.artifactCount }}</h2>
            @if (filesError()) {
              <p class="error-banner" role="alert">
                {{ filesError() }}
                <button class="text-button" (click)="loadFiles()">Повторить</button>
              </p>
            }
            @if (filesLoading() && !files()) {
              <p class="loading" role="status">Загружаем файлы…</p>
            }
            <div class="file-list">
              @for (file of files()?.items; track file.id) {
                @if (
                  file.status === 'READY' &&
                  file.complete &&
                  file.mimeType.split(';')[0].trim() === 'text/plain'
                ) {
                  <hg-text-artifact [id]="file.id" [name]="file.name" />
                } @else if (file.status === 'READY' && file.complete && file.mimeType.startsWith('audio/')) {
                  <hg-audio-analysis [id]="file.id" [name]="file.name" />
                } @else {
                  <div class="file-row">
                    <span class="file-mark"><hg-icon name="file" /></span
                    ><span
                      ><strong>{{ file.name }}</strong
                      ><small>{{ file.mimeType }} · {{ file.sizeBytes | megabytes }}</small></span
                    ><span class="spacer"></span
                    ><hg-status
                      [value]="
                        file.status === 'READY'
                          ? file.complete
                            ? 'FILE_READY'
                            : 'INCOMPLETE'
                          : file.status
                      "
                    />
                    @if (file.status === 'READY' && file.complete) {
                      <a class="button" [href]="'/api/artifacts/' + file.id + '/download'" download
                        >Скачать</a
                      >
                    }
                  </div>
                }
              }
            </div>
            @if (files(); as data) {
              @if (!data.items.length) {
                <p class="empty-small">На этой странице файлов нет.</p>
              }
              <hg-pager
                [page]="data.page"
                [size]="data.pageSize"
                [total]="data.total"
                (pageChange)="query.set({ filePage: $event }, false)"
                (sizeChange)="query.set({ filePage: null, filePageSize: $event }, false)"
              />
            }
          </section>
        }
        <section class="result-sources">
          @if (result.sources.length) {
            <h2>Источники</h2>
            <ul class="sources">
              @for (source of result.sources; track $index) {
                <li>
                  <a [href]="source.url" target="_blank" rel="noopener noreferrer"
                    >{{ source.title || source.url }} ↗</a
                  >
                </li>
              }
            </ul>
          }
        </section>
      </section>
    } @else {
      <section class="card">
        <hg-empty
          [title]="completed() ? 'Итоговые данные не получены' : 'Результат ещё не получен'"
          [description]="
            completed()
              ? 'Выполнение завершено. Причина и сохранённые шаги доступны в истории.'
              : 'Сохранённые сведения появятся здесь по ходу выполнения.'
          "
          ><a
            class="button"
            [routerLink]="['/tasks', task().id]"
            [queryParams]="{ tab: 'overview' }"
            queryParamsHandling="merge"
            ><hg-icon name="list" />Открыть выполнение</a
          ></hg-empty
        >
      </section>
    }
    @if (error()) {
      <p class="error-banner" role="alert">
        {{ error() }} <button class="text-button" (click)="load()">Повторить</button>
      </p>
    }
    @if (message()) {
      <p class="notice" role="status">{{ message() }}</p>
    }
  `,
})
export class ResultView {
  readonly task = input.required<Task>();
  readonly completed = computed(() =>
    ['SUCCEEDED', 'PARTIAL', 'NOT_ACHIEVED', 'FAILED', 'STOPPED'].includes(this.task().status),
  );
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  readonly query = inject(QueryState);
  private generation = 0;
  readonly rows = signal<Page<z.infer<typeof resultRowSchema>> | null>(null);
  readonly files = signal<Page<z.infer<typeof artifactSchema>> | null>(null);
  readonly filesError = signal('');
  readonly filesLoading = signal(false);
  private filesGeneration = 0;
  private filesTaskIdentity = '';
  readonly error = signal('');
  readonly message = signal('');
  readonly loading = signal(false);
  readonly search = computed(() => this.query.text('resultSearch'));
  readonly sort = computed(() => this.query.text('resultSort'));
  readonly direction = computed(() => this.table.direction());
  readonly page = computed(() => this.query.number('resultPage', 1));
  readonly size = computed(() => this.query.number('resultPageSize', 5));
  readonly filePage = computed(() => this.query.number('filePage', 1));
  readonly fileSize = computed(() => this.query.number('filePageSize', 10));
  readonly table = inject(TableViews).create(
    () => 'result:' + this.task().id,
    () => [
      ...(this.task().result?.columns ?? []).map((column) => ({
        key: column.key,
        label: column.label,
        width: 200,
      })),
      { key: '$actions', label: 'Полная строка', width: 58, action: true },
    ],
    this.query,
    {
      sort: 'resultSort',
      direction: 'resultDirection',
      page: 'resultPage',
      size: 'resultPageSize',
    },
  );
  private taskIdentity = '';
  constructor() {
    effect(() => {
      this.task();
      this.filePage();
      this.fileSize();
      void this.loadFiles();
    });
    effect(() => {
      this.task();
      this.search();
      this.sort();
      this.direction();
      this.page();
      this.size();
      void this.load();
    });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
      this.filesGeneration++;
    });
  }
  async loadFiles() {
    const generation = ++this.filesGeneration;
    const task = this.task();
    if (this.filesTaskIdentity !== task.id || !task.result?.artifactCount) {
      this.filesTaskIdentity = task.id;
      this.files.set(null);
      this.filesError.set('');
    }
    if (!task.result?.artifactCount) {
      this.filesLoading.set(false);
      return;
    }
    this.filesLoading.set(true);
    try {
      const files = await this.api.get(
        '/api/tasks/' + task.id + '/artifacts',
        pageSchema(artifactSchema),
        {
          page: this.filePage(),
          pageSize: this.fileSize(),
        },
      );
      if (generation === this.filesGeneration) {
        this.files.set(files);
        this.filesError.set('');
      }
    } catch (error: unknown) {
      if (generation === this.filesGeneration) this.filesError.set(errorMessage(error));
    } finally {
      if (generation === this.filesGeneration) this.filesLoading.set(false);
    }
  }
  async load() {
    const generation = ++this.generation;
    const task = this.task();
    if (this.taskIdentity !== task.id) {
      this.taskIdentity = task.id;
      this.rows.set(null);
      this.message.set('');
    }
    if (!task.result?.columns.length) {
      this.rows.set(null);
      return;
    }
    this.loading.set(true);
    try {
      const rows = await this.api.get(
        '/api/tasks/' + task.id + '/result/rows',
        pageSchema(resultRowSchema),
        {
          search: this.search(),
          sort: this.sort(),
          direction: this.direction(),
          page: this.page(),
          pageSize: this.size(),
        },
      );
      if (generation === this.generation) {
        this.rows.set(rows);
        this.error.set('');
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
  set(values: Record<string, string | number | null>) {
    this.query.set({ resultPage: null, ...values }, false);
  }
  cellUrl(type: string, value: unknown) {
    return type.toUpperCase() === 'URL' &&
      typeof value === 'string' &&
      /^https?:\/\/\S+$/i.test(value)
      ? value
      : null;
  }
  async copy() {
    try {
      await navigator.clipboard.writeText(this.task().result?.summary ?? '');
      this.message.set('Текст скопирован.');
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    }
  }
  openRow(row: z.infer<typeof resultRowSchema>) {
    this.dialog.info(
      'Полная строка',
      (this.task().result?.columns ?? [])
        .map((column) => column.label + ': ' + (row.cells[column.key] ?? '—'))
        .join('\n'),
    );
  }
}
