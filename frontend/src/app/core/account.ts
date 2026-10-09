import { Component, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Empty } from '../shared/ui';
import { errorMessage } from './api';
import { Session } from './session';

@Component({
  selector: 'hg-sign-in',
  template: '<p class="loading" role="status">Открываем защищённую страницу входа…</p>',
})
export class SignIn {
  constructor() {
    inject(Session).beginSignIn(inject(ActivatedRoute).snapshot.queryParamMap.get('return'));
  }
}
@Component({
  selector: 'hg-unavailable',
  imports: [RouterLink, Empty],
  styles: '.actions { justify-content: center; }',
  template: `<main class="standalone">
    <a class="brand" routerLink="/tasks"
      ><img src="helm-logo.png" width="40" height="40" alt="" />Helm Glass</a
    >
    <section class="card">
      <hg-empty
        [icon]="denied ? 'lock' : 'alert'"
        [title]="title"
        [description]="description"
      >
        <div class="actions">
          @if (signInError) {
            <a class="button primary" routerLink="/sign-in">Повторить вход</a>
          } @else {
            @if (denied) {
              <a class="button primary" routerLink="/tasks">К задачам</a>
            }
            <button class="button" [class.primary]="!denied" (click)="retry()">Повторить</button>
          }
        </div>
      </hg-empty>
    </section>
  </main>`,
})
export class Unavailable {
  private readonly route = inject(ActivatedRoute);
  readonly denied = this.route.snapshot.data['denied'] === true;
  readonly signInError = this.route.snapshot.data['signInError'] === true;
  readonly title = this.signInError
    ? 'Не удалось войти'
    : this.denied ? 'Нет доступа' : 'Не удалось открыть страницу';
  readonly description = this.signInError
    ? 'Ссылка для входа недействительна, истекла или сервис авторизации не ответил. Начните вход заново. Ваши задачи сохранены.'
    : this.denied
      ? 'У вашей учётной записи нет разрешения на этот раздел.'
      : 'Сервис не ответил или страница не найдена. Можно повторить запрос.';
  retry() {
    location.reload();
  }
}

@Component({
  selector: 'hg-resource-unavailable',
  imports: [RouterLink, Empty],
  styles: `
    :host { display: block; }
    .actions { justify-content: center; margin-top: 18px; }
    .current-account { margin-top: 18px; color: var(--muted); overflow-wrap: anywhere; }
    .current-account strong { display: block; color: var(--ink); }
    .error-banner { margin-top: 18px; }
  `,
  template: `
    <section class="card">
      <hg-empty
        icon="lock"
        [title]="title()"
        description="Ссылка может быть недействительной или ресурс недоступен этому аккаунту. Для задачи из ChatGPT войдите тем же аккаунтом Helm Glass, который подключён в чате."
      >
        @if (session.user(); as user) {
          <p class="current-account">
            Текущий аккаунт<strong>{{ user.name }}</strong>{{ user.email }}
          </p>
        }
        <div class="actions">
          <button class="button primary" [disabled]="session.signingOut()" (click)="switchAccount()">
            {{ session.signingOut() ? 'Открываем вход…' : 'Войти другим аккаунтом' }}
          </button>
          <a class="button" [routerLink]="backUrl()">{{ backLabel() }}</a>
        </div>
        @if (error()) { <p class="error-banner" role="alert">{{ error() }}</p> }
      </hg-empty>
    </section>
  `,
})
export class ResourceUnavailable {
  readonly title = input('Объект недоступен для текущего аккаунта');
  readonly backUrl = input('/tasks');
  readonly backLabel = input('К задачам');
  readonly session = inject(Session);
  private readonly router = inject(Router);
  readonly error = signal('');

  async switchAccount() {
    this.error.set('');
    try {
      await this.session.logout(this.router.url);
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    }
  }
}
