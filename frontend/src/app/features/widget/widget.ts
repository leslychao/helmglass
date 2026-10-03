import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { App } from '@modelcontextprotocol/ext-apps';
import { BrowserPanel } from '../../shared/browser-panel/browser-panel';
import { Icon } from '../../shared/icon/icon';
import { LabelPipe, Status } from '../../shared/status/status';
import { ReconnectWindow } from '../../core/realtime/reconnect-window';
import { BrowserClock, browserClockOf, newerClock } from '../../core/realtime/browser-clock';
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
            [providedClock]="browserClock()"
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
            @if (!inactive() && !accessDenied()) {
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
  readonly browserClock = signal<BrowserClock | null>(null);
  private readonly publicOrigin = widgetOrigin(document);
  readonly presentation = signal<Presentation | null>(null);
  readonly snapshot = signal<WidgetSnapshot | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly inactive = signal(false);
  readonly accessDenied = signal(false);
  readonly manualText = signal('');
  private readonly app = new App(
    { name: 'Helm Glass', version: '1.0.0' },
    {},
    { autoResize: true, strict: true },
  );
  readonly instanceId = crypto.randomUUID();
  private readonly destroy = inject(DestroyRef);
  private events?: WebSocket;
  private activeEventTicket?: WidgetSnapshot['eventTicket'];
  private heartbeat?: ReturnType<typeof setInterval>;
  private renewal?: ReturnType<typeof setTimeout>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private attention?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private connected = false;
  private disposed = false;
  private eventsReady = false;
  private snapshotFresh = false;
  private recoveryExhausted = false;
  private dirty = false;
  private readonly recovery = new ReconnectWindow();
  private dispatching = false;
  private delivery?: DeliveryAttempt;
  private openingTask = false;
  constructor() {
    this.app.addEventListener('toolresult', (event) => {
      if (this.disposed) return;
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
          previous.observedSessionId === presentation.observedSessionId
        )
          return;
        this.clear();
        this.accessDenied.set(false);
        this.recovery.reset();
        this.recoveryExhausted = false;
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
      this.disposed = true;
      this.clear();
      this.inactive.set(true);
      return {};
    };
    const visible = () => {
      if (document.hidden) {
        this.clear();
      } else this.retry();
    };
    const pagehide = () => this.clear();
    const online = () => {
      if (!document.hidden && !this.inactive()) this.retry();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('online', online);
    this.destroy.onDestroy(() => {
      this.disposed = true;
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('online', online);
      this.clear();
      void this.app.close();
    });
    void this.app
      .connect()
      .then(() => {
        if (this.disposed) return;
        this.connected = true;
        if (this.presentation()) void this.attach();
      })
      .catch(() => {
        if (!this.disposed)
          this.error.set(
            'Этот клиент не предоставляет подключение Apps. Откройте задачу в кабинете.',
          );
      });
  }
  async attach() {
    const presentation = this.presentation();
    if (presentation?.presentationState === 'LINK_ONLY') {
      this.message.set(
        'Откройте задачу в кабинете. Продолжение запускается сообщением в исходном чате.',
      );
      return;
    }
    if (
      !this.connected ||
      !presentation ||
      this.disposed ||
      this.inactive() ||
      this.accessDenied() ||
      document.hidden ||
      this.recoveryExhausted ||
      this.reconnect !== undefined
    )
      return;
    if (this.loading()) {
      this.dirty = true;
      return;
    }
    this.loading.set(true);
    this.error.set('');
    const generation = this.generation;
    let diagnostic: WidgetDiagnostic = { stage: 'ATTACH', category: 'HOST_REQUEST_FAILED' };
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
      if (result.isError) {
        diagnostic = toolDiagnostic('ATTACH', result);
        const denied = accessFailure(result);
        if (denied) {
          this.warn(diagnostic);
          this.stopForAccess(denied);
          return;
        }
        throw new Error('Доступ к просмотру не подтверждён');
      }
      diagnostic = { stage: 'ATTACH', category: 'CONTRACT_INVALID' };
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
      clearTimeout(this.reconnect);
      this.reconnect = undefined;
      this.snapshot.set(snapshot);
      this.snapshotFresh = this.eventsReady && !this.dirty;
      if (this.snapshotFresh) this.recovery.reset();
      if (snapshot.presentation.presentationState === 'LINK_ONLY') {
        this.message.set(
          'Этот клиент не поддерживает защищённый просмотр. Откройте задачу в кабинете.',
        );
      } else if (snapshot.eventTicket) {
        if (
          this.activeEventTicket &&
          this.activeEventTicket.viewGeneration !== snapshot.eventTicket.viewGeneration
        )
          this.disconnectEvents();
        if (!this.events) {
          diagnostic = { stage: 'EVENT_CHANNEL', category: 'CHANNEL_OPEN_FAILED' };
          this.connectEvents(snapshot.eventTicket, generation);
        }
      }
      diagnostic = { stage: 'ATTACH', category: 'AUTHORIZATION_EXPIRED' };
      this.scheduleAuthorizationRenewal(snapshot);
      if (snapshot.presentation.presentationState === 'ACTIVE' && !this.events) {
        this.warn({ stage: 'ATTACH', category: 'EVENT_TICKET_MISSING' });
        this.error.set('Восстанавливаем канал обновлений просмотра.');
        this.scheduleRecovery();
      }
      this.updateAttention();
      await this.continueIfReady(snapshot, generation);
    } catch (error) {
      if (generation === this.generation) {
        this.warn(requestDiagnostic(diagnostic, error));
        this.snapshotFresh = false;
        this.updateAttention();
        this.error.set('Не удалось обновить просмотр. Действия задачи не повторялись.');
        this.scheduleRecovery();
      }
    } finally {
      if (generation === this.generation) {
        this.loading.set(false);
        if (this.dirty) {
          this.dirty = false;
          if (this.reconnect === undefined && !this.recoveryExhausted) void this.attach();
        }
      }
    }
  }
  private scheduleAuthorizationRenewal(snapshot: WidgetSnapshot) {
    clearTimeout(this.renewal);
    const deadlines = [
      this.activeEventTicket?.viewerAuthorizationExpiresAt,
      snapshot.viewTicket?.viewerAuthorizationExpiresAt,
    ].filter((value): value is string => value !== undefined);
    if (!deadlines.length) return;
    const remaining = Math.min(...deadlines.map((value) => Date.parse(value))) - Date.now();
    if (remaining <= 0) {
      this.disconnectEvents();
      this.snapshot.set(null);
      throw new Error('Срок доступа к просмотру истёк');
    }
    // The host may retain its access token until expiry. Renew once at that deadline,
    // including event-only views, instead of repeatedly reconnecting with the same token.
    this.renewal = setTimeout(() => {
      this.disconnectEvents();
      this.snapshot.set(null);
      void this.attach();
    }, remaining);
  }
  private scheduleRecovery(window: ReconnectWindow = this.recovery) {
    if (
      this.disposed ||
      this.inactive() ||
      this.accessDenied() ||
      document.hidden ||
      this.reconnect !== undefined ||
      this.recoveryExhausted
    )
      return;
    const delay = window.nextDelay();
    if (delay === null) {
      this.recoveryExhausted = true;
      this.warn({
        stage: 'RECOVERY',
        category: 'RECOVERY_EXHAUSTED',
        recovery: window === this.recovery ? 'CHANNEL' : 'DELIVERY',
      });
      this.error.set('Связь не восстановлена. Откройте ту же задачу в кабинете.');
      return;
    }
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.attach();
    }, delay);
  }
  private stopForAccess(reason: 'authentication' | 'authorization') {
    this.clear();
    this.accessDenied.set(true);
    this.error.set(
      reason === 'authentication'
        ? 'Авторизуйте Helm Glass в ChatGPT заново.'
        : 'Доступ к просмотру больше не разрешён. Откройте задачу в кабинете.',
    );
  }
  private updateAttention() {
    clearTimeout(this.attention);
    const snapshot = this.snapshot(),
      continuation = snapshot?.continuation;
    if (
      !continuation ||
      ['CLAIMED', 'CONSUMED', 'CANCELLED', 'EXPIRED'].includes(continuation.state)
    ) {
      this.manualText.set('');
      return;
    }
    if (!continuation.deliveredAt) return;
    this.manualText.set('');
    // The deadline is durable; only a synchronized channel can establish absence of a claim.
    if (!this.eventsReady || !this.snapshotFresh) return;
    const remaining = Date.parse(continuation.deliveredAt) + 60000 - Date.now();
    if (!Number.isFinite(remaining)) return;
    if (remaining > 0) {
      this.attention = setTimeout(() => this.updateAttention(), remaining);
      return;
    }
    this.manualText.set(
      continuation.manualMessage ||
        `Продолжи задачу ${snapshot.presentation.taskId} после моего участия. Не создавай новую задачу.`,
    );
  }
  private connectEvents(ticket: NonNullable<WidgetSnapshot['eventTicket']>, generation: number) {
    const socket = new WebSocket(ticket.url);
    this.events = socket;
    this.activeEventTicket = ticket;
    let lastPong = Date.now();
    socket.onopen = () => {
      if (this.events === socket)
        socket.send(JSON.stringify({ type: 'authenticate', ticket: ticket.ticket }));
    };
    socket.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (
        generation !== this.generation ||
        this.events !== socket ||
        typeof data !== 'string' ||
        data.length > 8192
      )
        return;
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        socket.close();
        return;
      }
      if (!record(value)) return;
      if (value['type'] === 'browserActivity') {
        const clock = browserClockOf(value['clock']);
        if (clock) this.browserClock.update((current) => newerClock(current, clock));
      }
      if (value['type'] === 'pong') {
        lastPong = Date.now();
      }
      if (value['type'] === 'ready') this.eventsReady = true;
      if (value['type'] === 'ready' || value['type'] === 'invalidate') {
        this.snapshotFresh = false;
        this.updateAttention();
        void this.attach();
      }
    };
    this.heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 45000) socket.close();
      else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    }, 15000);
    socket.onclose = (event) => {
      if (generation !== this.generation || this.events !== socket) return;
      this.warn({
        stage: 'EVENT_CHANNEL',
        category: 'CHANNEL_CLOSED',
        status: event.code,
        code: diagnosticCode(event.reason),
      });
      this.disconnectEvents();
      this.snapshot.set(null);
      if (event.code === 4412) {
        this.clear();
        this.inactive.set(true);
        return;
      }
      const expiredTicket =
        event.code === 4401 &&
        ['AUTHORIZATION_EXPIRED', 'TICKET_EXPIRED', 'TICKET_TIMEOUT'].includes(event.reason);
      if ((event.code === 4401 && !expiredTicket) || event.code === 4403) {
        this.stopForAccess(event.code === 4401 ? 'authentication' : 'authorization');
        return;
      }
      this.scheduleRecovery();
    };
  }
  private async continueIfReady(snapshot: WidgetSnapshot, generation: number) {
    const continuation = snapshot.continuation,
      presentation = snapshot.presentation;
    if (this.dispatching || document.hidden || this.disposed) return;
    let attempt = this.delivery;
    // A lost delivery receipt can be repaired after claim/consumption without invoking the host.
    if (attempt?.outcome && !attempt.recorded && !attempt.stopped) {
      await this.finishDelivery(attempt, generation);
      return;
    }
    if (
      !continuation ||
      continuation.mode !== 'WIDGET_RETURN' ||
      presentation.presentationState !== 'ACTIVE'
    )
      return;
    const sameAttempt =
      attempt?.continuationId === continuation.id &&
      attempt.taskId === presentation.taskId &&
      attempt.viewScopeId === presentation.viewScopeId &&
      attempt.presentationRevision === presentation.presentationRevision;
    if (sameAttempt && (attempt?.recorded || attempt?.stopped || attempt?.hostInvoked)) return;
    // DISPATCHING may be recovered only by the mount that still knows it has not invoked the host.
    if (continuation.state !== 'READY' && !(sameAttempt && continuation.state === 'DISPATCHING'))
      return;
    // Recovering an expired claim does not authorize another host message.
    if (continuation.state === 'READY' && continuation.dispatchId !== undefined) {
      this.manualText.set(
        continuation.manualMessage ||
          `Продолжи задачу ${presentation.taskId} после моего участия. Не создавай новую задачу.`,
      );
      return;
    }
    if (!this.app.getHostCapabilities()?.message?.text) {
      this.manualText.set(
        `Продолжи задачу ${presentation.taskId} после моего участия. Не создавай новую задачу.`,
      );
      return;
    }
    if (!this.snapshotFresh || !this.eventsReady) return;
    if (!sameAttempt) {
      attempt = {
        taskId: presentation.taskId,
        continuationId: continuation.id,
        viewScopeId: presentation.viewScopeId,
        presentationRevision: presentation.presentationRevision,
        prepareKey: crypto.randomUUID(),
        recordKey: crypto.randomUUID(),
        hostInvoked: false,
        recorded: false,
        stopped: false,
        recovery: new ReconnectWindow(),
      };
      this.delivery = attempt;
    }
    if (!attempt) return;
    this.dispatching = true;
    let diagnostic: WidgetDiagnostic | undefined = {
      stage: 'PREPARE_MESSAGE',
      category: 'HOST_REQUEST_FAILED',
    };
    try {
      if (!attempt.prepared) {
        const prepared = await this.app.callServerTool(
          {
            name: 'continuations.prepare_message',
            arguments: {
              taskId: presentation.taskId,
              continuationId: continuation.id,
              viewScopeId: presentation.viewScopeId,
              presentationRevision: presentation.presentationRevision,
              viewerInstanceId: this.instanceId,
              idempotencyKey: attempt.prepareKey,
            },
          },
          { timeout: 15000 },
        );
        if (prepared.isError) {
          diagnostic = toolDiagnostic('PREPARE_MESSAGE', prepared);
          attempt.stopped = !unknownToolOutcome(prepared);
          throw new Error();
        }
        diagnostic = { stage: 'PREPARE_MESSAGE', category: 'CONTRACT_INVALID' };
        if (!record(prepared.structuredContent)) throw new Error();
        const dispatchId = string(prepared.structuredContent['dispatchId']),
          text = string(prepared.structuredContent['text']),
          expiresAt = Date.parse(string(prepared.structuredContent['expiresAt']));
        if (!dispatchId || !text || text.length > 4096 || !Number.isFinite(expiresAt))
          throw new Error();
        attempt.prepared = { dispatchId, text, expiresAt };
      }
      // A temporary hide or invalidation defers the known-unsent message. Only a
      // synchronized read may authorize its delivery; it is not a host rejection.
      const current = this.snapshot();
      if (
        generation !== this.generation ||
        document.hidden ||
        this.inactive() ||
        this.disposed ||
        this.accessDenied() ||
        !this.eventsReady ||
        !this.snapshotFresh ||
        current?.continuation?.id !== attempt.continuationId ||
        !['READY', 'DISPATCHING'].includes(current.continuation.state) ||
        current.presentation.taskId !== attempt.taskId ||
        current.presentation.viewScopeId !== attempt.viewScopeId ||
        current.presentation.presentationRevision !== attempt.presentationRevision
      )
        return;
      if (attempt.prepared.expiresAt <= Date.now()) {
        attempt.stopped = true;
        this.manualText.set(attempt.prepared.text);
        return;
      }
      // A timeout does not prove that ChatGPT rejected the message.
      attempt.hostInvoked = true;
      try {
        const delivered = await this.app.sendMessage(
          { role: 'user', content: [{ type: 'text', text: attempt.prepared.text }] },
          { timeout: 15000 },
        );
        attempt.outcome = delivered.isError ? 'REJECTED' : 'DELIVERED';
      } catch {
        attempt.outcome = 'UNKNOWN';
      }
      diagnostic = undefined;
      await this.recordDelivery(attempt);
      this.showDelivery(attempt, generation);
    } catch (error) {
      if (diagnostic && generation === this.generation)
        this.warn(requestDiagnostic(diagnostic, error));
      this.deliveryFailed(attempt, generation);
    } finally {
      this.dispatching = false;
      // Visibility may have returned while prepare was still pending in the old generation.
      if (generation !== this.generation && !document.hidden && !this.disposed) void this.attach();
    }
  }
  private async finishDelivery(attempt: DeliveryAttempt, generation: number) {
    this.dispatching = true;
    try {
      await this.recordDelivery(attempt);
      this.showDelivery(attempt, generation);
    } catch {
      this.deliveryFailed(attempt, generation);
    } finally {
      this.dispatching = false;
    }
  }
  private async recordDelivery(attempt: DeliveryAttempt) {
    if (!attempt.prepared || !attempt.outcome) return;
    let diagnostic: WidgetDiagnostic = {
      stage: 'RECORD_DELIVERY',
      category: 'HOST_REQUEST_FAILED',
    };
    try {
      const receipt = await this.app.callServerTool(
        {
          name: 'continuations.record_delivery',
          arguments: {
            dispatchId: attempt.prepared.dispatchId,
            outcome: attempt.outcome,
            idempotencyKey: attempt.recordKey,
          },
        },
        { timeout: 15000 },
      );
      if (receipt.isError) {
        diagnostic = toolDiagnostic('RECORD_DELIVERY', receipt);
        attempt.stopped = !unknownToolOutcome(receipt);
        throw new Error();
      }
      attempt.recorded = true;
    } catch (error) {
      this.warn(requestDiagnostic(diagnostic, error));
      throw error;
    }
  }
  private warn(diagnostic: WidgetDiagnostic) {
    console.warn('Helm widget', {
      ...diagnostic,
      eventsReady: this.eventsReady,
      snapshotFresh: this.snapshotFresh,
      viewGeneration: this.activeEventTicket?.viewGeneration,
    });
  }
  private showDelivery(attempt: DeliveryAttempt, generation: number) {
    if (generation !== this.generation) return;
    const current = this.snapshot()?.continuation;
    if (
      current?.id === attempt.continuationId &&
      !['CLAIMED', 'CONSUMED', 'CANCELLED', 'EXPIRED'].includes(current.state)
    ) {
      if (attempt.outcome !== 'DELIVERED') this.manualText.set(attempt.prepared?.text ?? '');
      else this.message.set('Сообщение отправлено. Ожидаем принятия задачи ChatGPT.');
    }
    this.dirty = true;
  }
  private deliveryFailed(attempt: DeliveryAttempt, generation: number) {
    if (generation !== this.generation) return;
    this.error.set(
      attempt.stopped
        ? 'Автоматическое продолжение сейчас недоступно. Откройте ту же задачу в кабинете.'
        : 'Восстанавливаем связь с ChatGPT. Уже отправленное сообщение не повторяется.',
    );
    if (!attempt.stopped) this.scheduleRecovery(attempt.recovery);
  }
  refreshView() {
    this.snapshot.set(null);
    this.snapshotFresh = false;
    this.updateAttention();
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
    if (this.disposed || this.inactive() || this.accessDenied() || document.hidden) return;
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.recovery.reset();
    this.recoveryExhausted = false;
    this.refreshView();
  }
  copy() {
    void navigator.clipboard
      .writeText(this.manualText())
      .catch(() => this.error.set('Выделите и скопируйте сообщение вручную.'));
  }
  private disconnectEvents() {
    clearInterval(this.heartbeat);
    clearTimeout(this.attention);
    this.eventsReady = false;
    this.activeEventTicket = undefined;
    clearTimeout(this.renewal);
    this.snapshotFresh = false;
    this.updateAttention();
    if (this.events) {
      this.events.onopen = null;
      this.events.onmessage = null;
      this.events.onclose = null;
      this.events.close();
      this.events = undefined;
    }
  }
  private clear() {
    this.browserClock.set(null);
    this.generation++;
    this.disconnectEvents();
    clearTimeout(this.renewal);
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    clearTimeout(this.attention);
    this.snapshot.set(null);
    this.manualText.set('');
    this.loading.set(false);
    this.dirty = false;
  }
}

