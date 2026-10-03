import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { DatePipe } from '@angular/common';
import { Identity } from '../identity/identity.service';
import { Navigation } from './navigation.service';
import { Realtime } from '../realtime/realtime.service';
import { ServerResource } from '../api/server-resource';
import { LogoutResult, Notifications, Problem } from '../api/models';
import { Api, problemOf } from '../api/api.service';
import { Mutation } from '../api/mutation';
import { Icon } from '../../shared/icon/icon';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { LabelPipe } from '../../shared/status/status';

@Component({
  selector: 'hg-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    Icon,
    DatePipe,
    Feedback,
    MutationFeedback,
    LabelPipe,
  ],
  template: `
    <a class="skip-link" href="#main">Перейти к содержимому</a>
    <div class="shell h-shell">
      <aside class="sidebar" [class.mobile-open]="menu()">
        <a class="brand" routerLink="/tasks" (click)="menu.set(false)"
          ><img class="h-brand-logo" src="/helm-logo.png" width="38" height="38" alt="" /><span
            >Helm Glass</span
          ></a
        >
        <nav aria-label="Основная навигация">
          @for (item of links; track item.path) {
            <a
              class="nav-item"
              [routerLink]="item.path"
              routerLinkActive="active"
              ariaCurrentWhenActive="page"
              (click)="menu.set(false)"
              ><hg-icon [name]="item.icon" />{{ item.label }}</a
            >
          }
          @if (identity.can('platform_admin')) {
            <div class="nav-divider"></div>
            <a
              class="nav-item"
              routerLink="/admin"
              routerLinkActive="active"
              ariaCurrentWhenActive="page"
              (click)="menu.set(false)"
              ><hg-icon name="settings" />Администрирование</a
            >
          }
        </nav>
        <div class="side-bottom">
          <a routerLink="/connections/guide"><hg-icon name="chat" />Подключить ChatGPT</a>
        </div>
      </aside>
      @if (menu()) {
        <button
          class="mobile-backdrop"
          aria-label="Закрыть меню"
          (click)="menu.set(false)"
        ></button>
      }
      <div class="work">
        <header class="topbar">
          <button
            class="icon-btn mobile-toggle"
            aria-label="Открыть меню"
            [attr.aria-expanded]="menu()"
            (click)="menu.set(!menu())"
          >
            <hg-icon name="menu" /></button
          ><span class="context-path">{{ navigation.section() }}</span
          ><span class="spacer"></span
          ><button
            class="icon-btn notification-trigger"
            aria-label="Уведомления"
            [attr.aria-expanded]="notificationsOpen()"
            (click)="toggleNotifications()"
          >
            <hg-icon name="bell" />
            @if ((notifications.data()?.unreadCount ?? 0) > 0) {
              <span class="dot"></span>
            }</button
          ><button
            class="profile-trigger"
            aria-label="Меню профиля"
            [attr.aria-expanded]="profileOpen()"
            (click)="profileOpen.set(!profileOpen()); notificationsOpen.set(false)"
          >
            <span class="avatar">{{ identity.me()?.displayName?.slice(0, 2)?.toUpperCase() }}</span
            ><span aria-hidden="true">⌄</span>
          </button>
        </header>
        @if (profileOpen()) {
          <div class="popover profile">
            <a routerLink="/profile" (click)="profileOpen.set(false)"
              ><hg-icon name="user" />Профиль</a
            ><button [disabled]="loggingOut()" (click)="logout()">
              <hg-icon name="back" />Выйти</button
            ><hg-mutation [action]="action" />
            <hg-feedback [error]="logoutError()" (retry)="logout()" />
          </div>
        }
        @if (notificationsOpen()) {
          <section class="popover notifications" aria-label="Уведомления">
            <header class="panel-head">
              <h2>Уведомления</h2>
              <button
                class="icon-btn"
                aria-label="Закрыть уведомления"
                (click)="notificationsOpen.set(false)"
              >
                <hg-icon name="close" />
              </button>
            </header>
            <hg-feedback
              [loading]="notifications.loading()"
              [error]="notifications.error()"
              (retry)="notifications.refresh()"
            />
            @for (item of notifications.data()?.items ?? []; track item.id) {
              <a
                class="notification"
                [class.unread]="!item.readAt"
                [routerLink]="item.taskId ? '/tasks/' + item.taskId : '/tasks'"
                (click)="readNotification(item.id)"
                ><strong>{{ item.kind | label }}</strong>
                <small>{{ item.createdAt | date: 'dd.MM, HH:mm' }}</small></a
              >
            } @empty {
              @if (notifications.data()) {
                <p class="panel-body muted">Новых уведомлений нет</p>
              }
            }
            @if (notifications.data()?.nextCursor) {
              <button class="btn" (click)="moreNotifications()">Следующие уведомления</button>
            }
          </section>
        }
        <main id="main" class="content" tabindex="-1">
          @if (navigation.back(); as back) {
            <a class="page-return8" [routerLink]="back.url"
              ><hg-icon name="back" />{{ back.label }}</a
            >
          }
          @if (realtime.state() === 'offline') {
            <div class="notice warning" role="status">
              Обновления приостановлены. Восстанавливаем связь; данные могут быть устаревшими.
            </div>
          }
          @if (realtime.state() === 'denied') {
            <div class="notice error" role="alert">
              Сессия завершена. <a routerLink="/sign-in">Войти снова</a>
            </div>
          }
          @if (realtime.state() === 'exhausted') {
            <div class="notice warning" role="status">
              Связь не восстановлена. Данные могут быть устаревшими.
              <button class="btn" (click)="realtime.retry()">Повторить подключение</button>
            </div>
          }
          <router-outlet />
        </main>
        <footer class="app-footer">Helm Glass</footer>
      </div>
    </div>
  `,
})
export class Shell {
  private readonly api = inject(Api);
  private readonly destroy = inject(DestroyRef);
  private readonly logoutKey = crypto.randomUUID();
  readonly loggingOut = signal(false);
  readonly logoutError = signal<Problem | null>(null);
  readonly identity = inject(Identity);
  readonly navigation = inject(Navigation);
  readonly realtime = inject(Realtime);
  readonly notifications = new ServerResource<Notifications>(['notifications']);
  readonly action = new Mutation();
  readonly menu = signal(false);
  readonly profileOpen = signal(false);
  readonly notificationsOpen = signal(false);
  readonly links = [
    { path: '/tasks', label: 'Задачи', icon: 'tasks' },
    { path: '/connections', label: 'Подключения', icon: 'plug' },
    { path: '/usage', label: 'Использование', icon: 'chart' },
  ];
  constructor() {
    effect(() => {
      if (this.identity.me()) this.notifications.load('/notifications', { limit: 20 });
    });
  }
  toggleNotifications() {
    this.notificationsOpen.set(!this.notificationsOpen());
    this.profileOpen.set(false);
  }
  moreNotifications() {
    this.notifications.load('/notifications', {
      limit: 20,
      cursor: this.notifications.data()?.nextCursor,
    });
  }
  readNotification(id: string) {
    this.action.run('POST', `/notifications/${id}/read`, {}, () => this.notifications.refresh());
    this.notificationsOpen.set(false);
  }
  logout() {
    if (this.loggingOut()) return;
    this.loggingOut.set(true);
    this.logoutError.set(null);
    this.api
      .mutate<LogoutResult>('POST', '/auth/logout', {}, this.logoutKey)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (response) => {
          this.identity.clear();
          location.assign(response.redirect);
        },
        error: (error: unknown) => {
          this.loggingOut.set(false);
          this.logoutError.set(problemOf(error));
        },
      });
  }
}
