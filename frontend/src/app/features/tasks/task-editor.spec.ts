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
});