interface DeliveryAttempt {
  taskId: string;
  continuationId: string;
  viewScopeId: string | null;
  presentationRevision: number;
  prepareKey: string;
  recordKey: string;
  hostInvoked: boolean;
  recorded: boolean;
  stopped: boolean;
  recovery: ReconnectWindow;
  prepared?: { dispatchId: string; text: string; expiresAt: number };
  outcome?: 'DELIVERED' | 'UNKNOWN' | 'REJECTED';
}

interface WidgetDiagnostic {
  stage: 'ATTACH' | 'EVENT_CHANNEL' | 'PREPARE_MESSAGE' | 'RECORD_DELIVERY' | 'RECOVERY';
  category:
    | 'HOST_REQUEST_FAILED'
    | 'HOST_TIMEOUT'
    | 'TOOL_REJECTED'
    | 'CONTRACT_INVALID'
    | 'AUTHORIZATION_EXPIRED'
    | 'EVENT_TICKET_MISSING'
    | 'CHANNEL_OPEN_FAILED'
    | 'CHANNEL_CLOSED'
    | 'RECOVERY_EXHAUSTED';
  code?: string;
  status?: number;
  recovery?: 'CHANNEL' | 'DELIVERY';
}

const diagnosticCodes = new Set([
  'OWNER_RESPONSE_UNKNOWN',
  'OWNER_CONTRACT_INVALID',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'CONTINUATION_BLOCKED',
  'CONTINUATION_NOT_READY',
  'CONTINUATION_EXPIRED',
  'CONTINUATION_DESTINATION_CHANGED',
  'AUTOMATIC_CONTINUATION_UNAVAILABLE',
  'DISPATCH_NOT_SENDABLE',
  'STALE_PRESENTATION',
  'VIEW_ALREADY_ATTACHED',
  'VIEW_LEASE_EXPIRED',
  'VIEW_GENERATION_CHANGED',
  'PRESENTATION_SUPERSEDED',
  'GRANT_REVOKED',
  'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_UNAVAILABLE',
  'CHANNEL_ORIGIN_REJECTED',
  'CONNECTION_LIMIT',
  'AUTHENTICATION_LIMIT',
  'TICKET_REQUIRED',
  'TICKET_EXPIRED',
  'TICKET_TIMEOUT',
  'HEARTBEAT_TIMEOUT',
  'DELIVERY_FAILED',
  'INVALID_MESSAGE',
]);

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' && diagnosticCodes.has(value) ? value : undefined;
}

