import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';
import { Task } from '../core/models';
import { DurationPipe } from '../shared/ui';

@Component({
  selector: 'hg-task-duration',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DurationPipe],
  template: `{{ seconds() === null ? '—' : (seconds() | duration) }}`,
})
export class TaskDuration {
  readonly timing = input.required<Task['timing']>();
  readonly seconds = signal<number | null>(null);

  constructor() {
    effect((onCleanup) => {
      const { elapsedSeconds, running } = this.timing();
      this.seconds.set(elapsedSeconds);
      if (elapsedSeconds === null || !running) return;
      const receivedAt = performance.now();
      const timer = setInterval(
        () => this.seconds.set(elapsedSeconds + (performance.now() - receivedAt) / 1000),
        1000,
      );
      onCleanup(() => clearInterval(timer));
    });
  }
}
