import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NEVER, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Realtime } from '../../core/realtime/realtime.service';
import { TaskDetail } from './task-detail';

describe('task browser confirmation', () => {
  const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    for (const [name, original] of [
      ['showModal', originalShow],
      ['close', originalClose],
    ] as const) {
      if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    }
  });

  it.each([409, 0])(
    'shows a failed browser open inside the active dialog (status %s)',
    async (status) => {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.open = true;
        },
      });
      Object.defineProperty(HTMLDialogElement.prototype, 'close', {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.open = false;
        },
      });
      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          {
            provide: ActivatedRoute,
            useValue: {
              snapshot: { paramMap: convertToParamMap({ id: 'task-1' }), data: {} },
            },
          },
          { provide: Realtime, useValue: { refresh: new Subject() } },
          {
            provide: Api,
            useValue: {
              get: () => NEVER,
              mutate: () =>
                throwError(
                  () =>
                    new HttpErrorResponse({
                      status,
                      error: {
                        title: 'Browser unavailable',
                        detail: 'The browser budget is exhausted',
                      },
                    }),
                ),
            },
          },
        ],
      });
      const fixture = TestBed.createComponent(TaskDetail);
      fixture.componentInstance.openDialog.set(true);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.componentInstance.action.run('POST', '/tasks/task-1/browser-sessions', {});
      fixture.detectChanges();

      const root: HTMLElement = fixture.nativeElement;
      const dialog = root.querySelector('dialog[open]');
      expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain('Browser unavailable');
      expect(root.querySelectorAll('[role="alert"]')).toHaveLength(1);
      if (status === 0) {
        expect(dialog?.textContent).toContain('Проверить результат');
        expect(dialog?.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(true);
      }
    },
  );
});
