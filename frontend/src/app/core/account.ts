import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Session } from './session';
import { Empty } from '../shared/ui';

@Component({
  selector: 'hg-sign-in',
  template: '<p class="loading" role="status">Открываем защищённую страницу входа…</p>',
})
export class SignIn {
  constructor() {
    const target = inject(ActivatedRoute).snapshot.queryParamMap.get('return') ?? '/tasks';
    const url = URL.parse(target, location.origin);
    const safe =
      url !== null &&
      url.origin === location.origin &&
      url.pathname.startsWith('/') &&
      !url.pathname.startsWith('/sign-in') &&
      !url.pathname.startsWith('/oauth2/');
    location.replace(
      '/oauth2/start?rd=' +
        encodeURIComponent(safe && url ? url.pathname + url.search + url.hash : '/tasks'),
    );
  }
}
@Component({
  selector: 'hg-profile',
  template: `<header class="page-heading">
      <div>
        <h1>Профиль</h1>
        <p>Ваша учётная запись Helm Glass.</p>
      </div>
    </header>
    <section class="card profile-card">
      <span class="avatar large">{{ session.user()?.name?.slice(0, 1) }}</span>
      <h2>{{ session.user()?.name }}</h2>
      <p class="muted">{{ session.user()?.email }}</p>
      <a
        class="button"
        [href]="session.user()?.accountManagementUrl"
        target="_blank"
        rel="noopener noreferrer"
        >Управление аккаунтом ↗</a
      >
    </section>`,
})
export class Profile {
  readonly session = inject(Session);
}
@Component({
  selector: 'hg-unavailable',
  imports: [RouterLink, Empty],
  template: `<main class="standalone">
    <a class="brand" routerLink="/tasks"
      ><img src="helm-logo.png" width="40" height="40" alt="" />Helm Glass</a
    >
    <section class="card">
      <hg-empty
        [title]="denied ? 'Нет доступа' : 'Не удалось открыть страницу'"
        [description]="
          denied
            ? 'У вашей учётной записи нет разрешения на этот раздел.'
            : 'Сервис не ответил или страница не найдена. Можно повторить запрос.'
        "
        ><a class="button primary" routerLink="/tasks">К задачам</a
        ><button class="button" (click)="retry()">Повторить</button></hg-empty
      >
    </section>
  </main>`,
})
export class Unavailable {
  readonly denied = inject(ActivatedRoute).snapshot.data['denied'] === true;
  retry() {
    location.reload();
  }
}
