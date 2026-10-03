import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { LoginComplete, LoginOperation } from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { Mutation } from '../../core/api/mutation';
import { BrowserPanel } from '../../shared/browser-panel/browser-panel';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Icon } from '../../shared/icon/icon';
import { LabelPipe, Status } from '../../shared/status/status';
import { AsyncOperation } from '../../shared/async-operation/async-operation';
import { Dialog } from '../../shared/dialog/dialog';
@Component({
  selector: 'hg-manual-login',
  imports: [
    FormsModule,
    BrowserPanel,
    Feedback,
    MutationFeedback,
    Icon,
    Status,
    LabelPipe,
    AsyncOperation,
    Dialog,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="heading">
      <div>
        <h1 tabindex="-1">Вход на сайт</h1>
        <p class="description">Введите данные непосредственно на сайте в приватном браузере.</p>
      </div>
      <hg-icon name="lock" />
    </header>
    <hg-feedback [loading]="login.loading()" [error]="login.error()" (retry)="login.refresh()" />
    @if (login.data(); as login) {
      @if (login.state === 'SUCCEEDED') {
        <div class="notice success" role="status">
          <strong>Вход завершён</strong>
          <p>{{ login.verification | label }}</p>
          <a
            class="btn primary"
            [routerLink]="
              login.taskId ? ['/tasks', login.taskId] : ['/connections', login.connectionId]
            "
          >
            {{ login.taskId ? 'Вернуться к задаче' : 'Вернуться к подключению' }}
          </a>
        </div>
      }
      <div class="login-layout">
        <div>
          @if (login.sessionId; as sessionId) {
            <hg-browser-panel
              [sessionId]="sessionId"
              [activeLoginOperationId]="id"
              [taskId]="login.taskId ?? undefined"
              (changed)="refresh()"
            />
          } @else {
            <section class="panel">
              <div class="viewer-empty">
                <div>
                  <hg-icon name="browser" />
                  <h3>Подготовка приватного браузера</h3>
                  <p>Ожидаем подтверждённую сессию. Новая вкладка не создаёт второй браузер.</p>
                  <button class="btn" (click)="refresh()">Проверить состояние</button>
                </div>
              </div>
            </section>
          }
          <hg-mutation [action]="action" />
          @if (action.receipt()?.operationId; as operation) {
            <hg-operation [id]="operation" />
          }
        </div>
        <aside>
          <section class="panel">
            <header class="panel-head"><h2>Приватный вход</h2></header>
            <div class="panel-body">
              <hg-status [value]="login.state" />
              <p>
                ChatGPT не видит экран входа, пароли и коды подтверждения. Вход выполняется в
                текущем браузере.
              </p>
              <label class="field"
                >Название аккаунта<input
                  [(ngModel)]="accountLabel"
                  maxlength="200"
                  placeholder="Личный / рабочий аккаунт"
              /></label>
              <fieldset>
                <legend>После входа</legend>
                <label class="checkbox"
                  ><input
                    type="radio"
                    name="save-mode"
                    value="SAVE_PROFILE"
                    [(ngModel)]="saveMode"
                  />Сохранить вход для следующих задач</label
                ><label class="checkbox"
                  ><input
                    type="radio"
                    name="save-mode"
                    value="SESSION_ONLY"
                    [(ngModel)]="saveMode"
                  />Использовать только в этой сессии</label
                >
              </fieldset>
              @if (login.taskId) {
                <label class="checkbox"
                  ><input type="checkbox" [(ngModel)]="continueAfter" />Продолжить исходную задачу в
                  ChatGPT</label
                >
              }
              <label class="checkbox"
                ><input type="checkbox" [(ngModel)]="userAsserted" />Я вошёл в нужный аккаунт и
                открыл страницу, где нет паролей и кодов подтверждения.</label
              >
              <p class="small muted">
                {{
                  login.verification
                    ? (login.verification | label)
                    : 'Подтвердите вход и отсутствие секретов на открытой странице. Сервис проверит возможность безопасного возврата.'
                }}
              </p>
              <button
                class="btn primary wide"
                [disabled]="
                  !login.capabilities['complete']?.allowed ||
                  !userAsserted ||
                  !accountLabel.trim() ||
                  browser()?.session.data()?.controllerRelation !== 'SELF' ||
                  busy()
                "
                (click)="complete()"
              >
                Я вошёл, завершить вход</button
              ><button
                class="btn quiet wide"
                [disabled]="busy() || !login.capabilities['cancel']?.allowed"
                (click)="cancelOpen.set(true)"
              >
                Отменить вход
              </button>
            </div>
          </section>
          <div class="notice neutral">
            <strong>Пароли вводятся только на сайте</strong>
            <p>
              Для OTP и MFA используйте средства сайта. Не отправляйте коды в чат или уточнения
              задачи.
            </p>
          </div>
        </aside>
      </div>
    }
    @if (cancelOpen()) {
      <hg-dialog title="Отменить вход?" [busy]="action.pending()" (closed)="cancelOpen.set(false)"
        ><p>
          Новый вход не будет сохранён. Предыдущий сохранённый профиль останется без изменений.
        </p>
        <hg-mutation [action]="action" /><button
          dialog-actions
          class="btn danger"
          [disabled]="busy()"
          (click)="cancel()"
        >
          Отменить вход
        </button></hg-dialog
      >
    }`,
})
export class ManualLogin {
  readonly browser = viewChild(BrowserPanel);
  readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';
  private router = inject(Router);
  readonly login = new ServerResource<LoginOperation>(['connections', 'tasks', 'operations']);
  readonly action = new Mutation();
  readonly cancelOpen = signal(false);
  readonly busy = computed(() => this.action.pending() || this.action.unknown());
  accountLabel = '';
  saveMode: LoginComplete['mode'] = 'SAVE_PROFILE';
  continueAfter = true;
  userAsserted = false;
  constructor() {
    this.login.load('/login-operations/' + this.id);
  }
  refresh() {
    this.login.refresh();
  }
  complete() {
    const login = this.login.data();
    const browser = this.browser();
    const session = browser?.session.data();
    if (!login || !browser || !session) return;
    const input: LoginComplete = {
      userAsserted: this.userAsserted,
      mode: this.saveMode,
      accountLabel: this.accountLabel,
      confirmedOrigins: login.origins ?? [],
      expectedVersion: login.version,
      expectedProfileVersion: session.currentProfileVersion ?? null,
      controllerInstanceId: browser.instance.id,
      controlEpoch: session.controlEpoch,
      pageEpoch: session.pageEpoch,
      continuationIntent: this.continueAfter ? 'CONTINUE' : 'KEEP_PAUSED',
    };
    this.action.run('POST', `/login-operations/${this.id}/complete`, input, () =>
      this.login.refresh(),
    );
  }
  cancel() {
    const login = this.login.data();
    if (!login) return;
    this.action.run('POST', `/login-operations/${this.id}/cancel`, {}, () => {
      this.cancelOpen.set(false);
      void this.router.navigate(
        login.taskId ? ['/tasks', login.taskId] : ['/connections', login.connectionId],
      );
    });
  }
}
