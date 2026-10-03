import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Icon } from '../icon/icon';

const knownSites: Readonly<Partial<Record<string, { mark: string; text: string }>>> = {
  'ozon.ru': { mark: 'ozon', text: 'OZON' },
  'wildberries.ru': { mark: 'wb', text: 'WB' },
  'hh.ru': { mark: 'hh', text: 'hh' },
  'web.telegram.org': { mark: 'telegram', text: '↗' },
};
@Component({
  selector: 'hg-site-mark',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="site-mark" [class]="site()?.mark || 'supplier'" aria-hidden="true">
    @if (site(); as site) {
      {{ site.text }}
    } @else {
      <hg-icon name="globe" />
    }
  </span>`,
  host: { style: 'display:inline-flex;flex:none' },
})
export class SiteMark {
  host = input('');
  readonly site = computed(() => knownSites[this.host().replace(/^www\./, '')]);
}
