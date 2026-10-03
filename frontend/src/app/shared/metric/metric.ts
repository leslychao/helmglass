import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Icon } from '../icon/icon';
import { NgTemplateOutlet } from '@angular/common';

@Component({
  selector: 'hg-metric',
  imports: [Icon, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (interactive()) {
      <button
        type="button"
        class="metric h-attention-metric"
        [disabled]="disabled()"
        (click)="selected.emit()"
      >
        <ng-container [ngTemplateOutlet]="content" />
      </button>
    } @else {
      <div class="metric"><ng-container [ngTemplateOutlet]="content" /></div>
    }
    <ng-template #content
      ><div class="dash-metric">
        <span
          class="metric-mark"
          [class.green]="tone() === 'green'"
          [class.violet]="tone() === 'violet'"
          ><hg-icon [name]="icon()"
        /></span>
        <div>
          <div class="metric-label">{{ label() }}</div>
          <div class="metric-value">{{ value() ?? 'Нет данных' }}</div>
          <div class="metric-caption">{{ caption() }}</div>
        </div>
      </div></ng-template
    >
  `,
  host: { class: 'metric-component' },
})
export class Metric {
  label = input.required<string>();
  value = input<string | number | null | undefined>();
  caption = input('');
  icon = input('tasks');
  tone = input('');
  interactive = input(false);
  disabled = input(false);
  selected = output<void>();
}