function toolDiagnostic(stage: WidgetDiagnostic['stage'], result: unknown): WidgetDiagnostic {
  const diagnostic: WidgetDiagnostic = { stage, category: 'TOOL_REJECTED' };
  if (!record(result) || !Array.isArray(result['content'])) return diagnostic;
  for (const item of result['content'].slice(0, 8)) {
    if (
      !record(item) ||
      item['type'] !== 'text' ||
      typeof item['text'] !== 'string' ||
      item['text'].length > 4096
    )
      continue;
    try {
      const problem: unknown = JSON.parse(item['text']);
      if (!record(problem)) continue;
      const status = problem['status'];
      diagnostic.code = diagnosticCode(problem['code']);
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599)
        diagnostic.status = status;
      return diagnostic;
    } catch {
      diagnostic.code = diagnosticCode(item['text']);
    }
  }
  return diagnostic;
}

function requestDiagnostic(diagnostic: WidgetDiagnostic, error: unknown): WidgetDiagnostic {
  return diagnostic.category === 'HOST_REQUEST_FAILED' && record(error) && error['code'] === -32001
    ? { ...diagnostic, category: 'HOST_TIMEOUT' }
    : diagnostic;
}

function unknownToolOutcome(result: unknown): boolean {
  if (!record(result) || !Array.isArray(result['content'])) return true;
  for (const item of result['content']) {
    if (!record(item) || item['type'] !== 'text' || typeof item['text'] !== 'string') continue;
    try {
      const problem: unknown = JSON.parse(item['text']);
      if (record(problem) && problem['code'] === 'OWNER_RESPONSE_UNKNOWN') return true;
      if (record(problem) && typeof problem['status'] === 'number' && problem['status'] >= 500)
        return true;
    } catch {
      // Plain protocol denials are definitive; an ambiguous transport result uses its named code.
    }
  }
  return false;
}

function accessFailure(result: unknown): 'authentication' | 'authorization' | null {
  if (!record(result) || !Array.isArray(result['content'])) return null;
  for (const item of result['content']) {
    if (!record(item) || item['type'] !== 'text' || typeof item['text'] !== 'string') continue;
    let problem: unknown;
    try {
      problem = JSON.parse(item['text']);
    } catch {
      problem = { code: item['text'] };
    }
    if (!record(problem)) continue;
    if (problem['status'] === 401 || problem['code'] === 'UNAUTHENTICATED') return 'authentication';
    if (
      problem['status'] === 403 ||
      problem['status'] === 404 ||
      ['FORBIDDEN', 'INSUFFICIENT_SCOPE', 'NOT_FOUND'].includes(String(problem['code']))
    )
      return 'authorization';
  }
  return null;
}
