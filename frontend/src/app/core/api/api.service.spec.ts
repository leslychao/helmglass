import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api, MutationProgress, problemOf } from './api.service';
import { ResponseContractError } from './response-contract';

describe('authentication error contracts', () => {
  it.each(['AUTHENTICATION_REQUIRED', 'REAUTHENTICATION_REQUIRED'])(
    'retains %s from the gateway and identity filter without a title',
    (code) => {
      const problem = problemOf(
        new HttpErrorResponse({
          status: 401,
          error: { status: 401, code, requestId: 'request-1' },
        }),
      );
      expect(problem).toMatchObject({
        code,
        status: 401,
        requestId: 'request-1',
        title: 'Войдите в Helm Glass',
      });
    },
  );
});

describe('optional mutation diagnostics', () => {
  const path = '/browser-sessions/58781913-ec66-4f0e-a093-15d191709ea6/control/renew';
  const body = { controllerInstanceId: '049221e3-6e39-43ef-9c36-4dab85d49760', controlEpoch: 2 };
  const response = { controlEpoch: 2, expiresAt: '2026-10-03T20:00:15Z' };
  let api: Api;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(Api);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports only stages and the existing request identity without changing the validated response', async () => {
    const progress: MutationProgress[] = [];
    const result = firstValueFrom(
      api.mutate('POST', path, body, 'stable-key', (event) => {
        progress.push(event);
        if (event.stage === 'SENT') throw new Error('Optional diagnostic failure');
      }),
    );
    const request = http.expectOne(`/api/v1${path}`);
    expect(request.request.body).toEqual(body);
    expect(request.request.headers.get('Idempotency-Key')).toBe('stable-key');
    const requestId = request.request.headers.get('X-Request-Id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(progress.map((event) => event.stage)).toEqual(['SUBSCRIBED', 'SENT']);
    request.flush(response);
    await expect(result).resolves.toEqual(response);
    expect(progress).toEqual(
      ['SUBSCRIBED', 'SENT', 'RESPONSE_RECEIVED', 'VALIDATED'].map((stage) => ({
        stage,
        requestId,
      })),
    );
  });

  it('identifies SENT without RESPONSE and still aborts exactly at the caller timeout', async () => {
    vi.useFakeTimers();
    const progress: MutationProgress[] = [];
    let failure: unknown;
    api
      .mutate('POST', path, body, 'stable-key', (event) => progress.push(event))
      .pipe(timeout(4000))
      .subscribe({
        error: (error: unknown) => {
          failure = error;
        },
      });
    const request = http.expectOne(`/api/v1${path}`);
    await vi.advanceTimersByTimeAsync(3999);
    expect(failure).toBeUndefined();
    expect(request.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(failure).toBeInstanceOf(TimeoutError);
    expect(request.cancelled).toBe(true);
    expect(progress.map((event) => event.stage)).toEqual(['SUBSCRIBED', 'SENT']);
  });

  it('preserves HTTP failure when the optional observer throws', async () => {
    const result = firstValueFrom(
      api.mutate('POST', path, body, 'stable-key', () => {
        throw new Error('Optional diagnostic failure');
      }),
    );
    http
      .expectOne(`/api/v1${path}`)
      .flush({ code: 'CONTROL_LEASE_EXPIRED' }, { status: 409, statusText: 'Conflict' });
    await expect(result).rejects.toMatchObject({
      status: 409,
      error: { code: 'CONTROL_LEASE_EXPIRED' },
    });
  });

  it('never reports validation success for a malformed response', async () => {
    const progress: MutationProgress[] = [];
    const result = firstValueFrom(
      api.mutate('POST', path, body, 'stable-key', (event) => progress.push(event)),
    );
    http.expectOne(`/api/v1${path}`).flush({ controlEpoch: 'not-a-number' });
    await expect(result).rejects.toBeInstanceOf(ResponseContractError);
    expect(progress.at(-1)?.stage).toBe('RESPONSE_RECEIVED');
  });

  it('identifies RESPONSE while validation is pending and ignores late progress after cancellation', async () => {
    vi.useFakeTimers();
    const progress: MutationProgress[] = [];
    const received = vi.fn();
    let failure: unknown;
    api
      .mutate('POST', path, body, 'stable-key', (event) => progress.push(event))
      .pipe(timeout(4000))
      .subscribe({
        next: received,
        error: (error: unknown) => {
          failure = error;
        },
      });
    http.expectOne(`/api/v1${path}`).flush(response);
    expect(progress.map((event) => event.stage)).toEqual([
      'SUBSCRIBED',
      'SENT',
      'RESPONSE_RECEIVED',
    ]);
    // Expire the existing timer before the asynchronous contract validation resumes.
    vi.advanceTimersByTime(4000);
    expect(failure).toBeInstanceOf(TimeoutError);
    expect(received).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(progress.at(-1)?.stage).toBe('RESPONSE_RECEIVED');
    expect(received).not.toHaveBeenCalled();
  });
});
