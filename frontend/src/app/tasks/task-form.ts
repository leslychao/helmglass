import { Icon } from '../shared/icon';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { Api, ApiError, errorMessage } from '../core/api';
import { Task, taskSchema } from '../core/models';
import { ConnectionPicker } from '../connections/connection-picker';
import { Session } from '../core/session';

const pendingFormSchema = z.object({
  phase: z.enum(['CREATE', 'AMEND', 'PREPARE']),
  prepare: z.boolean(),
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
    requireConfirmation: true,
    preferredConnectionIds: true,
  }),
});

@Component({
  selector: 'hg-task-form',
  imports: [Icon, ReactiveFormsModule, RouterLink, ConnectionPicker],
  templateUrl: './task-form.html',
  host: { '(window:beforeunload)': 'beforeUnload($event)' },
})
export class TaskForm {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private generation = 0;
  readonly form = inject(FormBuilder).nonNullable.group({
    goal: ['', [Validators.maxLength(20000)]],
    startUrl: ['', [Validators.maxLength(4096), Validators.pattern(/^$|^https?:\/\/[^\s]+$/i)]],
    outputFormat: ['TABLE'],
    requireConfirmation: [true],
    preferredConnectionIds: [[] as string[]],
  });
  readonly task = signal<Task | null>(null);
  private readonly baseVersion = signal<number | null>(null);
  readonly versionConflict = computed(
    () => this.mode !== 'similar' && !!this.task() && this.baseVersion() !== this.task()?.version,
  );
  readonly error = signal('');
  readonly fieldErrors = signal<Record<string, string>>({});
  readonly busy = signal(false);
  readonly loading = signal(true);
  readonly loaded = signal(false);
  readonly mode =
    this.route.snapshot.data['mode'] === 'refine'
      ? 'refine'
      : this.route.snapshot.data['mode'] === 'similar'
        ? 'similar'
        : 'edit';
  get title() {
    return this.mode === 'refine'
      ? 'Уточнить задачу'
      : this.mode === 'similar'
        ? 'Похожая задача'
        : this.route.snapshot.paramMap.has('id')
          ? 'Редактировать черновик'
          : 'Новая задача';
  }
  private readonly session = inject(Session);
  private get inputKey() {
    return (
      'helm-input:' +
      this.session.user()?.id +
      ':' +
      this.mode +
      ':' +
      (this.route.snapshot.paramMap.get('id') ?? 'new')
    );
  }
  readonly pending = signal<z.infer<typeof pendingFormSchema> | null>(null);
  private rememberPending(value: z.infer<typeof pendingFormSchema> | null) {
    this.pending.set(value);
    if (value) sessionStorage.setItem(this.inputKey + ':operation', JSON.stringify(value));
    else sessionStorage.removeItem(this.inputKey + ':operation');
  }
  canSubmit(prepare: boolean) {
    return (
      !this.busy() &&
      (!this.versionConflict() || !!this.pending()) &&
      (!this.pending() || this.pending()?.prepare === prepare)
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
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(() => {
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
          requireConfirmation: true,
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
    const context = this.route.snapshot.queryParamMap.get('back');
    void this.router.navigateByUrl('/tasks' + (context ? '?' + context : ''));
  }
  async load() {
    const generation = ++this.generation;
    try {
      const id = this.route.snapshot.paramMap.get('id');
      const task = id ? await this.api.get('/api/tasks/' + id, taskSchema) : null;
      if (generation !== this.generation) return;
      this.task.set(task);
      this.baseVersion.set(task?.version ?? null);
      if (task) this.form.patchValue({ ...task, startUrl: task.startUrl ?? '' });
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
  async save(prepare: boolean) {
    if (!this.canSubmit(prepare)) return;
    this.form.markAllAsTouched();
    const fields: Record<string, string> = {};
    if (prepare || this.mode === 'refine') {
      if (!this.form.controls.goal.value.trim()) fields['goal'] = 'Опишите цель задачи.';
      if (!this.form.controls.startUrl.value.trim())
        fields['startUrl'] = 'Укажите начальный сайт для подготовки задачи.';
    }
    this.fieldErrors.set(fields);
    if (this.form.invalid || Object.keys(fields).length) {
      this.error.set('Опишите цель задачи и проверьте адрес сайта.');
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
          phase: original && this.mode !== 'similar' ? 'AMEND' : 'CREATE',
          prepare,
          taskId: original?.id ?? null,
          version: this.baseVersion() ?? 0,
        });
      const pending = this.pending();
      if (!pending) return;
      let saved: Task;
      if (pending.phase === 'PREPARE')
        saved = await this.api.mutate(
          '/api/tasks/' + pending.taskId + '/commands',
          { type: 'PREPARE', expectedVersion: pending.version },
          taskSchema,
        );
      else if (pending.phase === 'AMEND') {
        saved = await this.api.mutate(
          '/api/tasks/' + pending.taskId + '/commands',
          { type: 'AMEND', expectedVersion: pending.version, ...values },
          taskSchema,
        );
        if (generation !== this.generation) return;
        this.task.set(saved);
        this.baseVersion.set(saved.version);
        this.preserveInput();
        if (prepare) {
          this.rememberPending({
            phase: 'PREPARE',
            prepare,
            taskId: saved.id,
            version: saved.version,
          });
          saved = await this.api.mutate(
            '/api/tasks/' + saved.id + '/commands',
            { type: 'PREPARE', expectedVersion: saved.version },
            taskSchema,
          );
        }
      } else saved = await this.api.mutate('/api/tasks', { ...values, prepare }, taskSchema);
      if (generation !== this.generation) return;
      sessionStorage.removeItem(this.inputKey);
      this.rememberPending(null);
      this.form.markAsPristine();
      await this.router.navigate(['/tasks', saved.id], { queryParamsHandling: 'preserve' });
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
