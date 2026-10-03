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
    return this.read().pipe(
      tap((me) => {
        this.realtime.start(me, () => this.read());
      }),
      map(() => true),
      catchError(() => {
        this.me.set(null);
        this.realtime.stop();
        return of(false);
      }),
    );
  }

  private read(): Observable<Me> {
    return this.api.get<Me>('/me').pipe(
      tap({
        next: (me) => {
          this.me.set(me);
          this.error.set(null);
        },
        error: (error: unknown) => {
          const problem = problemOf(error);
          this.error.set(problem);
          if (problem.status === 401 || problem.status === 403) this.me.set(null);
        },
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
