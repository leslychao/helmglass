import { Icon } from '../shared/icon';
import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
@Component({
  selector: 'hg-admin',
  imports: [Icon, RouterLink, RouterLinkActive, RouterOutlet],
  template: `<h1 class="sr-only">Администрирование</h1>
    <nav class="tabs" aria-label="Администрирование">
      <a routerLink="/admin/users" routerLinkActive="active" ariaCurrentWhenActive="page"
        ><hg-icon name="user" />Пользователи и журнал</a
      ><a routerLink="/admin/nodes" routerLinkActive="active" ariaCurrentWhenActive="page"
        ><hg-icon name="browser" />Браузеры</a
      >
    </nav>
    <router-outlet />`,
})
export class AdminShell {}
