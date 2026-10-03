import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Mutation } from './mutation';
import { Receipt } from './models';

describe('mutation recovery', () => {
  let http: HttpTestingController;
  let mutation: Mutation;
  const receipt: Receipt = {
    operationId: '11111111-1111-4111-8111-111111111111',
    resource: { type: 'TASK', id: '22222222-2222-4222-8222-222222222222', version: 2 },
    statusUrl: '/api/v1/operations/operation-1',
    requestId: '33333333-3333-4333-8333-333333333333',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    mutation = TestBed.runInInjectionContext(() => new Mutation());
  });
  afterEach(() => http.verify());

  it('does not resend an uncertain write and recovers with the original server scope and key', async () => {
    const accepted = vi.fn();
    mutation.run('PATCH', '/tasks/task-1', { expectedVersion: 1, goal: 'Updated' }, accepted);
    const write = http.expectOne('/api/v1/tasks/task-1');
    const key = write.request.headers.get('Idempotency-Key');
    write.error(new ProgressEvent('error'));
    expect(mutation.unknown()).toBe(true);
    mutation.run('PATCH', '/tasks/task-1', { expectedVersion: 1, goal: 'Updated' }, accepted);
    http.expectNone('/api/v1/tasks/task-1');
    mutation.recover();
    const lookup = http.expectOne('/api/v1/operations/lookup?kind=tasks.edit:task-1');
    expect(lookup.request.method).toBe('GET');
    expect(lookup.request.headers.get('Idempotency-Key')).toBe(key);
    lookup.flush(receipt);
    await vi.waitFor(() => expect(mutation.unknown()).toBe(false));
    expect(accepted).toHaveBeenCalledExactlyOnceWith(receipt);
  });

  it('does not treat an absent operation as proof that an uncertain write failed', () => {
    mutation.run('POST', '/tasks', { goal: 'New task' });
    http.expectOne('/api/v1/tasks').error(new ProgressEvent('error'));
    mutation.recover();
    http
      .expectOne('/api/v1/operations/lookup?kind=tasks.create')
      .flush(
        { title: 'Not yet found', code: 'NOT_FOUND' },
        { status: 404, statusText: 'Not Found' },
      );
    expect(mutation.unknown()).toBe(true);
    mutation.run('POST', '/tasks', { goal: 'New task' });
    http.expectNone('/api/v1/tasks');
  });

  it('preserves an explicit conflict without automatically retrying it with a new version', () => {
    mutation.run('PATCH', '/tasks/task-1', { expectedVersion: 1 });
    http
      .expectOne('/api/v1/tasks/task-1')
      .flush(
        { title: 'Task changed', code: 'VERSION_CONFLICT' },
        { status: 409, statusText: 'Conflict' },
      );
    expect(mutation.unknown()).toBe(false);
    expect(mutation.error()?.code).toBe('VERSION_CONFLICT');
    mutation.recover();
    http.expectNone((request) => request.method === 'GET');
  });
});
