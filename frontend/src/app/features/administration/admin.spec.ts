import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { NEVER, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { AdminOverview as OverviewDto, AuditEntry, BrowserPool } from '../../core/api/models';
import { Realtime } from '../../core/realtime/realtime.service';
import { AdminAudit, AdminBrowsers, AdminOverview, AdminShell, AdminUsers } from './admin';
import { auditRows } from './admin-tables';

const overview: OverviewDto = {
  version: 4,
  acceptingAllocations: true,
  standardBrowserLimit: 2,
  confirmedBusy: 2,
  unconfirmedOccupied: 1,
  waitingTasks: 3,
  queuedForBrowser: 1,
  unavailableWorkers: 1,
  pendingOperations: 1,
  blockedUsers: 1,
  totalUsers: 4,
  physicalFree: 2,
  allocatableFree: 1,
  observedAt: '2026-10-03T13:00:00Z',
  completeness: 'COMPLETE',
};

describe('administration design and table ownership', () => {
  const read = vi.fn((_path: string, _query?: unknown) => NEVER);
  let refresh: Subject<Set<'users'> | null>;
  beforeEach(() => {
    read.mockClear();
    refresh = new Subject();
    TestBed.configureTestingModule({
      providers: [
        { provide: Api, useValue: { get: read } },
        { provide: Realtime, useValue: { refresh } },
        provideRouter([
          {
            path: 'admin',
            component: AdminShell,
            children: [
              { path: '', component: AdminOverview },
              { path: 'browsers', component: AdminBrowsers },
              { path: 'users', component: AdminUsers },
              { path: 'audit', component: AdminAudit },
            ],
          },
        ]),
      ],
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('composes users and audit once and reserves admission for the browsers tab', async () => {
    const harness = await RouterTestingHarness.create('/admin');
    const page = harness.fixture.debugElement
      .query(By.directive(AdminOverview))
      .injector.get(AdminOverview);
    page.overview.data.set(overview);
    harness.detectChanges();
    const element: HTMLElement = harness.fixture.nativeElement;
    expect(
      [...element.querySelectorAll('.a-admin-tab')].map((link) => link.textContent?.trim()),
    ).toEqual(['Пользователи и журнал', 'Браузеры']);
    expect(element.textContent).toContain('Без удалённых аккаунтов');
    expect(element.textContent).not.toContain('Приостановить новые запуски');
    expect(read.mock.calls.filter(([path]) => path === '/admin/users')).toHaveLength(1);
    expect(read.mock.calls.filter(([path]) => path === '/admin/audit')).toHaveLength(1);
    await harness.navigateByUrl('/admin/browsers');
    const browsers = harness.fixture.debugElement
      .query(By.directive(AdminBrowsers))
      .injector.get(AdminBrowsers);
    browsers.overview.data.set(overview);
    harness.detectChanges();
    expect(element.textContent).toContain('Приостановить новые запуски');
    expect(element.textContent).toContain('Доступно для запуска');
    expect(element.querySelector('.a-admin-tab.active')?.textContent).toContain('Браузеры');
  });

  it('keeps applied user and audit filters independent and preserves drafts during push', async () => {
    const harness = await RouterTestingHarness.create(
      '/admin?users.q=anna&audit.action=LIMITS_CHANGED',
    );
    const users = harness.fixture.debugElement
      .query(By.directive(AdminUsers))
      .injector.get(AdminUsers);
    const audit = harness.fixture.debugElement
      .query(By.directive(AdminAudit))
      .injector.get(AdminAudit);
    const router = TestBed.inject(Router);
    users.openFilters();
    users.draftQuery = 'Unsaved';
    refresh.next(new Set(['users']));
    harness.detectChanges();
    expect(users.draftQuery).toBe('Unsaved');
    users.filtersOpen.set(false);
    expect(users.query.text('q')).toBe('anna');
    users.openFilters();
    users.draftQuery = 'Olga';
    users.draftStates = ['ACTIVE', 'BLOCKED'];
    users.draftWaiting = true;
    users.applyFilters();
    await harness.fixture.whenStable();
    expect(router.url).toContain('users.q=Olga');
    expect(router.url).toContain('users.waiting=true');
    expect(router.url).toContain('audit.action=LIMITS_CHANGED');
    expect(audit.query.text('action')).toBe('LIMITS_CHANGED');
    audit.query.clear();
    await harness.fixture.whenStable();
    expect(router.url).toContain('users.q=Olga');
    expect(router.url).not.toContain('audit.action');
  });

  it('sends exact admission and node versions and keeps three pool table queries independent', async () => {
    const harness = await RouterTestingHarness.create(
      '/admin/browsers?workers.state=OFFLINE&allocations.page=2&queue.sort=createdAt&queue.direction=desc',
    );
    const page = harness.fixture.debugElement
      .query(By.directive(AdminBrowsers))
      .injector.get(AdminBrowsers);
    const emptyPage = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      snapshot: 'fixture',
      sort: null,
    };
    const pool: BrowserPool = {
      workers: {
        ...emptyPage,
        total: 1,
        items: [
          {
            id: 'worker-id',
            bootId: 'boot-id',
            capacity: 1,
            version: 7,
            desiredMode: 'DRAINING',
            observedState: 'READY',
            imageVersion: 'fixture',
            heartbeatAt: overview.observedAt,
            state: 'OFFLINE',
            occupied: null,
            lastKnownOccupied: 1,
            free: null,
          },
        ],
      },
      allocations: emptyPage,
      queue: emptyPage,
    };
    page.overview.data.set(overview);
    page.pool.data.set(pool);
    harness.detectChanges();
    expect(page.workerRows()[0].values['occupied']).toBe('Неизвестно');
    expect(page.workerRows()[0].metadata?.['occupied']).toContain('1');
    expect(page.onlyOffline()).toBe(true);
    expect(read).toHaveBeenCalledWith(
      '/admin/browsers',
      expect.objectContaining({
        'workers.state': 'OFFLINE',
        'allocations.page': 2,
        'queue.sort': 'createdAt',
        'queue.direction': 'desc',
      }),
    );
    const write = vi.spyOn(page.action, 'run').mockImplementation(() => undefined);
    page.changeAdmission();
    page.reason = 'Maintenance';
    page.apply();
    expect(write).toHaveBeenLastCalledWith(
      'PATCH',
      '/admin/platform/admission',
      {
        acceptingAllocations: false,
        expectedVersion: 4,
        reason: 'Maintenance',
      },
      expect.any(Function),
    );
    page.changeWorker('worker-id');
    page.reason = 'Return node';
    page.apply();
    expect(write).toHaveBeenLastCalledWith(
      'POST',
      '/admin/workers/worker-id/enable',
      {
        expectedVersion: 7,
        reason: 'Return node',
      },
      expect.any(Function),
    );
    page.toggleOffline();
    await harness.fixture.whenStable();
    expect(page.onlyOffline()).toBe(false);
    expect(TestBed.inject(Router).url).toContain('allocations.page=2');
    expect(TestBed.inject(Router).url).toContain('queue.sort=createdAt');
  });

  it('renders canonical audit changes in Russian with a distinct reason column', () => {
    const entry: AuditEntry = {
      id: 'audit',
      actorId: 'actor',
      actorName: 'Администратор',
      targetId: 'target',
      targetName: 'Анна',
      targetType: 'user',
      action: 'LIMITS_CHANGED',
      reason: 'Согласовано',
      operationId: 'operation',
      operationState: 'SUCCEEDED',
      occurredAt: overview.observedAt,
      previousValue: { browserMode: 'STANDARD' },
      newValue: { browserMode: 'CUSTOM', browserCustom: 3 },
    };
    const row = auditRows([entry])[0];
    expect(row.values['action']).toBe('Изменение квот');
    expect(row.values['target']).toBe('Анна');
    expect(row.values['reason']).toBe('Согласовано');
    expect(row.metadata?.['action']).toBe(
      'Браузеры: стандартный лимит → Браузеры: 3\nОперация: Выполнено',
    );
  });
});
