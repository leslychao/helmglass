import { describe, expect, it } from 'vitest';
import { presentationOf, retainActiveTicket, snapshotOf } from './widget-contracts';

describe('widget presentation and frame authorization', () => {
  const origin = 'https://helm.example.test';
  const presentation = {
    taskId: 'a927ca24-ce55-4bb7-a267-d6fca1d3c952',
    taskUrl: `${origin}/tasks/a927ca24-ce55-4bb7-a267-d6fca1d3c952`,
    summary: 'Задача',
    viewScopeId: '1c4eb0ef-a4cc-4a78-8c1f-137986ac00bb',
    presentationRevision: 3,
    presentationState: 'ACTIVE',
  };
  const session = {
    id: '7aa7d4a9-43ec-4f91-93dd-569ed11456b2',
    version: 3,
    state: 'ACTIVE',
    controlState: 'ACTIVE',
    controlMode: 'NONE',
    controllerRelation: 'NONE',
    controlEpoch: 1,
    pageEpoch: 4,
    privacyEpoch: 2,
    mediaGeneration: 1,
    privacyMode: 'NORMAL',
    siteAccess: 'ALLOWED',
    viewport: { width: 1280, height: 720 },
    capabilities: { view: { allowed: true } },
  };
  const meta = {
    viewTicket: {
      ticket: 'single-use-ticket',
      signalingUrl: `${origin.replace(/^http/, 'ws')}/stream/v1/widget/signaling/${session.id}`,
      viewGeneration: 5,
      expiresAt: '2026-10-03T00:00:30Z',
      viewerAuthorizationExpiresAt: '2026-10-03T00:05:00Z',
    },
  };

  it('rejects foreign task links and a snapshot for a different presentation', () => {
    expect(() =>
      presentationOf({ ...presentation, taskUrl: 'https://other.example/tasks/x' }, origin),
    ).toThrow();
    expect(() =>
      snapshotOf(
        { presentation: { ...presentation, presentationRevision: 2 } },
        {},
        presentation,
        origin,
      ),
    ).toThrow();
  });

  it('accepts the canonical link-only envelope without granting an active presentation', () => {
    const fallback = presentationOf(
      {
        receipt: { operationId: 'receipt' },
        presentation: {
          ...presentation,
          viewScopeId: null,
          presentationRevision: 0,
          presentationState: 'LINK_ONLY',
        },
      },
      origin,
    );
    expect(fallback.viewScopeId).toBeNull();
    expect(fallback.presentationState).toBe('LINK_ONLY');
    expect(fallback.taskUrl).toBe(presentation.taskUrl);
    expect(() => presentationOf({ ...presentation, viewScopeId: null }, origin)).toThrow();
  });

  it('retains the live single-use ticket when control changes but frame binding is unchanged', () => {
    const previous = snapshotOf({ presentation, session }, meta, presentation, origin);
    const next = snapshotOf(
      { presentation, session: { ...session, controlMode: 'HUMAN', controlEpoch: 2 } },
      {},
      presentation,
      origin,
    );
    expect(retainActiveTicket(previous, next).viewTicket).toBe(previous.viewTicket);
  });

  it('clears private frames and never carries an old ticket across a privacy epoch', () => {
    const previous = snapshotOf({ presentation, session }, meta, presentation, origin);
    const privateView = snapshotOf(
      { presentation, session: { ...session, privacyMode: 'LOGIN_PRIVATE' } },
      meta,
      presentation,
      origin,
    );
    expect(retainActiveTicket(previous, privateView).viewTicket).toBeNull();
    const nextEpoch = snapshotOf(
      { presentation, session: { ...session, privacyEpoch: 3 } },
      {},
      presentation,
      origin,
    );
    expect(retainActiveTicket(previous, nextEpoch).viewTicket).toBeNull();
  });

  it('uses the configured service origin and rejects another channel scope', () => {
    expect(presentationOf(presentation, origin).taskUrl).toBe(presentation.taskUrl);
    const value = snapshotOf({ presentation, session }, meta, presentation, origin);
    expect(value.viewTicket?.signalingUrl).toBe(meta.viewTicket.signalingUrl);
    expect(() =>
      snapshotOf(
        { presentation, session },
        {
          viewTicket: {
            ...meta.viewTicket,
            signalingUrl: `${origin.replace(/^http/, 'ws')}/stream/v1/input/${session.id}`,
          },
        },
        presentation,
        origin,
      ),
    ).toThrow();
  });

  it('requires a finite authorization deadline for event and video channels', () => {
    for (const deadline of [undefined, 'not-a-date']) {
      expect(() =>
        snapshotOf(
          { presentation, session },
          {
            viewTicket: { ...meta.viewTicket, viewerAuthorizationExpiresAt: deadline },
          },
          presentation,
          origin,
        ),
      ).toThrow();
      expect(() =>
        snapshotOf(
          { presentation, session: null },
          {
            eventTicket: {
              ticket: 'event-ticket',
              url: `${origin.replace(/^http/, 'ws')}/events/v1/widget/tasks/${presentation.taskId}`,
              viewGeneration: 1,
              viewerAuthorizationExpiresAt: deadline,
            },
          },
          presentation,
          origin,
        ),
      ).toThrow();
    }
  });
});
