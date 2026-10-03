import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../api/api.service';
import { Me } from '../api/models';
import { Identity } from '../identity/identity.service';
import { Realtime } from './realtime.service';

class Socket {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readonly send = vi.fn();
  readonly close = vi.fn();
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    Socket.instances.push(this);
  }

  ready() {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
  }

  disconnect(code: number, reason = '') {
    this.onclose?.({ code, reason });
  }
}

const me: Me = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Admin',
  email: 'admin@example.test',
  accountState: 'ACTIVE',
  permissions: ['platform_admin'],
  serverTime: '2026-10-03T00:00:00Z',
  policy: {
    version: 1,
    siteMode: 'ALL',
    connectionMode: 'AUTO',
    blockedActions: [],
    requireConfirmationBeforeChanges: false,
    origins: [],
    maxCommandsPerRun: null,
    maxActiveSecondsPerRun: null,
    maxParallelRuns: null,
    maxQueuedRuns: null,
    maxRetainedMediaBytes: null,
    maxBrowserSessions: null,
    quotas: {
      assignedBrowserLimit: 2,
      assignedQueuedLimit: 4,
      effectiveBrowserLimit: 2,
      effectiveQueuedLimit: 4,
    },
  },
};

describe('cabinet session recovery', () => {
  let identity: Identity;
  let realtime: Realtime;
  let reads: Subject<Me>[];
  let refresh = vi.fn<(value: ReadonlySet<string> | null) => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.stubGlobal('WebSocket', Socket);
    Socket.instances = [];
    reads = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Api,
          useValue: {
            get: (path: string) => {
              expect(path).toBe('/me');
              const response = new Subject<Me>();
              reads.push(response);
              return response;
            },
          },
        },
      ],
    });
    identity = TestBed.inject(Identity);
    realtime = TestBed.inject(Realtime);
    refresh = vi.fn();
    realtime.refresh.subscribe(refresh);
    identity.load().subscribe();
    respond(me);
    socket().ready();
    refresh.mockClear();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function socket() {
    return Socket.instances[Socket.instances.length - 1];
  }

  it('accepts policy invalidation on the existing self channel without identity reload', () => {
    const readCount = reads.length;
    socket().onmessage?.({ data: JSON.stringify({ type: 'invalidate', resources: ['policy'] }) });
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(new Set(['policy']));
    expect(reads).toHaveLength(readCount);
  });

  it('preserves a scoped task identity on the same invalidation stream', () => {
    const resourceId = '11111111-1111-4111-8111-111111111111';
    socket().onmessage?.({
      data: JSON.stringify({ type: 'invalidate', resources: ['events'], resourceId }),
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(
      Object.assign(new Set(['events']), { resourceId }),
    );
    expect(reads).toHaveLength(1);
  });

  it('rejects malformed resource identity without turning it into an unscoped invalidation', () => {
    socket().onmessage?.({
      data: JSON.stringify({
        type: 'invalidate',
        resources: ['events'],
        resourceId: 'untrusted/'.repeat(100),
      }),
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(socket().close).toHaveBeenCalledOnce();
  });

  function respond(profile: Me) {
    const response = reads[reads.length - 1];
    response.next(profile);
    response.complete();
  }

  function fail(status: number) {
    reads[reads.length - 1].error(new HttpErrorResponse({ status }));
  }

  it('delivers compact deadline state without resource invalidation or HTTP reads', () => {
    const received = vi.fn();
    realtime.browserClocks.subscribe(received);
    const clock = {
      browserSessionId: 'session',
      allocationEpoch: 1,
      privacyEpoch: 1,
      lastActivityAt: '2026-10-03T00:00:00Z',
      idleDeadlineAt: '2026-10-03T00:15:00Z',
      budgetDeadlineAt: '2026-10-03T00:30:00Z',
    };
    socket().onmessage?.({ data: JSON.stringify({ type: 'browserActivity', clock }) });
    socket().onmessage?.({
      data: JSON.stringify({ type: 'browserActivity', clock: { ...clock, lastActivityAt: 'bad' } }),
    });
    expect(received).toHaveBeenCalledExactlyOnceWith(clock);
    expect(refresh).not.toHaveBeenCalled();
    expect(reads).toHaveLength(1);
  });

  it.each(['AUTHORIZATION_EXPIRED', 'HEARTBEAT_TIMEOUT', 'SUBSCRIBE_TIMEOUT'])(
    'revalidates the existing session after %s, then resubscribes and refreshes once',
    (reason) => {
      socket().disconnect(4401, reason);
      expect(realtime.state()).toBe('offline');
      vi.advanceTimersByTime(1000);
      expect(reads).toHaveLength(2);
      expect(Socket.instances).toHaveLength(1);
      expect(refresh).not.toHaveBeenCalled();
      respond(me);
      expect(Socket.instances).toHaveLength(2);
      expect(realtime.state()).toBe('connecting');
      expect(refresh).not.toHaveBeenCalled();
      socket().ready();
      expect(socket().send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', channels: ['self', 'administration'] }),
      );
      expect(realtime.state()).toBe('ready');
      expect(refresh).toHaveBeenCalledExactlyOnceWith(null);
      expect(identity.me()).toEqual(me);
    },
  );

  it.each([401, 403])('stops recovery on an HTTP %s from session validation', (status) => {
    socket().disconnect(1006);
    vi.advanceTimersByTime(1000);
    fail(status);
    expect(realtime.state()).toBe('denied');
    expect(identity.me()).toBeNull();
    expect(identity.error()?.status).toBe(status);
    realtime.retry();
    vi.advanceTimersByTime(180000);
    expect(reads).toHaveLength(2);
    expect(Socket.instances).toHaveLength(1);
  });

  it('does not reconnect after an explicit access revocation', () => {
    socket().disconnect(4403, 'ACCESS_REVOKED');
    realtime.retry();
    vi.advanceTimersByTime(180000);
    expect(realtime.state()).toBe('denied');
    expect(reads).toHaveLength(1);
    expect(Socket.instances).toHaveLength(1);
  });

  it.each([0, 503])('recovers from a temporary HTTP %s without declaring logout', (status) => {
    socket().disconnect(1006);
    vi.advanceTimersByTime(1000);
    fail(status);
    expect(realtime.state()).toBe('offline');
    expect(identity.me()).toEqual(me);
    vi.advanceTimersByTime(2000);
    respond({ ...me, permissions: [] });
    socket().ready();
    expect(socket().send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', channels: ['self'] }),
    );
    expect(identity.can('platform_admin')).toBe(false);
    expect(realtime.state()).toBe('ready');
  });

  it('bounds stalled authentication and eventually exhausts recovery', () => {
    socket().disconnect(1006);
    vi.advanceTimersByTime(150000);
    expect(realtime.state()).toBe('exhausted');
    expect(reads.length).toBeLessThan(10);
    expect(Socket.instances).toHaveLength(1);
    expect(identity.me()).toEqual(me);
    realtime.retry();
    respond(me);
    socket().ready();
    expect(realtime.state()).toBe('ready');
  });

  it('coalesces resume signals and cancels authentication on logout', () => {
    socket().disconnect(4401, 'AUTHORIZATION_EXPIRED');
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    expect(reads).toHaveLength(2);
    identity.clear();
    respond(me);
    vi.advanceTimersByTime(180000);
    expect(identity.me()).toBeNull();
    expect(realtime.state()).toBe('denied');
    expect(Socket.instances).toHaveLength(1);
  });

  it('cancels a hidden page request and verifies again on return before refreshing', () => {
    socket().disconnect(1006);
    vi.advanceTimersByTime(1000);
    const previous = reads[1];
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    previous.next(me);
    expect(Socket.instances).toHaveLength(1);
    vi.advanceTimersByTime(180000);
    expect(reads).toHaveLength(2);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toHaveLength(3);
    expect(refresh).not.toHaveBeenCalled();
    respond(me);
    socket().ready();
    expect(refresh).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('ignores stale socket callbacks when a new user is loaded', () => {
    const old = socket();
    const opened = old.onopen;
    const closed = old.onclose;
    identity.load().subscribe();
    respond({ ...me, id: '22222222-2222-4222-8222-222222222222' });
    socket().ready();
    refresh.mockClear();
    old.send.mockClear();
    opened?.();
    closed?.({ code: 4403, reason: 'ACCESS_REVOKED' });
    expect(old.send).not.toHaveBeenCalled();
    expect(realtime.state()).toBe('ready');
    expect(refresh).not.toHaveBeenCalled();
  });
});
