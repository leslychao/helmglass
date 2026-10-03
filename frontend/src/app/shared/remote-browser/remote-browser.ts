import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  computed,
  effect,
  untracked,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { EMPTY, Subscription, exhaustMap, switchMap, timeout, timer } from 'rxjs';
import GstWebRTCAPI from 'gstwebrtc-api/src/gstwebrtc-api.js';
import type ConsumerSession from 'gstwebrtc-api/types/consumer-session';
import { Api, problemOf } from '../../core/api/api.service';
import { BrowserSession, InputTicket, ViewTicket } from '../../core/api/models';
import { HelmTransport, StreamState } from './helm-transport';
import { Icon } from '../icon/icon';
import { committedTextActions, InputAction, pointerAction } from './input-action';
import { ReconnectWindow } from '../../core/realtime/reconnect-window';
import { PresentedFrames } from './presented-frames';

export type ViewerState = 'CONNECTING' | 'LIVE' | 'HIDDEN' | 'UNAVAILABLE' | 'ERROR' | 'AUTOPLAY';

@Component({
  selector: 'hg-remote-browser',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <div
    class="remote-viewport"
    [style.aspect-ratio]="session().viewport.width + '/' + session().viewport.height"
  >
    <video
      #video
      autoplay
      muted
      playsinline
      [class.hidden-video]="state() !== 'LIVE'"
      (error)="fail('Ошибка декодирования видео')"
    ></video>
    @if (state() === 'LIVE' && inputReady()) {
      <textarea
        class="remote-input"
        aria-label="Управление удалённым браузером. Нажмите Escape, затем Tab, чтобы покинуть область."
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        (pointerdown)="pointer($event, 'pointerDown')"
        (pointerup)="pointer($event, 'pointerUp')"
        (pointermove)="pointer($event, 'pointerMove')"
        (wheel)="wheel($event)"
        (keydown)="key($event, 'keyDown')"
        (keyup)="key($event, 'keyUp')"
        (input)="text($event)"
        (contextmenu)="$event.preventDefault()"
        (blur)="releaseKeys()"
        (compositionstart)="composing = true"
        (compositionend)="composition($event)"
      ></textarea>
    }
    @if (state() !== 'LIVE') {
      <div class="viewer-empty">
        <div>
          <hg-icon name="browser" />
          <h3>{{ title() }}</h3>
          <p>{{ message() }}</p>
          @if (state() === 'ERROR' || state() === 'AUTOPLAY') {
            <button class="btn" (click)="retry()">
              {{ state() === 'AUTOPLAY' ? 'Включить просмотр' : 'Восстановить просмотр' }}
            </button>
          }
        </div>
      </div>
    }
  </div>`,
})
export class RemoteBrowser {
  session = input.required<BrowserSession>();
  instanceId = input.required<string>();
  taskId = input<string | undefined>();
  surface = input<'WEB' | 'WIDGET'>('WEB');
  ticket = input<ViewTicket | null>(null);
  paused = input(false);
  refresh = output<void>();
  live = output<boolean>();
  stateChanged = output<ViewerState>();
  readonly state = signal<ViewerState>('CONNECTING');
  readonly message = signal('Подключаемся к текущему браузеру…');
  readonly inputReady = signal(false);
  private video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private api = inject(Api);
  private zone = inject(NgZone);
  private destroy = inject(DestroyRef);
  private transport?: HelmTransport;
  private consumer?: ConsumerSession;
  private sdk?: GstWebRTCAPI;
  private inputSocket?: WebSocket;
  private request?: Subscription;
  private inputRequest?: Subscription;
  private generation = 0;
  private frames?: PresentedFrames;
  private frameTimeout?: ReturnType<typeof setTimeout>;
  private captureTimeout?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private readonly recovery = new ReconnectWindow();
  private channelSession?: BrowserSession;
  private current?: StreamState;
  private sequence = 0;
  private heldKeys = new Set<string>();
  composing = false;
  private escape = false;
  private visible = signal(!document.hidden);
  private readonly retryAttempt = signal(0);
  constructor() {
    const visibility = () => {
      this.visible.set(!document.hidden);
      if (document.hidden) this.teardown();
      else this.refresh.emit();
    };
    const hide = () => {
      this.visible.set(false);
      this.teardown();
    };
    const show = () => {
      this.visible.set(!document.hidden);
      this.recovery.reset();
      this.refresh.emit();
    };
    const online = () => {
      if (this.visible() && !this.paused() && this.state() === 'ERROR') this.retry();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    window.addEventListener('online', online);
    this.destroy.onDestroy(() => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('online', online);
      this.teardown();
    });
    const binding = computed(() => {
      const session = this.session();
      return [
        session.id,
        session.state,
        session.pageEpoch,
        session.privacyEpoch,
        session.mediaGeneration,
        this.surface() === 'WEB' ? session.controlEpoch : '',
        this.surface() === 'WEB' ? session.controlMode : '',
        this.surface() === 'WEB' ? session.controlState : '',
        this.surface() === 'WEB' ? session.controllerRelation : '',
        session.capabilities['view']?.allowed,
      ].join(':');
    });
    effect(() => {
      binding();
      this.retryAttempt();
      const video = this.video(),
        visible = this.visible(),
        paused = this.paused(),
        ticket = this.ticket();
      if (!video) return;
      untracked(() => {
        const session = this.session();
        this.teardown();
        this.recovery.reset();
        if (!visible || paused) {
          this.state.set('HIDDEN');
          this.message.set(
            paused ? 'Просмотр приостановлен. Задача продолжает работу.' : 'Просмотр скрыт',
          );
          return;
        }
        if (!session.capabilities['view']?.allowed) {
          this.state.set('UNAVAILABLE');
          this.message.set(session.capabilities['view']?.reason || 'Просмотр сейчас недоступен');
          return;
        }
        if (this.surface() === 'WIDGET') {
          if (ticket) this.connect(ticket);
          else {
            this.state.set('HIDDEN');
            this.message.set('Просмотр доступен в кабинете.');
          }
        } else this.acquireTicket();
      });
    });
    // Control has a 15-second lease. Its heartbeat must not wait for the first
    // video frame or stop while the media transport reconnects.
    const controlBinding = computed(() => {
      const session = this.session();
      return [
        session.id,
        session.state,
        session.controlEpoch,
        session.controlState,
        session.controlMode,
        session.controllerRelation,
      ].join(':');
    });
    effect((onCleanup) => {
      controlBinding();
      this.retryAttempt();
      const visible = this.visible(),
        paused = this.paused(),
        surface = this.surface();
      const instanceId = this.instanceId();
      untracked(() => {
        const session = this.session();
        if (
          !visible ||
          paused ||
          surface !== 'WEB' ||
          session.state !== 'ACTIVE' ||
          session.controlState !== 'ACTIVE' ||
          session.controlMode !== 'HUMAN' ||
          session.controllerRelation !== 'SELF'
        )
          return;
        const renewal = timer(0, 5000)
          .pipe(
            exhaustMap(() =>
              this.api
                .mutate<unknown>(
                  'POST',
                  `/browser-sessions/${session.id}/control/renew`,
                  { controllerInstanceId: instanceId, controlEpoch: session.controlEpoch },
                  crypto.randomUUID(),
                )
                .pipe(timeout(4000)),
            ),
          )
          .subscribe({
            error: () => {
              this.fail(
                'Не удалось продлить управление браузером. Обновляем его состояние.',
                false,
              );
              this.refresh.emit();
            },
          });
        onCleanup(() => renewal.unsubscribe());
      });
    });
    effect(() => this.stateChanged.emit(this.state()));
  }
  title() {
    return this.state() === 'ERROR'
      ? 'Не удалось показать браузер'
      : this.state() === 'AUTOPLAY'
        ? 'Нажмите, чтобы начать просмотр'
        : this.state() === 'UNAVAILABLE'
          ? 'Просмотр недоступен'
          : this.state() === 'HIDDEN'
            ? 'Просмотр приостановлен'
            : 'Подключаем браузер';
  }
  private acquireTicket() {
    this.state.set('CONNECTING');
    const session = this.session(),
      generation = this.generation;
    this.request = this.api
      .get<BrowserSession>(`/browser-sessions/${session.id}`, {
        controllerInstanceId: this.instanceId(),
      })
      .pipe(
        switchMap((current) => {
          this.channelSession = current;
          if (!current.capabilities['view']?.allowed) {
            this.state.set('UNAVAILABLE');
            this.message.set(current.capabilities['view']?.reason || 'Просмотр сейчас недоступен');
            this.refresh.emit();
            return EMPTY;
          }
          return this.api.mutate<ViewTicket>(
            'POST',
            `/browser-sessions/${session.id}/view-tickets`,
            {
              taskId: this.taskId(),
              viewerInstanceId: this.instanceId(),
              controllerInstanceId: this.instanceId(),
              expectedVersion: current.version,
            },
            crypto.randomUUID(),
          );
        }),
      )
      .subscribe({
        next: (ticket) => {
          if (generation === this.generation) this.connect(ticket);
        },
        error: (error: unknown) => {
          if (generation !== this.generation) return;
          const problem = problemOf(error);
          const retryAfter =
            error instanceof HttpErrorResponse ? error.headers.get('Retry-After') : null;
          const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
          this.fail(problem.title, ![401, 403, 404].includes(problem.status), seconds);
        },
      });
  }
  private connect(ticket: ViewTicket) {
    const generation = this.generation,
      session = this.channelSession ?? this.session();
    this.state.set('CONNECTING');
    const webrtcConfig: RTCConfiguration = {
      iceServers: [],
      bundlePolicy: 'max-bundle',
      iceTransportPolicy: 'relay',
    };
    const config = {
      meta: {},
      signalingServerUrl: ticket.signalingUrl,
      reconnectionTimeout: 0,
      webrtcConfig,
      transportFactory: (url: string) => {
        const transport = new HelmTransport(
          url,
          ticket.ticket,
          (state) => {
            if (generation !== this.generation) return;
            if (
              state.sessionId !== session.id ||
              state.pageEpoch !== session.pageEpoch ||
              state.privacyEpoch !== session.privacyEpoch ||
              state.viewGeneration !== ticket.viewGeneration ||
              (session.mediaGeneration !== undefined &&
                state.mediaGeneration !== session.mediaGeneration)
            ) {
              this.fail('Контекст браузера изменился. Обновляем просмотр.');
              this.refresh.emit();
              return;
            }
            this.current = state;
            webrtcConfig.iceServers = state.iceServers;
            clearTimeout(this.captureTimeout);
            if (state.captureState !== 'ACTIVE') {
              this.markStale();
              return;
            }
            if (this.frames?.fresh && this.state() !== 'LIVE') {
              this.state.set('LIVE');
              this.live.emit(true);
              this.connectInput();
            }
            this.captureTimeout = setTimeout(() => this.markStale(), 2000);
          },
          (code) => {
            if (generation !== this.generation) return;
            this.fail(
              code === 4403 ? 'Доступ к просмотру отозван' : 'Видеоканал прерван',
              ![4401, 4403, 4404, 4412].includes(code),
            );
            this.refresh.emit();
          },
        );
        this.transport = transport;
        return transport;
      },
    };
    this.sdk = new GstWebRTCAPI(config);
    let signalingReady = false;
    const start = (producerId: string) => {
      if (
        !signalingReady ||
        generation !== this.generation ||
        this.consumer ||
        producerId !== this.current?.producerId
      )
        return;
      const consumer = this.sdk?.createConsumerSession(producerId);
      if (!consumer) {
        this.fail('Не удалось создать видеоканал');
        return;
      }
      this.consumer = consumer;
      consumer.addEventListener('streamsChanged', () => {
        if (generation !== this.generation) return;
        const stream = consumer.streams[0],
          video = this.video()?.nativeElement;
        if (!stream || !video) return;
        video.srcObject = stream;
        void video
          .play()
          .then(() => this.waitFrame(generation))
          .catch(() => {
            if (generation === this.generation) {
              this.state.set('AUTOPLAY');
              this.message.set('Браузер запретил автоматическое воспроизведение.');
            }
          });
      });
      consumer.addEventListener('error', () => {
        if (generation === this.generation)
          this.fail('Не удалось согласовать или декодировать поток');
      });
      consumer.addEventListener('closed', () => {
        if (generation === this.generation) this.fail('Просмотр завершён');
      });
      if (!consumer.connect()) this.fail('Сервер не принял подключение видео');
      this.frameTimeout = setTimeout(() => {
        if (generation === this.generation && this.state() !== 'LIVE')
          this.fail('За отведённое время свежие кадры не поступили');
      }, 15000);
    };
    this.sdk.registerConnectionListener({
      connected: () => {
        signalingReady = true;
        for (const producer of this.sdk?.getAvailableProducers() ?? []) start(producer.id);
      },
      disconnected: () => {
        signalingReady = false;
        if (generation === this.generation) this.fail('Сигнальный канал отключён');
      },
    });
    this.sdk.registerPeerListener({
      producerAdded: (producer) => start(producer.id),
      producerRemoved: (producer) => {
        // Upstream replaces its peer list synchronously, emitting removed/added
        // even when the same producer remains in the refreshed list.
        queueMicrotask(() => {
          if (
            generation === this.generation &&
            producer.id === this.current?.producerId &&
            !this.sdk?.getAvailableProducers().some((peer) => peer.id === producer.id)
          )
            this.fail('Поток браузера завершён');
        });
      },
    });
  }
  private waitFrame(generation: number) {
    this.zone.runOutsideAngular(() => {
      const video = this.video()?.nativeElement;
      if (!video || generation !== this.generation) return;
      this.frames?.stop();
      this.frames = new PresentedFrames(
        video,
        () => {
          if (
            generation !== this.generation ||
            this.current?.captureState !== 'ACTIVE' ||
            this.state() === 'LIVE'
          )
            return;
          clearTimeout(this.frameTimeout);
          this.zone.run(() => {
            this.recovery.reset();
            this.state.set('LIVE');
            this.live.emit(true);
            this.connectInput();
          });
        },
        () => {
          if (generation === this.generation)
            this.zone.run(() => this.fail('Новые кадры не поступают. Ввод остановлен.'));
        },
      );
    });
  }
  private markStale() {
    this.state.set('CONNECTING');
    this.message.set('Ждём подтверждения свежести изображения. Ввод временно недоступен.');
    if (!this.destroy.destroyed) this.live.emit(false);
  }
  private connectInput() {
    const session = this.channelSession ?? this.session();
    if (
      this.inputSocket ||
      (this.inputRequest && !this.inputRequest.closed) ||
      this.surface() !== 'WEB' ||
      !['HUMAN', 'PRIVATE'].includes(session.controlMode) ||
      session.controlState !== 'ACTIVE' ||
      session.controllerRelation !== 'SELF'
    )
      return;
    const generation = this.generation;
    this.inputRequest = this.api
      .mutate<InputTicket>(
        'POST',
        `/browser-sessions/${session.id}/control/input-tickets`,
        { controllerInstanceId: this.instanceId(), controlEpoch: session.controlEpoch },
        crypto.randomUUID(),
      )
      .subscribe({
        next: (ticket) => {
          if (generation !== this.generation) return;
          const socket = new WebSocket(ticket.inputUrl);
          this.inputSocket = socket;
          socket.onopen = () =>
            socket.send(JSON.stringify({ type: 'authenticate', ticket: ticket.ticket }));
          socket.onmessage = ({ data }: MessageEvent<unknown>) => {
            if (typeof data !== 'string' || generation !== this.generation) return;
            let msg: unknown;
            try {
              msg = JSON.parse(data);
            } catch {
              return;
            }
            if (
              typeof msg === 'object' &&
              msg &&
              'type' in msg &&
              msg.type === 'ready' &&
              'schemaVersion' in msg &&
              msg.schemaVersion === 1 &&
              'nextInputSequence' in msg &&
              typeof msg.nextInputSequence === 'number' &&
              Number.isSafeInteger(msg.nextInputSequence) &&
              msg.nextInputSequence > 0
            ) {
              this.sequence = msg.nextInputSequence - 1;
              this.inputReady.set(true);
              clearInterval(this.heartbeat);
              this.heartbeat = setInterval(() => this.send({ type: 'heartbeat' }), 1000);
            }
          };
          socket.onclose = () => {
            if (generation !== this.generation) return;
            clearInterval(this.heartbeat);
            this.inputReady.set(false);
            this.inputSocket = undefined;
            this.refresh.emit();
          };
        },
        error: () => {
          this.inputReady.set(false);
          this.refresh.emit();
        },
      });
  }
  private send(action: InputAction) {
    const session = this.channelSession ?? this.session();
    if (
      !this.inputReady() ||
      (action.type !== 'heartbeat' && this.state() !== 'LIVE') ||
      this.inputSocket?.readyState !== WebSocket.OPEN
    )
      return;
    this.inputSocket.send(
      JSON.stringify({
        type: 'input',
        schemaVersion: 1,
        browserSessionId: session.id,
        controlEpoch: session.controlEpoch,
        pageEpoch: session.pageEpoch,
        inputSequence: ++this.sequence,
        action,
      }),
    );
  }
  pointer(event: PointerEvent, type: 'pointerMove' | 'pointerDown' | 'pointerUp') {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const viewport = this.current?.viewport ?? this.session().viewport;
    if (type === 'pointerDown') {
      target.focus();
      target.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const action = pointerAction(type, event, target.getBoundingClientRect(), viewport);
    if (action) this.send(action);
  }
  wheel(event: WheelEvent) {
    event.preventDefault();
    const scale =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? this.session().viewport.height
          : 1;
    this.send({
      type: 'wheel',
      deltaX: Math.max(-5000, Math.min(5000, event.deltaX * scale)),
      deltaY: Math.max(-5000, Math.min(5000, event.deltaY * scale)),
    });
  }
  key(event: KeyboardEvent, type: 'keyDown' | 'keyUp') {
    if (this.escape && event.key === 'Tab') {
      this.escape = false;
      return;
    }
    this.escape = event.key === 'Escape';
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    if (this.composing) return;
    event.preventDefault();
    if (type === 'keyDown') this.heldKeys.add(event.key);
    else this.heldKeys.delete(event.key);
    this.send({ type, key: event.key });
  }
  text(event: Event) {
    if (this.composing) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement && target.value) {
      this.commitText(target.value);
      target.value = '';
    }
  }
  composition(event: CompositionEvent) {
    this.composing = false;
    if (event.data) this.commitText(event.data);
    if (event.target instanceof HTMLTextAreaElement) event.target.value = '';
  }
  releaseKeys() {
    for (const key of this.heldKeys) this.send({ type: 'keyUp', key });
    this.heldKeys.clear();
    this.escape = false;
  }
  private commitText(text: string) {
    for (const action of committedTextActions(text)) this.send(action);
  }
  retry() {
    if (this.state() === 'AUTOPLAY') {
      const video = this.video()?.nativeElement,
        generation = this.generation;
      if (video)
        void video
          .play()
          .then(() => this.waitFrame(generation))
          .catch(() => this.fail('Воспроизведение заблокировано браузером'));
      return;
    }
    if (this.surface() === 'WEB') this.retryAttempt.update((attempt) => attempt + 1);
    else this.refresh.emit();
  }
  fail(message: string, recover = true, retryAfterMs = 0) {
    this.teardown();
    this.state.set('ERROR');
    this.message.set(message);
    if (!recover || !this.visible() || this.paused() || this.surface() !== 'WEB') return;
    const delay = this.recovery.nextDelay(Date.now(), retryAfterMs);
    if (delay === null) return;
    this.state.set('CONNECTING');
    this.message.set(`${message}. Повторяем подключение к текущему браузеру…`);
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.acquireTicket();
    }, delay);
  }
  private teardown() {
    this.releaseKeys();
    this.generation++;
    this.request?.unsubscribe();
    this.inputRequest?.unsubscribe();
    clearTimeout(this.frameTimeout);
    clearTimeout(this.captureTimeout);
    this.frames?.stop();
    this.frames = undefined;
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.inputReady.set(false);
    if (!this.destroy.destroyed) this.live.emit(false);
    const video = this.video()?.nativeElement;
    if (video) {
      video.pause();
      if (video.srcObject instanceof MediaStream)
        for (const track of video.srcObject.getTracks()) track.stop();
      video.srcObject = null;
    }
    this.consumer?.close();
    this.consumer = undefined;
    this.sdk?.unregisterAllConnectionListeners();
    this.sdk?.unregisterAllPeerListeners();
    this.sdk = undefined;
    this.transport?.close();
    this.transport = undefined;
    if (this.inputSocket) {
      this.inputSocket.onclose = null;
      this.inputSocket.close();
      this.inputSocket = undefined;
    }
    this.current = undefined;
    this.channelSession = undefined;
  }
}
