import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { BrowserSession } from '../../core/api/models';
import { Realtime } from '../../core/realtime/realtime.service';
import { BrowserPanel } from './browser-panel';

describe('browser address editing', () => {
  it('shows actual viewer readiness and omits navigation to the current login operation', () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Api, useValue: { get: () => NEVER } },
        { provide: Realtime, useValue: { refresh: new Subject(), browserClocks: new Subject() } },
      ],
    });
    TestBed.overrideComponent(BrowserPanel, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(BrowserPanel);
    fixture.componentRef.setInput('sessionId', 'session');
    fixture.detectChanges();
    const panel = fixture.componentInstance;
    const session: BrowserSession = {
      id: 'session',
      version: 1,
      state: 'ACTIVE',
      controlState: 'ACTIVE',
      controlMode: 'HUMAN',
      controllerRelation: 'SELF',
      controlEpoch: 1,
      pageEpoch: 1,
      privacyEpoch: 1,
      privacyMode: 'LOGIN_PRIVATE',
      siteAccess: 'PRIVATE_LOGIN',
      loginOperationId: 'login-1',
      viewport: { width: 1280, height: 720 },
      savePolicy: 'ASK',
      capabilities: { view: { allowed: true }, continueLogin: { allowed: true, visible: true } },
    };
    panel.session.data.set(session);
    expect(panel.primary()?.key).toBe('continueLogin');
    fixture.componentRef.setInput('activeLoginOperationId', 'login-1');
    expect(panel.primary()).toBeNull();
    expect(panel.viewStatus()).toBe('VIEW_CONNECTING');
    panel.viewState.set('LIVE');
    expect(panel.viewStatus()).toBe('VIEW_LIVE');
    panel.viewState.set('CONNECTING');
    expect(panel.viewStatus()).toBe('VIEW_CONNECTING');
    panel.viewState.set('ERROR');
    expect(panel.viewStatus()).toBe('VIEW_ERROR');
    panel.session.data.set({
      ...session,
      controlState: 'QUIESCED',
      controllerRelation: 'NONE',
      capabilities: {
        view: { allowed: false },
        acquire: { allowed: true, visible: true },
        continueLogin: { allowed: false, visible: true },
      },
    });
    expect(panel.viewStatus()).toBe('VIEW_UNAVAILABLE');
    expect(panel.controlStatus()).toBe('NONE');
    expect(panel.primary()?.label).toBe('Восстановить управление');
    panel.session.data.set({ ...session, state: 'CLOSED' });
    expect(panel.viewStatus()).toBe('CLOSED');
  });

  it('preserves a draft on session refresh and follows confirmed page changes', () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Api, useValue: { get: () => NEVER } },
        { provide: Realtime, useValue: { refresh: new Subject(), browserClocks: new Subject() } },
      ],
    });
    TestBed.overrideComponent(BrowserPanel, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(BrowserPanel);
    fixture.componentRef.setInput('sessionId', 'session');
    fixture.detectChanges();
    const panel = fixture.componentInstance;
    const session: BrowserSession = {
      id: 'session',
      version: 1,
      state: 'OPEN',
      controlState: 'HUMAN',
      controlMode: 'HUMAN',
      controllerRelation: 'SELF',
      controlEpoch: 1,
      pageEpoch: 1,
      privacyEpoch: 1,
      privacyMode: 'NORMAL',
      siteAccess: 'PUBLIC',
      currentUrl: 'https://example.com/',
      viewport: { width: 1280, height: 720 },
      capabilities: {},
      savePolicy: 'ASK',
    };
    panel.session.data.set(session);
    fixture.detectChanges();
    expect(panel.url).toBe('https://example.com/');
    panel.url = 'https://example.com/next';
    panel.session.data.set({ ...session, version: 2 });
    fixture.detectChanges();
    expect(panel.url).toBe('https://example.com/next');
    panel.session.data.set({ ...session, version: 3, currentUrl: 'https://example.com/final' });
    fixture.detectChanges();
    expect(panel.url).toBe('https://example.com/final');
  });

  it('keeps handback primary and exposes allowed transfer ahead of disabled continuation', () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Api, useValue: { get: () => NEVER } },
        { provide: Realtime, useValue: { refresh: new Subject(), browserClocks: new Subject() } },
      ],
    });
    TestBed.overrideComponent(BrowserPanel, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(BrowserPanel);
    fixture.componentRef.setInput('sessionId', 'session');
    fixture.detectChanges();
    const panel = fixture.componentInstance;
    const session: BrowserSession = {
      id: 'session',
      taskId: 'task',
      version: 1,
      state: 'OPEN',
      controlState: 'HUMAN',
      controlMode: 'HUMAN',
      controllerRelation: 'SELF',
      controlEpoch: 1,
      pageEpoch: 1,
      privacyEpoch: 1,
      privacyMode: 'NORMAL',
      siteAccess: 'NEEDS_LOGIN',
      viewport: { width: 1280, height: 720 },
      savePolicy: 'ASK',
      capabilities: {
        release: { allowed: true, visible: true },
        login: { allowed: true, visible: true },
      },
    };
    panel.session.data.set(session);
    expect(panel.primary()?.key).toBe('release');
    panel.session.data.set({
      ...session,
      privacyMode: 'LOGIN_PRIVATE',
      controllerRelation: 'OTHER',
      capabilities: {
        continueLogin: { allowed: false, visible: true },
        transfer: { allowed: true, visible: true },
      },
    });
    expect(panel.primary()?.key).toBe('transfer');

    fixture.componentRef.setInput('surface', 'WIDGET');
    fixture.componentRef.setInput('providedSession', {
      ...session,
      capabilities: { openLogin: { allowed: true, visible: true }, acquire: { allowed: true } },
    });
    fixture.detectChanges();
    const opened = vi.fn();
    const sent = vi.spyOn(panel.action, 'run');
    panel.openTask.subscribe(opened);
    expect(panel.primary()?.key).toBe('openLogin');
    panel.perform('openLogin');
    panel.perform('acquire');
    expect(opened).toHaveBeenCalledOnce();
    expect(sent).not.toHaveBeenCalled();
  });

  it('blocks another mutation until the matching accepted operation is complete', () => {
    const mutate = vi.fn(() =>
      of({
        operationId: 'operation-1',
        resource: { type: 'BROWSER_SESSION', id: 'session', version: 2 },
        statusUrl: '/api/v1/operations/operation-1',
        requestId: 'request-1',
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Api, useValue: { get: () => NEVER, mutate } },
        { provide: Realtime, useValue: { refresh: new Subject(), browserClocks: new Subject() } },
      ],
    });
    TestBed.overrideComponent(BrowserPanel, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(BrowserPanel);
    fixture.componentRef.setInput('sessionId', 'session');
    fixture.detectChanges();
    const panel = fixture.componentInstance;
    panel.session.data.set({
      id: 'session',
      version: 1,
      state: 'ACTIVE',
      controlState: 'ACTIVE',
      controlMode: 'NONE',
      controllerRelation: 'NONE',
      controlEpoch: 1,
      pageEpoch: 1,
      privacyEpoch: 1,
      privacyMode: 'NORMAL',
      siteAccess: 'PUBLIC',
      viewport: { width: 1280, height: 720 },
      capabilities: { acquire: { allowed: true, visible: true } },
      savePolicy: 'DISCARD_CHANGES',
    });

    panel.perform('acquire');
    panel.perform('acquire');
    panel.operation.set({ id: 'older-operation', state: 'SUCCEEDED' });
    panel.perform('acquire');
    panel.operation.set({ id: 'operation-1', state: 'UNKNOWN' });
    panel.perform('acquire');
    expect(mutate).toHaveBeenCalledOnce();

    panel.operation.set({ id: 'operation-1', state: 'SUCCEEDED' });
    panel.perform('acquire');
    expect(mutate).toHaveBeenCalledTimes(2);
  });
});
