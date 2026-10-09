import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import * as z from 'zod/mini';
import { Api, ApiError } from './api';
import { LiveEvents } from './live-events';
import { Me, meSchema } from './models';

const SIGN_IN_RETURN = 'helm-sign-in-return';

export function accountReturnPath(target: string | null | undefined): string {
  const url = URL.parse(target ?? '/tasks', location.origin);
  if (
    !url || url.origin !== location.origin ||
    url.pathname.startsWith('/sign-in') || url.pathname.startsWith('/oauth2/') ||
    url.pathname.startsWith('/auth/')
  ) return '/tasks';
  return url.pathname + url.search + url.hash;
}

@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  private readonly live = inject(LiveEvents);
  readonly user = signal<Me | null>(null);
  private pending: Promise<Me> | null = null;
  private refreshRequested = false;
  readonly refreshError = signal('');
  readonly signingOut = signal(false);
  readonly logoutPending = signal(false);
  beginSignIn(target: string | null) {
    const path = accountReturnPath(target ?? sessionStorage.getItem(SIGN_IN_RETURN));
    sessionStorage.setItem(SIGN_IN_RETURN, path);
    location.replace('/oauth2/start?rd=' + encodeURIComponent(path));
  }
  constructor() {
    this.live
      .watch(['account'])
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.refresh());
    effect(() => {
      if (this.live.state() === 'reconnecting') untracked(() => void this.refresh());
    });
  }
  private async refresh() {
    if (!this.user() || this.api.authenticationRequired()) return;
    if (this.pending) {
      this.refreshRequested = true;
      return;
    }
    try {
      this.pending = this.api.get('/api/me', meSchema);
      const value = await this.pending;
      this.applyProfile(value);
      this.refreshError.set('');
    } catch (error: unknown) {
      this.refreshError.set(
        error instanceof Error ? error.message : 'Не удалось проверить доступ.',
      );
    } finally {
      this.pending = null;
      if (this.refreshRequested) {
        this.refreshRequested = false;
        void this.refresh();
      }
    }
  }
  load(): Promise<Me> {
    const user = this.user();
    if (user) return Promise.resolve(user);
    return (this.pending ??= this.api
      .get('/api/me', meSchema)
      .then((value) => {
        sessionStorage.removeItem(SIGN_IN_RETURN);
        this.user.set(value);
        this.api.setAccount(value.id);
        this.live.start();
        return value;
      })
      .finally(() => {
        this.pending = null;
      }));
  }
  get admin() {
    return this.user()?.roles.some((role) => role.toLowerCase() === 'admin') ?? false;
  }
  applyProfile(value: Me) {
    const current = this.user();
    if (current?.id === value.id && current.version <= value.version) this.user.set(value);
  }
  initials(name = this.user()?.name ?? '') {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.slice(0, 1))
      .join('')
      .toUpperCase();
  }
  async logout(returnTo?: string) {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    try {
      const result = await this.api.mutate(
        '/api/auth/logout',
        {},
        z.object({
          status: z.enum(['COMPLETED', 'PENDING']),
          redirectUrl: z.nullable(z.string()),
          message: z.nullable(z.string()),
        }),
      );
      this.live.stop();
      this.logoutPending.set(result.status === 'PENDING');
      if (result.status === 'PENDING')
        throw new ApiError(
          result.message ??
            'Доступ отозван; закрытие просмотров ещё не подтверждено. Повторите завершение выхода.',
          202,
          false,
          {},
          'LOGOUT_PENDING',
        );
      this.user.set(null);
      sessionStorage.removeItem(SIGN_IN_RETURN);
      const signIn = returnTo
        ? '/sign-in?return=' + encodeURIComponent(accountReturnPath(returnTo))
        : '/sign-in';
      location.assign('/oauth2/sign_out?rd=' + encodeURIComponent(signIn));
    } finally {
      this.signingOut.set(false);
    }
  }
}
export const authenticated: CanActivateFn = async (_route, state) => {
  const session = inject(Session),
    router = inject(Router);
  try {
    await session.load();
    return true;
  } catch (error: unknown) {
    return router.createUrlTree(
      [error instanceof ApiError && error.status === 401 ? '/sign-in' : '/unavailable'],
      {
        queryParams: { return: state.url },
      },
    );
  }
};
export const administrator: CanActivateFn = () =>
  inject(Session).admin || inject(Router).createUrlTree(['/denied']);
export interface EditedForm {
  hasChanges(): boolean;
}
export const preserveForm = (component: EditedForm) =>
  !component.hasChanges() || confirm('Покинуть форму без сохранения изменений?');
