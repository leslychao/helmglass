import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ServerResource } from '../../core/api/server-resource';
import { AdminCleanupOperation } from '../../core/api/models';
import { Mutation } from '../../core/api/mutation';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Dialog } from '../../shared/dialog/dialog';
import { LabelPipe, Status } from '../../shared/status/status';

@Component({
  selector: 'hg-admin-cleanup',
  imports: [DatePipe, FormsModule, Feedback, MutationFeedback, Dialog, LabelPipe, Status],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="panel">
      <header class="panel-head">
        <h2>Очистка аккаунта</h2>
        <button
          type="button"
          class="btn"
          [disabled]="operation.loading()"
          (click)="operation.refresh()"
        >
          Обновить
        </button>
      </header>
      <div class="panel-body">
        <hg-feedback
          [loading]="operation.loading()"
          [error]="operation.error()"
          (retry)="operation.refresh()"
        />
        @if (operation.data(); as operation) {
          <p><hg-status [value]="operation.state" /> · {{ operation.progress }}%</p>
          <p class="small muted">
            Обновлено {{ operation.updatedAt | date: 'dd.MM.yyyy HH:mm:ss' }}
          </p>
          @if (operation.failureCode) {
            <p role="alert">{{ operation.failureCode }}</p>
          }
          @if (operation.state === 'NEEDS_ATTENTION' || operation.state === 'FAILED') {
            <p>Автоматическая очистка приостановлена. Проверьте причину сбоя перед повтором.</p>
            <button type="button" class="btn" (click)="openRetry()">Повторить очистку</button>
          }
          <details class="details">
            <summary>Состояние очистки данных</summary>
            <ul class="cleanup-items">
              @for (item of operation.items; track item.key) {
                <li>
                  <span>{{ item.phase | label }}</span> <hg-status [value]="item.state" />
                  <time>{{ item.updatedAt | date: 'dd.MM.yyyy HH:mm' }}</time>
                </li>
              }
            </ul>
            @if (operation.hasMoreItems) {
              <p class="small muted">
                Показаны {{ operation.items.length }} из {{ operation.totalItems }} записей.
              </p>
            }
          </details>
        }
      </div>
    </section>
    @if (retryOpen()) {
      <hg-dialog
        title="Повторить очистку аккаунта"
        [busy]="action.pending()"
        (closed)="retryOpen.set(false)"
      >
        <p>Уже очищенные данные не восстанавливаются. Повтор продолжит незавершённую операцию.</p>
        <label class="field"
          >Причина<textarea [(ngModel)]="reason" required maxlength="1000"></textarea>
        </label>
        <hg-mutation [action]="action" />
        <div dialog-actions class="flex">
          <button
            type="button"
            class="btn"
            [disabled]="action.pending()"
            (click)="retryOpen.set(false)"
          >
            Отмена
          </button>
          <button
            type="button"
            class="btn danger"
            [disabled]="!reason.trim() || action.pending() || action.unknown()"
            (click)="retry()"
          >
            Повторить очистку
          </button>
        </div>
      </hg-dialog>
    }`,
})
export class AdminCleanup {
  readonly id = input.required<string>();
  readonly operation = new ServerResource<AdminCleanupOperation>(['operations', 'users']);
  readonly action = new Mutation();
  readonly retryOpen = signal(false);
  reason = '';

  constructor() {
    effect(() => this.operation.load('/admin/operations/' + this.id()));
  }

  openRetry() {
    this.reason = '';
    this.retryOpen.set(true);
  }

  retry() {
    const operation = this.operation.data();
    if (!operation || !this.reason.trim()) return;
    this.action.run(
      'POST',
      `/admin/operations/${operation.id}/retry`,
      {
        expectedVersion: operation.version,
        reason: this.reason.trim(),
      },
      () => {
        this.retryOpen.set(false);
        this.operation.refresh();
      },
    );
  }
}
