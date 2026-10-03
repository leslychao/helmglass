import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Policy } from '../../core/api/models';
import { ServerResource } from '../../core/api/server-resource';
import { Mutation } from '../../core/api/mutation';
import { Identity } from '../../core/identity/identity.service';
import { Feedback, MutationFeedback } from '../../shared/feedback/feedback';
import { Icon } from '../../shared/icon/icon';
import { protectUnsavedChanges } from '../../core/navigation/unsaved-changes';
@Component({
  selector: 'hg-profile',
  imports: [ReactiveFormsModule, Feedback, MutationFeedback, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="heading">
      <div>
        <h1 tabindex="-1">Профиль</h1>
        <p class="description">Учётная запись, доступ к сайтам и настройки автоматизации.</p>
      </div>
    </header>
    <div class="profile-layout-v">
      <section class="panel">
        <div class="profile-summary-v">
          <span class="big-avatar">{{
            identity.me()?.displayName?.slice(0, 2)?.toUpperCase()
          }}</span>
          <div>
            <h2>{{ identity.me()?.displayName }}</h2>
            <p>{{ identity.me()?.email }}</p>
          </div>
        </div>
        <a class="btn full" href="/auth/realms/helm/account/"
          ><hg-icon name="lock" />Управление аккаунтом</a
        >
        <p class="help-text-v mt">Данные аккаунта и способы входа управляются через Keycloak.</p>
      </section>
      <section class="panel">
        <header class="panel-head">
          <h2>Автоматизация и ограничения</h2>
          <hg-icon name="shield" />
        </header>
        <div class="panel-body">
          <p class="small muted mb">
            По умолчанию все сайты и действия разрешены в рамках поручения. Подтверждения и лимиты
            выключены. Изменения применяются также к продолжающимся задачам.
          </p>
          <hg-feedback
            [loading]="policy.loading()"
            [error]="policy.error()"
            (retry)="policy.refresh()"
          />
          <form [formGroup]="form" (ngSubmit)="save()">
            <div>
              <div>
                <div class="field">
                  <label for="site-mode">Доступ к сайтам</label
                  ><select id="site-mode" formControlName="siteMode">
                    <option value="ALL">Все сайты</option>
                    <option value="ALLOW_LIST">Только из списка</option>
                    <option value="DENY_LIST">Все, кроме списка</option>
                  </select>
                </div>
                <div class="field">
                  <label for="origins">Адреса сайтов, по одному на строку</label
                  ><textarea
                    id="origins"
                    formControlName="origins"
                    placeholder="https://example.org"
                  ></textarea
                  ><small
                    >Сравнивается точный origin. Поддомены не добавляются автоматически.</small
                  >
                </div>
                <div class="field">
                  <label for="connection-mode">Подключения</label
                  ><select id="connection-mode" formControlName="connectionMode">
                    <option value="AUTO">Автоматический подбор</option>
                    <option value="EXPLICIT">Только явно выбранные</option>
                    <option value="PUBLIC_ONLY">Без входа</option>
                  </select>
                </div>
                <label class="checkbox"
                  ><input
                    type="checkbox"
                    formControlName="requireConfirmationBeforeChanges"
                  />Запрашивать подтверждение перед изменениями</label
                >
                <fieldset class="checkbox-group">
                  <legend>Запрещённые действия</legend>
                  @for (action of actions; track action.key) {
                    <label class="checkbox"
                      ><input
                        type="checkbox"
                        [checked]="blocked().includes(action.key)"
                        (change)="toggle(action.key)"
                      />{{ action.label }}</label
                    >
                  }
                </fieldset>
              </div>
              <div>
                <h3>Личные ограничения</h3>
                <p class="small muted">
                  Пустое значение означает отсутствие пользовательского ограничения. Системные квоты
                  сохраняются.
                </p>
                @if (policy.data()?.quotas; as quotas) {
                  <p class="small muted">
                    Назначено администратором: браузеры
                    {{ quotas.assignedBrowserLimit ?? 'без ограничения' }}; подготовленные задачи в
                    ожидании {{ quotas.assignedQueuedLimit ?? 'без ограничения' }}. Личный предел
                    может только уменьшить назначенную квоту.
                  </p>
                  <p class="small muted">
                    Действующий предел: браузеры
                    {{ quotas.effectiveBrowserLimit ?? 'без ограничения' }}; ожидающие задачи
                    {{ quotas.effectiveQueuedLimit ?? 'без ограничения' }}.
                  </p>
                }
                @for (limit of limits; track limit.key) {
                  <div class="field">
                    <label [for]="limit.key">{{ limit.label }}</label
                    ><input
                      [id]="limit.key"
                      type="number"
                      [min]="limit.minimum"
                      [max]="assignedMaximum(limit.key)"
                      step="1"
                      [formControlName]="limit.key"
                    />
                  </div>
                }
              </div>
            </div>
            @if (validation()) {
              <p class="notice error" role="alert">{{ validation() }}</p>
            }
            <hg-mutation [action]="mutation" />
            <footer class="form-footer">
              <button
                class="btn primary"
                [disabled]="!policy.data() || mutation.pending() || mutation.unknown()"
              >
                Сохранить настройки
              </button>
            </footer>
          </form>
        </div>
      </section>
    </div>`,
})
export class Profile {
  readonly identity = inject(Identity);
  readonly policy = new ServerResource<Policy>(['policy']);
  readonly mutation = new Mutation();
  private formVersion: number | null = null;
  private fb = inject(FormBuilder);
  readonly validation = signal('');
  readonly blocked = signal<string[]>([]);
  readonly actions = [
    { key: 'READ', label: 'Чтение' },
    { key: 'EDIT', label: 'Изменение' },
    { key: 'SUBMIT', label: 'Отправка' },
    { key: 'DELETE', label: 'Удаление' },
    { key: 'PURCHASE', label: 'Покупка' },
    { key: 'PAYMENT', label: 'Платёж' },
    { key: 'MEDIA', label: 'Медиа' },
  ];
  readonly limits = [
    { key: 'maxCommandsPerRun', label: 'Команд в задаче', minimum: 1 },
    { key: 'maxActiveSecondsPerRun', label: 'Активное время задачи, секунд', minimum: 60 },
    { key: 'maxParallelRuns', label: 'Одновременных задач', minimum: 1 },
    { key: 'maxQueuedRuns', label: 'Подготовленные задачи в ожидании', minimum: 0 },
    { key: 'maxRetainedMediaBytes', label: 'Сохраняемых байтов медиа', minimum: 0 },
    { key: 'maxBrowserSessions', label: 'Одновременные браузеры', minimum: 1 },
  ] as const;
  readonly form = this.fb.group({
    siteMode: this.fb.nonNullable.control<Policy['siteMode']>('ALL'),
    origins: this.fb.nonNullable.control(''),
    connectionMode: this.fb.nonNullable.control<Policy['connectionMode']>('AUTO'),
    requireConfirmationBeforeChanges: this.fb.nonNullable.control(false),
    maxCommandsPerRun: this.fb.control<number | null>(null),
    maxActiveSecondsPerRun: this.fb.control<number | null>(null),
    maxParallelRuns: this.fb.control<number | null>(null),
    maxQueuedRuns: this.fb.control<number | null>(null),
    maxRetainedMediaBytes: this.fb.control<number | null>(null),
    maxBrowserSessions: this.fb.control<number | null>(null),
  });
  constructor() {
    this.policy.load('/me/policy');
    effect(() => {
      const policy = this.policy.data();
      if (policy && !this.form.dirty) {
        this.form.patchValue({ ...policy, origins: policy.origins.join('\n') });
        this.blocked.set(policy.blockedActions);
        this.formVersion = policy.version;
      }
    });
  }
  toggle(key: string) {
    this.blocked.update((items) =>
      items.includes(key) ? items.filter((item) => item !== key) : [...items, key],
    );
    this.form.markAsDirty();
  }
  readonly canLeave = protectUnsavedChanges(() => this.form.dirty);
  assignedMaximum(key: string): number | null {
    const quotas = this.policy.data()?.quotas;
    if (!quotas) return null;
    if (key === 'maxBrowserSessions') return quotas.assignedBrowserLimit;
    if (key === 'maxQueuedRuns') return quotas.assignedQueuedLimit;
    return null;
  }
  save() {
    const policy = this.policy.data();
    if (!policy || this.formVersion === null) return;
    const invalidLimit = this.limits.some(({ key, minimum }) => {
      const value = this.form.controls[key].value;
      const maximum = this.assignedMaximum(key);
      return (
        value !== null &&
        (!Number.isSafeInteger(value) || value < minimum || (maximum !== null && value > maximum))
      );
    });
    if (this.form.invalid || invalidLimit) {
      this.validation.set(
        'Укажите целые лимиты в допустимых границах: активное время от 60 секунд; очередь и объём медиа могут быть нулевыми. Личные квоты не выше назначенных администратором. Пустое поле наследует назначенный предел.',
      );
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue(),
      origins = value.origins
        .split(/\r?\n/)
        .map((origin) => origin.trim())
        .filter(Boolean);
    for (const origin of origins) {
      try {
        const url = new URL(origin);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error();
      } catch {
        this.validation.set(
          'Укажите точные origins: протокол и домен, без пути, query и завершающего /.',
        );
        return;
      }
    }
    this.validation.set('');
    this.mutation.run(
      'PATCH',
      '/me/policy',
      { ...value, origins, blockedActions: this.blocked(), expectedVersion: this.formVersion },
      () => {
        this.form.markAsPristine();
        this.policy.refresh();
      },
    );
  }
}
