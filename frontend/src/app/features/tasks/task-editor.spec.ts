import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Realtime, ResourceName } from '../../core/realtime/realtime.service';
import { TaskEditor } from './task-editor';

describe('task connection choices', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('excludes deleting connections on first load, pagination and push recovery', () => {
    const refresh = new Subject<Set<ResourceName> | null>();
    const get = vi.fn(() =>
      of({ items: [], page: 1, pageSize: 10, total: 20, snapshot: 'connections-v1' }),
    );
    const mutate = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({}) } },
        },
        { provide: Api, useValue: { get, mutate } },
        { provide: Realtime, useValue: { refresh } },
      ],
    });
    const fixture = TestBed.createComponent(TaskEditor);
    expect(get).toHaveBeenLastCalledWith(
      '/connections',
      expect.objectContaining({ page: 1, pageSize: 10, excludeStatus: 'DELETING' }),
    );
    fixture.componentInstance.connectionPage(2);
    expect(get).toHaveBeenLastCalledWith(
      '/connections',
      expect.objectContaining({ page: 2, pageSize: 10, excludeStatus: 'DELETING' }),
    );
    refresh.next(new Set(['connections']));
    expect(get).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenLastCalledWith(
      '/connections',
      expect.objectContaining({ page: 2, pageSize: 10, excludeStatus: 'DELETING' }),
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it('lets the user remove a saved selection that is no longer selectable without saving implicitly', async () => {
    const mutate = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({}) } } },
        {
          provide: Api,
          useValue: {
            get: () => of({ items: [], page: 1, pageSize: 10, total: 0, snapshot: 'empty' }),
            mutate,
          },
        },
        { provide: Realtime, useValue: { refresh: new Subject() } },
      ],
    });
    const fixture = TestBed.createComponent(TaskEditor);
    fixture.componentInstance.form.patchValue({
      goal: 'Keep my draft',
      connectionIds: ['deleted-connection'],
    });
    fixture.detectChanges();
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    const clear = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Снять выбор',
    );
    if (!clear) throw new Error('Explicit clear selection action is missing');
    expect(fixture.componentInstance.form.controls.connectionIds.value).toEqual([
      'deleted-connection',
    ]);
    clear.click();
    expect(fixture.componentInstance.form.controls.connectionIds.value).toEqual([]);
    expect(fixture.componentInstance.form.controls.goal.value).toBe('Keep my draft');
    expect(fixture.componentInstance.form.dirty).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });
});
