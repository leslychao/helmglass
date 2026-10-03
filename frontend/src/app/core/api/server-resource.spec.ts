import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { effect, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Realtime } from '../realtime/realtime.service';
import { Page, TaskListItem, UsageMetric } from './models';
import { ServerResource } from './server-resource';
import { Api } from './api.service';

describe('visible server resources', () => {
  let http: HttpTestingController;
  let refresh: Subject<ReadonlySet<string> | null>;
  let resource: ServerResource<Page<TaskListItem>>;
  const unknownMetric: UsageMetric = {
    value: null,
    knownValue: null,
    completeness: 'UNKNOWN',
    measuredCount: 0,
    expectedCount: 1,
  };
  const item: TaskListItem = {
    id: '11111111-1111-4111-8111-111111111111',
    displayNumber: 1,
    version: 1,
    instructionRevision: 1,
    goal: 'Inspect public page',
    title: 'Inspect public page',
    startUrl: 'https://example.com',
    outputFormat: 'TEXT',
    state: 'RUNNING',
    outcome: null,
    origin: 'ANGULAR',
    waitReason: null,
    failureCode: null,
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
    confirmImportantActions: false,
    browserTimeLimitSeconds: 1800,
    site: 'example.com',
    reason: null,
    currentStep: 'Inspecting page',
    summary: null,
    usage: {
      browserSeconds: null,
      humanSeconds: null,
      humanControlSeconds: null,
      executionSeconds: null,
      activeSeconds: null,
      mediaSeconds: null,
      mediaBytes: null,
      commandCount: null,
      completeness: 'UNKNOWN',
      metrics: {
        browser_seconds: unknownMetric,
        execution_seconds: unknownMetric,
        active_agent_seconds: unknownMetric,
        human_login_seconds: unknownMetric,
        human_control_seconds: unknownMetric,
        media_seconds: unknownMetric,
        media_bytes: unknownMetric,
        audio_analyzed_seconds: unknownMetric,
        command_count: unknownMetric,
      },
    },
  };
  const page = (number = 1, total = 25, snapshot = 'revision-1'): Page<TaskListItem> => ({
    items: total ? [item] : [],
    page: number,
    pageSize: 10,
    total,
    sort: null,
    snapshot,
  });

  beforeEach(() => {
    refresh = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Realtime, useValue: { refresh } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    resource = TestBed.runInInjectionContext(() => new ServerResource(['tasks']));
  });
  afterEach(() => http.verify());

  it('loads only when the route query changes, not when its response arrives', async () => {
    const query = signal('first');
    const load = TestBed.runInInjectionContext(() =>
      effect(() => resource.load('/tasks', { q: query() })),
    );
    TestBed.tick();
    http.expectOne('/api/v1/tasks?q=first').flush(page());
    await vi.waitFor(() => expect(resource.data()?.total).toBe(25));
    TestBed.tick();
    http.expectNone((request) => request.url === '/api/v1/tasks');
    query.set('second');
    TestBed.tick();
    http.expectOne('/api/v1/tasks?q=second').flush(page(1, 0));
    await vi.waitFor(() => expect(resource.data()?.total).toBe(0));
    load.destroy();
  });

  it('coalesces invalidations during a read and reads again after it completes', async () => {
    resource.load('/tasks', { page: 1, pageSize: 10 });
    const first = http.expectOne('/api/v1/tasks?page=1&pageSize=10');
    refresh.next(new Set(['tasks']));
    refresh.next(new Set(['tasks']));
    http.expectNone('/api/v1/tasks?page=1&pageSize=10');
    first.flush(page());
    await vi.waitFor(() => expect(resource.data()?.total).toBe(25));
    const next = http.expectOne('/api/v1/tasks?page=1&pageSize=10');
    next.flush(page(1, 26, 'revision-2'));
    await vi.waitFor(() => expect(resource.data()?.total).toBe(26));
    expect(resource.loading()).toBe(false);
  });

  it('cancels a previous route request and never restores its data', async () => {
    resource.load('/tasks', { q: 'old' });
    const old = http.expectOne('/api/v1/tasks?q=old');
    resource.load('/tasks', { q: 'new' });
    expect(old.cancelled).toBe(true);
    http.expectOne('/api/v1/tasks?q=new').flush(page(1, 0));
    await vi.waitFor(() => expect(resource.data()?.total).toBe(0));
  });

  it('reuses a list snapshot for pagination, then refreshes and corrects a shrinking list', async () => {
    resource.load('/tasks', { page: 1, pageSize: 10, q: 'helm' });
    http.expectOne('/api/v1/tasks?page=1&pageSize=10&q=helm').flush(page());
    await vi.waitFor(() => expect(resource.data()?.total).toBe(25));
    resource.load('/tasks', { page: 3, pageSize: 10, q: 'helm' });
    http
      .expectOne('/api/v1/tasks?page=3&pageSize=10&q=helm&snapshot=revision-1')
      .flush(
        { title: 'Expired', code: 'LIST_SNAPSHOT_EXPIRED' },
        { status: 409, statusText: 'Conflict' },
      );
    http.expectOne('/api/v1/tasks?page=3&pageSize=10&q=helm').flush(page(3, 12, 'revision-2'));
    const clamped = await vi.waitFor(() =>
      http.expectOne('/api/v1/tasks?page=2&pageSize=10&q=helm&snapshot=revision-2'),
    );
    clamped.flush(page(2, 12, 'revision-2'));
    await vi.waitFor(() => expect(resource.data()?.page).toBe(2));
    expect(resource.data()?.total).toBe(12);
  });

  it('shows read errors without converting them into a successful empty list', async () => {
    resource.load('/tasks');
    http.expectOne('/api/v1/tasks').flush(page());
    await vi.waitFor(() => expect(resource.data()?.total).toBe(25));
    resource.refresh();
    http.expectOne('/api/v1/tasks').error(new ProgressEvent('error'));
    expect(resource.error()?.code).toBe('NETWORK_ERROR');
    expect(resource.data()?.total).toBe(25);
  });
});

describe('nested paginated resources', () => {
  it('keeps the selected nested snapshot and corrects the selected page after shrink', () => {
    interface Nested {
      measurements: Page<string>;
    }
    const get = vi.fn(() => new Subject<Nested>());
    TestBed.configureTestingModule({
      providers: [
        { provide: Api, useValue: { get } },
        { provide: Realtime, useValue: { refresh: new Subject() } },
      ],
    });
    const resource = TestBed.runInInjectionContext(
      () => new ServerResource<Nested>(['usage'], (value) => value.measurements),
    );
    const data = (page: number, total: number): Nested => ({
      measurements: {
        items: [],
        page,
        pageSize: 10,
        total,
        sort: null,
        snapshot: 'nested-version',
      },
    });
    resource.load('/tasks/task/usage', { page: 1, pageSize: 10 });
    get.mock.results[0].value.next(data(1, 25));
    resource.load('/tasks/task/usage', { page: 3, pageSize: 10 });
    expect(get).toHaveBeenLastCalledWith('/tasks/task/usage', {
      page: 3,
      pageSize: 10,
      snapshot: 'nested-version',
    });
    get.mock.results[1].value.next(data(3, 12));
    expect(get).toHaveBeenLastCalledWith('/tasks/task/usage', {
      page: 2,
      pageSize: 10,
      snapshot: 'nested-version',
    });
    get.mock.results[2].value.next(data(2, 12));
    expect(resource.data()?.measurements.page).toBe(2);
  });
});
