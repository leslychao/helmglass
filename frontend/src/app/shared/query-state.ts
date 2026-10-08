import { Injectable, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';

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
  sort(key: string, defaultKey = 'updatedAt', defaultDirection = 'desc') {
    this.set({
      sort: key,
      direction:
        this.text('sort', defaultKey) === key && this.text('direction', defaultDirection) === 'asc'
          ? 'desc'
          : 'asc',
    });
  }
  ariaSort(
    key: string,
    defaultKey = 'updatedAt',
    defaultDirection = 'desc',
  ): 'ascending' | 'descending' | 'none' {
    return this.text('sort', defaultKey) === key
      ? this.text('direction', defaultDirection) === 'asc'
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
