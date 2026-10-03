import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Api, problemOf } from '../../core/api/api.service';
import { Connection, Page, Problem, Task, TaskInput } from '../../core/api/models';
import { Mutation } from '../../core/api/mutation';
import { ServerResource } from '../../core/api/server-resource';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Icon } from '../../shared/icon/icon';
import { Dialog } from '../../shared/dialog/dialog';
import { Status } from '../../shared/status/status';
import { protectUnsavedChanges } from '../../core/navigation/unsaved-changes';
import { FormSection } from '../../shared/form-section/form-section';
import { SiteMark } from '../../shared/site-mark/site-mark';

@Component({
  selector: 'hg-task-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    Feedback,
    MutationFeedback,
    Icon,
    Dialog,
    Status,
    FormSection,
    SiteMark,
  ],
  templateUrl: './task-editor.html',
})
export class TaskEditor {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(Api);
  private destroy = inject(DestroyRef);
  private fb = inject(FormBuilder);
  readonly id = this.route.snapshot.paramMap.get('id');
  readonly action = new Mutation();
  readonly connections = new ServerResource<Page<Connection>>(['connections']);
  readonly loading = signal(false);
  readonly loadError = signal<Problem | null>(null);
  readonly picker = signal(false);
  readonly submitted = signal(false);
  private version = 0;
  readonly formats = [
    { value: 'TABLE', label: 'Таблица', hint: 'Строки и столбцы', icon: 'grid' },
    { value: 'FILE', label: 'Файл', hint: 'Готовый файл для скачивания', icon: 'file' },
    { value: 'TEXT', label: 'Текстовый ответ', hint: 'Краткий результат', icon: 'tasks' },
  ];
  readonly form = this.fb.group({
    goal: this.fb.nonNullable.control('', Validators.maxLength(16000)),
    startUrl: this.fb.nonNullable.control('', Validators.pattern(/^https?:\/\/.+/)),
    connectionIds: this.fb.nonNullable.control<string[]>([]),
    outputFormat: this.fb.nonNullable.control<TaskInput['outputFormat']>('TEXT'),
    confirmImportantActions: this.fb.nonNullable.control(false),
    browserTimeLimitSeconds: this.fb.nonNullable.control(1800, [
      Validators.required,
      Validators.min(60),
      Validators.max(86400),
      Validators.pattern(/^\d+$/),
    ]),
  });
  readonly disabled = computed(
    () => this.loading() || this.action.pending() || this.action.unknown(),
  );
  readonly connectionTiles = computed(() => this.connections.data()?.items.slice(0, 5) ?? []);
  connectionPage(page: number) {
    this.connections.load('/connections', { page, pageSize: 10, excludeStatus: 'DELETING' });
  }
  constructor() {
    this.connectionPage(1);
    if (this.id) {
      this.loading.set(true);
      this.api
        .get<Task>(`/tasks/${this.id}`)
        .pipe(takeUntilDestroyed(this.destroy))
        .subscribe({
          next: (task) => {
            if (task.state !== 'DRAFT') {
              void this.router.navigate(['/tasks', task.id]);
              return;
            }
            this.version = task.version;
            this.form.patchValue({ ...task, startUrl: task.startUrl ?? '' });
            this.loading.set(false);
          },
          error: (error: unknown) => {
            this.loadError.set(problemOf(error));
            this.loading.set(false);
          },
        });
    }
  }
  toggleConnection(id: string) {
    const control = this.form.controls.connectionIds;
    control.setValue(
      control.value.includes(id)
        ? control.value.filter((value) => value !== id)
        : [...control.value, id],
    );
    this.form.markAsDirty();
  }
  save(intent: 'DRAFT' | 'PREPARE') {
    this.submitted.set(true);
    if (this.form.invalid || (intent === 'PREPARE' && !this.form.controls.goal.value.trim())) {
      this.form.markAllAsTouched();
      document
        .getElementById(!this.form.controls.goal.value.trim() ? 'goal' : 'start-url')
        ?.focus();
      return;
    }
    const input = this.form.getRawValue();
    if (!this.id) {
      this.action.run('POST', '/tasks', { ...input, intent }, (receipt) => {
        this.form.markAsPristine();
        void this.router.navigate(['/tasks', receipt.resource.id], { replaceUrl: true });
      });
      return;
    }
    this.action.run(
      'PATCH',
      `/tasks/${this.id}`,
      { ...input, expectedVersion: this.version },
      (receipt) => {
        this.version = receipt.resource.version;
        if (intent === 'PREPARE') {
          this.action.run(
            'POST',
            `/tasks/${this.id}/prepare`,
            { expectedVersion: this.version },
            () => {
              this.form.markAsPristine();
              void this.router.navigate(['/tasks', this.id], { replaceUrl: true });
            },
          );
        } else {
          this.form.markAsPristine();
          void this.router.navigate(['/tasks', this.id], { replaceUrl: true });
        }
      },
    );
  }
  readonly canLeave = protectUnsavedChanges(() => this.form.dirty);
}
