import { TestBed } from '@angular/core/testing';
import { NEVER, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Policy } from '../../core/api/models';
import { Realtime } from '../../core/realtime/realtime.service';
import { Profile } from './profile';

describe('personal queue limits', () => {
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
