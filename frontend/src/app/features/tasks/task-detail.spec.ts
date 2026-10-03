import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { NEVER, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Result, Task } from '../../core/api/models';
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

describe('copy published conclusion', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const result: Result = {
    id: 'result-1',
    taskId: 'task-1',
    revision: 2,
    final: true,
    conclusion: '  Итог <без HTML>\nВторая строка.  ',
    limitations: ['Отдельное ограничение'],
    missing: [],
    columns: [],
    coverage: {},
    sections: [{ title: 'Подробности', text: 'Не входит в скопированный вывод' }],
    sources: [],
    files: [],
    createdAt: '2026-10-03T10:00:00Z',
    outputFormat: 'TEXT',
  };

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  async function render(value: Result | null = result) {
    const mutate = vi.fn(() => NEVER);
    const get = vi.fn(() => NEVER);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ id: 'task-1' }), data: { result: true } },
          },
        },
        { provide: Realtime, useValue: { refresh: new Subject() } },
        { provide: Api, useValue: { get, mutate } },
      ],
    });
    const fixture = TestBed.createComponent(TaskDetail);
    const task: Task = {
      id: 'task-1',
      displayNumber: 1,
      version: 2,
      instructionRevision: 1,
      goal: 'Проверить результат',
      title: 'Задача',
      startUrl: null,
      outputFormat: 'TEXT',
      confirmImportantActions: true,
      browserTimeLimitSeconds: 1800,
      state: 'COMPLETED',
      outcome: 'SUCCESS',
      origin: 'MCP',
      waitReason: null,
      failureCode: null,
      mutationBarrier: false,
      createdAt: result.createdAt,
      updatedAt: result.createdAt,
      connectionIds: [],
      currentSession: null,
      capabilities: {},
      contextRef: 'context',
      continuation: null,
      unresolvedHumanOperationId: null,
    };
    fixture.componentInstance.task.data.set(task);
    fixture.componentInstance.task.loading.set(false);
    fixture.componentInstance.result.data.set(value);
    fixture.componentInstance.result.loading.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    get.mockClear();
    return { fixture, root, mutate, get, navigate };
  }

  function copyButton(root: HTMLElement): HTMLButtonElement {
    const button = [...root.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Скопировать вывод',
    );
    expect(button, 'published result has its own copy conclusion action').toBeDefined();
    if (!button) throw new Error('Copy conclusion button is missing');
    return button;
  }

  it('copies only the exact published conclusion without requests, navigation or creating a task', async () => {
    let finish: () => void = () => {
      throw new Error('Clipboard has not been called');
    };
    const copied = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const writeText = vi.fn(() => copied);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { fixture, root, mutate, get, navigate } = await render();
    const button = copyButton(root);
    button.click();
    fixture.detectChanges();
    button.click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(result.conclusion);
    expect(button.disabled).toBe(true);
    expect(root.textContent).not.toContain('Вывод скопирован');
    finish();
    await copied;
    await fixture.whenStable();
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Вывод скопирован');
    expect(button.disabled).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(root.textContent).toContain('Создать похожую');
  });

  it.each(['denied', 'unavailable'])(
    'keeps the conclusion selectable when clipboard is %s',
    async (mode) => {
      const writeText = vi.fn(() => Promise.reject(new Error('Denied')));
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: mode === 'denied' ? { writeText } : undefined,
      });
      const { fixture, root, mutate } = await render();
      copyButton(root).click();
      await fixture.whenStable();
      expect(root.querySelector('[role="status"]')?.textContent).toContain(
        'Не удалось скопировать вывод. Выделите текст и скопируйте его вручную.',
      );
      expect(root.querySelector('.report-text')?.textContent).toBe(result.conclusion);
      expect(root.textContent).not.toContain('Вывод скопирован');
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it('does not offer copying when no result has been published', async () => {
    const { root } = await render(null);
    expect(root.textContent).toContain('Результата пока нет');
    expect(root.textContent).not.toContain('Скопировать вывод');
  });

  it('does not announce an old clipboard completion for a newly published result', async () => {
    let finish: () => void = () => {
      throw new Error('Clipboard has not been called');
    };
    const copied = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const writeText = vi.fn(() => copied);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { fixture, root } = await render();
    copyButton(root).click();
    fixture.componentInstance.result.data.set({
      ...result,
      id: 'result-2',
      revision: 3,
      conclusion: 'Новый вывод',
    });
    fixture.detectChanges();
    finish();
    await copied;
    await fixture.whenStable();
    expect(root.querySelector('.report-text')?.textContent).toBe('Новый вывод');
    expect(root.textContent).not.toContain('Вывод скопирован');
    expect(copyButton(root).disabled).toBe(false);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(result.conclusion);
  });
});
