import { DestroyRef, Injectable, NgZone, inject, signal } from '@angular/core';
import { Observable, Subject, Subscription, timeout } from 'rxjs';
import { problemOf } from '../api/api.service';
import { Me } from '../api/models';
import { ReconnectWindow } from './reconnect-window';

export type ResourceName =
  | 'tasks'
  | 'connections'
  | 'result'
  | 'events'
  | 'artifacts'
  | 'audio'
  | 'notifications'
  | 'usage'
  | 'sites'
  | 'operations'
  | 'users'
  | 'userTasks'
  | 'userDays'
  | 'nodes'
  | 'sessions'
  | 'audit';
const resources = new Set<string>([
  'tasks',
  'connections',
  'result',
  'events',
  'artifacts',
  'audio',
  'notifications',
  'usage',
  'sites',
  'operations',
  'users',
  'userTasks',
  'userDays',
  'nodes',
  'sessions',
  'audit',
]);

@Injectable({ providedIn: 'root' })
export class Realtime {
  readonly refresh = new Subject<ReadonlySet<string> | null>();
  readonly state = signal<'connecting' | 'ready' | 'offline' | 'exhausted' | 'denied'>(
    'connecting',
  );
  private readonly zone = inject(NgZone);
  private authenticate?: () => Observable<Me>;
  private authentication?: Subscription;
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly recovery = new ReconnectWindow();
  private lastPong = 0;
  private enabled = false;
  private admin = false;
  private userId?: string;

  constructor() {
    const hide = () => this.disconnect();
    const show = () => this.retry();
    const visibility = () => (document.hidden ? hide() : show());
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    window.addEventListener('online', show);
    document.addEventListener('visibilitychange', visibility);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('online', show);
      document.removeEventListener('visibilitychange', visibility);
      this.disconnect();
      this.refresh.complete();
    });
  }

  retry() {
    if (!this.enabled || document.hidden || this.state() === 'denied') return;
    if (this.socket || this.authentication) return;
    this.recovery.reset();
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.reauthenticate();
  }

  start(me: Me, authenticate: () => Observable<Me>) {
    if (!this.enabled) this.recovery.reset();
    this.enabled = true;
    this.authenticate = authenticate;
    const admin = me.permissions.includes('platform_admin');
    if (this.userId !== me.id || this.admin !== admin) {
      this.userId = me.id;
      this.admin = admin;
      this.disconnect();
    }
    this.connect();
  }

  stop() {
    this.enabled = false;
    this.disconnect();
    this.state.set('denied');
  }

  private connect() {
    if (!this.enabled || document.hidden || this.socket || this.reconnect) return;
    this.state.set('connecting');
    this.zone.runOutsideAngular(() => {
      const socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events/v1/user`,
      );
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.lastPong = Date.now();
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            channels: this.admin ? ['self', 'administration'] : ['self'],
          }),
        );
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastPong > 45000) socket.close();
          else if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: 'ping' }));
        }, 15000);
      };
      socket.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (this.socket !== socket || typeof data !== 'string' || data.length > 8192) return;
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          socket.close();
          return;
        }
        if (typeof message !== 'object' || !message || !('type' in message)) return;
        if (message.type === 'pong') this.lastPong = Date.now();
        if (message.type === 'ready')
          this.zone.run(() => {
            this.recovery.reset();
            this.state.set('ready');
            this.refresh.next(null);
          });
        if (
          message.type === 'invalidate' &&
          'resources' in message &&
          Array.isArray(message.resources)
        ) {
          const names = message.resources.filter(
            (value: unknown): value is string => typeof value === 'string' && resources.has(value),
          );
          this.zone.run(() => this.refresh.next(new Set(names)));
        }
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.disconnect();
        if (event.code === 4403) {
          this.zone.run(() => this.stop());
          return;
        }
        this.scheduleReconnect();
      };
    });
  }

  private reauthenticate() {
    const authenticate = this.authenticate;
    if (!this.enabled || document.hidden || this.socket || this.authentication || !authenticate)
      return;
    // HTTP exposes 401/403 and lets OAuth2 Proxy refresh the session. A failed
    // WebSocket handshake only exposes code 1006 to the browser.
    const request = new Subscription();
    this.authentication = request;
    request.add(
      authenticate()
        .pipe(timeout(10000))
        .subscribe({
          next: (me) => {
            this.authentication = undefined;
            this.zone.run(() => this.start(me, authenticate));
          },
          error: (error: unknown) => {
            this.authentication = undefined;
            const problem = problemOf(error);
            if (problem.status === 401 || problem.status === 403) {
              this.zone.run(() => this.stop());
            } else {
              this.scheduleReconnect();
            }
          },
        }),
    );
  }

  private scheduleReconnect() {
    this.zone.run(() => this.state.set('offline'));
    if (!this.enabled || document.hidden) return;
    const delay = this.recovery.nextDelay();
    if (delay === null) {
      this.zone.run(() => this.state.set('exhausted'));
      return;
    }
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.reauthenticate();
    }, delay);
  }

  private disconnect() {
    this.authentication?.unsubscribe();
    this.authentication = undefined;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.reconnect = undefined;
    this.heartbeat = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
    }
  }
}
