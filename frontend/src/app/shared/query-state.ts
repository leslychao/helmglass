import { Injectable, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';

export interface TableQueryKeys {
  sort: string;
  direction: string;
  page: string;
  size: string;
}

export const tableQueryKeys: TableQueryKeys = {
  sort: 'sort',
  direction: 'direction',
  page: 'page',
  size: 'pageSize',
};

@Injectable()
export class QueryState {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly params = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });
  text(key: string, fallback = '') {
    return this.params().get(key) ?? fallback;
  }
  values(key: string) {
    return this.params().getAll(key);
  }
  hasFilters(keys: readonly string[]) {
    return keys.some((key) => this.values(key).some((value) => value !== ''));
  }
  clearFilters(keys: readonly string[], pageKey = 'page') {
    const values: Record<string, null> = { [pageKey]: null };
    for (const key of keys) values[key] = null;
    this.set(values, false);
  }
  context() {
    const params = new URLSearchParams();
    for (const key of this.params().keys)
      for (const value of this.params().getAll(key)) params.append(key, value);
    return params.toString();
  }
  number(key: string, fallback: number) {
    const value = Number(this.text(key));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
  sort(key: string, keys = tableQueryKeys) {
    const current = this.ariaSort(key, keys);
    this.set(
      {
        [keys.sort]: current === 'descending' ? null : key,
        [keys.direction]:
          current === 'descending' ? null : current === 'ascending' ? 'desc' : 'asc',
        [keys.page]: null,
      },
      false,
    );
  }
  ariaSort(key: string, keys = tableQueryKeys): 'ascending' | 'descending' | 'none' {
    return this.text(keys.sort) === key
      ? this.text(keys.direction, 'asc') === 'asc'
        ? 'ascending'
        : 'descending'
      : 'none';
  }
  set(values: Record<string, string | number | readonly string[] | null>, resetPage = true) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ...(resetPage ? { page: null } : {}), ...values },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
