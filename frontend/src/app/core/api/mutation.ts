import { DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Api, problemOf } from './api.service';
import { Problem, Receipt } from './models';
import { operationKind } from './operation-kind';

export class Mutation {
  readonly pending = signal(false);
  readonly error = signal<Problem | null>(null);
  readonly receipt = signal<Receipt | null>(null);
  readonly unknown = signal(false);
  private readonly api = inject(Api);
  private readonly destroy = inject(DestroyRef);
  private key = '';
  private kind = '';
  private completed?: (receipt: Receipt) => void;

  run(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    done?: (receipt: Receipt) => void,
  ) {
    if (this.pending() || this.unknown()) return;
    const kind = operationKind(method, path);
    if (!kind) {
      this.error.set({
        status: 0,
        code: 'API_CONTRACT_MISSING',
        title: 'Для этого действия отсутствует согласованный контракт API',
      });
      return;
    }
    this.key = crypto.randomUUID();
    this.kind = kind;
    this.completed = done;
    this.pending.set(true);
    this.error.set(null);
    this.receipt.set(null);
    this.api
      .mutate(method, path, body, this.key)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (receipt) => this.accept(receipt),
        error: (error: unknown) => {
          const problem = problemOf(error);
          this.pending.set(false);
          this.error.set(problem);
          this.unknown.set(problem.status === 0 || problem.status >= 500);
        },
      });
  }

  recover() {
    if (!this.unknown() || this.pending()) return;
    this.pending.set(true);
    this.api
      .lookup(this.kind, this.key)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (receipt) => this.accept(receipt),
        error: (error: unknown) => {
          this.error.set(problemOf(error));
          this.pending.set(false);
        },
      });
  }

  private accept(receipt: Receipt) {
    const completed = this.completed;
    this.completed = undefined;
    this.receipt.set(receipt);
    this.unknown.set(false);
    this.pending.set(false);
    this.error.set(null);
    completed?.(receipt);
  }
}
