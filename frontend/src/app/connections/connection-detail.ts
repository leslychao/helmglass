import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api, ApiError, errorMessage } from '../core/api';
import { ResourceUnavailable } from '../core/account';
import { LiveEvents } from '../core/live-events';
import { Connection, connectionSchema } from '../core/models';
import { PageContext, pageReturnUrl } from '../core/page-context';
import { Icon } from '../shared/icon';
import { Status } from '../shared/ui';

@Component({
  selector: 'hg-connection-detail',
  imports: [DatePipe, RouterLink, ResourceUnavailable, Icon, Status],
  styleUrl: './connection-detail.css',
  template: `
    <a class="back-link" [routerLink]="backUrl"><hg-icon name="arrow-left" />К подключениям</a>
    @if (unavailable()) {
      <hg-resource-unavailable title="Подключение недоступно для текущего аккаунта"
        backUrl="/connections" backLabel="К подключениям" />
    } @else {
      <header class="page-heading"><h1>{{ connection()?.name || 'Подключение' }}</h1></header>
      @if (error()) {
        <p class="error-banner" role="alert">{{ error() }}
          <button class="text-button" (click)="load()">Повторить</button>
        </p>
      }
      @if (connection(); as item) {
        <div class="connection-layout">
          <section class="card connection-card" aria-labelledby="connection-heading">
            <header class="connection-card-heading">
              <h2 id="connection-heading"><span class="connection-mark"><hg-icon name="globe" /></span>Подключение</h2>
              <hg-status [value]="item.status === 'READY' ? 'CONNECTION_READY' : item.status" />
            </header>
            <div class="connection-card-body">
              <dl class="connection-facts">
                <div><dt>Сайт</dt><dd>{{ item.site }}</dd></div>
                <div><dt>Последняя сохранённая сессия</dt><dd>{{ item.profileSavedAt ? (item.profileSavedAt | date: 'dd.MM.yyyy HH:mm') : 'Ещё не сохранена' }}</dd></div>
                <div><dt>Задач с подключением</dt><dd>{{ item.taskCount }}</dd></div>
              </dl>
              @if (item.cookieCheck; as check) {
                <p class="notice" [class.warning]="check.usableCount === 0" role="status">
                  @if (check.usableCount > 0) {
                    При сохранении найдены непросроченные cookies. Авторизация сайта не проверялась.
                  } @else {
                    Сессия сохранена, но подходящие непросроченные cookies не найдены. Данные сайта сохранены; авторизация не подтверждена.
                  }
                  <span>Проверено {{ check.checkedAt | date: 'dd.MM.yyyy HH:mm:ss' }}.</span>
                </p>
              } @else if (item.profileSavedAt) {
                <p class="connection-privacy">Cookies сохранённой сессии ещё не проверялись.</p>
              }
              <div class="connection-launch">
                <a class="button primary connection-open" [routerLink]="['/connections', item.id, 'login']"
                  [queryParams]="{ return: currentUrl }" aria-describedby="connection-open-help">
                  <hg-icon name="browser" />Открыть браузер
                </a>
                <p id="connection-open-help">Перейти к сайту и сразу управлять браузером.</p>
              </div>
              <p class="connection-privacy">Сохранённая сессия восстановится автоматически. Если сайт попросит войти, пройдите авторизацию в браузере. Пароли и коды не попадут в историю задач.</p>
            </div>
          </section>
          <section class="card connection-card" aria-labelledby="connection-events-heading">
            <header class="connection-card-heading"><h2 id="connection-events-heading">Последние события</h2></header>
            <ol class="connection-events">
              @for (event of recentEvents(); track event.label) {
                <li><span class="event-dot"></span><div><h3>{{ event.label }}</h3><p>{{ event.at | date: 'dd.MM.yyyy HH:mm' }}</p></div></li>
              }
            </ol>
          </section>
        </div>
      } @else if (!error()) {
        <p role="status">Загружаем подключение…</p>
      }
    }
  `,
})
export class ConnectionDetail {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly context = inject(PageContext);
  private readonly destroy = inject(DestroyRef);
  private generation = 0;
  readonly connection = signal<Connection | null>(null);
  readonly error = signal('');
  readonly unavailable = signal(false);
  readonly recentEvents = computed(() => {
    const connection = this.connection();
    if (!connection) return [];
    const events = [{ label: 'Подключение создано', at: connection.createdAt }];
    if (connection.profileSavedAt) events.push({ label: 'Сессия сохранена', at: connection.profileSavedAt });
    if (connection.lastUsedAt) events.push({ label: 'Подключение использовано', at: connection.lastUsedAt });
    return events.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  });
  get currentUrl() { return this.router.url; }
  get backUrl() { return pageReturnUrl(this.route, this.router, '/connections'); }

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(() => {
      this.connection.set(null);
      void this.load();
    });
    inject(LiveEvents).watch(['connection', 'task']).pipe(takeUntilDestroyed()).subscribe(change => {
      if (change.resource === 'sync' || change.resource === 'task'
        || change.entityId === this.route.snapshot.paramMap.get('id')) void this.load();
    });
    this.destroy.onDestroy(() => this.generation++);
  }

  async load() {
    const generation = ++this.generation;
    try {
      const connection = await this.api.get('/api/connections/' + this.route.snapshot.paramMap.get('id'), connectionSchema);
      if (generation !== this.generation) return;
      this.connection.set(connection);
      this.context.setResource('connections', connection.id, connection.name);
      this.error.set('');
      this.unavailable.set(false);
    } catch (error: unknown) {
      if (generation !== this.generation) return;
      this.error.set(errorMessage(error));
      this.unavailable.set(error instanceof ApiError && [403, 404].includes(error.status));
      if (this.unavailable()) this.connection.set(null);
    }
  }
}
