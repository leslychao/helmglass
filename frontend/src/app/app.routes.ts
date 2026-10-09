import { CanDeactivateFn, Routes } from '@angular/router';
import { authenticated, administrator, preserveForm } from './core/session';
import type { Manual } from './connections/manual';
import type { TaskDetail } from './tasks/task-detail';

const leaveBrowser: CanDeactivateFn<Manual | TaskDetail> =
  (page, _route, _state, nextState) => page.canLeave(nextState.url);

export const routes: Routes = [
  {
    path: 'sign-in',
    loadComponent: () => import('./core/account').then((module) => module.SignIn),
  },
  {
    path: 'unavailable',
    loadComponent: () => import('./core/account').then((module) => module.Unavailable),
  },
  {
    path: 'sign-in-error',
    data: { signInError: true },
    loadComponent: () => import('./core/account').then((module) => module.Unavailable),
  },
  {
    path: 'denied',
    data: { denied: true },
    loadComponent: () => import('./core/account').then((module) => module.Unavailable),
  },
  {
    path: '',
    canActivate: [authenticated],
    loadComponent: () => import('./core/shell').then((module) => module.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'tasks' },
      {
        path: 'tasks',
        loadComponent: () => import('./tasks/task-list').then((module) => module.TaskList),
      },
      {
        path: 'tasks/new',
        canDeactivate: [preserveForm],
        loadComponent: () => import('./tasks/task-form').then((module) => module.TaskForm),
      },
      {
        path: 'tasks/:id/edit',
        canDeactivate: [preserveForm],
        loadComponent: () => import('./tasks/task-form').then((module) => module.TaskForm),
      },
      {
        path: 'tasks/:id/result',
        canDeactivate: [leaveBrowser],
        data: { tab: 'result' },
        loadComponent: () => import('./tasks/task-detail').then((module) => module.TaskDetail),
      },
      {
        path: 'tasks/:id/manual',
        canDeactivate: [leaveBrowser],
        loadComponent: () => import('./tasks/task-detail').then((module) => module.TaskDetail),
      },
      {
        path: 'tasks/:id',
        canDeactivate: [leaveBrowser],
        loadComponent: () => import('./tasks/task-detail').then((module) => module.TaskDetail),
      },
      {
        path: 'connections',
        loadComponent: () =>
          import('./connections/connections').then((module) => module.Connections),
      },
      {
        path: 'connections/:id',
        loadComponent: () => import('./connections/connection-detail').then((module) => module.ConnectionDetail),
      },
      {
        path: 'connections/:id/login',
        canDeactivate: [leaveBrowser],
        loadComponent: () => import('./connections/manual').then((module) => module.Manual),
      },
      {
        path: 'usage',
        loadComponent: () => import('./usage/usage').then((module) => module.Usage),
      },
      {
        path: 'profile',
        canDeactivate: [preserveForm],
        loadComponent: () => import('./core/profile').then((module) => module.Profile),
      },
      {
        path: 'admin',
        canActivate: [administrator],
        loadComponent: () => import('./admin/admin-shell').then((module) => module.AdminShell),
        children: [
          { path: '', pathMatch: 'full', loadComponent: () => import('./admin/users').then(module => module.AdminUsers) },
          {
            path: 'users',
            loadComponent: () => import('./admin/users').then((module) => module.AdminUsers),
          },
          {
            path: 'users/:id',
            loadComponent: () => import('./admin/user-detail').then((module) => module.UserDetail),
          },
          {
            path: 'nodes',
            loadComponent: () => import('./admin/nodes').then((module) => module.Nodes),
          },
          {
            path: 'audit',
            loadComponent: () => import('./admin/audit').then(module => module.Audit),
          },
        ],
      },
    ],
  },
  {
    path: '**',
    loadComponent: () => import('./core/account').then((module) => module.Unavailable),
  },
];
