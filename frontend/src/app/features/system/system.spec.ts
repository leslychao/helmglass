import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Identity } from '../../core/identity/identity.service';
import { SignIn } from './system';

describe('explicit reauthentication', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps a revoked login visible and enables only a user-triggered fresh login after one second', () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: Identity,
          useValue: {
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
      '/oauth2/start?rd=%2Ftasks%2Fowned-task',
    );
    fixture.destroy();
  });
});
