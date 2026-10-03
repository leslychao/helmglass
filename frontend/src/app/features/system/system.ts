import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
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
        <p class="description">Продолжите с вашей учётной записью.</p>
        @if (reauthenticationRequired()) {
          <div class="notice warning" role="status">
            Сессия отозвана. Подождите секунду и войдите заново.
          </div>
        } @else if (identity.error()?.status && identity.error()?.status !== 401) {
          <div class="notice error" role="alert">{{ identity.error()?.title }}</div>
        }
        @if (retryReady()) {
          <a class="btn primary wide" [href]="loginUrl">Войти через Keycloak</a>
        } @else {
          <button class="btn primary wide" disabled>Подождите секунду</button>
        }
        <p class="small muted">Авторизация открывается на защищённой странице входа.</p>
      </div>
    </section>
  </main>`,
})
export class SignIn {
  readonly identity = inject(Identity);
  private route = inject(ActivatedRoute);
  readonly reauthenticationRequired = computed(
    () => this.identity.error()?.code === 'REAUTHENTICATION_REQUIRED',
  );
  readonly retryReady = signal(true);
  readonly target = this.route.snapshot.queryParamMap.get('returnTo');
  readonly loginUrl =
    '/oauth2/start?rd=' + encodeURIComponent(safePath(this.target) ? this.target : '/tasks');

  constructor() {
    effect((onCleanup) => {
      this.retryReady.set(!this.reauthenticationRequired());
      if (!this.reauthenticationRequired()) return;
      const timer = setTimeout(() => this.retryReady.set(true), 1000);
      onCleanup(() => clearTimeout(timer));
    });
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
