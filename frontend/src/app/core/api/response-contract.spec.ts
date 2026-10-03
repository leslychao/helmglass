import { describe, expect, it } from 'vitest';
import { validateResponse } from './response-contract';

describe('canonical API response validation', () => {
  it('accepts the control renewal receipt instead of expecting its request fields', async () => {
    const path = '/browser-sessions/58781913-ec66-4f0e-a093-15d191709ea6/control/renew';
    await expect(
      validateResponse('POST', path, {
        controlEpoch: 2,
        expiresAt: '2026-10-03T11:00:15Z',
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateResponse('POST', path, {
        controlEpoch: 2,
        controllerInstanceId: '2f873b32-4fb4-43b1-8201-3b62babacb37',
      }),
    ).rejects.toMatchObject({ code: 'API_RESPONSE_INVALID' });
  });

  it('matches a static summary endpoint before the task-id route', async () => {
    await expect(
      validateResponse('GET', '/tasks/summary', {
        total: 4,
        active: 1,
        waitingUser: 1,
        successCount: 1,
        successDenominator: 2,
        savedConnections: 1,
        totalConnections: 2,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a successful response with absent fields or a wrong primitive type', async () => {
    await expect(validateResponse('GET', '/tasks/summary', { total: 4 })).rejects.toMatchObject({
      code: 'API_RESPONSE_INVALID',
    });
    await expect(
      validateResponse('GET', '/tasks/summary', {
        total: '4',
        active: 1,
        waitingUser: 1,
        successCount: 1,
        successDenominator: 2,
        savedConnections: 1,
        totalConnections: 2,
      }),
    ).rejects.toMatchObject({ code: 'API_RESPONSE_INVALID' });
  });

  it('does not accept an unregistered endpoint or a malformed mutation receipt', async () => {
    await expect(validateResponse('GET', '/not-a-route', {})).rejects.toMatchObject({
      code: 'API_CONTRACT_MISSING',
    });
    await expect(
      validateResponse('POST', '/tasks', { operationId: 'invalid' }),
    ).rejects.toMatchObject({ code: 'API_RESPONSE_INVALID' });
  });

  it('accepts the paged administrative task contract and rejects its former array shape', async () => {
    const task = {
      id: 'd19e58f2-68cd-49b2-b966-67f772f6936b',
      state: 'DRAFT',
      waitReason: null,
      failureCode: null,
      createdAt: '2026-10-03T00:00:00Z',
      browserSessionId: null,
      workerId: null,
    };
    const path = '/admin/users/ed4ea3f7-cebd-425d-b975-bd3b1e365867/tasks';
    await expect(
      validateResponse('GET', path, {
        items: [task],
        total: 1,
        page: 1,
        pageSize: 10,
        sort: null,
        snapshot: 'task-snapshot',
      }),
    ).resolves.toBeUndefined();
    await expect(validateResponse('GET', path, [task])).rejects.toMatchObject({
      code: 'API_RESPONSE_INVALID',
    });
  });
});
