import { A11yModule } from '@angular/cdk/a11y';
import {
  Component,
  DestroyRef,
  ElementRef,
  inject,
  computed,
  input,
  model,
  output,
  signal,
  afterRenderEffect,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { Page, pageSchema } from '../core/models';
import { Pager } from './ui';
export interface Option {
  id: string;
  label: string;
}
@Component({
  selector: 'hg-multi-filter',
  imports: [FormsModule, A11yModule, Pager],
  host: { '(document:click)': 'outside($event)', '(keydown.escape)': 'close()' },
  template: ` <button
      class="filter"
      [class.selected]="value().length"
      [attr.aria-expanded]="open()"
      aria-haspopup="dialog"
      (click)="toggle($event)"
    >
      {{ caption() }}
      @if (value().length > 1) {
        <b>{{ value().length }}</b>
      }
      <span aria-hidden="true">⌄</span>
    </button>
    @if (open()) {
      <div
        class="filter-popover"
        role="dialog"
        [attr.aria-label]="label()"
        cdkTrapFocus
        (click)="$event.stopPropagation()"
      >
        <header>
          <strong
            >{{ label() }}
            @if (value().length) {
              · {{ value().length }}
            }</strong
          ><button class="icon-button" aria-label="Закрыть фильтр" (click)="close()">×</button>
        </header>
        <input
          #filterSearch
          class="filter-search"
          type="search"
          [attr.aria-label]="'Поиск: ' + label()"
          placeholder="Найти значение"
          maxlength="300"
          [ngModel]="search()"
          (ngModelChange)="searchChanged($event)"
        />
        @if (remoteError()) {
          <p class="field-error" role="alert">
            {{ remoteError() }}
            <button type="button" class="text-button" (click)="loadRemote()">Повторить</button>
          </p>
        }
        @if (remoteLoading()) {
          <p class="empty-small" role="status">Загружаем варианты…</p>
        }
        <div class="filter-options" [attr.aria-busy]="remoteLoading()">
          @for (option of displayedOptions(); track option.id) {
            <label [hidden]="!matches(option)"
              ><input
                type="checkbox"
                [disabled]="remoteLoading()"
                [checked]="value().includes(option.id)"
                (change)="select(option.id)"
              />{{ option.label }}</label
            >
          }
          @if (!visibleCount() && !remoteLoading() && !remoteError()) {
            <p class="empty-small">Ничего не найдено</p>
          }
        </div>
        @if (remoteData(); as data) {
          <hg-pager
            [page]="data.page"
            [size]="data.pageSize"
            [total]="data.total"
            (pageChange)="remotePage = $event; loadRemote()"
            (sizeChange)="remotePageSize = $event; remotePage = 1; loadRemote()"
          />
        }
        <footer>
          <button class="button quiet" [disabled]="!value().length" (click)="clear()">
            Снять выбор</button
          ><button class="button primary" (click)="close()">Готово</button>
        </footer>
      </div>
    }`,
})
export class MultiFilter {
  readonly label = input.required<string>();
  readonly options = input<readonly Option[]>([]);
  readonly remotePath = input('');
  readonly value = model<string[]>([]);
  readonly changed = output<string[]>();
  readonly open = signal(false);
  readonly search = signal('');
  readonly remoteData = signal<Page<string> | null>(null);
  readonly remoteError = signal('');
  readonly remoteLoading = signal(false);
  readonly displayedOptions = computed(() =>
    this.remotePath()
      ? (this.remoteData()?.items ?? []).map((value) => ({ id: value, label: value }))
      : this.options(),
  );
  remotePage = 1;
  remotePageSize = 10;
  private remoteGeneration = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly api = inject(Api);
  private trigger: HTMLElement | null = null;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('filterSearch');
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.searchTimer);
      this.remoteGeneration++;
    });
    afterRenderEffect(() => {
      const field = this.searchInput();
      if (this.open()) field?.nativeElement.focus();
    });
  }
  readonly caption = computed(() =>
    this.value().length === 1
      ? (this.displayedOptions().find((item) => item.id === this.value()[0])?.label ??
        (this.remotePath() ? this.value()[0] : this.label()))
      : this.label(),
  );
  readonly visibleCount = computed(
    () => this.displayedOptions().filter((option) => this.matches(option)).length,
  );
  matches(option: Option) {
    return (
      !!this.remotePath() ||
      option.label.toLocaleLowerCase('ru').includes(this.search().toLocaleLowerCase('ru'))
    );
  }
  toggle(event: MouseEvent) {
    this.trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (this.open()) this.close();
    else {
      this.open.set(true);
      if (this.remotePath()) void this.loadRemote();
    }
  }
  searchChanged(value: string) {
    this.search.set(value);
    if (!this.remotePath()) return;
    this.remotePage = 1;
    this.remoteGeneration++;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.loadRemote(), 300);
  }
  async loadRemote() {
    const path = this.remotePath();
    if (!path) return;
    clearTimeout(this.searchTimer);
    const generation = ++this.remoteGeneration;
    this.remoteLoading.set(true);
    try {
      const data = await this.api.get(path, pageSchema(z.string()), {
        search: this.search(),
        page: this.remotePage,
        pageSize: this.remotePageSize,
      });
      if (generation === this.remoteGeneration) {
        this.remoteData.set(data);
        this.remoteError.set('');
      }
    } catch (error: unknown) {
      if (generation === this.remoteGeneration) this.remoteError.set(errorMessage(error));
    } finally {
      if (generation === this.remoteGeneration) this.remoteLoading.set(false);
    }
  }
  select(id: string) {
    const selected = this.value().includes(id)
      ? this.value().filter((item) => item !== id)
      : [...this.value(), id];
    this.value.set(selected);
    this.changed.emit(selected);
  }
  clear() {
    this.value.set([]);
    this.changed.emit([]);
  }
  close() {
    if (this.open()) {
      this.hide();
      this.trigger?.focus();
    }
  }
  private hide() {
    this.open.set(false);
    clearTimeout(this.searchTimer);
    this.remoteGeneration++;
    this.remoteLoading.set(false);
  }
  outside(event: Event) {
    if (event.target instanceof Node && !this.host.nativeElement.contains(event.target))
      this.hide();
  }
}
