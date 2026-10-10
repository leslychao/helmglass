import { DatePipe } from '@angular/common';
import { Component, input } from '@angular/core';
import * as z from 'zod/mini';
import { stepLabels, stepSchema } from '../core/models';
import { Icon, IconName } from '../shared/icon';

@Component({
  selector: 'hg-browser-steps',
  imports: [DatePipe, Icon],
  styleUrl: './steps.css',
  template: `
    <ol class="history-list">
      @for (event of steps(); track event.id) {
        <li [attr.data-event]="event.status">
          <span class="history-mark"><hg-icon [name]="icons[event.status]" /></span>
          <div class="history-event-heading">
            <strong>{{ event.title }}</strong
            ><time>{{ event.createdAt | date: 'HH:mm:ss' }}</time>
          </div>
          <small>{{ stepLabels[event.status] }} · {{ event.tool }}
            @if (event.durationMs !== null) { · {{ event.durationMs }} мс }
          </small>
          @if (event.result) {
            <p>{{ event.result }}</p>
          }
        </li>
      }
    </ol>
  `,
})
export class BrowserSteps {
  readonly steps = input<readonly z.infer<typeof stepSchema>[]>();
  readonly stepLabels = stepLabels;
  readonly icons: Readonly<Record<z.infer<typeof stepSchema>['status'], IconName>> = {
    RUNNING: 'gpt',
    SUCCEEDED: 'check',
    FAILED: 'alert',
  };
}
