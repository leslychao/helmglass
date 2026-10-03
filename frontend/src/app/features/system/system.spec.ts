import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Identity } from '../../core/identity/identity.service';
import { Problem } from '../../core/api/models';
import { SignIn } from './system';

describe('explicit reauthentication', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps a revoked login visible and enables only a user-triggered fresh login after one second', () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: Identity,
          useValue: {
            me: signal(null),
            error: signal({
              status: 401,
              code: 'REAUTHENTICATION_REQUIRED',
              title: 'Fresh authentication is required',
            }),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: convertToParamMap({ returnTo: '/tasks/owned-task' }),
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(SignIn);
    fixture.detectChanges();
    const element: unknown = fixture.nativeElement;
    if (!(element instanceof HTMLElement)) throw new Error('Sign-in element is missing');
    expect(element.textContent).toContain('Сессия отозвана');
    expect(element.querySelector('button[disabled]')).not.toBeNull();
    expect(element.querySelector('a[href^="/oauth2/start"]')).toBeNull();
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();
    expect(element.querySelector('a[href^="/oauth2/start"]')?.getAttribute('href')).toBe(
      '/oauth2/start?rd=' +
        encodeURIComponent('/sign-in?complete=1&returnTo=%2Ftasks%2Fowned-task'),
    );
    fixture.destroy();
  });

  function signIn(error: Problem | null, query: Record<string, string> = {}, allowed = false) {
    const identity = {
      me: signal(null),
      error: signal(error),
      load: vi.fn(() => {
        if (!allowed)
          identity.error.set({ status: 401, code: 'AUTHENTICATION_REQUIRED', title: 'Войдите' });
        return of(allowed);
      }),
    };
    const replace = vi.fn();
    vi.stubGlobal('location', { replace });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Identity, useValue: identity },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(query) } },
        },
      ],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(SignIn);
    fixture.detectChanges();
    return { fixture, identity, replace, navigate };
  }

  it('opens the branded credential form directly and preserves an allowed deep link', () => {
    const { fixture, replace, identity } = signIn(null, {
      returnTo: '/connections/account?tab=history',
    });
    const login = new URL(replace.mock.calls[0][0], 'https://helm.example.test');
    const callback = new URL(login.searchParams.get('rd')!, login.origin);
    expect(callback.pathname).toBe('/sign-in');
    expect(callback.searchParams.get('complete')).toBe('1');
    expect(callback.searchParams.get('returnTo')).toBe('/connections/account?tab=history');
    expect(identity.load).toHaveBeenCalledOnce();
    fixture.destroy();
  });

  it.each([
    'https://evil.test',
    '//evil.test',
    '/oauth2/start',
    '/sign-in',
    '/tasks/../oauth2/start',
  ])('rejects an unsafe return path: %s', (returnTo) => {
    const { fixture, replace } = signIn(null, { returnTo });
    const login = new URL(replace.mock.calls[0][0], 'https://helm.example.test');
    const callback = new URL(login.searchParams.get('rd')!, login.origin);
    expect(callback.searchParams.get('returnTo')).toBe('/tasks');
    fixture.destroy();
  });

  it('verifies the callback then returns to the original page', () => {
    const { fixture, replace, navigate } = signIn(
      null,
      { complete: '1', returnTo: '/profile' },
      true,
    );
    expect(navigate).toHaveBeenCalledWith('/profile', { replaceUrl: true });
    expect(replace).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('leaves a failed callback visible without an automatic login loop', () => {
    const { fixture, replace } = signIn(null, { complete: '1' });
    expect(fixture.componentInstance.checking()).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('shows incomplete provider logout without claiming a fully closed session', () => {
    const { fixture, replace, identity } = signIn(null, { logoutPending: '1' });
    expect(fixture.componentInstance.logoutPending).toBe(true);
    expect(fixture.componentInstance.checking()).toBe(false);
    expect(identity.load).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('does not repeat the guard request or hide an access failure', () => {
    const { fixture, replace, identity } = signIn({
      status: 403,
      code: 'ACCOUNT_BLOCKED',
      title: 'Нет доступа',
    });
    expect(identity.load).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(fixture.componentInstance.checking()).toBe(false);
    fixture.destroy();
  });
});
