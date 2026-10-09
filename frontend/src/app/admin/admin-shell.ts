import { Icon } from '../shared/icon';
import { Component, ViewEncapsulation, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { pageReturnLabel, pageReturnUrl } from '../core/page-context';
import { Tooltip } from '../shared/tooltip';
import { UserDetail } from './user-detail';
@Component({
  selector: 'hg-admin',
  imports: [Icon, RouterLink, RouterOutlet, Tooltip],
  host: { class: 'admin-v14' },
  encapsulation: ViewEncapsulation.None,
  styleUrl: './admin.css',
  template: ` @if (detail(); as user) {
      <button class="back-link" [hgTooltip]="user.backLabel()" (click)="user.back()">
        <hg-icon name="arrow-left" />{{ user.backLabel() }}
      </button>
    } @else if (standalone()) {
      <button class="back-link" (click)="back()">
        <hg-icon name="arrow-left" />{{ backLabel() }}
      </button>
    }
    <nav class="tabs" aria-label="Администрирование">
      <a
        routerLink="/admin"
        [class.active]="!nodes()"
        [attr.aria-current]="!nodes() ? 'page' : null"
        ><hg-icon name="user" />Пользователи и журнал</a
      ><a
        routerLink="/admin/nodes"
        [class.active]="nodes()"
        [attr.aria-current]="nodes() ? 'page' : null"
        ><hg-icon name="browser" />Браузеры</a
      >
    </nav>
    <router-outlet (activate)="activated($event)" (deactivate)="detail.set(null)" />`,
})
export class AdminShell {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  readonly nodes = computed(() => this.url().split('?')[0] === '/admin/nodes');
  readonly standalone = computed(() =>
    ['/admin/users', '/admin/audit'].includes(this.url().split('?')[0]),
  );
  readonly detail = signal<UserDetail | null>(null);
  activated(page: unknown) {
    this.detail.set(page instanceof UserDetail ? page : null);
  }
  back() {
    void this.router.navigateByUrl(pageReturnUrl(this.route, this.router, '/admin'));
  }
  backLabel() {
    return pageReturnLabel(
      this.router.serializeUrl(pageReturnUrl(this.route, this.router, '/admin')),
    );
  }
}
