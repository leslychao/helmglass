import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { BrowserSession } from '../../core/api/models';
import { BrowserClock, browserClockOf, sessionClock } from '../../core/realtime/browser-clock';
import { Realtime } from '../../core/realtime/realtime.service';
import { BrowserPanel } from './browser-panel';

describe('server-confirmed browser deadlines', () => {
  const base: BrowserSession = {
    id: 'session',
    version: 1,
    state: 'ACTIVE',
    controlState: 'ACTIVE',
    controlMode: 'HUMAN',
    controllerRelation: 'SELF',
    controlEpoch: 1,
    allocationEpoch: 1,
    pageEpoch: 1,
    privacyEpoch: 1,
    privacyMode: 'NORMAL',
    siteAccess: 'PUBLIC',
    viewport: { width: 1280, height: 720 },
    capabilities: {},
    savePolicy: 'DISCARD_CHANGES',
    lastActivityAt: '2026-10-03T18:00:00Z',
    idleDeadlineAt: '2026-10-03T18:15:00Z',
    budgetDeadlineAt: '2026-10-03T18:30:00Z',
  };
  let clocks: Subject<BrowserClock>;
  let get: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T18:13:00Z'));
    clocks = new Subject();
    get = vi.fn(() => NEVER);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Api, useValue: { get } },
        { provide: Realtime, useValue: { refresh: new Subject(), browserClocks: clocks } },
      ],
    });
    TestBed.overrideComponent(BrowserPanel, { set: { template: '', imports: [] } });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  function panel(session = base) {
    const fixture = TestBed.createComponent(BrowserPanel);
    fixture.componentRef.setInput('sessionId', session.id);
    fixture.detectChanges();
    fixture.componentInstance.session.data.set(session);
    fixture.detectChanges();
    return fixture;
  }
  function clock(session: BrowserSession): BrowserClock {
    const value = sessionClock(session);
    if (!value) throw new Error('Invalid fixture clock');
    return value;
  }

  it('counts down the actual deadline across remount without reads or extending activity', () => {
    const fixture = panel();
    expect(fixture.componentInstance.countdown()).toMatchObject({ text: '2:00', warning: true });
    vi.advanceTimersByTime(61000);
    expect(fixture.componentInstance.countdown()?.text).toBe('0:59');
    fixture.destroy();
    const remount = panel();
    expect(remount.componentInstance.countdown()?.text).toBe('0:59');
    expect(get).toHaveBeenCalledTimes(2); // Only each mount's canonical initial snapshot.
    remount.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies activity deltas without GET and ignores old snapshots, other runtimes and old epochs', () => {
    const fixture = panel();
    const current = {
      ...base,
      lastActivityAt: '2026-10-03T18:13:00Z',
      idleDeadlineAt: '2026-10-03T18:28:00Z',
    };
    clocks.next(clock(current));
    fixture.detectChanges();
    expect(fixture.componentInstance.countdown()?.text).toBe('15:00');
    clocks.next(clock(base));
    clocks.next({ ...clock(current), browserSessionId: 'other' });
    clocks.next({ ...clock(current), allocationEpoch: 2 });
    clocks.next({ ...clock(current), privacyEpoch: 0 });
    fixture.componentInstance.session.data.set({ ...base });
    fixture.detectChanges();
    expect(fixture.componentInstance.countdown()?.text).toBe('15:00');
    expect(get).toHaveBeenCalledOnce();
  });

  it('accepts a shorter private interval only with its new privacy binding', () => {
    const fixture = panel();
    clocks.next({ ...clock(base), privacyEpoch: 2, idleDeadlineAt: '2026-10-03T18:14:00Z' });
    expect(fixture.componentInstance.countdown()?.text).toBe('2:00');
    fixture.componentInstance.session.data.set({
      ...base,
      privacyMode: 'LOGIN_PRIVATE',
      privacyEpoch: 2,
      idleDeadlineAt: '2026-10-03T18:14:00Z',
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.countdown()?.text).toBe('1:00');
    clocks.next(clock(base));
    expect(fixture.componentInstance.countdown()?.text).toBe('1:00');
  });

  it('keeps activity received during initial loading and hides private clock after losing control', () => {
    const fixture = TestBed.createComponent(BrowserPanel);
    fixture.componentRef.setInput('sessionId', base.id);
    fixture.detectChanges();
    clocks.next(
      clock({
        ...base,
        lastActivityAt: '2026-10-03T18:13:00Z',
        idleDeadlineAt: '2026-10-03T18:28:00Z',
      }),
    );
    fixture.componentInstance.session.data.set(base);
    fixture.detectChanges();
    expect(fixture.componentInstance.countdown()?.text).toBe('15:00');
    fixture.componentInstance.session.data.set({
      ...base,
      privacyMode: 'LOGIN_PRIVATE',
      privacyEpoch: 2,
      lastActivityAt: null,
      idleDeadlineAt: null,
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.countdown()).toBeNull();
  });

  it('applies a widget delta received before the panel mounts without reopening channels', () => {
    const fixture = TestBed.createComponent(BrowserPanel);
    fixture.componentRef.setInput('sessionId', base.id);
    fixture.componentRef.setInput('surface', 'WIDGET');
    fixture.componentRef.setInput('providedSession', base);
    fixture.componentRef.setInput(
      'providedClock',
      clock({
        ...base,
        lastActivityAt: '2026-10-03T18:13:00Z',
        idleDeadlineAt: '2026-10-03T18:28:00Z',
      }),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.countdown()?.text).toBe('15:00');
    fixture.componentRef.setInput('providedSession', { ...base });
    fixture.detectChanges();
    expect(fixture.componentInstance.countdown()?.text).toBe('15:00');
    expect(get).not.toHaveBeenCalled();
  });

  it('shows the earlier budget limit and waits for server closure when its deadline passes', () => {
    const fixture = panel({ ...base, budgetDeadlineAt: '2026-10-03T18:13:10Z' });
    expect(fixture.componentInstance.countdown()).toMatchObject({ budget: true, text: '0:10' });
    vi.advanceTimersByTime(11000);
    expect(fixture.componentInstance.countdown()).toMatchObject({ expired: true, text: '0:00' });
    expect(fixture.componentInstance.session.data()?.state).toBe('ACTIVE');
    expect(get).toHaveBeenCalledOnce();
    fixture.componentInstance.session.data.set({ ...base, state: 'CLOSED' });
    fixture.detectChanges();
    expect(fixture.componentInstance.countdown()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('parses only bounded valid clock metadata and supports widget snapshots identically', () => {
    expect(browserClockOf({ ...clock(base), lastActivityAt: 'invalid' })).toBeNull();
    expect(
      browserClockOf({ ...clock(base), allocationEpoch: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBeNull();
    const fixture = panel();
    fixture.componentRef.setInput('surface', 'WIDGET');
    fixture.componentRef.setInput('providedSession', base);
    fixture.detectChanges();
    clocks.next(
      clock({
        ...base,
        lastActivityAt: '2026-10-03T18:13:00Z',
        idleDeadlineAt: '2026-10-03T18:28:00Z',
      }),
    );
    expect(fixture.componentInstance.countdown()?.text).toBe('15:00');
    expect(get).toHaveBeenCalledOnce();
  });
});
