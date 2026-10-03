import { Injectable, inject, signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';

interface Destination {
  url: string;
  label: string;
}
const roots = new Set([
  '/tasks',
  '/connections',
  '/usage',
  '/admin',
  '/admin/browsers',
  '/profile',
]);
export function safePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^\/(?!\/)[a-zA-Z0-9/?=&%_.~:+,-]*$/.test(value)
  )
    return false;
  const path = value.split('?')[0];
  return /^(?:\/tasks(?:\/[a-zA-Z0-9_-]+(?:\/(?:edit|result|overview))?)?|\/connections(?:\/[a-zA-Z0-9_-]+)?|\/login-operations\/[a-zA-Z0-9_-]+|\/usage|\/profile|\/forbidden|\/admin(?:\/(?:users(?:\/[a-zA-Z0-9_-]+(?:\/audit)?)?|browsers|audit))?)$/.test(
    path,
  );
}
function label(url: string): string {
  if (url.startsWith('/tasks/')) return 'К задаче';
  if (url.startsWith('/connections/')) return 'К подключению';
  if (url.startsWith('/admin/users/')) return 'К пользователю';
  if (url.startsWith('/connections')) return 'К подключениям';
  if (url.startsWith('/admin')) return 'К администрированию';
  return 'К задачам';
}
function family(url: string): string {
  return url.split('?')[0].replace(/\/(overview|result)$/, '');
}

@Injectable({ providedIn: 'root' })
export class Navigation {
  readonly back = signal<Destination | null>(null);
  readonly section = signal('Задачи');
  private readonly router = inject(Router);
  private previous = '';
  private stack: Destination[] = [];
  private isHistory = false;
  private frame = 0;

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) this.isHistory = event.navigationTrigger === 'popstate';
      if (!(event instanceof NavigationEnd)) return;
      const url = event.urlAfterRedirects,
        path = url.split('?')[0];
      const stored: unknown = history.state?.['helmSources'];
      if ((this.isHistory || !this.previous) && Array.isArray(stored)) {
        this.stack = stored
          .filter(
            (item: unknown): item is Destination =>
              typeof item === 'object' &&
              item !== null &&
              'url' in item &&
              safePath(item.url) &&
              'label' in item &&
              typeof item.label === 'string',
          )
          .slice(-8);
      } else if (roots.has(path)) this.stack = [];
      else if (
        this.previous &&
        family(this.previous) !== family(url) &&
        !this.previous.startsWith('/sign-in')
      ) {
        const existing = this.stack.findIndex((item) => family(item.url) === family(url));
        if (existing >= 0) this.stack = this.stack.slice(0, existing);
        else if (!this.previous.includes('/new') && !this.previous.endsWith('/edit'))
          this.stack = [...this.stack, { url: this.previous, label: label(this.previous) }].slice(
            -8,
          );
      }
      this.previous = url;
      history.replaceState({ ...history.state, helmSources: this.stack }, '');
      const fallback = path.startsWith('/connections/')
        ? '/connections'
        : path.startsWith('/admin/users/')
          ? '/admin/users'
          : path.startsWith('/admin/')
            ? '/admin'
            : '/tasks';
      this.back.set(
        roots.has(path) ? null : (this.stack.at(-1) ?? { url: fallback, label: label(fallback) }),
      );
      this.section.set(
        path.startsWith('/connections') || path.startsWith('/login-operations')
          ? 'Подключения'
          : path.startsWith('/usage')
            ? 'Использование'
            : path.startsWith('/admin')
              ? 'Администрирование'
              : path.startsWith('/profile')
                ? 'Профиль'
                : 'Задачи',
      );
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('main h1')?.focus(),
      );
    });
  }
}
