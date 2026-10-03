import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { Navigation, safePath } from './navigation.service';
import { ResourceRouteReuse } from './resource-route-reuse';

describe('internal navigation boundaries', () => {
  afterEach(() => history.replaceState(null, ''));

  it('switches administration tabs without a back action and preserves the nested screen source', () => {
    const events = new Subject<NavigationStart | NavigationEnd>();
    TestBed.configureTestingModule({ providers: [{ provide: Router, useValue: { events } }] });
    history.replaceState(null, '');
    const navigation = TestBed.inject(Navigation);
    let sequence = 0;
    const navigate = (url: string) => {
      sequence++;
      events.next(new NavigationStart(sequence, url));
      events.next(new NavigationEnd(sequence, url, url));
    };

    navigate('/admin');
    navigate('/admin/browsers');
    expect(navigation.back()).toBeNull();
    navigate('/admin?users.page=2&users.q=anna');
    expect(navigation.back()).toBeNull();
    navigate('/admin/users/04d96ee5-2d0d-4704-b59c-7255ebc0c3e6');
    expect(navigation.back()).toEqual({
      url: '/admin?users.page=2&users.q=anna',
      label: 'К администрированию',
    });
    navigate('/admin/browsers');
    expect(navigation.back()).toBeNull();
    expect(history.state.helmSources).toEqual([]);
    events.complete();
  });

  it('restores supported task views and filters without accepting arbitrary endpoints', () => {
    expect(
      safePath('/tasks/04d96ee5-2d0d-4704-b59c-7255ebc0c3e6/result?page=2&q=hello%20world'),
    ).toBe(true);
    expect(safePath('/admin/users/04d96ee5-2d0d-4704-b59c-7255ebc0c3e6/audit')).toBe(true);
    for (const path of [
      '//evil.example',
      '/oauth2/sign_out',
      '/mcp',
      '/keycloak/admin',
      '/tasks/../mcp',
      '/tasks/%2e%2e/mcp',
      'https://evil.example',
    ])
      expect(safePath(path)).toBe(false);
  });

  it('destroys a resource owner when its id changes but reuses it for filtering', () => {
    const strategy = new ResourceRouteReuse();
    const current = new ActivatedRouteSnapshot();
    current.params = { id: 'task-1' };
    const same = new ActivatedRouteSnapshot();
    same.params = { id: 'task-1' };
    const other = new ActivatedRouteSnapshot();
    other.params = { id: 'task-2' };
    expect(strategy.shouldReuseRoute(same, current)).toBe(true);
    expect(strategy.shouldReuseRoute(other, current)).toBe(false);
  });
});
