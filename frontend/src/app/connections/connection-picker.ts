import { A11yModule } from '@angular/cdk/a11y';
import {
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Api, errorMessage } from '../core/api';
import { Connection, Page, connectionSchema, pageSchema } from '../core/models';
import { Pager, Status } from '../shared/ui';
import { SearchInput } from '../shared/search-input';
import { Icon } from '../shared/icon';
import { Tooltip } from '../shared/tooltip';

@Component({
  selector: 'hg-connection-picker',
  imports: [A11yModule, Icon, Pager, Status, SearchInput, Tooltip],
  template: ` <button
      type="button"
      class="button"
      (click)="show($event)"
      [attr.aria-expanded]="open()"
      [disabled]="disabled()"
    >
      {{ maximum() === 1 ? 'Выбрать подключение' : 'Выбрать подключения' }}
      @if (selected().length) {
        · {{ selected().length }}
      }
    </button>
    @if (open()) {
      <div class="modal-shade" (keydown.escape)="close()">
        <section
          class="dialog connection-picker"
          role="dialog"
          aria-modal="true"
          aria-label="Выбор подключений"
          cdkTrapFocus
          [cdkTrapFocusAutoCapture]="true"
        >
          <header>
            <h2>{{ title() }}</h2>
            <button
              type="button"
              class="icon-button"
              aria-label="Закрыть"
              hgTooltip="Закрыть"
              (click)="close()"
            >
              <hg-icon name="close" />
            </button>
          </header>
          <label class="search"
            ><input
              hgSearch
              aria-label="Поиск подключений"
              placeholder="Название, сайт или аккаунт"
              [value]="search"
              (searchChange)="search = $event; page = 1; load()"
          /></label>
          @if (error()) {
            <p class="error-banner" role="alert">{{ error() }}</p>
          }
          @if (data(); as data) {
            <div class="filter-options">
              @for (connection of data.items; track connection.id) {
                <label
                  ><input
                    [type]="maximum() === 1 ? 'radio' : 'checkbox'"
                    name="connection-selection"
                    [checked]="selected().includes(connection.id)"
                    [disabled]="
                      maximum() > 1 &&
                      selected().length >= maximum() &&
                      !selected().includes(connection.id)
                    "
                    (change)="toggle(connection.id)" /><span
                    ><strong>{{ connection.name }}</strong
                    ><small
                      >{{ connection.site }} ·
                      {{ connection.accountLabel || 'Аккаунт не указан' }}</small
                    ></span
                  ><span class="spacer"></span
                  ><hg-status
                    [value]="
                      connection.status === 'READY' ? 'CONNECTION_READY' : connection.status
                    "
                /></label>
              }
            </div>
            @if (!data.items.length) {
              <p class="empty-small">Подключений не найдено.</p>
            }
            <hg-pager
              [page]="data.page"
              [size]="data.pageSize"
              [total]="data.total"
              (pageChange)="page = $event; load()"
              (sizeChange)="pageSize = $event; page = 1; load()"
            />
          } @else if (loading()) {
            <p class="loading" role="status">Загружаем подключения…</p>
          }
          <footer class="actions">
            <span class="muted">Выбрано: {{ selected().length }} из {{ maximum() }}</span
            ><span class="spacer"></span
            ><button type="button" class="button" (click)="changed.emit([])">Снять выбор</button
            ><button type="button" class="button primary" (click)="close()">Готово</button>
          </footer>
        </section>
      </div>
    }`,
})
export class ConnectionPicker {
  readonly disabled = input(false);
  readonly maximum = input(50);
  readonly title = input('Подключения для задачи');
  readonly site = input<string>();
  readonly status = input<'READY'>();
  readonly selected = input<string[]>([]);
  readonly changed = output<string[]>();
  readonly open = signal(false);
  readonly error = signal('');
  readonly data = signal<Page<Connection> | null>(null);
  readonly loading = signal(false);
  search = '';
  page = 1;
  pageSize = 10;
  private generation = 0;
  private trigger: HTMLElement | null = null;
  private readonly api = inject(Api);
  constructor() {
    effect(() => {
      this.site();
      this.status();
      untracked(() => {
        this.generation++;
        this.page = 1;
        this.data.set(null);
        if (this.open()) void this.load();
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }
  show(event: MouseEvent) {
    this.trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.open.set(true);
    void this.load();
  }
  close() {
    this.open.set(false);
    this.trigger?.focus();
  }
  toggle(id: string) {
    if (this.maximum() === 1) {
      this.changed.emit([id]);
      return;
    }
    if (!this.selected().includes(id) && this.selected().length >= this.maximum()) return;
    this.changed.emit(
      this.selected().includes(id)
        ? this.selected().filter((value) => value !== id)
        : [...this.selected(), id],
    );
  }
  async load() {
    const generation = ++this.generation;
    this.loading.set(true);
    try {
      const data = await this.api.get('/api/connections', pageSchema(connectionSchema), {
        search: this.search,
        site: this.site(),
        status: this.status(),
        page: this.page,
        pageSize: this.pageSize,
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
}
