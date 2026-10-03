import { TestBed } from '@angular/core/testing';
import { NEVER, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Realtime } from '../../core/realtime/realtime.service';
import { Profile } from './profile';

describe('personal queue limits', () => {
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
