import { Injectable, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Session } from './session';

type ResourceKind = 'tasks' | 'connections' | 'users';

@Injectable({ providedIn: 'root' })
export class PageContext {
  readonly resource = signal<{ kind: ResourceKind; id: string; label: string } | null>(null);
  private readonly session = inject(Session);

  constructor() {
    let owner: string | undefined;
    effect(() => {
      const current = this.session.user()?.id;
      if (current !== owner) this.resource.set(null);
      owner = current;
    });
  }

  setResource(kind: ResourceKind, id: string, label: string) {
    this.resource.set({ kind, id, label });
  }
}

export function pageReturnUrl(route: ActivatedRoute, router: Router, parent: string) {
  const source = internalReturnPath(route.snapshot.queryParamMap.get('return'));
  if (source) return router.parseUrl(source);
  const context = route.snapshot.queryParamMap.get('back');
  return router.parseUrl(parent + (context ? '?' + context : ''));
}

export function internalReturnPath(source: string | null): string | null {
  return source && /^\/(tasks|connections|usage|admin)(?:[/?#]|$)/.test(source) ? source : null;
}

export function pageReturnLabel(target: string) {
  const path = target.split(/[?#]/)[0];
  if (path === '/tasks') return 'К задачам';
  if (path.startsWith('/tasks/')) return 'К задаче';
  if (path === '/connections') return 'К подключениям';
  if (path.startsWith('/connections/')) return 'К подключению';
  if (path === '/usage') return 'К использованию';
  if (path === '/admin/nodes') return 'К браузерам';
  if (path === '/admin/audit') return 'К журналу';
  if (path === '/admin/users') return 'К пользователям';
  if (path.startsWith('/admin/users/')) return 'К пользователю';
  return 'К администрированию';
}
