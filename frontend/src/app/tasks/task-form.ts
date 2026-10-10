import { Icon } from '../shared/icon';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import * as z from 'zod/mini';
import { Api, ApiError, errorMessage } from '../core/api';
import { Task, taskSchema } from '../core/models';
import { ConnectionPicker } from '../connections/connection-picker';
import { Session } from '../core/session';
import { PageContext, pageReturnLabel, pageReturnUrl } from '../core/page-context';
import { Tooltip } from '../shared/tooltip';
import { combineLatest, distinctUntilChanged, map } from 'rxjs';

const pendingFormSchema = z.object({
  phase: z.enum(['CREATE', 'AMEND']),
  taskId: z.nullable(z.string()),
  version: z.number(),
});
const draftFormSchema = z.object({
  taskId: z.nullable(z.string()),
  baseVersion: z.nullable(z.number()),
  values: z.pick(taskSchema, {
    goal: true,
    startUrl: true,
    outputFormat: true,
    preferredConnectionIds: true,
  }),
});

@Component({
  selector: 'hg-task-form',
  imports: [Icon, ReactiveFormsModule, ConnectionPicker, Tooltip],
  templateUrl: './task-form.html',
  styleUrl: './task-form.css',
  host: { '(window:beforeunload)': 'beforeUnload($event)' },
})
export class TaskForm {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly pageContext = inject(PageContext);
  private readonly destroy = inject(DestroyRef);
  private generation = 0;
  readonly form = inject(FormBuilder).nonNullable.group({
    goal: ['', [Validators.maxLength(20000)]],
    startUrl: ['', [Validators.maxLength(4096), Validators.pattern(/^$|^https?:\/\/[^\s]+$/i)]],
    outputFormat: ['TABLE'],
    preferredConnectionIds: [[] as string[]],
  });
  readonly task = signal<Task | null>(null);
  private readonly baseVersion = signal<number | null>(null);
  readonly versionConflict = computed(
    () => !!this.task() && this.baseVersion() !== this.task()?.version,
  );
  readonly error = signal('');
  readonly fieldErrors = signal<Record<string, string>>({});
  readonly busy = signal(false);
  readonly loading = signal(true);
  readonly loaded = signal(false);
  get title() {
    return this.route.snapshot.paramMap.has('id') ? 'Редактировать черновик' : 'Новая задача';
  }
  get returnLabel() {
    return pageReturnLabel(pageReturnUrl(this.route, this.router, '/tasks').toString());
  }
  private readonly session = inject(Session);
  private get inputKey() {
    return (
      'helm-input:' +
      this.session.user()?.id +
      ':' +
      'edit' +
      ':' +
      (this.route.snapshot.paramMap.get('id') ??
        'new' +
          (this.route.snapshot.queryParamMap.get('copy')
            ? ':copy:' + this.route.snapshot.queryParamMap.get('copy')
            : ''))
    );
  }
  readonly pending = signal<z.infer<typeof pendingFormSchema> | null>(null);
  private rememberPending(value: z.infer<typeof pendingFormSchema> | null) {
    this.pending.set(value);
    if (value) sessionStorage.setItem(this.inputKey + ':operation', JSON.stringify(value));
    else sessionStorage.removeItem(this.inputKey + ':operation');
  }
  canSubmit() {
    return (
      !this.busy() &&
      (!this.versionConflict() || !!this.pending())
    );
  }
  private preserveInput() {
    sessionStorage.setItem(
      this.inputKey,
      JSON.stringify({
        taskId: this.task()?.id ?? null,
        baseVersion: this.baseVersion(),
        values: this.form.getRawValue(),
      }),
    );
  }
  acceptCurrentVersion() {
    this.baseVersion.set(this.task()?.version ?? null);
    this.preserveInput();
  }
  constructor() {
    this.destroy.onDestroy(() => {
      this.generation++;
    });
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      if (this.form.dirty) this.preserveInput();
    });
    combineLatest([this.route.paramMap, this.route.queryParamMap])
      .pipe(
        map(([params, query]) => [params.get('id'), query.get('copy')].join(':')),
        distinctUntilChanged(),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.task.set(null);
        this.baseVersion.set(null);
        this.pending.set(null);
        this.busy.set(false);
        this.loading.set(true);
        this.loaded.set(false);
        this.fieldErrors.set({});
        this.form.reset(
          {
            goal: '',
            startUrl: '',
            outputFormat: 'TABLE',
            preferredConnectionIds: [],
          },
          { emitEvent: false },
        );
        this.form.enable({ emitEvent: false });
        void this.load();
      });
  }
  hasChanges() {
    return this.form.dirty;
  }
  beforeUnload(event: BeforeUnloadEvent) {
    if (this.hasChanges() && this.session.user()) event.preventDefault();
  }
  back() {
    void this.router.navigateByUrl(pageReturnUrl(this.route, this.router, '/tasks'));
  }
  async load() {
    const generation = ++this.generation;
    try {
      const id = this.route.snapshot.paramMap.get('id');
      const copy = id ? null : this.route.snapshot.queryParamMap.get('copy');
      const source = id ?? copy;
      const parameters = source ? await this.api.get('/api/tasks/' + source, taskSchema) : null;
      const task = id ? parameters : null;
      if (generation !== this.generation) return;
      if (task && task.status !== 'DRAFT') {
        await this.router.navigate(['/tasks', task.id], {
          queryParams: {
            tab: 'overview',
            back: this.route.snapshot.queryParamMap.get('back'),
            return: this.route.snapshot.queryParamMap.get('return'),
          },
          replaceUrl: true,
        });
        return;
      }
      this.task.set(task);
      this.baseVersion.set(task?.version ?? null);
      if (task) this.pageContext.setResource('tasks', task.id, task.title);
      if (parameters) {
        this.form.patchValue({
          goal: parameters.goal,
          startUrl: parameters.startUrl ?? '',
          outputFormat: parameters.outputFormat,
          preferredConnectionIds: parameters.preferredConnectionIds,
        });
        if (copy) this.form.markAsDirty();
      }
      const input = sessionStorage.getItem(this.inputKey);
      if (input) {
        const parsed = draftFormSchema.safeParse(JSON.parse(input));
        if (parsed.success && parsed.data.taskId === (task?.id ?? null)) {
          this.baseVersion.set(parsed.data.baseVersion);
          this.form.patchValue({
            ...parsed.data.values,
            startUrl: parsed.data.values.startUrl ?? '',
          });
          this.form.markAsDirty();
        }
      }
      const operation = sessionStorage.getItem(this.inputKey + ':operation');
      if (operation) {
        const parsed = pendingFormSchema.safeParse(JSON.parse(operation));
        if (parsed.success) {
          this.pending.set(parsed.data);
          this.form.disable({ emitEvent: false });
          this.form.markAsDirty();
        }
      }
      this.error.set('');
      this.loaded.set(true);
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
  selectConnections(ids: string[]) {
    this.form.markAsDirty();
    this.form.controls.preferredConnectionIds.setValue(ids);
  }
  async save() {
    if (!this.canSubmit()) return;
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.error.set('Проверьте поручение и адрес сайта.');
      return;
    }
    this.busy.set(true);
    const generation = this.generation;
    this.error.set('');
    this.fieldErrors.set({});
    try {
      const original = this.task();
      const values = this.form.getRawValue();
      this.form.disable({ emitEvent: false });
      this.preserveInput();
      if (!this.pending())
        this.rememberPending({
          phase: original ? 'AMEND' : 'CREATE',
          taskId: original?.id ?? null,
          version: this.baseVersion() ?? 0,
        });
      const pending = this.pending();
      if (!pending) return;
      let saved: Task;
      if (pending.phase === 'AMEND') {
        saved = await this.api.mutate(
          '/api/tasks/' + pending.taskId + '/commands',
          { type: 'AMEND', expectedVersion: pending.version, ...values },
          taskSchema,
        );
      } else saved = await this.api.mutate('/api/tasks', values, taskSchema);
      if (generation !== this.generation) return;
      sessionStorage.removeItem(this.inputKey);
      this.rememberPending(null);
      this.form.markAsPristine();
      await this.router.navigate(['/tasks', saved.id], {
        queryParams: {
          back: this.route.snapshot.queryParamMap.get('back'),
          return: this.route.snapshot.queryParamMap.get('return'),
        },
      });
    } catch (error: unknown) {
      if (generation !== this.generation) return;
      this.error.set(errorMessage(error));
      if (error instanceof ApiError) this.fieldErrors.set(error.fields);
      if (error instanceof ApiError && error.uncertain) this.form.disable({ emitEvent: false });
      else {
        this.rememberPending(null);
        this.form.enable({ emitEvent: false });
      }
      if (error instanceof ApiError && error.status === 409 && this.task()) {
        try {
          const task = await this.api.get('/api/tasks/' + this.task()?.id, taskSchema);
          if (generation === this.generation) this.task.set(task);
        } catch (refreshError: unknown) {
          if (generation === this.generation) this.error.set(errorMessage(refreshError));
        }
      }
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
}
