import { Injectable, OnDestroy, signal } from '@angular/core';
import { Subject, filter } from 'rxjs';
import { changeSchema, Change } from './models';

@Injectable({ providedIn: 'root' })
export class LiveEvents implements OnDestroy {
  readonly state = signal<'idle' | 'syncing' | 'ready' | 'reconnecting' | 'unavailable'>('idle');
  private source: EventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cursor = '';
  private attempts = 0;
  private stopped = true;
  private refreshes = 0;
  private synchronized = false;
  private refreshFailed = false;
  private readonly changes = new Subject<Change>();

  watch(resources: readonly string[], entityId?: string) {
    return this.changes.pipe(
      filter(
        (event) =>
          event.resource === 'sync' ||
          (resources.includes(event.resource) &&
            (!entityId || event.entityId === entityId || !event.entityId)),
      ),
    );
  }
  start() {
    if (this.stopped) {
      this.stopped = false;
      this.connect();
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.source?.close();
    this.source = null;
    this.cursor = '';
    this.synchronized = false;
    this.state.set('idle');
  }
  reconnect() {
    this.attempts = 0;
    this.connect();
  }
  beginRefresh() {
    const tracked = this.state() === 'syncing';
    if (tracked) this.refreshes++;
    return tracked;
  }
  endRefresh(tracked: boolean, success: boolean) {
    if (!tracked) return;
    this.refreshes = Math.max(0, this.refreshes - 1);
    if (!success) this.refreshFailed = true;
    this.finishSynchronization();
  }
  private finishSynchronization() {
    if (!this.stopped && this.synchronized && this.refreshes === 0)
      this.state.set(this.refreshFailed ? 'unavailable' : 'ready');
  }
  private connect() {
    if (this.stopped) return;
    this.source?.close();
    clearTimeout(this.timer);
    this.synchronized = false;
    this.refreshFailed = false;
    this.state.set('syncing');
    const source = new EventSource(
      '/api/events' + (this.cursor ? '?cursor=' + encodeURIComponent(this.cursor) : ''),
    );
    this.source = source;
    source.addEventListener('change', (event) => {
      if (!(event instanceof MessageEvent) || source !== this.source) return;
      let json: unknown;
      try {
        json = JSON.parse(String(event.data));
      } catch {
        this.failed(source);
        return;
      }
      const parsed = changeSchema.safeParse(json);
      if (!parsed.success) {
        this.failed(source);
        return;
      }
      if (parsed.data.id <= Number(this.cursor) && parsed.data.resource !== 'sync') return;
      this.cursor = event.lastEventId || String(parsed.data.id);
      this.attempts = 0;
      if (parsed.data.resource === 'sync') {
        this.synchronized = true;
        this.state.set('syncing');
      }
      this.changes.next(parsed.data);
      this.finishSynchronization();
    });
    source.onerror = () => this.failed(source);
  }
  private failed(source: EventSource) {
    if (source !== this.source || this.stopped) return;
    source.close();
    this.source = null;
    if (++this.attempts > 8) {
      this.state.set('unavailable');
      return;
    }
    this.state.set('reconnecting');
    this.timer = setTimeout(
      () => this.connect(),
      Math.min(30_000, 1000 * 2 ** (this.attempts - 1)) * (0.85 + Math.random() * 0.3),
    );
  }
  ngOnDestroy() {
    this.stop();
    this.changes.complete();
  }
}
