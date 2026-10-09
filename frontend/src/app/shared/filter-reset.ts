import { Component, inject, input } from '@angular/core';
import { Icon } from './icon';
import { QueryState } from './query-state';
import { Tooltip } from './tooltip';

@Component({
  selector: 'hg-filter-reset',
  imports: [Icon, Tooltip],
  template: `
    @if (query.hasFilters(keys())) {
      <button
        type="button"
        class="icon-button reset-filters"
        aria-label="Сбросить фильтры"
        hgTooltip="Сбросить фильтры"
        (click)="query.clearFilters(keys(), pageKey())"
      >
        <hg-icon name="reset-filters" />
      </button>
    }
  `,
})
export class FilterReset {
  readonly query = inject(QueryState);
  readonly keys = input.required<readonly string[]>();
  readonly pageKey = input('page');
}
