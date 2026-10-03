import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  catchError,
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  finalize,
  of,
  startWith,
  switchMap,
} from 'rxjs';
import { Api, problemOf } from '../../core/api/api.service';
import { Site, SiteSuggestions } from '../../core/api/models';

@Component({
  selector: 'hg-site-multiselect',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="site-field" (focusout)="blur($event)">
    <label [for]="id">{{ label() }}</label>
    <input
      [id]="id"
      role="combobox"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="id + '-list'"
      aria-autocomplete="list"
      [attr.aria-activedescendant]="open() && active() >= 0 ? id + '-' + active() : null"
      [formControl]="query"
      (focus)="open.set(true)"
      (keydown)="key($event)"
      placeholder="Найти сайт"
      autocomplete="off"
    />
    @if (open()) {
      <div class="suggestions" [id]="id + '-list'" role="listbox" [attr.aria-busy]="loading()">
        @for (site of items(); track site.id; let index = $index) {
          <button
            type="button"
            role="option"
            [id]="id + '-' + index"
            [attr.aria-selected]="index === active()"
            (mousedown)="$event.preventDefault()"
            (click)="select(site)"
          >
            <strong>{{ site.displayName }}</strong
            ><small>{{ site.host }}</small>
          </button>
        }
      </div>
      <p class="small muted" role="status">
        {{
          loading()
            ? 'Поиск…'
            : error() ||
              (!items().length
                ? 'Нет подходящих сайтов'
                : hasMore()
                  ? 'Уточните запрос, чтобы найти другие сайты'
                  : '')
        }}
      </p>
    }
    <div class="chips">
      @for (site of chips(); track site.id) {
        <span class="chip"
          >{{ site.label
          }}<button
            type="button"
            [attr.aria-label]="'Убрать ' + site.label"
            (click)="remove(site.id)"
          >
            ×
          </button></span
        >
      }
    </div>
  </div>`,
})
export class SiteMultiselect {
  readonly id = 'sites-' + crypto.randomUUID();
  readonly scope = input<'tasks' | 'connections'>('tasks');
  readonly label = input('Сайты');
  readonly selectedIds = input<readonly string[]>([]);
  readonly changed = output<readonly string[]>();
  private readonly selected = signal<Site[]>([]);
  readonly query = new FormControl('', { nonNullable: true });
  readonly items = signal<Site[]>([]);
  readonly error = signal('');
  readonly loading = signal(false);
  readonly hasMore = signal(false);
  readonly open = signal(false);
  readonly active = signal(-1);
  readonly chips = computed(() => {
    const sites = new Map(this.selected().map((site) => [site.id, site]));
    return this.selectedIds().map((id) => ({
      id,
      label:
        sites.get(id)?.displayName ??
        (this.loading()
          ? 'Загрузка сайта…'
          : this.error()
            ? 'Не удалось загрузить сайт'
            : 'Сайт недоступен'),
    }));
  });
  private readonly api = inject(Api);

  constructor() {
    combineLatest([
      this.query.valueChanges.pipe(startWith(''), debounceTime(250), distinctUntilChanged()),
      toObservable(this.selectedIds),
      toObservable(this.scope),
    ])
      .pipe(
        switchMap(([q, selected, scope]) => {
          this.error.set('');
          this.loading.set(true);
          this.items.set([]);
          this.active.set(-1);
          return this.api
            .get<SiteSuggestions>('/sites/suggestions', {
              scope,
              q,
              limit: 3,
              selectedId: selected,
              excludeId: selected,
            })
            .pipe(
              catchError((error: unknown) => {
                this.error.set(problemOf(error).title);
                return of(null);
              }),
              finalize(() => this.loading.set(false)),
            );
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((response) => {
        if (!response) return;
        this.items.set(response.items);
        this.hasMore.set(response.hasMore);
        this.selected.set(response.selected);
      });
  }

  select(site: Site): void {
    if (this.selectedIds().includes(site.id) || this.selectedIds().length >= 50) return;
    this.selected.update((selected) => [...selected, site]);
    this.changed.emit([...this.selectedIds(), site.id]);
    this.query.setValue('');
    this.open.set(false);
  }

  remove(id: string): void {
    this.changed.emit(this.selectedIds().filter((item) => item !== id));
    document.getElementById(this.id)?.focus();
  }

  blur(event: FocusEvent): void {
    if (
      event.currentTarget instanceof HTMLElement &&
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    )
      return;
    this.open.set(false);
  }

  key(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.open.set(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.open.set(true);
      const size = this.items().length;
      if (size)
        this.active.set((this.active() + (event.key === 'ArrowDown' ? 1 : -1) + size) % size);
    }
    if (event.key === 'Enter' && this.open() && this.active() >= 0) {
      event.preventDefault();
      const site = this.items()[this.active()];
      if (site) this.select(site);
    }
  }
}
