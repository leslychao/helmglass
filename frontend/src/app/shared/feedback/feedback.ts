import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Problem } from '../../core/api/models';
import { Mutation } from '../../core/api/mutation';
@Component({
  selector: 'hg-feedback',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error(); as problem) {
      <div class="notice error" role="alert">
        <strong>{{ problem.title }}</strong>
        @if (problem.detail) {
          <p>{{ problem.detail }}</p>
        }
        @if (problem.requestId) {
          <small>Запрос {{ problem.requestId }}</small>
        }
        @if (retryable()) {
          <button class="btn" (click)="retry.emit()">Повторить чтение</button>
        }
      </div>
    }
    @if (loading()) {
      <div class="loading" role="status"><span class="spinner"></span> Загрузка…</div>
    }
  `,
})
export class Feedback {
  loading = input(false);
  error = input<Problem | null>(null);
  retryable = input(true);
  retry = output<void>();
}
@Component({
  selector: 'hg-mutation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (action().error(); as problem) {
      <div class="notice error" role="alert">
        <strong>{{ problem.title }}</strong>
        @if (problem.detail) {
          <p>{{ problem.detail }}</p>
        }
        @if (problem.requestId) {
          <small>Запрос {{ problem.requestId }}</small>
        }
      </div>
    }
    @if (action().unknown()) {
      <div class="notice warning">
        <strong>Результат действия пока неизвестен</strong>
        <p>Не отправляйте действие повторно. Проверьте исходную операцию.</p>
        <button class="btn" [disabled]="action().pending()" (click)="action().recover()">
          Проверить результат
        </button>
      </div>
    }
    @if (action().pending()) {
      <p role="status"><span class="spinner"></span> Выполняется…</p>
    }
  `,
})
export class MutationFeedback {
  action = input.required<Mutation>();
}
