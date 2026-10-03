import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Query, Usage as UsageDto, UsageMetric } from '../../core/api/models';
import { validateResponse } from '../../core/api/response-contract';
import { Realtime } from '../../core/realtime/realtime.service';
import { calendarBoundary } from '../../shared/data-table/date-range';
import { Usage } from './usage';
import { UsageChart } from './usage-chart';

describe('usage reporting boundaries', () => {
  it('renders the six outcome groups with their design labels and colors', async () => {
    const usage = usageWithGroups([
      { state: 'SUCCESS', count: 2 },
      { state: 'ACTIVE', count: 8 },
      { state: 'PARTIAL', count: 3 },
      { state: 'NOT_ACHIEVED', count: 1 },
      { state: 'ERROR', count: 4 },
      { state: 'CANCELLED', count: 5 },
    ]);
    await expect(validateResponse('GET', '/usage', usage.usage.data())).resolves.toBeUndefined();
    const svg = stateChart(usage);
    expect(svg.getAttribute('aria-label')).toBe(
      'Готово: 2; В работе: 8; Частично: 3; Без успеха: 1; Ошибка: 4; Остановлено: 5',
    );
    expect(Array.from(svg.querySelectorAll('rect'), (bar) => bar.getAttribute('fill'))).toEqual([
      '#4a8cff',
      '#39ba91',
      '#a396e9',
      '#d7a665',
      '#ed7b88',
      '#b6c1d2',
    ]);
    expect(Array.from(svg.querySelectorAll('rect title'), (title) => title.textContent)).toEqual([
      'Готово: 2',
      'В работе: 8',
      'Частично: 3',
      'Без успеха: 1',
      'Ошибка: 4',
      'Остановлено: 5',
    ]);
  });

  it('rejects lifecycle states in place of the outcome group contract', async () => {
    const usage = usageWithGroups([
      { state: 'SUCCESS', count: 1 },
      { state: 'ACTIVE', count: 0 },
      { state: 'PARTIAL', count: 0 },
      { state: 'NOT_ACHIEVED', count: 0 },
      { state: 'ERROR', count: 0 },
      { state: 'CANCELLED', count: 0 },
    ]);
    const summary = usage.usage.data();
    if (!summary) throw new Error('Usage summary is missing');
    await expect(
      validateResponse('GET', '/usage', {
        ...summary,
        states: [{ state: 'COMPLETED', count: 1 }, ...summary.states.slice(1)],
      }),
    ).rejects.toMatchObject({ code: 'API_RESPONSE_INVALID' });
  });

  it('keeps measured zero groups visible alongside a nonzero partial outcome', () => {
    const usage = usageWithGroups([
      { state: 'SUCCESS', count: 0 },
      { state: 'ACTIVE', count: 0 },
      { state: 'PARTIAL', count: 1 },
      { state: 'NOT_ACHIEVED', count: 0 },
      { state: 'ERROR', count: 0 },
      { state: 'CANCELLED', count: 0 },
    ]);
    const svg = stateChart(usage);
    expect(svg.getAttribute('aria-label')).toBe(
      'Готово: 0; В работе: 0; Частично: 1; Без успеха: 0; Ошибка: 0; Остановлено: 0',
    );
    expect(Array.from(svg.querySelectorAll('rect'), (bar) => bar.getAttribute('height'))).toEqual([
      '0',
      '0',
      '130',
      '0',
      '0',
      '0',
    ]);
    expect(svg.querySelectorAll('rect')).toHaveLength(6);
  });

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

function usageWithGroups(states: UsageDto['states']): Usage {
  const params = new BehaviorSubject(convertToParamMap({ from: '2026-09-01', to: '2026-09-30' }));
  TestBed.configureTestingModule({
    providers: [
      { provide: Api, useValue: { get: () => NEVER } },
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
  const zero: UsageMetric = {
    value: 0,
    knownValue: 0,
    completeness: 'COMPLETE',
    measuredCount: 1,
    expectedCount: 1,
  };
  usage.usage.data.set({
    scope: 'TASK_COHORT',
    basis: 'TASK_CREATED',
    from: '2026-09-01T00:00:00Z',
    to: '2026-10-01T00:00:00Z',
    timezone: 'UTC',
    asOf: '2026-10-01T00:00:00Z',
    taskCount: states.reduce((total, group) => total + group.count, 0),
    terminalCount: 0,
    successfulCount: 0,
    successRate: null,
    metrics: {
      browser_seconds: zero,
      execution_seconds: zero,
      human_login_seconds: zero,
      human_control_seconds: zero,
      media_seconds: zero,
      media_bytes: zero,
      audio_analyzed_seconds: zero,
      active_agent_seconds: zero,
      command_count: zero,
    },
    daily: [],
    states,
  });
  return usage;
}

function stateChart(usage: Usage): SVGSVGElement {
  const fixture = TestBed.createComponent(UsageChart);
  fixture.componentRef.setInput('points', usage.statePoints());
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Chart element is missing');
  const svg = element.querySelector('svg');
  if (!svg) throw new Error('Chart SVG is missing');
  return svg;
}
