import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Query } from '../../core/api/models';
import { Realtime } from '../../core/realtime/realtime.service';
import { calendarBoundary } from '../../shared/data-table/date-range';
import { Usage } from './usage';
import { UsageChart } from './usage-chart';

describe('usage reporting boundaries', () => {
  it('restores the URL cohort and changes site pages without reloading the summary', () => {
    const params = new BehaviorSubject(
      convertToParamMap({ from: '2026-09-01', to: '2026-09-30', state: 'COMPLETED' }),
    );
    const get = vi.fn((_path: string, _query?: Query) => NEVER);
    TestBed.configureTestingModule({
      providers: [
        { provide: Api, useValue: { get } },
        { provide: Realtime, useValue: { refresh: new Subject() } },
        {
          provide: ActivatedRoute,
          useValue: { queryParamMap: params, snapshot: { queryParamMap: params.value } },
        },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    });
    const usage = TestBed.runInInjectionContext(() => new Usage());
    TestBed.tick();
    expect(get.mock.calls.filter(([path]) => path === '/usage')).toHaveLength(1);
    expect(get.mock.calls.find(([path]) => path === '/usage')?.[1]).toMatchObject({
      from: calendarBoundary('2026-09-01', false),
      to: calendarBoundary('2026-09-30', true),
      state: ['COMPLETED'],
    });
    params.next(
      convertToParamMap({ from: '2026-09-01', to: '2026-09-30', state: 'COMPLETED', page: 2 }),
    );
    TestBed.tick();
    expect(get.mock.calls.filter(([path]) => path === '/usage')).toHaveLength(1);
    expect(get.mock.calls.filter(([path]) => path === '/usage/sites')).toHaveLength(2);
    params.next(convertToParamMap({ from: '2026-09-05', to: '2026-09-07', state: 'FAILED' }));
    TestBed.tick();
    expect(usage.from).toBe('2026-09-05');
    expect(usage.to).toBe('2026-09-07');
    expect(get.mock.calls.filter(([path]) => path === '/usage')).toHaveLength(2);
    params.next(convertToParamMap({ from: '2026-02-30', to: '2026-03-07' }));
    TestBed.tick();
    expect(usage.rangeError()).not.toBe('');
    expect(usage.usage.loading()).toBe(false);
    expect(usage.usage.data()).toBeNull();
    expect(get.mock.calls.filter(([path]) => path === '/usage')).toHaveLength(2);
    params.next(convertToParamMap({ from: '2026-03-01', to: '2026-03-07' }));
    TestBed.tick();
    expect(usage.rangeError()).toBe('');
    expect(get.mock.calls.filter(([path]) => path === '/usage')).toHaveLength(3);
  });

  it('leaves a gap for unknown browser time while retaining a measured zero', () => {
    const fixture = TestBed.createComponent(UsageChart);
    fixture.componentRef.setInput('kind', 'line');
    fixture.componentRef.setInput('points', [
      { key: 'one', label: '01', value: 0, description: '01: 0 минут' },
      { key: 'two', label: '02', value: null, description: '02: Нет данных' },
      { key: 'three', label: '03', value: 20, description: '03: 20 минут' },
    ]);
    fixture.detectChanges();
    const element: unknown = fixture.nativeElement;
    if (!(element instanceof HTMLElement)) throw new Error('Chart element is missing');
    const svg = element.querySelector('svg');
    const path = svg?.querySelector('path');
    if (!svg || !path) throw new Error('Chart SVG path is missing');
    expect(svg.getAttribute('aria-label')).toContain('02: Нет данных');
    expect(svg.querySelectorAll('circle')).toHaveLength(2);
    expect(path.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    expect(path.getAttribute('d')).not.toContain('L');
  });
});
