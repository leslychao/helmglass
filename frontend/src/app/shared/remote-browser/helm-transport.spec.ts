import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, Subject, throwError } from 'rxjs';
import { Api, MutationProgress } from '../../core/api/api.service';
import { BrowserSession } from '../../core/api/models';
import { ResponseContractError } from '../../core/api/response-contract';
import { HelmTransport, streamStateOf } from './helm-transport';
import { RemoteBrowser } from './remote-browser';

class TestSocket {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: MessageEvent<unknown>) => void;
  onerror?: () => void;
  onclose?: (event: CloseEvent) => void;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    TestSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  receive(message: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  disconnect(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

describe('authenticated upstream transport', () => {
  const stream = {
    type: 'streamState',
    sessionId: 'session-1',
    producerId: 'producer-1',
    pageEpoch: 1,
    privacyEpoch: 1,
    mediaGeneration: 2,
    viewGeneration: 3,
    viewport: { width: 1280, height: 720 },
    captureState: 'ACTIVE',
    iceServers: [
      { urls: ['turns:relay.example:5349'], username: 'viewer', credential: 'temporary' },
    ],
  };
  let transport: HelmTransport;
  let socket: TestSocket;

  beforeEach(() => {
    TestSocket.instances = [];
    vi.stubGlobal('WebSocket', TestSocket);
    transport = new HelmTransport(
      'wss://helm.example/stream/v1/signaling/session-1',
      'one-use-ticket',
      vi.fn(),
    );
    const created = TestSocket.instances.at(-1);
    if (!created) throw new Error('Test socket was not created');
    socket = created;
  });
  afterEach(() => {
    transport.close();
    vi.unstubAllGlobals();
  });

  it('authenticates first and forwards the unmodified upstream message only after streamState', () => {
    const upstream = vi.fn();
    transport.onmessage = upstream;
    socket.onopen?.();
    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'authenticate', ticket: 'one-use-ticket' }),
    ]);
    expect(() => transport.send('{"type":"list"}')).toThrow('Signaling not authenticated');
    socket.receive(stream);
    socket.receive({ type: 'welcome', peerId: 'peer-1' });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0].data).toBe('{"type":"welcome","peerId":"peer-1"}');
    transport.send('{"type":"list"}');
    expect(socket.sent.at(-1)).toBe('{"type":"list"}');
  });

  it('closes when upstream negotiation arrives before authentication', () => {
    const upstream = vi.fn();
    transport.onmessage = upstream;
    socket.receive({ type: 'welcome', peerId: 'peer-1' });
    expect(socket.closed).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects malformed epochs and viewport dimensions instead of trusting a TypeScript annotation', () => {
    expect(streamStateOf({ ...stream, privacyEpoch: 1.5 })).toBeNull();
    expect(streamStateOf({ ...stream, viewport: { width: 0, height: 720 } })).toBeNull();
    expect(
      streamStateOf({ ...stream, iceServers: [{ urls: 'https://unexpected.example' }] }),
    ).toBeNull();
  });

  it('never forwards revocation controls to the stock client', () => {
    const upstream = vi.fn();
    transport.onmessage = upstream;
    socket.receive(stream);
    socket.receive({ type: 'revoked' });
    expect(socket.closed).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('remote viewer with the pinned upstream signaling client', () => {
  let fixture: ComponentFixture<RemoteBrowser>;
  let currentSession: BrowserSession;
  const mutate = vi.fn(
    (
      _method: string,
      path: string,
      _body?: unknown,
      _key?: string,
      _observe?: (progress: MutationProgress) => void,
    ) =>
      of(
        path.endsWith('/control/renew')
          ? {
              controlEpoch: currentSession.controlEpoch,
              expiresAt: new Date(Date.now() + 15000).toISOString(),
            }
          : { ticket: 'scoped-ticket', signalingUrl: 'wss://helm.test/stream', viewGeneration: 1 },
      ),
  );
  const session: BrowserSession = {
    id: 'browser-1',
    version: 1,
    taskId: 'task-1',
    state: 'ACTIVE',
    controlState: 'ACTIVE',
    controlMode: 'AGENT',
    controllerRelation: 'NONE',
    controlEpoch: 1,
    pageEpoch: 2,
    privacyEpoch: 1,
    mediaGeneration: 1,
    privacyMode: 'NORMAL',
    siteAccess: 'PUBLIC',
    savePolicy: 'ASK',
    viewport: { width: 1280, height: 720 },
    capabilities: { view: { allowed: true } },
  };
  const cancelFrame = Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype,
    'cancelVideoFrameCallback',
  );

  beforeEach(() => {
    currentSession = session;
    mutate.mockClear();
    TestSocket.instances = [];
    vi.stubGlobal('WebSocket', TestSocket);
    vi.stubGlobal('MediaStream', class {});
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
      configurable: true,
      value: () => {},
    });
    TestBed.configureTestingModule({
      imports: [RemoteBrowser],
      providers: [
        {
          provide: Api,
          useValue: {
            get: () => of(currentSession),
            mutate,
          },
        },
      ],
    });
    fixture = TestBed.createComponent(RemoteBrowser);
    fixture.componentRef.setInput('session', session);
    fixture.componentRef.setInput('instanceId', 'viewer-1');
    fixture.componentRef.setInput('taskId', 'task-1');
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    if (cancelFrame)
      Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', cancelFrame);
    else Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for listener readiness and preserves a producer across upstream list replacement', async () => {
    const socket = TestSocket.instances.at(-1);
    if (!socket) throw new Error('Viewer socket was not created');
    socket.onopen?.();
    socket.receive({
      type: 'streamState',
      sessionId: session.id,
      producerId: 'producer-1',
      pageEpoch: 2,
      privacyEpoch: 1,
      mediaGeneration: 1,
      viewGeneration: 1,
      viewport: session.viewport,
      captureState: 'PREPARING',
      iceServers: [],
    });
    socket.receive({ type: 'welcome', peerId: 'viewer-1' });
    const producers = { type: 'list', producers: [{ id: 'producer-1' }] };
    socket.receive(producers);
    expect(socket.closed).toBe(false);
    expect(socket.sent.some((message) => message.includes('startSession'))).toBe(false);

    socket.receive({ type: 'peerStatusChanged', peerId: 'viewer-1', roles: ['listener'] });
    expect(socket.sent.filter((message) => message.includes('startSession'))).toHaveLength(1);
    socket.receive(producers);
    await Promise.resolve();
    expect(socket.closed).toBe(false);
    expect(socket.sent.filter((message) => message.includes('startSession'))).toHaveLength(1);

    socket.receive({ type: 'list', producers: [] });
    await Promise.resolve();
    expect(socket.closed).toBe(true);
  });

  function privateControl() {
    currentSession = {
      ...session,
      privacyMode: 'LOGIN_PRIVATE',
      controlMode: 'HUMAN',
      controllerRelation: 'SELF',
    };
    fixture.componentRef.setInput('session', currentSession);
    fixture.detectChanges();
  }

  it.each([4401, 4403, 4404, 4412])(
    'keeps terminal close %i through synchronous upstream teardown without retrying',
    async (code) => {
      vi.useFakeTimers();
      const socket = TestSocket.instances.at(-1);
      if (!socket) throw new Error('Viewer socket is missing');
      socket.receive({
        type: 'streamState',
        sessionId: session.id,
        producerId: 'producer-1',
        pageEpoch: 2,
        privacyEpoch: 1,
        mediaGeneration: 1,
        viewGeneration: 1,
        viewport: session.viewport,
        captureState: 'PREPARING',
        iceServers: [],
      });
      socket.receive({ type: 'welcome', peerId: 'viewer-1' });
      socket.receive({ type: 'peerStatusChanged', peerId: 'viewer-1', roles: ['listener'] });
      socket.receive({ type: 'list', producers: [{ id: 'producer-1' }] });
      expect(socket.sent.some((message) => message.includes('startSession'))).toBe(true);
      mutate.mockClear();
      socket.disconnect(code, 'VIEW_REVOKED');
      expect(fixture.componentInstance.state()).toBe('ERROR');
      expect(fixture.componentInstance.technicalDetails()).toBe(`${code}: VIEW_REVOKED`);
      expect(fixture.componentInstance.message()).not.toContain(String(code));
      await vi.advanceTimersByTimeAsync(31000);
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it('recovers from 4503 with the bounded known cause and ignores a late old close', async () => {
    vi.useFakeTimers();
    const socket = TestSocket.instances.at(-1);
    if (!socket) throw new Error('Viewer socket is missing');
    const lateClose = socket.onclose;
    mutate.mockClear();
    socket.disconnect(4503, 'MEDIA_BINDING_CHANGED');
    expect(fixture.componentInstance.technicalDetails()).toBe('4503: MEDIA_BINDING_CHANGED');
    expect(fixture.componentInstance.state()).toBe('CONNECTING');
    await vi.advanceTimersByTimeAsync(1201);
    expect(mutate).toHaveBeenCalledOnce();
    const current = TestSocket.instances.at(-1);
    lateClose?.(new CloseEvent('close', { code: 4403, reason: 'VIEW_REVOKED' }));
    expect(current?.closed).toBe(false);
    expect(fixture.componentInstance.state()).toBe('CONNECTING');
  });

  it('does not expose arbitrary server close text', () => {
    const socket = TestSocket.instances.at(-1);
    if (!socket) throw new Error('Viewer socket is missing');
    socket.disconnect(4503, 'sensitive-untrusted-close-payload');
    expect(fixture.componentInstance.technicalDetails()).toBe('4503');
    expect(fixture.componentInstance.message()).not.toContain('sensitive-untrusted');
    fixture.detectChanges();
    const element: unknown = fixture.nativeElement;
    if (!(element instanceof HTMLElement)) throw new Error('Viewer root is missing');
    const details = element.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Технические сведения');
    expect(details?.textContent).toContain('4503');
    expect(element.textContent).not.toContain('sensitive-untrusted');
  });

  it('requires a fresh capture confirmation as well as decoded frames before reporting LIVE', async () => {
    vi.useFakeTimers();
    const element: unknown = fixture.nativeElement;
    if (!(element instanceof HTMLElement)) throw new Error('Viewer root is missing');
    const video = element.querySelector('video');
    if (!video) throw new Error('Viewer video is missing');
    let frame: VideoFrameRequestCallback | undefined;
    Object.defineProperty(video, 'requestVideoFrameCallback', {
      value: (callback: VideoFrameRequestCallback) => {
        frame = callback;
        return 1;
      },
    });
    vi.spyOn(video, 'play').mockResolvedValue();
    const socket = TestSocket.instances.at(-1);
    if (!socket) throw new Error('Viewer socket is missing');
    const capture = {
      type: 'streamState',
      sessionId: session.id,
      producerId: 'producer-1',
      pageEpoch: 2,
      privacyEpoch: 1,
      mediaGeneration: 1,
      viewGeneration: 1,
      viewport: session.viewport,
      captureState: 'ACTIVE',
      iceServers: [],
    };
    socket.receive(capture);
    expect(fixture.componentInstance.state()).not.toBe('LIVE');
    fixture.componentInstance.state.set('AUTOPLAY');
    fixture.componentInstance.retry();
    await Promise.resolve();
    const present = () => {
      if (!frame) throw new Error('Frame callback is missing');
      frame(performance.now(), {
        expectedDisplayTime: 0,
        width: 1280,
        height: 720,
        mediaTime: 0,
        presentationTime: 0,
        presentedFrames: 1,
      });
    };
    present();
    expect(fixture.componentInstance.state()).toBe('LIVE');
    await vi.advanceTimersByTimeAsync(1000);
    present();
    await vi.advanceTimersByTimeAsync(1100);
    expect(fixture.componentInstance.state()).toBe('CONNECTING');
    present();
    expect(fixture.componentInstance.state()).toBe('CONNECTING');
    socket.receive(capture);
    expect(fixture.componentInstance.state()).toBe('LIVE');
    const late = frame;
    fixture.componentRef.setInput('session', { ...session, privacyEpoch: 2 });
    fixture.detectChanges();
    late?.(performance.now(), {
      expectedDisplayTime: 0,
      width: 1280,
      height: 720,
      mediaTime: 0,
      presentationTime: 0,
      presentedFrames: 2,
    });
    expect(fixture.componentInstance.state()).not.toBe('LIVE');
  });

  it('renews private control before video arrives and throughout media recovery', async () => {
    vi.useFakeTimers();
    privateControl();
    await vi.advanceTimersByTimeAsync(0);
    const renewalCount = () =>
      mutate.mock.calls.filter((call) => call[1].endsWith('/control/renew')).length;
    expect(renewalCount()).toBe(1);
    expect(fixture.componentInstance.state()).toBe('CONNECTING');
    fixture.componentInstance.fail('Видеоканал прерван');
    await vi.advanceTimersByTimeAsync(20000);
    expect(renewalCount()).toBe(5);
    expect(fixture.componentInstance.state()).not.toBe('LIVE');

    fixture.componentRef.setInput('paused', true);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(20000);
    expect(renewalCount()).toBe(5);
    fixture.componentRef.setInput('paused', false);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(renewalCount()).toBe(6);
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(20000);
    expect(renewalCount()).toBe(6);
  });

  it('stops renewals when hidden, transferred to another controller, or mounted as a widget', async () => {
    vi.useFakeTimers();
    privateControl();
    await vi.advanceTimersByTimeAsync(0);
    mutate.mockClear();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(20000);
    expect(mutate).not.toHaveBeenCalled();

    currentSession = { ...currentSession, controllerRelation: 'OTHER' };
    fixture.componentRef.setInput('session', currentSession);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(mutate.mock.calls.some((call) => call[1].endsWith('/control/renew'))).toBe(false);

    fixture.componentRef.setInput('surface', 'WIDGET');
    fixture.componentRef.setInput('session', { ...currentSession, controllerRelation: 'SELF' });
    fixture.detectChanges();
    mutate.mockClear();
    await vi.advanceTimersByTimeAsync(20000);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('stops video on a failed control renewal and reads the updated authorization once', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    fixture.componentInstance.refresh.subscribe(refresh);
    privateControl();
    mutate.mockImplementationOnce(() => throwError(() => new Error('CONTROL_EXPIRED')));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.componentInstance.state()).toBe('ERROR');
    expect(fixture.componentInstance.inputReady()).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(TestSocket.instances.at(-1)?.closed).toBe(true);
    const calls = mutate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(mutate).toHaveBeenCalledTimes(calls);
  });

  it.each([
    {
      name: 'network failure',
      error: new HttpErrorResponse({ status: 0, error: { detail: 'private content' } }),
      details: 'CONTROL_RENEW_NETWORK',
    },
    {
      name: 'known HTTP refusal and valid request identity',
      error: new HttpErrorResponse({
        status: 409,
        error: {
          code: 'CONTROL_EXPIRED',
          requestId: '049221e3-6e39-43ef-9c36-4dab85d49760',
          title: 'private content',
          detail: 'private content',
        },
      }),
      details: 'CONTROL_RENEW_HTTP 409 · CONTROL_EXPIRED · 049221e3-6e39-43ef-9c36-4dab85d49760',
    },
    {
      name: 'HTTP failure without untrusted server strings',
      error: new HttpErrorResponse({
        status: 500,
        error: { code: 'private content', requestId: 'private content', detail: 'private content' },
      }),
      details: 'CONTROL_RENEW_HTTP 500',
    },
    {
      name: 'response contract rejection',
      error: new ResponseContractError('API_RESPONSE_INVALID'),
      details: 'CONTROL_RENEW_RESPONSE_CONTRACT · API_RESPONSE_INVALID',
    },
    {
      name: 'unexpected error without its message',
      error: new Error('private content'),
      details: 'CONTROL_RENEW_UNEXPECTED',
    },
  ])(
    'shows safe renewal diagnostics for $name without restarting control',
    async ({ error, details }) => {
      vi.useFakeTimers();
      privateControl();
      mutate.mockImplementationOnce(() => throwError(() => error));
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      expect(fixture.componentInstance.technicalDetails()).toBe(details);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(details);
      const element: unknown = fixture.nativeElement;
      if (!(element instanceof HTMLElement)) throw new Error('Viewer element is missing');
      const disclosure = element.querySelector('details');
      expect(disclosure?.hasAttribute('open')).toBe(false);
      expect(disclosure?.textContent).toContain(details);
      expect(element.textContent).not.toContain('private content');
      expect(fixture.componentInstance.inputReady()).toBe(false);
      const calls = mutate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20000);
      expect(mutate).toHaveBeenCalledTimes(calls);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(details);
    },
  );

  it('identifies the real four-second renewal timeout and stops the heartbeat', async () => {
    vi.useFakeTimers();
    privateControl();
    mutate.mockImplementationOnce(() => new Subject<never>());
    await vi.advanceTimersByTimeAsync(3999);
    expect(fixture.componentInstance.technicalDetails()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.componentInstance.technicalDetails()).toBe('CONTROL_RENEW_TIMEOUT');
    expect(fixture.componentInstance.state()).toBe('ERROR');
    expect(fixture.componentInstance.inputReady()).toBe(false);
    const calls = mutate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(mutate).toHaveBeenCalledTimes(calls);
  });

  it.each(['SENT', 'RESPONSE_HEADERS', 'RESPONSE_RECEIVED'] as const)(
    'retains the %s stage on a four-second renewal timeout without restarting control',
    async (stage) => {
      vi.useFakeTimers();
      const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
      const requestId = '049221e3-6e39-43ef-9c36-4dab85d49760';
      const serverRequestId = stage === 'SENT' ? undefined : 'b365ff9fcfb546f7473c6969283c8023';
      privateControl();
      mutate.mockImplementationOnce((_method, _path, _body, _key, observe) => {
        observe?.({ stage, requestId, serverRequestId });
        return new Subject<never>();
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3999);
      expect(fixture.componentInstance.technicalDetails()).toBeNull();
      clock.mockReturnValue(4100);
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.componentInstance.technicalDetails()).toBe(
        `CONTROL_RENEW_TIMEOUT · stage=${stage} · elapsedMs=4000 · gapMs=first · visible=true/true · requestId=${requestId}` +
          (serverRequestId ? ` · serverRequestId=${serverRequestId}` : ''),
      );
      expect(fixture.componentInstance.state()).toBe('ERROR');
      expect(fixture.componentInstance.inputReady()).toBe(false);
      const calls = mutate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20000);
      expect(mutate).toHaveBeenCalledTimes(calls);
    },
  );

  it('bounds renewal timing and excludes untrusted fields while retaining the gap and visibility', async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    privateControl();
    await vi.advanceTimersByTimeAsync(0);
    mutate.mockImplementationOnce((_method, _path, _body, _key, observe) => {
      const progress = {
        stage: 'SENT' as const,
        requestId: 'private content',
        serverRequestId: 'private server content',
        url: 'https://secret.test',
        body: 'secret body',
        token: 'secret token',
      };
      observe?.(progress);
      return new Subject<never>();
    });
    clock.mockReturnValue(5500);
    await vi.advanceTimersByTimeAsync(5000);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    clock.mockReturnValue(1_000_000_000);
    await vi.advanceTimersByTimeAsync(4000);
    const details = fixture.componentInstance.technicalDetails();
    expect(details).toBe(
      'CONTROL_RENEW_TIMEOUT · stage=SENT · elapsedMs=3600000 · gapMs=5400 · visible=true/false',
    );
    expect(details?.length).toBeLessThan(256);
    expect(details).not.toMatch(/private|secret|https|body|token|requestId/);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(details);
    fixture.componentInstance.technicalDetails.set(null);
    await vi.advanceTimersByTimeAsync(20000);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(details);
  });

  it('cancels a pending renewal on transfer so its late error cannot close the new viewer', async () => {
    vi.useFakeTimers();
    privateControl();
    const pending = new Subject<never>();
    mutate.mockImplementationOnce(() => pending);
    await vi.advanceTimersByTimeAsync(0);
    currentSession = { ...session, controlEpoch: 2 };
    fixture.componentRef.setInput('session', currentSession);
    fixture.detectChanges();
    pending.error(new Error('late failure'));
    expect(fixture.componentInstance.state()).toBe('CONNECTING');
    expect(TestSocket.instances.at(-1)?.closed).toBe(false);
  });

  it('distinguishes denied viewing from a user pause and keeps the concrete failure during retries', () => {
    currentSession = {
      ...session,
      capabilities: {
        view: {
          allowed: false,
          reason: 'Сеанс управления прерван. Восстановите управление.',
        },
      },
    };
    fixture.componentRef.setInput('session', currentSession);
    fixture.detectChanges();
    expect(fixture.componentInstance.state()).toBe('UNAVAILABLE');
    expect(fixture.componentInstance.title()).toBe('Просмотр недоступен');
    expect(fixture.componentInstance.message()).toContain('Сеанс управления прерван');
    fixture.componentRef.setInput('paused', true);
    fixture.detectChanges();
    expect(fixture.componentInstance.title()).toBe('Просмотр приостановлен');
    fixture.componentRef.setInput('paused', false);
    fixture.componentRef.setInput('session', session);
    fixture.detectChanges();
    fixture.componentInstance.fail('Не удалось согласовать поток');
    expect(fixture.componentInstance.message()).toContain('Не удалось согласовать поток');
  });

  it('uses the fresh denial reason without requesting an unauthorized video ticket', () => {
    currentSession = {
      ...session,
      capabilities: {
        view: {
          allowed: false,
          reason: 'Сеанс управления прерван. Восстановите управление.',
        },
      },
    };
    mutate.mockClear();
    fixture.componentInstance.retry();
    fixture.detectChanges();
    expect(mutate).not.toHaveBeenCalled();
    expect(fixture.componentInstance.state()).toBe('UNAVAILABLE');
    expect(fixture.componentInstance.message()).toContain('Сеанс управления прерван');
  });
});
