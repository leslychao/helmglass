import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Widget } from './widget';
import { Presentation } from './widget-contracts';

const bridge = vi.hoisted(() => ({
  listener: undefined as ((event: { structuredContent: unknown }) => void) | undefined,
  attach: vi.fn(),
}));

vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: class {
    addEventListener(_name: string, listener: typeof bridge.listener) {
      bridge.listener = listener;
    }
    connect() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    callServerTool = bridge.attach;
  },
}));

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

  beforeEach(() => {
    bridge.attach.mockReset();
    bridge.listener = undefined;
    config = document.createElement('script');
    config.id = 'helm-runtime-config';
    config.type = 'application/json';
    config.textContent = JSON.stringify({ publicOrigin: 'https://helm.example.test' });
    document.head.append(config);
    TestBed.overrideComponent(Widget, { set: { template: '', imports: [] } });
  });

  afterEach(() => config.remove());

  it('reactivates for a new scoped presentation and clears the old error', async () => {
    const fixture = TestBed.createComponent(Widget);
    await Promise.resolve();
    const widget = fixture.componentInstance;
    widget.presentation.set(presentation);
    widget.snapshot.set({ presentation, session: null, continuation: null, viewTicket: null });
    widget.inactive.set(true);
    widget.error.set('Old presentation failed');
    const next = { ...presentation, viewScopeId: '2c4eb0ef-a4cc-4a78-8c1f-137986ac00bb' };
    bridge.attach.mockResolvedValue({ structuredContent: { presentation: next, session: null } });

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
});
