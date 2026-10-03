import { ChangeDetectionStrategy, Component, effect, input, output } from '@angular/core';
import { Operation } from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { Status } from '../status/status';
import { Feedback } from '../feedback/feedback';
@Component({
  selector: 'hg-operation',
  imports: [Status, Feedback],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="notice neutral">
    <strong>Состояние операции</strong>
    @if (operation.data(); as operation) {
      <p>
        <hg-status [value]="operation.state" /> <span class="small">{{ operation.id }}</span>
      </p>
      @if (operation.state !== 'SUCCEEDED' && operation.failureCode) {
        <p role="alert">{{ operation.failureCode }}</p>
      }
      @if (operation.reconciliationOutcome; as outcome) {
        <p>
          {{
            outcome === 'APPLIED'
              ? 'Действие подтверждено'
              : outcome === 'NOT_APPLIED'
                ? 'Подтверждено, что действие не выполнено'
                : 'Результат действия остаётся неизвестным. Повтор заблокирован.'
          }}
        </p>
      }
      @if (operation.state === 'UNKNOWN') {
        <p>Сервер ещё не подтвердил результат. Не повторяйте внешнее действие.</p>
      }
      @if (operation.state === 'SUCCEEDED' && operation.targetType === 'artifact') {
        <a class="btn" [href]="'/api/v1/artifacts/' + operation.targetId + '/content'" download>
          Скачать файл
        </a>
      }
    }
    <hg-feedback
      [loading]="operation.loading()"
      [error]="operation.error()"
      (retry)="operation.refresh()"
    /><button class="btn" (click)="operation.refresh()">Проверить состояние</button>
  </section>`,
})
export class AsyncOperation {
  id = input.required<string>();
  stateChanged = output<Pick<Operation, 'id' | 'state'>>();
  readonly operation = new ServerResource<Operation>(['operations']);
  constructor() {
    effect(() => this.operation.load('/operations/' + this.id()));
    effect(() => {
      const operation = this.operation.data();
      if (operation) this.stateChanged.emit({ id: operation.id, state: operation.state });
    });
  }
}
