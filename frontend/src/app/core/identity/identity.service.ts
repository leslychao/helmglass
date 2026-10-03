import { Injectable, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Observable, catchError, map, of, tap } from 'rxjs';
import { Api, problemOf } from '../api/api.service';
import { Me, Problem } from '../api/models';
import { Realtime } from '../realtime/realtime.service';

@Injectable({ providedIn: 'root' })
export class Identity {
  readonly me = signal<Me | null>(null);
  readonly error = signal<Problem | null>(null);
  private readonly api = inject(Api);
  private readonly realtime = inject(Realtime);

  load(): Observable<boolean> {
    return this.api.get<Me>('/me').pipe(
      tap((me) => {
        this.me.set(me);
        this.error.set(null);
        this.realtime.start(me.permissions.includes('platform_admin'));
      }),
      map(() => true),
      catchError((error: unknown) => {
        this.error.set(problemOf(error));
        this.me.set(null);
        this.realtime.stop();
        return of(false);
      }),
    );
  }

  can(permission: string) {
    return this.me()?.permissions.includes(permission) ?? false;
  }
  clear() {
    this.me.set(null);
    this.realtime.stop();
  }
}

export const authenticated: CanActivateFn = (_, state) => {
  const identity = inject(Identity),
    router = inject(Router);
  if (identity.me()) return true;
  return identity
    .load()
    .pipe(
      map((allowed) =>
        allowed
          ? true
          : router.createUrlTree(['/sign-in'], { queryParams: { returnTo: state.url } }),
      ),
    );
};
export const administrator: CanActivateFn = () =>
  inject(Identity).can('platform_admin') || inject(Router).createUrlTree(['/forbidden']);
