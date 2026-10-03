import { CanDeactivateFn, Routes } from '@angular/router';
import { authenticated, administrator } from './core/identity/identity.service';
const unsavedTask: CanDeactivateFn<{ canLeave(): boolean }> = (component) => component.canLeave();

export const routes: Routes = [
  {
    path: 'sign-in',
    loadComponent: () => import('./features/system/system').then((m) => m.SignIn),
  },
  {
    path: '',
    canActivate: [authenticated],
    loadComponent: () => import('./core/navigation/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'tasks' },
      {
        path: 'tasks',
        loadComponent: () => import('./features/tasks/task-list').then((m) => m.TaskList),
      },
      {
        path: 'tasks/new',
        loadComponent: () => import('./features/tasks/task-editor').then((m) => m.TaskEditor),
        canDeactivate: [unsavedTask],
      },
      {
        path: 'tasks/:id/edit',
        loadComponent: () => import('./features/tasks/task-editor').then((m) => m.TaskEditor),
        canDeactivate: [unsavedTask],
      },
      {
        path: 'tasks/:id/result',
        loadComponent: () => import('./features/tasks/task-detail').then((m) => m.TaskDetail),
        data: { result: true },
      },
      { path: 'tasks/:id/overview', redirectTo: 'tasks/:id' },
      {
        path: 'tasks/:id',
        loadComponent: () => import('./features/tasks/task-detail').then((m) => m.TaskDetail),
      },
      {
        path: 'connections',
        loadComponent: () =>
          import('./features/connections/connections').then((m) => m.Connections),
      },
      {
        path: 'connections/guide',
        loadComponent: () => import('./features/connections/mcp-guide').then((m) => m.McpGuide),
      },
      {
        path: 'connections/:id',
        loadComponent: () =>
          import('./features/connections/connections').then((m) => m.ConnectionDetail),
      },
      {
        path: 'login-operations/:id',
        loadComponent: () =>
          import('./features/manual-login/manual-login').then((m) => m.ManualLogin),
      },
      { path: 'usage', loadComponent: () => import('./features/usage/usage').then((m) => m.Usage) },
      {
        path: 'profile',
        loadComponent: () => import('./features/profile/profile').then((m) => m.Profile),
        canDeactivate: [unsavedTask],
      },
      {
        path: 'admin',
        canActivate: [administrator],
        loadComponent: () => import('./features/administration/admin').then((m) => m.AdminShell),
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./features/administration/admin').then((m) => m.AdminOverview),
          },
          {
            path: 'users',
            loadComponent: () =>
              import('./features/administration/admin').then((m) => m.AdminUsers),
          },
          {
            path: 'users/:id/audit',
            loadComponent: () =>
              import('./features/administration/admin').then((m) => m.AdminAudit),
          },
          {
            path: 'users/:id',
            loadComponent: () => import('./features/administration/admin').then((m) => m.AdminUser),
          },
          {
            path: 'browsers',
            loadComponent: () =>
              import('./features/administration/admin').then((m) => m.AdminBrowsers),
          },
          {
            path: 'audit',
            loadComponent: () =>
              import('./features/administration/admin').then((m) => m.AdminAudit),
          },
        ],
      },
      {
        path: 'forbidden',
        loadComponent: () => import('./features/system/system').then((m) => m.SystemPage),
        data: { forbidden: true },
      },
      {
        path: '**',
        loadComponent: () => import('./features/system/system').then((m) => m.SystemPage),
      },
    ],
  },
];
