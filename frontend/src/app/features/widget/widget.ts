import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { App } from '@modelcontextprotocol/ext-apps';
import { BrowserPanel } from '../../shared/browser-panel/browser-panel';
import { Icon } from '../../shared/icon/icon';
import { LabelPipe, Status } from '../../shared/status/status';
import { ReconnectWindow } from '../../core/realtime/reconnect-window';
import { widgetOrigin } from './widget-config';
import {
  Presentation,
  WidgetSnapshot,
  presentationOf,
  record,
  retainActiveTicket,
  snapshotOf,
  string,
} from './widget-contracts';

@Component({
  selector: 'hg-widget',
  imports: [BrowserPanel, Icon, Status, LabelPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main class="widget-page">
    <section class="widget-shell">
      <header class="widget-head">
        <img src="helm-logo.png" width="28" height="28" alt="" /><strong>Helm Glass</strong
        ><span class="spacer"></span>
        @if (snapshot()?.continuation; as continuation) {
          <hg-status [value]="continuation.state" />
        }
      </header>
      <div class="widget-body">
        <h1 tabindex="-1">{{ presentation()?.summary || 'Браузер задачи' }}</h1>
        @if (inactive()) {
          <div class="notice neutral">
            <strong>Неактивен — просмотр перенесён в последний ответ</strong>
            <p>Результаты задачи сохранены в кабинете.</p>
          </div>
        } @else if (snapshot()?.session; as session) {
          <hg-browser-panel
            [sessionId]="session.id"
            [taskId]="presentation()?.taskId"
            surface="WIDGET"
            [viewerInstanceId]="instanceId"
            [providedSession]="session"
            [providedTicket]="snapshot()?.viewTicket ?? null"
            (changed)="refreshView()"
            (openTask)="openTask()"
          />
        } @else {
          <div class="viewer-empty">
            <div>
              <hg-icon name="browser" />
              <h3>{{ loading() ? 'Подключаем просмотр' : 'Просмотр доступен в кабинете' }}</h3>
              <p>{{ message() || 'Откройте ту же задачу в Helm Glass.' }}</p>
            </div>
          </div>
        }
        @if (error()) {
          <div class="notice warning" role="status">
            {{ error() }}
            @if (!inactive()) {
              <button class="btn" (click)="retry()">Восстановить просмотр</button>
            }
          </div>
        }
        @if (snapshot()?.continuation?.reason) {
          <p class="widget-note">{{ snapshot()?.continuation?.reason | label }}</p>
        }
        @if (manualText()) {
          <div class="notice neutral">
            <p>Отправьте это сообщение в исходном чате, чтобы продолжить ту же задачу:</p>
            <p class="report-text">{{ manualText() }}</p>
            <button class="btn" (click)="copy()">Копировать сообщение</button>
          </div>
        }
      </div>
      <footer class="widget-foot">
        @if (presentation(); as presentation) {
          <a class="btn" [href]="presentation.taskUrl" target="_blank" rel="noopener noreferrer"
            >Открыть задачу</a
          ><span class="small muted">{{ presentation.taskId }}</span>
        } @else {
          <p class="small muted">Откройте просмотр из инструмента Helm Glass в ChatGPT.</p>
        }
      </footer>
    </section>
  </main>`,
})
export class Widget {
  private readonly publicOrigin = widgetOrigin(document);
  readonly presentation = signal<Presentation | null>(null);
  readonly snapshot = signal<WidgetSnapshot | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly inactive = signal(false);
  readonly manualText = signal('');
  private readonly app = new App(
    { name: 'Helm Glass', version: '1.0.0' },
    {},
    { autoResize: true, strict: true },
  );
  readonly instanceId = crypto.randomUUID();
  private readonly destroy = inject(DestroyRef);
  private events?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private renewal?: ReturnType<typeof setTimeout>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private attention?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private connected = false;
  private dirty = false;
  private readonly recovery = new ReconnectWindow();
  private dispatching = false;
  private seenDispatch = new Set<string>();
  private openingTask = false;
  constructor() {
    this.app.addEventListener('toolresult', (event) => {
      try {
        const presentation = presentationOf(
          event._meta?.['presentation'] ?? event.structuredContent,
          this.publicOrigin,
        );
        const previous = this.presentation();
        if (
          previous &&
          previous.viewScopeId === presentation.viewScopeId &&
          presentation.presentationRevision < previous.presentationRevision
        )
          return;
        if (
          previous &&
          previous.taskId === presentation.taskId &&
          previous.viewScopeId === presentation.viewScopeId &&
          previous.presentationRevision === presentation.presentationRevision &&
          previous.presentationState === presentation.presentationState &&
          previous.observedSessionId === presentation.observedSessionId &&
          this.snapshot()
        )
          return;
        this.clear();
        this.inactive.set(presentation.presentationState === 'SUPERSEDED');
        this.error.set('');
        this.message.set('');
        this.presentation.set(presentation);
        if (!this.inactive()) void this.attach();
      } catch {
        this.error.set(
          'Не удалось прочитать сведения задачи. Откройте её из актуального ответа ChatGPT.',
        );
      }
    });
    this.app.onteardown = async () => {
      this.clear();
      this.inactive.set(true);
      return {};
    };
    const visible = () => {
      if (document.hidden) {
        this.clear();
      } else if (!this.inactive()) {
        this.recovery.reset();
        void this.attach();
      }
    };
    const pagehide = () => this.clear();
    const online = () => {
      if (!document.hidden && !this.inactive()) this.retry();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('online', online);
    this.destroy.onDestroy(() => {
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('online', online);
      this.clear();
      void this.app.close();
    });
    void this.app
      .connect()
      .then(() => {
        this.connected = true;
        if (this.presentation()) void this.attach();
      })
      .catch(() =>
        this.error.set(
          'Этот клиент не предоставляет подключение Apps. Откройте задачу в кабинете.',
        ),
      );
  }
  async attach() {
    const presentation = this.presentation();
    if (presentation?.presentationState === 'LINK_ONLY') {
      this.message.set(
        'Откройте задачу в кабинете. Продолжение запускается сообщением в исходном чате.',
      );
      return;
    }
    if (!this.connected || !presentation || this.inactive() || document.hidden) return;
    if (this.loading()) {
      this.dirty = true;
      return;
    }
    this.loading.set(true);
    this.error.set('');
    const generation = this.generation;
    try {
      const result = await this.app.callServerTool(
        {
          name: 'browser.attach_view',
          arguments: {
            taskId: presentation.taskId,
            viewScopeId: presentation.viewScopeId,
            presentationRevision: presentation.presentationRevision,
            viewerInstanceId: this.instanceId,
            observedSessionId: presentation.observedSessionId,
          },
        },
        { timeout: 15000 },
      );
      if (generation !== this.generation) return;
      if (result.isError) throw new Error('Доступ к просмотру не подтверждён');
      const previous = this.snapshot(),
        snapshot = retainActiveTicket(
          previous,
          snapshotOf(result.structuredContent, result._meta, presentation, this.publicOrigin),
        );
      if (snapshot.presentation.presentationState === 'SUPERSEDED') {
        this.clear();
        this.inactive.set(true);
        this.snapshot.set(null);
        return;
      }
      this.snapshot.set(snapshot);
      if (snapshot.presentation.presentationState === 'LINK_ONLY') {
        this.message.set(
          'Этот клиент не поддерживает защищённый просмотр. Откройте задачу в кабинете.',
        );
      } else if (snapshot.eventTicket && !this.events)
        this.connectEvents(snapshot.eventTicket, generation);
      if (snapshot.viewTicket && snapshot.viewTicket !== previous?.viewTicket) {
        clearTimeout(this.renewal);
        const authorizationDeadline = snapshot.viewTicket.viewerAuthorizationExpiresAt;
        const remaining = authorizationDeadline
          ? Date.parse(authorizationDeadline) - Date.now() - 10000
          : 240000;
        this.renewal = setTimeout(
          () => {
            this.disconnectEvents();
            this.snapshot.set(null);
            void this.attach();
          },
          Math.max(1000, Math.min(240000, remaining)),
        );
      }
      clearTimeout(this.attention);
      if (
        !snapshot.continuation ||
        ['CLAIMED', 'CONSUMED', 'CANCELLED', 'EXPIRED'].includes(snapshot.continuation.state)
      )
        this.manualText.set('');
      else if (
        snapshot.continuation.deliveredAt &&
        Date.now() - Date.parse(snapshot.continuation.deliveredAt) >= 60000
      )
        this.manualText.set(
          snapshot.continuation.manualMessage ||
            `Продолжи задачу ${presentation.taskId} после моего участия. Не создавай новую задачу.`,
        );
      if (snapshot.continuation?.deliveredAt && !this.manualText()) {
        const delay = Date.parse(snapshot.continuation.deliveredAt) + 60000 - Date.now();
        if (Number.isFinite(delay) && delay > 0)
          this.attention = setTimeout(() => void this.attach(), Math.min(delay, 60000));
      }
      await this.continueIfReady(snapshot, generation);
    } catch {
      if (generation === this.generation) {
        this.error.set('Не удалось обновить просмотр. Действия задачи не повторялись.');
      }
    } finally {
      if (generation === this.generation) {
        this.loading.set(false);
        if (this.dirty) {
          this.dirty = false;
          void this.attach();
        }
      }
    }
  }
  private connectEvents(ticket: { ticket: string; url: string }, generation: number) {
    const socket = new WebSocket(ticket.url);
    this.events = socket;
    let lastPong = Date.now();
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: 'authenticate', ticket: ticket.ticket }));
    socket.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (generation !== this.generation || typeof data !== 'string' || data.length > 8192) return;
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        socket.close();
        return;
      }
      if (!record(value)) return;
      if (value['type'] === 'pong') {
        lastPong = Date.now();
        this.recovery.reset();
      }
      if (value['type'] === 'ready' || value['type'] === 'invalidate') void this.attach();
    };
    this.heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        if (Date.now() - lastPong > 45000) socket.close();
        else socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);
    socket.onclose = (event) => {
      if (generation !== this.generation) return;
      this.disconnectEvents();
      this.snapshot.set(null);
      if (event.code === 4412 || event.code === 4403) {
        this.clear();
        this.inactive.set(true);
        return;
      }
      if (event.code === 4401) {
        this.error.set('Авторизуйте Helm Glass в ChatGPT заново.');
        return;
      }
      const delay = this.recovery.nextDelay();
      if (!document.hidden && delay !== null)
        this.reconnect = setTimeout(() => void this.attach(), delay);
      else this.error.set('Связь не восстановлена. Откройте ту же задачу в кабинете.');
    };
  }
  private async continueIfReady(snapshot: WidgetSnapshot, generation: number) {
    const continuation = snapshot.continuation,
      presentation = snapshot.presentation;
    if (
      this.dispatching ||
      !continuation ||
      continuation.state !== 'READY' ||
      continuation.mode !== 'WIDGET_RETURN' ||
      presentation.presentationState !== 'ACTIVE' ||
      document.hidden
    )
      return;
    if (!this.app.getHostCapabilities()?.message) {
      this.manualText.set(
        `Продолжи задачу ${presentation.taskId} после моего участия. Не создавай новую задачу.`,
      );
      return;
    }
    this.dispatching = true;
    try {
      const prepared = await this.app.callServerTool(
        {
          name: 'continuations.prepare_message',
          arguments: {
            taskId: presentation.taskId,
            continuationId: continuation.id,
            viewScopeId: presentation.viewScopeId,
            presentationRevision: presentation.presentationRevision,
            viewerInstanceId: this.instanceId,
            idempotencyKey: crypto.randomUUID(),
          },
        },
        { timeout: 15000 },
      );
      if (prepared.isError || !record(prepared.structuredContent)) throw new Error();
      const dispatchId = string(prepared.structuredContent['dispatchId']),
        text = string(prepared.structuredContent['text']);
      if (this.seenDispatch.has(dispatchId)) return;
      this.seenDispatch.add(dispatchId);
      if (this.seenDispatch.size > 32) {
        const oldest = this.seenDispatch.values().next().value;
        if (oldest) this.seenDispatch.delete(oldest);
      }
      let outcome: 'DELIVERED' | 'UNKNOWN' | 'REJECTED' = 'REJECTED';
      if (generation === this.generation && !document.hidden && !this.inactive()) {
        try {
          const delivered = await this.app.sendMessage(
            { role: 'user', content: [{ type: 'text', text }] },
            { timeout: 15000 },
          );
          outcome = delivered.isError ? 'REJECTED' : 'DELIVERED';
        } catch {
          outcome = 'UNKNOWN';
        }
      }
      const receipt = await this.app.callServerTool(
        {
          name: 'continuations.record_delivery',
          arguments: { dispatchId, outcome, idempotencyKey: crypto.randomUUID() },
        },
        { timeout: 15000 },
      );
      if (receipt.isError) throw new Error();
      if (outcome !== 'DELIVERED') this.manualText.set(text);
      else this.message.set('Сообщение отправлено. Ожидаем принятия задачи ChatGPT.');
      this.dirty = true;
    } catch {
      if (generation === this.generation)
        this.error.set(
          'Результат передачи продолжения пока неизвестен. Сообщение автоматически не повторяется.',
        );
    } finally {
      this.dispatching = false;
    }
  }
  refreshView() {
    this.snapshot.set(null);
    void this.attach();
  }
  async openTask() {
    const presentation = this.presentation();
    if (!presentation || this.openingTask) return;
    this.openingTask = true;
    try {
      const result = await this.app.openLink({ url: presentation.taskUrl }, { timeout: 15000 });
      if (result.isError) throw new Error('The host did not open the task');
    } catch {
      this.error.set('Клиент не открыл кабинет. Используйте ссылку «Открыть задачу» внизу.');
    } finally {
      this.openingTask = false;
    }
  }
  retry() {
    this.recovery.reset();
    this.refreshView();
  }
  copy() {
    void navigator.clipboard
      .writeText(this.manualText())
      .catch(() => this.error.set('Выделите и скопируйте сообщение вручную.'));
  }
  private disconnectEvents() {
    clearInterval(this.heartbeat);
    if (this.events) {
      this.events.onclose = null;
      this.events.close();
      this.events = undefined;
    }
  }
  private clear() {
    this.generation++;
    this.disconnectEvents();
    clearTimeout(this.renewal);
    clearTimeout(this.reconnect);
    clearTimeout(this.attention);
    this.snapshot.set(null);
    this.manualText.set('');
    this.loading.set(false);
    this.dirty = false;
  }
}
