import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Identity } from '../../core/identity/identity.service';
import { safePath } from '../../core/navigation/navigation.service';
@Component({
  selector: 'hg-sign-in',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main class="auth-page">
    <section class="auth-art">
      <a class="brand" routerLink="/tasks"
        ><img src="/helm-logo.png" width="42" height="42" alt="" /><strong>Helm Glass</strong></a
      >
      <div class="auth-story">
        <h1>Ваш браузер.<br />Под управлением ChatGPT.</h1>
        <p>Поручайте задачи, наблюдайте за выполнением и подключайтесь, когда нужна ваша помощь.</p>
      </div>
    </section>
    <section class="auth-form-side">
      <div class="auth-card">
        <h1 tabindex="-1">Войти в Helm Glass</h1>
        @if (checking()) {
          <p class="description" role="status">Проверяем вход…</p>
        } @else if (logoutPending) {
          <div class="notice warning" role="status">
            Вы вышли из приложения. Сервер входа пока недоступен; завершение сессии будет повторено.
          </div>
        } @else if (reauthenticationRequired()) {
          <div class="notice warning" role="status">
            Сессия отозвана. Подождите секунду и войдите заново.
          </div>
        } @else {
          <div class="notice error" role="alert">{{ identity.error()?.title }}</div>
        }
        @if (!checking() && retryReady()) {
          <a class="btn primary wide" [href]="loginUrl">Войти снова</a>
        } @else if (!checking()) {
          <button class="btn primary wide" disabled>Подождите секунду</button>
        }
      </div>
    </section>
  </main>`,
})
export class SignIn {
  readonly identity = inject(Identity);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  readonly checking = signal(true);
  readonly logoutPending = this.route.snapshot.queryParamMap.get('logoutPending') === '1';
  readonly reauthenticationRequired = computed(
    () => this.identity.error()?.code === 'REAUTHENTICATION_REQUIRED',
  );
  readonly retryReady = signal(true);
  private readonly target = this.route.snapshot.queryParamMap.get('returnTo');
  readonly destination = safePath(this.target) ? this.target : '/tasks';
  readonly loginUrl =
    '/oauth2/start?rd=' +
    encodeURIComponent('/sign-in?complete=1&returnTo=' + encodeURIComponent(this.destination));

  constructor() {
    effect((onCleanup) => {
      this.retryReady.set(!this.reauthenticationRequired());
      if (!this.reauthenticationRequired()) return;
      const timer = setTimeout(() => this.retryReady.set(true), 1000);
      onCleanup(() => clearTimeout(timer));
    });

    if (this.logoutPending) {
      this.checking.set(false);
    } else if (this.identity.error()) {
      this.continueLogin();
    } else {
      this.identity
        .load()
        .pipe(takeUntilDestroyed(this.destroy))
        .subscribe((allowed) => {
          if (allowed) void this.router.navigateByUrl(this.destination, { replaceUrl: true });
          else this.continueLogin();
        });
    }
  }

  private continueLogin() {
    // A failed callback must remain visible instead of starting another authorize loop.
    if (
      this.identity.error()?.code === 'AUTHENTICATION_REQUIRED' &&
      this.route.snapshot.queryParamMap.get('complete') !== '1'
    ) {
      location.replace(this.loginUrl);
      return;
    }
    this.checking.set(false);
  }
}
@Component({
  selector: 'hg-system',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="system-page">
    <h1 tabindex="-1">{{ forbidden ? 'Нет доступа' : 'Страница не найдена' }}</h1>
    <p class="description">
      {{
        forbidden
          ? 'У вашей учётной записи нет разрешения для этого раздела.'
          : 'Объект удалён, недоступен или адрес изменился.'
      }}
    </p>
    <a class="btn primary" routerLink="/tasks">К задачам</a>
  </section>`,
})
export class SystemPage {
  readonly forbidden = inject(ActivatedRoute).snapshot.data['forbidden'] === true;
}
