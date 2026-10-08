import { CdkMenuModule } from '@angular/cdk/menu';
import { Icon } from '../shared/icon';
import { A11yModule } from '@angular/cdk/a11y';
import { DatePipe } from '@angular/common';
import {
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  NavigationError,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import * as z from 'zod/mini';
import { Api, errorMessage } from './api';
import { LiveEvents } from './live-events';
import { Notification, notificationsSchema } from './models';
import { Session } from './session';
import { Status } from '../shared/ui';

@Component({
  selector: 'hg-shell',
  imports: [
    CdkMenuModule,
    Icon,
    A11yModule,
    DatePipe,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    Status,
  ],
  templateUrl: './shell.html',
})
export class Shell {
  readonly session = inject(Session);
  readonly api = inject(Api);
  readonly live = inject(LiveEvents);
  private readonly router = inject(Router);
  readonly mobile = signal(false);
  readonly notificationsOpen = signal(false);
  readonly notifications = signal<z.infer<typeof notificationsSchema> | null>(null);
  readonly error = signal('');
  readonly notificationError = signal('');
  readonly navigationFailed = signal(false);
  readonly reading = signal(false);
  readonly current = signal(this.router.url);
  readonly breadcrumbs = computed(() => {
    const parts = this.current().split('?')[0].split('/').filter(Boolean);
    const labels: Record<string, string> = {
      tasks: 'Задачи',
      connections: 'Подключения',
      usage: 'Использование',
      profile: 'Профиль',
      admin: 'Администрирование',
      users: 'Пользователи',
      nodes: 'Браузеры',
      audit: 'Журнал',
      new: 'Новая задача',
      edit: 'Редактирование',
      refine: 'Уточнение',
      similar: 'Похожая задача',
      result: 'Результат',
      manual: 'Ручное управление',
      login: 'Вход на сайт',
    };
    return parts.map((part, index) => ({
      label:
        labels[part] ??
        (parts[0] === 'tasks'
          ? 'Задача'
          : parts[0] === 'connections'
            ? 'Подключение'
            : 'Пользователь'),
      url: '/' + parts.slice(0, index + 1).join('/'),
    }));
  });
  private generation = 0;
  private preserveNotifications = false;
  private readonly bell = viewChild<ElementRef<HTMLButtonElement>>('bell');
  private readonly notificationHeading = viewChild<ElementRef<HTMLElement>>('notificationHeading');
  private readonly main = viewChild<ElementRef<HTMLElement>>('main');
  constructor() {
    void this.loadNotifications();
    this.live
      .watch(['notification'])
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.loadNotifications());
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationError) {
        this.navigationFailed.set(true);
        return;
      }
      if (!(event instanceof NavigationEnd)) return;
      this.navigationFailed.set(false);
      const changedPath = this.current().split('?')[0] !== this.router.url.split('?')[0];
      this.current.set(this.router.url);
      if (!changedPath) return;
      this.mobile.set(false);
      if (!this.preserveNotifications) this.notificationsOpen.set(false);
      this.preserveNotifications = false;
      if (!this.notificationsOpen()) queueMicrotask(() => this.main()?.nativeElement.focus());
    });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }
  async loadNotifications() {
    const generation = ++this.generation;
    try {
      const data = await this.api.get('/api/notifications', notificationsSchema);
      if (generation === this.generation) {
        this.notifications.set(data);
        this.notificationError.set('');
      }
    } catch (error: unknown) {
      if (generation === this.generation) this.notificationError.set(errorMessage(error));
    }
  }
  async read(item: Notification) {
    if (this.reading()) return;
    this.reading.set(true);
    const generation = ++this.generation;
    try {
      const data = await this.api.mutate(
        '/api/notifications/read',
        { id: item.id },
        notificationsSchema,
      );
      if (
        generation === this.generation &&
        data.throughSequence >= (this.notifications()?.throughSequence ?? 0)
      )
        this.notifications.set(data);
      else await this.loadNotifications();
      this.preserveNotifications = true;
      await this.router.navigate(['/tasks', item.taskId]);
      this.notificationHeading()?.nativeElement.focus();
    } catch (error: unknown) {
      this.notificationError.set(errorMessage(error));
    } finally {
      this.reading.set(false);
    }
  }
  async readAll() {
    const throughSequence = this.notifications()?.throughSequence;
    if (throughSequence === undefined || this.reading()) return;
    this.reading.set(true);
    const generation = ++this.generation;
    try {
      const data = await this.api.mutate(
        '/api/notifications/read',
        { throughSequence },
        notificationsSchema,
      );
      if (
        generation === this.generation &&
        data.throughSequence >= (this.notifications()?.throughSequence ?? 0)
      )
        this.notifications.set(data);
      else await this.loadNotifications();
      this.notificationHeading()?.nativeElement.focus();
    } catch (error: unknown) {
      this.notificationError.set(errorMessage(error));
    } finally {
      this.reading.set(false);
    }
  }
  closeNotifications() {
    this.notificationsOpen.set(false);
    this.bell()?.nativeElement.focus();
  }
  closeMenu() {
    this.mobile.set(false);
    queueMicrotask(() => document.getElementById('mobile-navigation-button')?.focus());
  }
  signIn() {
    location.assign('/sign-in?return=' + encodeURIComponent(this.router.url));
  }
  reloadApplication() {
    location.reload();
  }
  async logout() {
    try {
      await this.session.logout();
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    }
  }
}
