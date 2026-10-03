import { DestroyRef, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { Api, problemOf } from './api.service';
import { Problem, Query } from './models';
import { Realtime, ResourceName } from '../realtime/realtime.service';

/** One visible resource. Invalidations coalesce while a read is in flight. */
export class ServerResource<T> {
  readonly data = signal<T | null>(null);
  readonly loading = signal(false);
  readonly error = signal<Problem | null>(null);
  private readonly api = inject(Api);
  private readonly destroy = inject(DestroyRef);
  private request?: Subscription;
  private generation = 0;
  private dirty = false;
  private path = '';
  private query: Query = {};
  private readonly pages: readonly [string, (value: T) => unknown][];

  constructor(
    names: ResourceName[],
    pageOf: ((value: T) => unknown) | Readonly<Record<string, (value: T) => unknown>> = (value) =>
      value,
  ) {
    this.pages = typeof pageOf === 'function' ? [['', pageOf]] : Object.entries(pageOf);
    inject(Realtime)
      .refresh.pipe(takeUntilDestroyed(this.destroy))
      .subscribe((changed) => {
        if (changed === null || names.some((name) => changed.has(name))) this.refresh();
      });
    this.destroy.onDestroy(() => this.request?.unsubscribe());
  }

  load(path: string, query: Query = {}) {
    this.request?.unsubscribe();
    this.generation++;
    this.dirty = false;
    if (path !== this.path) this.data.set(null);
    const data = untracked(this.data);
    const nextQuery = { ...query };
    for (const [prefix, select] of this.pages) {
      const previous = data === null ? null : pageMetadata(untracked(() => select(data)));
      const sameScope =
        queryScope(path, query, prefix) === queryScope(this.path, this.query, prefix);
      nextQuery[pageKey(prefix, 'snapshot')] = sameScope ? previous?.snapshot : undefined;
    }
    this.path = path;
    this.query = nextQuery;
    this.read();
  }

  refresh() {
    if (!this.path) return;
    this.clearSnapshots();
    if (untracked(this.loading)) {
      this.dirty = true;
      return;
    }
    this.read();
  }

  clear() {
    this.request?.unsubscribe();
    this.generation++;
    this.dirty = false;
    this.path = '';
    this.query = {};
    this.data.set(null);
    this.error.set(null);
    this.loading.set(false);
  }

  private read(recovered = false, corrected = false) {
    const generation = this.generation;
    this.loading.set(true);
    this.error.set(null);
    this.request = this.api.get<T>(this.path, this.query).subscribe({
      next: (data) => {
        if (generation !== this.generation) return;
        let needsCorrection = false;
        const query = { ...this.query };
        for (const [prefix, select] of this.pages) {
          const page = data === null ? null : pageMetadata(untracked(() => select(data)));
          if (!page) continue;
          const lastPage = Math.max(1, Math.ceil(page.total / page.pageSize));
          query[pageKey(prefix, 'snapshot')] = this.dirty ? undefined : page.snapshot;
          if (!corrected && page.page > lastPage) {
            query[pageKey(prefix, 'page')] = lastPage;
            needsCorrection = true;
          }
        }
        this.query = query;
        if (needsCorrection) {
          this.read(recovered, true);
          return;
        }
        this.data.set(data);
        this.finish();
      },
      error: (error: unknown) => {
        if (generation !== this.generation) return;
        const problem = problemOf(error);
        if (!recovered && problem.code === 'LIST_SNAPSHOT_EXPIRED') {
          this.clearSnapshots();
          this.read(true, corrected);
          return;
        }
        if (problem.status === 401 || problem.status === 403 || problem.status === 404)
          this.data.set(null);
        this.error.set(problem);
        this.finish();
      },
    });
  }

  private clearSnapshots() {
    const query = { ...this.query };
    for (const [prefix] of this.pages) query[pageKey(prefix, 'snapshot')] = undefined;
    this.query = query;
  }

  private finish() {
    this.loading.set(false);
    if (this.dirty) {
      this.dirty = false;
      this.read();
    }
  }
}

function pageKey(prefix: string, name: string): string {
  return prefix ? prefix + '.' + name : name;
}

function queryScope(path: string, query: Query, prefix: string): string {
  return (
    path +
    JSON.stringify(
      Object.keys(query)
        .filter(
          (key) =>
            (!prefix || key.startsWith(prefix + '.') || !key.includes('.')) &&
            key !== pageKey(prefix, 'page') &&
            key !== pageKey(prefix, 'snapshot'),
        )
        .sort()
        .map((key) => [key, query[key]]),
    )
  );
}

function pageMetadata(
  value: unknown,
): { page: number; pageSize: number; total: number; snapshot: string } | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('page' in value) ||
    !('pageSize' in value) ||
    !('total' in value) ||
    !('snapshot' in value)
  )
    return null;
  const { page, pageSize, total, snapshot } = value;
  if (
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    typeof pageSize !== 'number' ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    typeof total !== 'number' ||
    !Number.isInteger(total) ||
    total < 0 ||
    typeof snapshot !== 'string'
  )
    return null;
  return { page, pageSize, total, snapshot };
}
