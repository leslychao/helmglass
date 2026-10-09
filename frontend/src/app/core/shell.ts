import { CdkMenuModule } from '@angular/cdk/menu';
import {
  CdkConnectedOverlay,
  ConnectedOverlayPositionChange,
  ConnectedPosition,
  OverlayModule,
} from '@angular/cdk/overlay';
import { Icon } from '../shared/icon';
import { A11yModule } from '@angular/cdk/a11y';
import { DatePipe } from '@angular/common';
import {
  Component,
  afterRenderEffect,
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
import { Tooltip } from '../shared/tooltip';
import { PageContext, internalReturnPath } from './page-context';

@Component({
  selector: 'hg-shell',
  imports: [
    OverlayModule,
    CdkMenuModule,
    Icon,
    A11yModule,
    DatePipe,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    Status,
    Tooltip,
  ],
  templateUrl: './shell.html',
  host: { '(window:resize)': 'repositionPopup()' },
})
export class Shell {
  readonly session = inject(Session);
  readonly api = inject(Api);
  readonly live = inject(LiveEvents);
  private readonly router = inject(Router);
  private readonly pageContext = inject(PageContext);
  readonly mobile = signal(false);
  readonly popup = signal<'notifications' | 'profile' | null>(null);
  readonly notificationsOpen = computed(() => this.popup() === 'notifications');
  readonly popupAnchorX = signal(0);
  readonly popupMaxWidth = signal(document.documentElement.clientWidth - 24);
  readonly popupAbove = signal(false);
  readonly popupPositions: ConnectedPosition[] = [
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 10 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -10 },
  ];
  readonly notifications = signal<z.infer<typeof notificationsSchema> | null>(null);
  readonly error = signal('');
  readonly notificationError = signal('');
  readonly navigationFailed = signal(false);
  readonly reading = signal(false);
  readonly current = signal(this.router.url);
  readonly profileUrl = computed(() =>
    this.current().startsWith('/profile')
      ? this.router.parseUrl(this.current())
      : this.router.createUrlTree(['/profile'], { queryParams: { return: this.current() } }),
  );
  readonly breadcrumbs = computed(() => {
    const parts = this.current().split('?')[0].split('/').filter(Boolean);
    const resource = this.pageContext.resource();
    const query = this.router.parseUrl(this.current()).queryParamMap;
    const parent = parts[0] === 'admin' ? '/admin/users' : '/' + parts[0];
    const back = query.get('back');
    const source = internalReturnPath(query.get('return'));
    const urlFor = (url: string) => {
      if (source && source.split('?')[0] === url) return this.router.parseUrl(source);
      return this.router.parseUrl(url === parent && back ? url + '?' + back : url);
    };
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
      result: 'Результат',
      manual: 'Ручное управление',
      login: 'Вход на сайт',
    };
    if (parts[0] === 'connections' && parts[2] === 'login') {
      return [
        { label: 'Подключения', url: urlFor('/connections') },
        {
          label:
            resource?.kind === 'connections' && resource.id === parts[1]
              ? resource.label
              : 'Подключение',
          url: urlFor('/connections/' + parts[1]),
        },
        { label: 'Браузер', url: this.router.parseUrl(this.current().split('?')[0]) },
      ];
    }
    return parts.map((part, index) => ({
      label:
        (resource?.id === part && parts[index - 1] === resource.kind ? resource.label : null) ??
        labels[part] ??
        (parts[0] === 'tasks'
          ? 'Задача'
          : parts[0] === 'connections'
            ? 'Подключение'
            : 'Пользователь'),
      url: urlFor('/' + parts.slice(0, index + 1).join('/')),
    }));
  });
  private generation = 0;
  private readonly bell = viewChild<ElementRef<HTMLButtonElement>>('bell');
  private readonly profileButton = viewChild<ElementRef<HTMLButtonElement>>('profileButton');
  private readonly profileLink = viewChild<ElementRef<HTMLAnchorElement>>('profileLink');
  private readonly popover = viewChild<ElementRef<HTMLElement>>('popover');
  private readonly overlay = viewChild<CdkConnectedOverlay>('topbarOverlay');
  private readonly notificationHeading = viewChild<ElementRef<HTMLElement>>('notificationHeading');
  private readonly main = viewChild<ElementRef<HTMLElement>>('main');
  constructor() {
    afterRenderEffect(() => {
      const target = this.notificationsOpen() ? this.notificationHeading() : this.profileLink();
      if (this.popup()) target?.nativeElement.focus();
    });
    afterRenderEffect(() => {
      this.notifications();
      this.notificationError();
      this.popupMaxWidth();
      this.repositionPopup();
    });
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
      this.popup.set(null);
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
      const navigated = await this.router.navigate(['/tasks', item.taskId]);
      if (navigated || this.router.url.split('?')[0] === '/tasks/' + item.taskId) {
        this.popup.set(null);
        this.main()?.nativeElement.focus();
      }
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
  togglePopup(kind: 'notifications' | 'profile') {
    if (this.popup() === kind) this.closePopup();
    else this.popup.set(kind);
  }
  closePopup() {
    const trigger = this.notificationsOpen() ? this.bell() : this.profileButton();
    this.popup.set(null);
    trigger?.nativeElement.focus();
  }
  outsidePopup(event: MouseEvent) {
    const target = event.target;
    if (
      !(target instanceof Node) ||
      this.bell()?.nativeElement.contains(target) ||
      this.profileButton()?.nativeElement.contains(target)
    )
      return;
    this.popup.set(null);
  }
  popupKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closePopup();
    }
  }
  positionPopup(event: ConnectedOverlayPositionChange) {
    this.popupAbove.set(event.connectionPair.overlayY === 'bottom');
    this.positionArrow();
  }
  repositionPopup() {
    if (this.popup() && this.popover()) {
      this.popupMaxWidth.set(document.documentElement.clientWidth - 24);
      this.overlay()?.overlayRef.updatePosition();
      this.positionArrow();
    }
  }
  private positionArrow() {
    const trigger = this.notificationsOpen() ? this.bell() : this.profileButton();
    const anchor = trigger?.nativeElement.getBoundingClientRect();
    const panel = this.popover()?.nativeElement.getBoundingClientRect();
    if (anchor && panel)
      this.popupAnchorX.set(
        Math.max(17, Math.min(panel.width - 17, anchor.left + anchor.width / 2 - panel.left)),
      );
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
