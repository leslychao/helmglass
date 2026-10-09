import { Component, input } from '@angular/core';
import { Icon } from './icon';

@Component({
  selector: 'hg-kpi-section',
  imports: [Icon],
  template: `
    <details class="kpi-section">
      <summary>
        <hg-icon name="chevron-right" /><span>{{ label() }}</span>
      </summary>
      <div class="kpi-content"><ng-content /></div>
    </details>
  `,
})
export class KpiSection {
  readonly label = input('Показатели');
}
