import { computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Query } from '../../core/api/models';

export class TableQuery {
  constructor(private readonly options: { prefix?: string; pageSize?: number } = {}) {}

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private params = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });
  readonly value = computed<Query>(
    () => {
      const map = this.params();
      const query: Record<string, string | number | string[]> = {};
      for (const key of this.keys()) {
        const localKey = this.options.prefix ? key.slice(this.options.prefix.length + 1) : key;
        query[localKey] = map.getAll(key).length > 1 ? map.getAll(key) : (map.get(key) ?? '');
      }
      const defaultSize = this.options.pageSize ?? 10;
      const pageSize = Number(query['pageSize']);
      query['page'] = Math.max(1, Number(query['page']) || 1);
      query['pageSize'] = [defaultSize, 10, 20, 50, 100].includes(pageSize)
        ? pageSize
        : defaultSize;
      return query;
    },
    { equal: sameQuery },
  );
  change(values: Query) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: this.scoped({ ...values, snapshot: null }),
      queryParamsHandling: 'merge',
    });
  }
  filter(values: Query) {
    this.change({ ...values, page: 1 });
  }
  replace(values: Query) {
    if (this.options.prefix) {
      const cleared = Object.fromEntries(this.keys().map((key) => [key, null]));
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: {
          ...cleared,
          ...this.scoped({ pageSize: this.value()['pageSize'], ...values }),
        },
        queryParamsHandling: 'merge',
      });
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { pageSize: this.value()['pageSize'], ...values },
    });
  }
  clear() {
    this.replace({});
  }
  text(key: string) {
    const value = this.value()[key];
    return typeof value === 'string' ? value : '';
  }
  values(key: string): readonly string[] {
    const value = this.value()[key];
    return Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
  }
  toggle(key: string, value: string) {
    const values = this.values(key);
    this.filter({
      [key]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value],
    });
  }

  private keys(): readonly string[] {
    const prefix = this.options.prefix;
    return this.params().keys.filter((key) => !prefix || key.startsWith(prefix + '.'));
  }

  private scoped(values: Query): Query {
    const prefix = this.options.prefix;
    if (!prefix) return values;
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [prefix + '.' + key, value]),
    );
  }
}

function sameQuery(left: Query, right: Query): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const before = left[key];
      const after = right[key];
      return (
        before === after ||
        (Array.isArray(before) &&
          Array.isArray(after) &&
          before.length === after.length &&
          before.every((value, index) => value === after[index]))
      );
    })
  );
}
