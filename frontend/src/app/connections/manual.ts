import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { BrowserViewer, browserViewerId } from '../browser/viewer';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { Connection, connectionSchema } from '../core/models';
import { Dialog } from '../shared/dialog';
import { Status } from '../shared/ui';

@Component({
  selector: 'hg-manual',
  imports: [BrowserViewer, Status],
  template: `
    <header class="page-heading">
      <div>
        <button class="back-link" (click)="back()">‹ К подключениям</button>
        <h1>
          {{ connection()?.browser?.privateMode ? 'Защищённый вход' : 'Браузер подключения' }}
        </h1>
        <p>{{ connection()?.name }} · {{ connection()?.site }}</p>
      </div>
      @if (connection(); as item) {
        <hg-status [value]="item.status === 'READY' ? 'CONNECTION_READY' : item.status" />
      }
    </header>
    <div class="notice">
      @if (connection()?.browser?.privateMode) {
        <strong>Введите пароль и код только на сайте внутри браузера</strong>
        <p>Во время защищённого входа содержимое скрыто от ChatGPT и других наблюдателей.</p>
      } @else {
        <strong>Защищённый вход не включён</strong>
        <p>Перед вводом пароля или кода нажмите «Войти защищённо».</p>
      }
    </div>
    @if (error()) {
      <div class="error-banner" role="alert">
        {{ error() }}<button class="text-button" (click)="load()">Обновить состояние</button>
      </div>
    }
    @if (connection(); as item) {
      <hg-browser
        [browser]="item.browser"
        [role]="controller() && item.browser?.controlOwner === 'USER' ? 'CONTROLLER' : 'VIEWER'"
        (controlLost)="controller.set(false)"
      />
      <section class="card login-actions">
        <h2>Когда вход завершён</h2>
        <p>Проверьте учётную запись на сайте и сохраните её для будущих задач.</p>
        <div class="actions">
          <button class="button primary" [disabled]="busy() || !canSave()" (click)="finish()">
            Сохранить вход</button
          ><button class="button" [disabled]="busy()" (click)="close()">
            Закрыть без сохранения
          </button>
          @if (!canSave()) {
            <button
              class="button"
              [disabled]="busy() || item.browser?.controlOwner === 'TRANSFERRING'"
              (click)="start()"
            >
              {{ item.browser?.privateMode ? 'Взять управление' : 'Войти защищённо' }}
            </button>
          }
        </div>
      </section>
    } @else if (!error()) {
      <div class="loading" role="status">Загружаем сеанс входа…</div>
    }
  `,
})
export class Manual {
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private get id() {
    return this.route.snapshot.paramMap.get('id') ?? '';
  }
  private readonly destroy = inject(DestroyRef);
  private generation = 0;
  readonly connection = signal<Connection | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly controller = signal(false);
  readonly canSave = computed(
    () =>
      this.controller() &&
      this.connection()?.browser?.privateMode === true &&
      this.connection()?.browser?.controlOwner === 'USER',
  );
  back() {
    const context = this.route.snapshot.queryParamMap.get('back');
    void this.router.navigateByUrl('/connections' + (context ? '?' + context : ''));
  }
  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(() => {
      this.connection.set(null);
      this.controller.set(false);
      this.busy.set(false);
      void this.load();
    });
    inject(LiveEvents)
      .watch(['connection', 'browser'])
      .pipe(takeUntilDestroyed())
      .subscribe((change) => {
        if (
          change.resource === 'sync' ||
          change.entityId === this.id ||
          change.entityId === this.connection()?.browser?.id
        )
          void this.load();
      });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }
  async load() {
    const generation = ++this.generation;
    try {
      const connection = await this.api.get('/api/connections/' + this.id, connectionSchema);
      if (generation !== this.generation) return;
      this.connection.set(connection);
      if (connection.browser)
        this.controller.set(
          connection.browser.privateMode &&
            connection.browser.controlOwner === 'USER' &&
            sessionStorage.getItem('helm-controller:' + connection.browser.id) === 'true',
        );
      this.error.set('');
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    }
  }
  async start() {
    if (this.busy()) return;
    const id = this.id;
    this.busy.set(true);
    try {
      const updated = await this.api.mutate(
        '/api/connections/' + id + '/login',
        { action: 'START', viewerId: browserViewerId() },
        connectionSchema,
      );
      if (this.destroy.destroyed || this.id !== id) return;
      this.connection.set(updated);
      if (updated.browser) sessionStorage.setItem('helm-controller:' + updated.browser.id, 'true');
      this.controller.set(true);
    } catch (error: unknown) {
      if (!this.destroy.destroyed && this.id === id) this.error.set(errorMessage(error));
    } finally {
      if (!this.destroy.destroyed && this.id === id) this.busy.set(false);
    }
  }
  async finish() {
    if (this.busy() || !this.canSave()) return;
    const values = await this.dialog.ask(
      'Сохранить этот вход',
      'Укажите конкретную учётную запись, видимую на сайте.',
      'Сохранить',
      [
        { key: 'accountLabel', label: 'Название учётной записи', required: true, max: 200 },
        {
          key: 'accountSubject',
          label: 'Логин или ID учётной записи на сайте',
          required: true,
          max: 500,
        },
      ],
    );
    if (values) await this.action('SAVE', values);
  }
  async close() {
    if (await this.dialog.ask('Закрыть браузер входа?', 'Новый вход не будет сохранён.', 'Закрыть'))
      await this.action('CLOSE', {});
  }
  private async action(action: string, values: Record<string, string>) {
    if (this.busy()) return;
    const id = this.id;
    this.busy.set(true);
    try {
      await this.api.mutate(
        '/api/connections/' + id + '/login',
        { action, viewerId: browserViewerId(), ...values },
        connectionSchema,
      );
      this.dialog.complete(values);
      if (this.destroy.destroyed || this.id !== id) return;
      this.back();
    } catch (error: unknown) {
      if (!this.destroy.destroyed && this.id === id) this.error.set(errorMessage(error));
    } finally {
      if (!this.destroy.destroyed && this.id === id) this.busy.set(false);
    }
  }
}
