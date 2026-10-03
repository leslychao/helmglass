import { PlatformLocation } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../app.config';

describe('application XSRF configuration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds the session CSRF cookie to a same-origin write', () => {
    TestBed.configureTestingModule({
      providers: [...appConfig.providers, provideHttpClientTesting()],
    });
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-helm_csrf=fixture-csrf');
    vi.spyOn(TestBed.inject(PlatformLocation), 'href', 'get').mockReturnValue(
      'https://helm.integration.test:8443/tasks/new',
    );
    TestBed.inject(HttpClient).post('/api/v1/tasks', { goal: 'A task' }).subscribe();
    const http = TestBed.inject(HttpTestingController);
    const request = http.expectOne('/api/v1/tasks');
    expect(request.request.headers.get('X-XSRF-TOKEN')).toBe('fixture-csrf');
    request.flush({});
    http.verify();
  });
});
