import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { NEVER, Observable, Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Query, TaskEventPage } from '../../core/api/models';
import { Realtime } from '../../core/realtime/realtime.service';
import { BrowserPanel } from './browser-panel';

const page = (number = 1, snapshot = 'snapshot-101'): TaskEventPage => ({
  items: [
    {
      id: 'event-1',
      sequence: 101,
      type: 'BROWSER',
      code: 'CLOSED',
      summary: 'Браузер закрыт',
      occurredAt: '2026-10-03T12:00:00Z',
    },
  ],
  page: number,
  pageSize: 10,
  total: 31,
  sort: { field: 'sequence', direction: 'desc' },
  snapshot,
  meta: { snapshotSequence: 101 },
});

function setup(
  read: (query: Query) => Observable<TaskEventPage> = (query) => of(page(Number(query['page']))),
  render = false,
) {
  const refresh = new Subject<ReadonlySet<string> | null>();
  const history = vi.fn(read);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: Api,
        useValue: {
          get: (path: string, query: Query) => (path.endsWith('/events') ? history(query) : NEVER),
        },
      },
      { provide: Realtime, useValue: { refresh, browserClocks: new Subject() } },
    ],
  });
  if (!render) TestBed.overrideComponent(BrowserPanel, { set: { template: '', imports: [] } });
  else
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  const fixture = TestBed.createComponent(BrowserPanel);
  if (!render) fixture.componentRef.setInput('sessionId', 'session-1');
  fixture.componentRef.setInput('taskId', 'task-1');
  fixture.detectChanges();
  return { fixture, panel: fixture.componentInstance, history, refresh };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});

