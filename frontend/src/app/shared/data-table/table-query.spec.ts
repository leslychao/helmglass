import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TableQuery } from './table-query';

describe('independent table URL state', () => {
  it('changes and clears one table without resetting or reloading the other', () => {
    const initial = convertToParamMap({ 'users.page': '2', 'users.q': 'anna', 'audit.page': '3' });
    const params = new BehaviorSubject(initial);
    const navigate = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParamMap: params, snapshot: { queryParamMap: initial } },
        },
        { provide: Router, useValue: { navigate } },
      ],
    });
    const users = TestBed.runInInjectionContext(
      () => new TableQuery({ prefix: 'users', pageSize: 5 }),
    );
    const audit = TestBed.runInInjectionContext(
      () => new TableQuery({ prefix: 'audit', pageSize: 3 }),
    );
    const previousUsers = users.value();
    expect(previousUsers).toEqual({ page: 2, q: 'anna', pageSize: 5 });
    expect(audit.value()).toEqual({ page: 3, pageSize: 3 });

    params.next(convertToParamMap({ 'users.page': '2', 'users.q': 'anna', 'audit.page': '4' }));
    expect(users.value()).toBe(previousUsers);
    expect(audit.value()['page']).toBe(4);
    users.change({ page: 3 });
    expect(navigate).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({
        queryParams: { 'users.page': 3, 'users.snapshot': null },
        queryParamsHandling: 'merge',
      }),
    );
    users.clear();
    expect(navigate).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({
        queryParams: { 'users.page': null, 'users.q': null, 'users.pageSize': 5 },
        queryParamsHandling: 'merge',
      }),
    );
  });
});
