import { Routes } from '@angular/router';
import { authenticated, administrator, preserveForm } from './core/session';

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
        path: 'tasks/:id/refine',
        data: { mode: 'refine' },
        canDeactivate: [preserveForm],
        loadComponent: () => import('./tasks/task-form').then((module) => module.TaskForm),
      },
      {
        path: 'tasks/:id/similar',
        data: { mode: 'similar' },
        canDeactivate: [preserveForm],
        loadComponent: () => import('./tasks/task-form').then((module) => module.TaskForm),
      },
      {
        path: 'tasks/:id/result',
        data: { tab: 'result' },
        loadComponent: () => import('./tasks/task-detail').then((module) => module.TaskDetail),
      },
      {
        path: 'tasks/:id/manual',
        loadComponent: () => import('./tasks/task-detail').then((module) => module.TaskDetail),
      },
      {
        path: 'tasks/:id',
        loadComponent: () => import('./tasks/task-detail').then((module) => module.TaskDetail),
      },
      {
        path: 'connections',
        loadComponent: () =>
          import('./connections/connections').then((module) => module.Connections),
      },
      {
        path: 'connections/:id/login',
        loadComponent: () => import('./connections/manual').then((module) => module.Manual),
      },
      {
        path: 'usage',
        loadComponent: () => import('./usage/usage').then((module) => module.Usage),
      },
      {
        path: 'profile',
        loadComponent: () => import('./core/account').then((module) => module.Profile),
      },
      {
        path: 'admin',
        canActivate: [administrator],
        loadComponent: () => import('./admin/admin-shell').then((module) => module.AdminShell),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'users' },
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
            loadComponent: () => import('./admin/audit').then((module) => module.Audit),
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