describe('append-only execution history', () => {
  it('keeps the same snapshot and page when append notifications arrive', () => {
    const { fixture, panel, history, refresh } = setup();
    expect(history).not.toHaveBeenCalled();
    panel.historyOpen.set(true);
    fixture.detectChanges();
    panel.eventPage({ page: 2 });
    expect(history.mock.lastCall?.[0]).toMatchObject({ page: 2, snapshot: 'snapshot-101' });
    refresh.next(new Set(['events']));
    refresh.next(new Set(['events']));
    expect(history).toHaveBeenCalledTimes(2);
    expect(panel.events.data()?.page).toBe(2);
    expect(panel.events.data()?.snapshot).toBe('snapshot-101');
    expect(panel.events.invalidated()).toBe(true);
    panel.refreshEvents();
    expect(history.mock.lastCall?.[0]).toMatchObject({ page: 1, snapshot: undefined });
    expect(panel.events.invalidated()).toBe(false);
  });

  it('cancels hidden drawer reads and never reads hidden pages on push', () => {
    const cancelled = vi.fn();
    const { fixture, panel, history, refresh } = setup(() => new Observable(() => cancelled));
    panel.historyOpen.set(true);
    fixture.detectChanges();
    panel.historyOpen.set(false);
    fixture.detectChanges();
    expect(cancelled).toHaveBeenCalledOnce();
    refresh.next(new Set(['events']));
    refresh.next(null);
    expect(history).toHaveBeenCalledOnce();
  });

  it('only marks this task as changed, and fetches a fresh page-one snapshot on reconnect', () => {
    const { fixture, panel, history, refresh } = setup();
    panel.historyOpen.set(true);
    fixture.detectChanges();
    refresh.next(Object.assign(new Set(['events']), { resourceId: 'task-2' }));
    expect(panel.events.invalidated()).toBe(false);
    refresh.next(Object.assign(new Set(['events']), { resourceId: 'task-1' }));
    expect(panel.events.invalidated()).toBe(true);
    panel.eventPage({ page: 2 });
    refresh.next(null);
    expect(panel.events.invalidated()).toBe(false);
    expect(history).toHaveBeenCalledTimes(3);
    expect(history.mock.lastCall?.[0]).toMatchObject({ page: 1, snapshot: undefined });
    expect(panel.events.data()?.page).toBe(1);
  });

  it('defers reconnect resynchronization until the hidden drawer is opened', () => {
    const { fixture, panel, history, refresh } = setup();
    panel.historyOpen.set(true);
    fixture.detectChanges();
    panel.toggleEventType('AGENT');
    panel.eventPage({ page: 2 });
    panel.historyOpen.set(false);
    fixture.detectChanges();
    refresh.next(null);
    refresh.next(null);
    expect(history).toHaveBeenCalledTimes(3);
    panel.historyOpen.set(true);
    fixture.detectChanges();
    expect(history).toHaveBeenCalledTimes(4);
    expect(history.mock.lastCall?.[0]).toMatchObject({
      page: 1,
      type: ['AGENT'],
      snapshot: undefined,
    });
    expect(panel.events.invalidated()).toBe(false);
  });

  it('cancels the pre-reconnect read and ignores its late snapshot', () => {
    const replies: Subject<TaskEventPage>[] = [];
    const cancelled = vi.fn();
    const { fixture, panel, history, refresh } = setup(
      () =>
        new Observable((subscriber) => {
          const reply = new Subject<TaskEventPage>();
          replies.push(reply);
          const subscription = reply.subscribe(subscriber);
          return () => {
            subscription.unsubscribe();
            cancelled();
          };
        }),
    );
    panel.historyOpen.set(true);
    fixture.detectChanges();
    refresh.next(null);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledTimes(2);
    replies[1].next(page(1, 'after-reconnect'));
    replies[0].next(page(1, 'before-reconnect'));
    expect(panel.events.data()?.snapshot).toBe('after-reconnect');
  });

  it('recovers an expired page-two snapshot at page one without a token', () => {
    const { fixture, panel, history } = setup((query) =>
      query['page'] === 2
        ? throwError(
            () => new HttpErrorResponse({ status: 409, error: { code: 'LIST_SNAPSHOT_EXPIRED' } }),
          )
        : of(page(1)),
    );
    panel.historyOpen.set(true);
    fixture.detectChanges();
    panel.eventPage({ page: 2 });
    expect(
      history.mock.calls.map(([query]) => ({ page: query['page'], snapshot: query['snapshot'] })),
    ).toEqual([
      { page: 1, snapshot: undefined },
      { page: 2, snapshot: 'snapshot-101' },
      { page: 1, snapshot: undefined },
    ]);
    expect(panel.events.data()?.page).toBe(1);
    expect(panel.events.error()).toBeNull();
  });
  it('retains page, filters and snapshot across drawer close, then resets for another task', () => {
    const { fixture, panel, history, refresh } = setup();
    panel.historyOpen.set(true);
    fixture.detectChanges();
    panel.toggleEventType('AGENT');
    panel.eventQuery = '  команда  ';
    panel.searchEvents();
    panel.eventPage({ page: 3 });
    panel.historyOpen.set(false);
    fixture.detectChanges();
    const count = history.mock.calls.length;
    refresh.next(new Set(['events']));
    expect(history).toHaveBeenCalledTimes(count);
    panel.historyOpen.set(true);
    fixture.detectChanges();
    expect(history.mock.lastCall?.[0]).toMatchObject({
      page: 3,
      q: 'команда',
      type: ['AGENT'],
      snapshot: 'snapshot-101',
    });
    expect(panel.events.invalidated()).toBe(true);
    fixture.componentRef.setInput('taskId', 'task-2');
    fixture.detectChanges();
    expect(history.mock.lastCall?.[0]).toMatchObject({
      page: 1,
      q: '',
      type: [],
      snapshot: undefined,
    });
    expect(panel.events.invalidated()).toBe(false);
  });

  it('cancels an obsolete filter read and preserves pending append information', () => {
    const replies: Subject<TaskEventPage>[] = [];
    const cancelled = vi.fn();
    const { fixture, panel, refresh } = setup(
      () =>
        new Observable((subscriber) => {
          const reply = new Subject<TaskEventPage>();
          replies.push(reply);
          const sub = reply.subscribe(subscriber);
          return () => {
            sub.unsubscribe();
            cancelled();
          };
        }),
    );
    panel.historyOpen.set(true);
    fixture.detectChanges();
    panel.toggleEventType('SYSTEM');
    expect(cancelled).toHaveBeenCalledOnce();
    replies[0].next(page(1, 'obsolete'));
    refresh.next(new Set(['events']));
    replies[1].next(page(1, 'current'));
    expect(panel.events.data()?.snapshot).toBe('current');
    expect(panel.events.invalidated()).toBe(true);
    expect(replies).toHaveLength(2);
  });

  it('does not submit a draft search during pagination, and starts a new snapshot for changed filters', () => {
    const { fixture, panel, history } = setup();
    panel.historyOpen.set(true);
    fixture.detectChanges();
    panel.eventQuery = 'unsubmitted';
    panel.eventPage({ page: 2 });
    expect(history.mock.lastCall?.[0]).toMatchObject({ q: '', page: 2, snapshot: 'snapshot-101' });
    panel.searchEvents();
    expect(history.mock.lastCall?.[0]).toMatchObject({
      q: 'unsubmitted',
      page: 1,
      snapshot: undefined,
    });
    panel.toggleEventType('SYSTEM');
    panel.toggleEventType('BROWSER');
    expect(history.mock.lastCall?.[0]).toMatchObject({
      type: ['BROWSER', 'SYSTEM'],
      page: 1,
      snapshot: undefined,
    });
    panel.eventPage({ page: 2 });
    expect(history.mock.lastCall?.[0]).toMatchObject({
      type: ['BROWSER', 'SYSTEM'],
      page: 2,
      snapshot: 'snapshot-101',
    });
  });

  it('renders a task history without a runtime, with accessible type filters and close focus', () => {
    const { fixture, panel, history } = setup(undefined, true);
    const element: HTMLElement = fixture.nativeElement;
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="Ход выполнения"]');
    expect(trigger).not.toBeNull();
    trigger?.click();
    fixture.detectChanges();
    expect(history).toHaveBeenCalledOnce();
    expect(element.querySelector('hg-remote-browser')).toBeNull();
    expect(element.textContent).toContain('Браузер закрыт');
    expect(element.textContent).toContain('Новые сверху');
    const filters = element.querySelector<HTMLDetailsElement>('details.history-types');
    expect(filters).not.toBeNull();
    if (!filters) throw Error('Missing type filters');
    filters.open = true;
    const checkbox = Array.from(filters.querySelectorAll<HTMLInputElement>('input')).find((input) =>
      input.closest('label')?.textContent?.includes('Агент'),
    );
    expect(checkbox).toBeDefined();
    checkbox?.click();
    fixture.detectChanges();
    expect(history.mock.lastCall?.[0]).toMatchObject({ type: ['AGENT'], page: 1 });
    checkbox?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(filters.open).toBe(false);
    expect(panel.historyOpen()).toBe(true);
    filters
      .querySelector('summary')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(panel.historyOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});
