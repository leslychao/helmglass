import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Widget } from './widget';
import { Presentation, WidgetSnapshot } from './widget-contracts';

const bridge = vi.hoisted(() => ({
  listener: undefined as ((event: { structuredContent: unknown }) => void) | undefined,
  attach: vi.fn(),
  connect: vi.fn(),
  capabilities: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: class {
    addEventListener(_name: string, listener: typeof bridge.listener) {
      bridge.listener = listener;
    }
    connect = bridge.connect;
    close() {
      return Promise.resolve();
    }
    callServerTool = bridge.attach;
    getHostCapabilities = bridge.capabilities;
    sendMessage = bridge.sendMessage;
  },
}));

class EventSocket {
  static readonly OPEN = 1;
  static instances: EventSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(readonly url: string) {
    EventSocket.instances.push(this);
  }
  send(data: string) {
    if (data === '{"type":"ping"}') this.receive('pong');
  }
  close() {
    this.fail(1006);
  }
  open() {
    this.readyState = EventSocket.OPEN;
    this.onopen?.(new Event('open'));
    this.receive('ready');
  }
  receive(type: string) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type }) }));
  }
  fail(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

describe('widget presentation lifecycle', () => {
  const presentation: Presentation = {
    taskId: 'a927ca24-ce55-4bb7-a267-d6fca1d3c952',
    taskUrl: 'https://helm.example.test/tasks/a927ca24-ce55-4bb7-a267-d6fca1d3c952',
    summary: 'Задача',
    viewScopeId: '1c4eb0ef-a4cc-4a78-8c1f-137986ac00bb',
    presentationRevision: 3,
    presentationState: 'ACTIVE',
  };
  let config: HTMLScriptElement;

  function attached(continuation: WidgetSnapshot['continuation'] = null, events = false) {
    return {
      structuredContent: { presentation, session: null, continuation },
      ...(events
        ? {
            _meta: {
              eventTicket: {
                ticket: 'event-ticket',
                viewGeneration: 1,
                viewerAuthorizationExpiresAt: new Date(Date.now() + 300000).toISOString(),
                url: `wss://helm.example.test/events/v1/widget/tasks/${presentation.taskId}`,
              },
            },
          }
        : {}),
    };
  }

  async function mount() {
    const fixture = TestBed.createComponent(Widget);
    await Promise.resolve();
    bridge.listener?.({ structuredContent: presentation });
    await vi.advanceTimersByTimeAsync(0);
    return fixture;
  }

  function socket() {
    const socket = EventSocket.instances.at(-1);
    if (!socket) throw new Error('Expected an event channel');
    return socket;
  }

  function delivered(secondsAgo = 0): WidgetSnapshot['continuation'] {
    return {
      id: 'continuation-1',
      state: 'DELIVERED',
      mode: 'WIDGET_RETURN',
      deliveredAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      manualMessage: 'Продолжи ту же задачу.',
    };
  }

  beforeEach(() => {
    bridge.attach.mockReset();
    bridge.attach.mockResolvedValue(attached());
    bridge.connect.mockReset().mockResolvedValue(undefined);
    bridge.capabilities.mockReset().mockReturnValue({ message: { text: {} } });
    bridge.sendMessage.mockReset().mockResolvedValue({});
    bridge.listener = undefined;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    EventSocket.instances = [];
    vi.stubGlobal('WebSocket', EventSocket);
    config = document.createElement('script');
    config.id = 'helm-runtime-config';
    config.type = 'application/json';
    config.textContent = JSON.stringify({ publicOrigin: 'https://helm.example.test' });
    document.head.append(config);
    TestBed.overrideComponent(Widget, { set: { template: '', imports: [] } });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    config.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reactivates for a new scoped presentation and clears the old error', async () => {
    const fixture = TestBed.createComponent(Widget);
    await Promise.resolve();
    const widget = fixture.componentInstance;
    widget.presentation.set(presentation);
    widget.snapshot.set({ presentation, session: null, continuation: null, viewTicket: null });
    widget.inactive.set(true);
    widget.error.set('Old presentation failed');
    const next = { ...presentation, viewScopeId: '2c4eb0ef-a4cc-4a78-8c1f-137986ac00bb' };
    bridge.attach.mockResolvedValue({
      ...attached(null, true),
      structuredContent: { presentation: next, session: null },
    });

    bridge.listener?.({ structuredContent: next });
    await Promise.resolve();

    expect(widget.presentation()?.viewScopeId).toBe(next.viewScopeId);
    expect(widget.inactive()).toBe(false);
    expect(widget.error()).toBe('');
    expect(bridge.attach).toHaveBeenCalledOnce();
  });

  it('does not attach a superseded presentation or accept an older revision', async () => {
    const fixture = TestBed.createComponent(Widget);
    await Promise.resolve();
    const widget = fixture.componentInstance;

    bridge.listener?.({ structuredContent: { ...presentation, presentationState: 'SUPERSEDED' } });
    bridge.listener?.({ structuredContent: { ...presentation, presentationRevision: 2 } });

    expect(widget.inactive()).toBe(true);
    expect(widget.presentation()?.presentationRevision).toBe(3);
    expect(bridge.attach).not.toHaveBeenCalled();
  });

  it('recovers the first transient attach failure without another host event', async () => {
    bridge.attach.mockResolvedValue(attached(null, true));
    bridge.attach.mockRejectedValueOnce(new Error('Connection lost'));
    const fixture = await mount();
    expect(fixture.componentInstance.snapshot()).toBeNull();
    expect(bridge.attach).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(999);
    expect(bridge.attach).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(bridge.attach).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.snapshot()?.presentation).toEqual(presentation);
    expect(fixture.componentInstance.error()).toBe('');
    expect(bridge.attach.mock.calls[1]?.[0]).toEqual(bridge.attach.mock.calls[0]?.[0]);
  });

  it('coalesces duplicate host events and updates into the pending recovery', async () => {
    bridge.attach.mockRejectedValueOnce(new Error('Unavailable'));
    const fixture = await mount();
    bridge.listener?.({ structuredContent: presentation });
    fixture.componentInstance.refreshView();
    fixture.componentInstance.refreshView();
    await vi.advanceTimersByTimeAsync(999);
    expect(bridge.attach).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.attach).toHaveBeenCalledTimes(2);
  });

  it('coalesces in-flight invalidations without bypassing backoff after failure', async () => {
    let rejectAttach: ((reason: Error) => void) | undefined;
    bridge.attach.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAttach = reject;
        }),
    );
    const fixture = await mount();
    fixture.componentInstance.refreshView();
    fixture.componentInstance.refreshView();
    rejectAttach?.(new Error('Lost response'));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.attach).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.attach).toHaveBeenCalledTimes(2);
  });

  it('stops automatic retries at the bounded deadline and allows explicit recovery', async () => {
    bridge.attach.mockRejectedValue(new Error('Offline'));
    const fixture = await mount();
    await vi.advanceTimersByTimeAsync(120000);
    const attempts = bridge.attach.mock.calls.length;
    expect(attempts).toBeGreaterThan(2);
    expect(attempts).toBeLessThan(15);
    expect(fixture.componentInstance.error()).toContain('Связь не восстановлена');
    await vi.advanceTimersByTimeAsync(300000);
    fixture.componentInstance.refreshView();
    bridge.listener?.({ structuredContent: presentation });
    expect(bridge.attach).toHaveBeenCalledTimes(attempts);

    bridge.attach.mockResolvedValue(attached());
    fixture.componentInstance.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.attach).toHaveBeenCalledTimes(attempts + 1);
    expect(fixture.componentInstance.snapshot()).not.toBeNull();
  });

  it.each(['hidden', 'destroyed', 'superseded'])(
    'cancels pending recovery when %s',
    async (reason) => {
      bridge.attach.mockRejectedValue(new Error('Offline'));
      const fixture = await mount();
      if (reason === 'hidden') {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
      } else if (reason === 'destroyed') fixture.destroy();
      else
        bridge.listener?.({
          structuredContent: { ...presentation, presentationState: 'SUPERSEDED' },
        });
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(180000);
      expect(bridge.attach).toHaveBeenCalledOnce();
    },
  );

  it('starts one fresh cycle on return to visibility and ignores a stale attach response', async () => {
    let resolveOld: ((value: ReturnType<typeof attached>) => void) | undefined;
    bridge.attach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const fixture = await mount();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    resolveOld?.(attached(delivered(90)));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.attach).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.snapshot()?.continuation).toBeNull();
    expect(fixture.componentInstance.manualText()).toBe('');
  });

  it.each([401, 403, 404])(
    'does not retry a terminal MCP response with status %s',
    async (status) => {
      bridge.attach.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'ACCESS_REJECTED', status }) }],
      });
      const fixture = await mount();
      fixture.componentInstance.retry();
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      bridge.listener?.({ structuredContent: presentation });
      await vi.advanceTimersByTimeAsync(180000);
      expect(bridge.attach).toHaveBeenCalledOnce();
      expect(fixture.componentInstance.error()).not.toBe('');
    },
  );

  it.each([4401, 4403, 4412])(
    'stops recovery after terminal event-channel close %s',
    async (code) => {
      bridge.attach.mockResolvedValue(attached(null, true));
      const fixture = await mount();
      socket().open();
      await vi.advanceTimersByTimeAsync(0);
      const attempts = bridge.attach.mock.calls.length;
      socket().fail(code);
      fixture.componentInstance.retry();
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(180000);
      expect(bridge.attach).toHaveBeenCalledTimes(attempts);
      expect(fixture.componentInstance.snapshot()).toBeNull();
    },
  );

  it('shares one recovery cycle across channel close and subsequent attach failures', async () => {
    bridge.attach.mockResolvedValue(attached(null, true));
    const fixture = await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    bridge.attach.mockRejectedValueOnce(new Error('Bridge unavailable'));
    socket().fail(1006);
    fixture.componentInstance.refreshView();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.attach).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1999);
    expect(bridge.attach).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.attach).toHaveBeenCalledTimes(4);
    expect(EventSocket.instances).toHaveLength(2);
  });

  it('renews an event-only view at its active authorization deadline despite later snapshots', async () => {
    const initial = attached(null, true);
    if (!initial._meta) throw new Error('Expected event ticket');
    initial._meta.eventTicket.viewerAuthorizationExpiresAt = new Date(
      Date.now() + 5000,
    ).toISOString();
    bridge.attach.mockResolvedValue(initial);
    await mount();
    const original = socket();
    original.open();
    await vi.advanceTimersByTimeAsync(4000);
    const fresh = attached(null, true);
    bridge.attach.mockResolvedValue(fresh);
    original.receive('invalidate');
    await vi.advanceTimersByTimeAsync(999);
    expect(bridge.attach).toHaveBeenCalledTimes(3);
    expect(EventSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.attach).toHaveBeenCalledTimes(4);
    expect(original.readyState).toBe(3);
    expect(EventSocket.instances).toHaveLength(2);
    socket().open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(bridge.attach).toHaveBeenCalledTimes(5);
  });

  it('replaces the event channel when the server renews the viewer generation', async () => {
    bridge.attach.mockResolvedValue(attached(null, true));
    await mount();
    const original = socket();
    original.open();
    await vi.advanceTimersByTimeAsync(0);
    const renewed = attached(null, true);
    if (!renewed._meta) throw new Error('Expected event ticket');
    renewed._meta.eventTicket.viewGeneration = 2;
    bridge.attach.mockResolvedValue(renewed);
    original.receive('invalidate');
    await vi.advanceTimersByTimeAsync(0);
    expect(original.readyState).toBe(3);
    expect(EventSocket.instances).toHaveLength(2);
  });

  it.each(['AUTHORIZATION_EXPIRED', 'TICKET_EXPIRED', 'TICKET_TIMEOUT'])(
    'requests a fresh host authorization after %s without requiring a new login',
    async (reason) => {
      bridge.attach.mockResolvedValue(attached(null, true));
      const fixture = await mount();
      socket().open();
      await vi.advanceTimersByTimeAsync(0);
      socket().fail(4401, reason);
      await vi.advanceTimersByTimeAsync(1000);
      expect(bridge.attach).toHaveBeenCalledTimes(3);
      expect(EventSocket.instances).toHaveLength(2);
      expect(fixture.componentInstance.accessDenied()).toBe(false);

      bridge.attach.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ status: 401 }) }],
      });
      socket().open();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.componentInstance.accessDenied()).toBe(true);
    },
  );

  it('recovers an expired lease without reviving a superseded presentation', async () => {
    bridge.attach.mockResolvedValue(attached(null, true));
    const fixture = await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    socket().fail(4503, 'VIEW_LEASE_EXPIRED');
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.attach).toHaveBeenCalledTimes(3);
    expect(fixture.componentInstance.inactive()).toBe(false);
    socket().fail(4412, 'PRESENTATION_SUPERSEDED');
    await vi.advanceTimersByTimeAsync(10000);
    expect(bridge.attach).toHaveBeenCalledTimes(3);
    expect(fixture.componentInstance.inactive()).toBe(true);
  });

  it('recovers a channel after restart while the previous server lease expires', async () => {
    bridge.attach.mockResolvedValue(attached());
    const fixture = await mount();
    await vi.advanceTimersByTimeAsync(45000);
    expect(EventSocket.instances).toHaveLength(0);
    expect(bridge.attach.mock.calls.length).toBeGreaterThan(2);
    bridge.attach.mockResolvedValue(attached(null, true));
    await vi.advanceTimersByTimeAsync(16000);
    expect(EventSocket.instances).toHaveLength(1);
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    const attempts = bridge.attach.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(bridge.attach).toHaveBeenCalledTimes(attempts);
    expect(fixture.componentInstance.error()).toBe('');
  });

  it('bounds recovery when snapshots never provide the missing event channel', async () => {
    bridge.attach.mockResolvedValue(attached());
    const fixture = await mount();
    await vi.advanceTimersByTimeAsync(120000);
    const attempts = bridge.attach.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(bridge.attach).toHaveBeenCalledTimes(attempts);
    expect(fixture.componentInstance.error()).toContain('Связь не восстановлена');
  });

  it('shows attention from the durable deadline without polling or sending a message', async () => {
    bridge.attach.mockResolvedValue(attached(delivered(30), true));
    const fixture = await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.attach).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29999);
    expect(fixture.componentInstance.manualText()).toBe('');
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.componentInstance.manualText()).toBe('Продолжи ту же задачу.');
    expect(bridge.attach).toHaveBeenCalledTimes(2);
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it('waits for recovered push and its fresh snapshot before showing overdue attention', async () => {
    bridge.attach.mockResolvedValue(attached(delivered(59), true));
    const fixture = await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    socket().fail(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.componentInstance.manualText()).toBe('');
    bridge.attach.mockResolvedValue(
      attached({ id: 'continuation-1', state: 'CLAIMED', mode: 'WIDGET_RETURN' }, true),
    );
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.componentInstance.snapshot()?.continuation?.state).toBe('CLAIMED');
    expect(fixture.componentInstance.manualText()).toBe('');
  });

  it('cancels local attention when a pushed claim arrives before its deadline', async () => {
    bridge.attach.mockResolvedValue(attached(delivered(59), true));
    const fixture = await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    bridge.attach.mockResolvedValue(
      attached({ id: 'continuation-1', state: 'CLAIMED', mode: 'WIDGET_RETURN' }, true),
    );
    socket().receive('invalidate');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.componentInstance.manualText()).toBe('');
    expect(bridge.attach).toHaveBeenCalledTimes(3);
  });

  it('waits for a coalesced read when invalidation arrives during the current snapshot request', async () => {
    bridge.attach.mockResolvedValue(attached(delivered(90), true));
    const fixture = await mount();
    let resolveRead: ((value: ReturnType<typeof attached>) => void) | undefined;
    bridge.attach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    socket().open();
    socket().receive('invalidate');
    let resolveFresh: ((value: ReturnType<typeof attached>) => void) | undefined;
    bridge.attach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFresh = resolve;
        }),
    );
    resolveRead?.(attached(delivered(90), true));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.componentInstance.manualText()).toBe('');
    expect(bridge.attach).toHaveBeenCalledTimes(3);
    resolveFresh?.(
      attached({ id: 'continuation-1', state: 'CLAIMED', mode: 'WIDGET_RETURN' }, true),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.componentInstance.manualText()).toBe('');
    expect(fixture.componentInstance.snapshot()?.continuation?.state).toBe('CLAIMED');
  });

  it('does not let successful channel pongs reset an unsuccessful snapshot recovery window', async () => {
    bridge.attach.mockResolvedValue(attached(null, true));
    const fixture = await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    bridge.attach.mockRejectedValue(new Error('Read unavailable'));
    socket().receive('invalidate');
    await vi.advanceTimersByTimeAsync(120000);
    const attempts = bridge.attach.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180000);
    expect(bridge.attach).toHaveBeenCalledTimes(attempts);
    expect(fixture.componentInstance.error()).toContain('Связь не восстановлена');
  });

  it('requires host message.text capability before preparing automatic continuation', async () => {
    bridge.capabilities.mockReturnValue({ message: { image: {} } });
    bridge.attach.mockResolvedValue(
      attached({ id: 'continuation-1', state: 'READY', mode: 'WIDGET_RETURN' }),
    );
    const fixture = await mount();
    expect(bridge.attach).toHaveBeenCalledOnce();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(fixture.componentInstance.manualText()).toContain(presentation.taskId);
  });

  function deliveryScenario(initialState = 'READY') {
    let state = initialState;
    const prepared = () => ({
      structuredContent: {
        dispatchId: '3f1978bb-80d8-4990-b345-edebeb351513',
        text: 'Продолжи ту же задачу после подтверждённого результата.',
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
    });
    const prepare = vi.fn(async (_arguments: Record<string, unknown>) => prepared());
    const recordDelivery = vi.fn(async (_arguments: Record<string, unknown>) => ({}));
    bridge.attach.mockImplementation(
      (request: { name: string; arguments: Record<string, unknown> }) => {
        if (request.name === 'continuations.prepare_message') {
          state = 'DISPATCHING';
          return prepare(request.arguments);
        }
        if (request.name === 'continuations.record_delivery') {
          state = request.arguments['outcome'] === 'DELIVERED' ? 'DELIVERED' : 'DELIVERY_UNKNOWN';
          return recordDelivery(request.arguments);
        }
        return Promise.resolve(
          attached({ id: 'continuation-1', state, mode: 'WIDGET_RETURN' }, true),
        );
      },
    );
    return { prepare, recordDelivery, prepared };
  }

  it('recovers a lost prepare response with the same key and sends only once', async () => {
    const protocol = deliveryScenario();
    protocol.prepare.mockRejectedValueOnce(new Error('Response lost after commit'));
    await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(protocol.prepare).toHaveBeenCalledOnce();
    expect(bridge.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(protocol.prepare).toHaveBeenCalledTimes(2);
    expect(protocol.prepare.mock.calls[1]?.[0]).toEqual(protocol.prepare.mock.calls[0]?.[0]);
    expect(bridge.sendMessage).toHaveBeenCalledOnce();
    expect(protocol.recordDelivery).toHaveBeenCalledOnce();
  });

  it('retries a lost delivery receipt with the same key without resending to ChatGPT', async () => {
    const protocol = deliveryScenario();
    protocol.recordDelivery.mockRejectedValueOnce(new Error('Receipt response lost'));
    await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.sendMessage).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1000);

    expect(protocol.recordDelivery).toHaveBeenCalledTimes(2);
    expect(protocol.recordDelivery.mock.calls[1]?.[0]).toEqual(
      protocol.recordDelivery.mock.calls[0]?.[0],
    );
    expect(protocol.prepare).toHaveBeenCalledOnce();
    expect(bridge.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not dispatch a server DISPATCHING continuation after remount', async () => {
    const protocol = deliveryScenario('DISPATCHING');
    await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive('invalidate');
    await vi.advanceTimersByTimeAsync(0);

    expect(protocol.prepare).not.toHaveBeenCalled();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  it('records an unknown host outcome and never treats it as permission to resend', async () => {
    const protocol = deliveryScenario();
    bridge.sendMessage.mockRejectedValueOnce(new Error('Host acknowledgement lost'));
    await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive('invalidate');
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.sendMessage).toHaveBeenCalledOnce();
    expect(protocol.recordDelivery.mock.calls[0]?.[0]['outcome']).toBe('UNKNOWN');
    expect(protocol.prepare).toHaveBeenCalledOnce();
  });

  it('does not send another message after an expired claim becomes READY on remount', async () => {
    const continuation = {
      id: 'continuation-1',
      state: 'READY',
      mode: 'WIDGET_RETURN',
      dispatchId: '3f1978bb-80d8-4990-b345-edebeb351513',
      manualMessage: 'Продолжи ту же задачу после восстановления управления.',
    };
    bridge.attach.mockResolvedValue(attached(continuation, true));
    const fixture = await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    socket().receive('invalidate');
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(bridge.attach.mock.calls.every(([request]) => request.name === 'browser.attach_view')).toBe(
      true,
    );
    expect(fixture.componentInstance.manualText()).toBe(continuation.manualMessage);
  });

  it('rejects a prepared message if the widget becomes hidden before host invocation', async () => {
    const protocol = deliveryScenario();
    let resolve: ((value: ReturnType<typeof protocol.prepared>) => void) | undefined;
    protocol.prepare.mockImplementationOnce(
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    resolve?.(protocol.prepared());
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(protocol.recordDelivery.mock.calls[0]?.[0]['outcome']).toBe('REJECTED');
  });

  it('bounds receipt repair even while attach and heartbeat remain healthy', async () => {
    const protocol = deliveryScenario();
    protocol.recordDelivery.mockRejectedValue(new Error('Receipt unavailable'));
    await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(120000);
    const attempts = protocol.recordDelivery.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);

    expect(protocol.recordDelivery).toHaveBeenCalledTimes(attempts);
    expect(attempts).toBeGreaterThan(1);
    expect(bridge.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not mistake the prepare transaction invalidation for a rejected delivery', async () => {
    const protocol = deliveryScenario();
    protocol.prepare.mockImplementationOnce(async () => {
      socket().receive('invalidate');
      return protocol.prepared();
    });
    await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.sendMessage).toHaveBeenCalledOnce();
    expect(protocol.recordDelivery.mock.calls[0]?.[0]['outcome']).toBe('DELIVERED');
  });

  it('rejects an expired prepare receipt without invoking the host', async () => {
    const protocol = deliveryScenario();
    const expired = protocol.prepared();
    expired.structuredContent.expiresAt = new Date(Date.now() - 1).toISOString();
    protocol.prepare.mockResolvedValueOnce(expired);
    await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(protocol.recordDelivery.mock.calls[0]?.[0]['outcome']).toBe('REJECTED');
  });

  it('does not send a delayed prepare response after presentation supersession', async () => {
    const protocol = deliveryScenario();
    let resolve: ((value: ReturnType<typeof protocol.prepared>) => void) | undefined;
    protocol.prepare.mockImplementationOnce(
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    await mount();
    socket().open();
    await vi.advanceTimersByTimeAsync(0);
    bridge.listener?.({ structuredContent: { ...presentation, presentationState: 'SUPERSEDED' } });
    resolve?.(protocol.prepared());
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(protocol.recordDelivery.mock.calls[0]?.[0]['outcome']).toBe('REJECTED');
  });

  it('does not attach after destruction while the host handshake is pending', async () => {
    let connect: (() => void) | undefined;
    bridge.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          connect = resolve;
        }),
    );
    const fixture = await mount();
    fixture.destroy();
    connect?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.attach).not.toHaveBeenCalled();
  });
});
