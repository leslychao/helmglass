import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'hg-form-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="panel form-step-v">
    <span class="step-num-v">{{ number() }}</span>
    <div>
      <h2>{{ title() }}</h2>
      <p class="form-sub">{{ hint() }}</p>
      <ng-content />
    </div>
  </section>`,
  host: { style: 'display:block;min-width:0' },
})
export class FormSection {
  number = input.required<number>();
  title = input.required<string>();
  hint = input('');
}
