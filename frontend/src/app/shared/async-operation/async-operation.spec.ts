import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Operation } from '../../core/api/models';
import { Realtime } from '../../core/realtime/realtime.service';
import { AsyncOperation } from './async-operation';

describe('asynchronous operation outcome', () => {
  const operation: Operation = {
    id: 'a570dfb5-7756-42c3-b471-31b6d2049e80',
    kind: 'browser.reload',
    targetType: 'browser-session',
    targetId: '0389759f-be58-48a7-808c-bac5f2002bff',
    state: 'SUCCEEDED',
    version: 3,
    progress: 100,
    failureCode: 'HANDLER_COMPLETED',
    createdAt: '2026-10-03T22:29:55Z',
    updatedAt: '2026-10-03T22:29:56Z',
  };

  function render(value: Operation) {
    const response = new Subject<Operation>();
    TestBed.configureTestingModule({
      providers: [
        { provide: Api, useValue: { get: () => response } },
        { provide: Realtime, useValue: { refresh: new Subject() } },
      ],
    });
    const fixture = TestBed.createComponent(AsyncOperation);
    const changed = vi.fn();
    fixture.componentInstance.stateChanged.subscribe(changed);
    fixture.componentRef.setInput('id', value.id);
    fixture.detectChanges();
    response.next(value);
    fixture.detectChanges();
    return { fixture, changed, element: fixture.nativeElement as HTMLElement };
  }

  it('shows success without a failure alert for an already stored receipt summary', () => {
    const { element, changed } = render(operation);
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.textContent).not.toContain('HANDLER_COMPLETED');
    expect(changed).toHaveBeenLastCalledWith({ id: operation.id, state: 'SUCCEEDED' });
  });

  it.each(['FAILED', 'NEEDS_ATTENTION', 'UNKNOWN'])(
    'preserves the failure explanation for %s',
    (state) => {
      const { element } = render({ ...operation, state, failureCode: 'NAVIGATION_FAILED' });
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('NAVIGATION_FAILED');
      if (state === 'UNKNOWN')
        expect(element.textContent).toContain('Не повторяйте внешнее действие');
    },
  );

  it('keeps the successful artifact download with no false error', () => {
    const { element } = render({
      ...operation,
      targetType: 'artifact',
      failureCode: 'SCREENSHOT_PUBLISHED',
    });
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector('a[download]')?.getAttribute('href')).toBe(
      `/api/v1/artifacts/${operation.targetId}/content`,
    );
  });
});
