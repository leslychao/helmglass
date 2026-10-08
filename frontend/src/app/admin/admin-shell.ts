import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
@Component({
  selector: 'hg-admin',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `<header class="page-heading">
      <div>
        <h1>Администрирование</h1>
        <p>Доступ пользователей, браузеры и журнал действий.</p>
      </div>
    </header>
    <nav class="tabs" aria-label="Администрирование">
      <a routerLink="/admin/users" routerLinkActive="active" ariaCurrentWhenActive="page"
        >Пользователи</a
      ><a routerLink="/admin/nodes" routerLinkActive="active" ariaCurrentWhenActive="page"
        >Браузеры</a
      ><a routerLink="/admin/audit" routerLinkActive="active" ariaCurrentWhenActive="page">Аудит</a>
    </nav>
    <router-outlet />`,
})
export class AdminShell {}
