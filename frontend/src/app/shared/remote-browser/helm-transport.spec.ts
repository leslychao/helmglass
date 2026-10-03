import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { Api } from '../../core/api/api.service';
import { BrowserSession } from '../../core/api/models';
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
    TestSocket.instances = [];
    vi.stubGlobal('WebSocket', TestSocket);
    vi.stubGlobal('MediaStream', class {});
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
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
            get: () => of(session),
            mutate: () =>
              of({
                ticket: 'scoped-ticket',
                signalingUrl: 'wss://helm.test/stream',
                viewGeneration: 1,
              }),
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
});
