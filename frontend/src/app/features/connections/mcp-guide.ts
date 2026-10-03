import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ClientGrant } from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { Mutation } from '../../core/api/mutation';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Status } from '../../shared/status/status';
import { Icon } from '../../shared/icon/icon';
import { Dialog } from '../../shared/dialog/dialog';
@Component({
  selector: 'hg-mcp-guide',
  imports: [DatePipe, Feedback, MutationFeedback, Status, Icon, Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="heading"><h1 tabindex="-1">Подключить ChatGPT</h1></header>
    <div class="guide-layout">
      <section class="panel">
        <header class="panel-head">
          <h2>Helm Glass в вашем ChatGPT</h2>
          <hg-icon name="chat" />
        </header>
        <div class="panel-body">
          <ol class="guide-steps">
            <li>
              <h3>Добавьте MCP-подключение</h3>
              <p>В настройках приложений ChatGPT создайте подключение к вашему Helm Glass.</p>
              <label class="field"
                >Адрес сервера<input [value]="endpoint" readonly aria-label="MCP endpoint" /></label
              ><button class="btn" (click)="copy()">Копировать адрес</button>
              <p class="small" role="status">{{ notice() }}</p>
            </li>
            <li>
              <h3>Разрешите доступ</h3>
              <p>
                Войдите в Helm Glass на странице OAuth и подтвердите нужные разрешения. Пароли от
                внешних сайтов в ChatGPT не передаются.
              </p>
            </li>
            <li>
              <h3>Продолжите вашу задачу</h3>
              <p>
                Выберите Helm Glass в чате и укажите ID подготовленной задачи. Встроенный просмотр
                открывает ту же задачу и тот же браузер.
              </p>
            </li>
          </ol>
        </div>
      </section>
      <aside class="panel">
        <header class="panel-head"><h2>Доступ приложений</h2></header>
        <div class="panel-body">
          <hg-feedback
            [loading]="grants.loading()"
            [error]="grants.error()"
            (retry)="grants.refresh()"
          />
          @for (grant of grants.data() ?? []; track grant.id) {
            <article class="grant">
              <h3>{{ grant.clientId }}</h3>
              <hg-status [value]="grant.status" />
              <p class="small">{{ grant.scopes.join(', ') }}</p>
              <p class="small muted">
                Последняя активность: {{ grant.lastUsedAt | date: 'dd.MM.yyyy HH:mm' }}
              </p>
              <div class="flex">
                <button
                  class="btn"
                  [disabled]="action.pending() || action.unknown()"
                  (click)="check(grant.id)"
                >
                  Проверить</button
                ><button
                  class="btn danger"
                  [disabled]="action.pending() || action.unknown()"
                  (click)="revokeId.set(grant.id)"
                >
                  Отозвать доступ
                </button>
              </div>
            </article>
          } @empty {
            @if (grants.data()) {
              <p class="muted">Нет подключённых клиентов.</p>
            }
          }
          <hg-mutation [action]="action" />
        </div>
      </aside>
    </div>
    @if (revokeId()) {
      <hg-dialog
        title="Отозвать доступ ChatGPT?"
        [busy]="action.pending()"
        (closed)="revokeId.set(null)"
        ><p>Новые команды клиента будут запрещены. Задачи и история останутся в кабинете.</p>
        <hg-mutation [action]="action" /><button
          dialog-actions
          class="btn danger"
          [disabled]="action.pending() || action.unknown()"
          (click)="revoke()"
        >
          Отозвать доступ
        </button></hg-dialog
      >
    }`,
})
export class McpGuide {
  readonly endpoint = location.origin + '/mcp';
  readonly grants = new ServerResource<ClientGrant[]>(['connections']);
  readonly action = new Mutation();
  readonly revokeId = signal<string | null>(null);
  readonly notice = signal('');
  constructor() {
    this.grants.load('/me/client-grants');
  }
  copy() {
    void navigator.clipboard
      .writeText(this.endpoint)
      .then(() => this.notice.set('Адрес скопирован'))
      .catch(() => this.notice.set('Выделите адрес и скопируйте его вручную.'));
  }
  check(id: string) {
    this.action.run('POST', `/me/client-grants/${id}/check`, {}, () => this.grants.refresh());
  }
  revoke() {
    this.action.run('POST', `/me/client-grants/${this.revokeId()}/revoke`, {}, () => {
      this.revokeId.set(null);
      this.grants.refresh();
    });
  }
}
