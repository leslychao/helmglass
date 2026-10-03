import { TestBed } from '@angular/core/testing';
import { NEVER, of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Policy, Receipt } from '../../core/api/models';
import { Realtime } from '../../core/realtime/realtime.service';
import { Profile } from './profile';

describe('personal queue limits', () => {
  it.each([false, true])(
    'submits the rendered Save button with loaded policy, edited=%s',
    (edited) => {
      const policy: Policy = {
        version: 7,
        siteMode: 'ALL',
        origins: [],
        connectionMode: 'AUTO',
        requireConfirmationBeforeChanges: true,
        blockedActions: [],
        maxCommandsPerRun: null,
        maxActiveSecondsPerRun: null,
        maxParallelRuns: null,
        maxQueuedRuns: null,
        maxRetainedMediaBytes: null,
        maxBrowserSessions: null,
        quotas: {
          assignedBrowserLimit: 2,
          assignedQueuedLimit: null,
          effectiveBrowserLimit: 2,
          effectiveQueuedLimit: null,
        },
      };
      const receipt = new Subject<Receipt>();
      const get = vi.fn(() => of(policy));
      const mutate = vi.fn(() => receipt);
      TestBed.configureTestingModule({
        providers: [
          { provide: Api, useValue: { get, mutate } },
          { provide: Realtime, useValue: { refresh: new Subject() } },
        ],
      });
      const fixture = TestBed.createComponent(Profile);
      fixture.detectChanges();
      const element: HTMLElement = fixture.nativeElement;
      const form = element.querySelector('form');
      const button = element.querySelector<HTMLButtonElement>('.form-footer button');
      const origins = element.querySelector<HTMLTextAreaElement>('#origins');
      if (!form || !button || !origins) throw new Error('Profile form is not rendered');
      const submitted = vi.fn();
      form.addEventListener('submit', submitted);
      if (edited) {
        origins.value = 'https://example.org';
        origins.dispatchEvent(new Event('input', { bubbles: true }));
        fixture.detectChanges();
      }
      expect(form.checkValidity()).toBe(true);
      expect(button.disabled).toBe(false);
      expect(button.type).toBe('submit');
      button.click();
      fixture.detectChanges();
      expect(submitted).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledExactlyOnceWith(
        'PATCH',
        '/me/policy',
        expect.objectContaining({
          expectedVersion: 7,
          origins: edited ? ['https://example.org'] : [],
          requireConfirmationBeforeChanges: true,
          maxBrowserSessions: null,
        }),
        expect.any(String),
      );
      expect(fixture.componentInstance.mutation.pending()).toBe(true);
      expect(button.disabled).toBe(true);
      button.click();
      expect(mutate).toHaveBeenCalledTimes(1);
      get.mockReturnValueOnce(of({ ...policy, version: 8 }));
      receipt.next({
        operationId: '11111111-1111-4111-8111-111111111111',
        resource: { type: 'policy', id: '22222222-2222-4222-8222-222222222222', version: 8 },
        statusUrl: '/api/v1/operations/11111111-1111-4111-8111-111111111111',
        requestId: '33333333-3333-4333-8333-333333333333',
      });
      fixture.detectChanges();
      expect(fixture.componentInstance.mutation.pending()).toBe(false);
      expect(fixture.componentInstance.form.pristine).toBe(true);
      expect(get).toHaveBeenCalledTimes(2);
      expect(button.disabled).toBe(false);
      form.removeEventListener('submit', submitted);
      fixture.destroy();
    },
  );

  it('refreshes assigned quotas on policy push without overwriting unsaved preferences', () => {
    const refresh = new Subject<ReadonlySet<string> | null>();
    const responses: Subject<Policy>[] = [];
    const get = vi.fn((path: string) => {
      expect(path).toBe('/me/policy');
      const response = new Subject<Policy>();
      responses.push(response);
      return response;
    });
    const mutate = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: Api, useValue: { get, mutate } },
        { provide: Realtime, useValue: { refresh } },
      ],
    });
    const fixture = TestBed.createComponent(Profile);
    const profile = fixture.componentInstance;
    const policy: Policy = {
      version: 1,
      siteMode: 'ALL',
      origins: [],
      connectionMode: 'AUTO',
      requireConfirmationBeforeChanges: false,
      blockedActions: [],
      maxCommandsPerRun: null,
      maxActiveSecondsPerRun: null,
      maxParallelRuns: null,
      maxQueuedRuns: null,
      maxRetainedMediaBytes: null,
      maxBrowserSessions: null,
      quotas: {
        assignedBrowserLimit: 2,
        assignedQueuedLimit: null,
        effectiveBrowserLimit: 2,
        effectiveQueuedLimit: null,
      },
    };
    responses[0].next(policy);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('#maxBrowserSessions') as HTMLInputElement;
    expect(input.max).toBe('2');
    profile.form.controls.origins.setValue('https://example.org');
    profile.form.markAsDirty();
    refresh.next(new Set(['policy']));
    expect(get).toHaveBeenCalledTimes(2);
    responses[1].next({
      ...policy,
      quotas: {
        assignedBrowserLimit: 1,
        assignedQueuedLimit: 0,
        effectiveBrowserLimit: 1,
        effectiveQueuedLimit: 0,
      },
    });
    fixture.detectChanges();
    expect(input.max).toBe('1');
    expect(profile.policy.data()?.quotas.effectiveQueuedLimit).toBe(0);
    expect(profile.form.controls.origins.value).toBe('https://example.org');
    expect(profile.form.dirty).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Действующий предел: браузеры 1');
    refresh.next(new Set(['tasks']));
    expect(get).toHaveBeenCalledTimes(2);
    expect(mutate).not.toHaveBeenCalled();

    refresh.next(new Set(['policy']));
    responses[2].next({ ...policy, version: 2, connectionMode: 'EXPLICIT' });
    fixture.detectChanges();
    const write = vi.spyOn(profile.mutation, 'run').mockImplementation(() => undefined);
    profile.save();
    expect(write).toHaveBeenCalledWith(
      'PATCH',
      '/me/policy',
      expect.objectContaining({ expectedVersion: 1, origins: ['https://example.org'] }),
      expect.any(Function),
    );
    expect(profile.form.dirty).toBe(true);
    fixture.destroy();
    refresh.next(new Set(['policy']));
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('accepts zero queued tasks and preserves positive bounds for execution limits', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: Api, useValue: { get: () => NEVER } },
        { provide: Realtime, useValue: { refresh: new Subject() } },
      ],
    });
    TestBed.overrideComponent(Profile, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(Profile);
    const profile = fixture.componentInstance;
    profile.policy.data.set({
      version: 1,
      siteMode: 'ALL',
      origins: [],
      connectionMode: 'AUTO',
      requireConfirmationBeforeChanges: false,
      blockedActions: [],
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
    });
    fixture.detectChanges();
    const write = vi.spyOn(profile.mutation, 'run').mockImplementation(() => undefined);

    profile.form.controls.maxQueuedRuns.setValue(0);
    profile.save();
    expect(write).toHaveBeenCalledWith(
      'PATCH',
      '/me/policy',
      expect.objectContaining({ maxQueuedRuns: 0 }),
      expect.any(Function),
    );
    write.mockClear();
    profile.form.controls.maxParallelRuns.setValue(0);
    profile.save();
    expect(write).not.toHaveBeenCalled();
    expect(profile.form.controls.maxQueuedRuns.value).toBe(0);
    expect(profile.validation()).not.toBe('');
    profile.form.controls.maxParallelRuns.setValue(null);
    profile.form.controls.maxBrowserSessions.setValue(3);
    profile.save();
    expect(write).not.toHaveBeenCalled();
    profile.form.controls.maxBrowserSessions.setValue(2);
    profile.form.controls.maxRetainedMediaBytes.setValue(0);
    profile.save();
    expect(write).toHaveBeenCalledWith(
      'PATCH',
      '/me/policy',
      expect.objectContaining({ maxBrowserSessions: 2, maxRetainedMediaBytes: 0 }),
      expect.any(Function),
    );
  });
});
