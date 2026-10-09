import { DestroyRef, Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import * as z from 'zod/mini';
import { browserViewerId } from './viewer';
import { Api } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { BrowserSession } from '../core/models';

const pageSchema = z.object({ active: z.boolean() });

@Injectable({ providedIn: 'root' })
export class BrowserPageLifetime {
  private readonly api = inject(Api);
  private readonly live = inject(LiveEvents);
  private readonly destroy = inject(DestroyRef);
  private readonly router = inject(Router);
  private visit = crypto.randomUUID();
  private session = '';
  private epoch = -1;
  private controlOwner: BrowserSession['controlOwner'] = null;
  private registered = false;
  private pending: Promise<void> = Promise.resolve();

  constructor() {
    // Leaving the document has a reconnect grace period; hiding a Chrome tab does not.
    const hide = () => this.live.leaveBrowserPage(this.visit);
    const show = (event: PageTransitionEvent) => {
      if (event.persisted && this.registered) this.live.followBrowserPage(this.visit);
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    this.destroy.onDestroy(() => {
      this.live.leaveBrowserPage(this.visit);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    });
  }

  prepareStart() {
    this.reset();
    return this.visit;
  }

  retains(browser: BrowserSession | null | undefined, nextUrl: string): boolean {
    const path = this.router.parseUrl(nextUrl).root.children['primary']?.segments
      .map(segment => segment.path) ?? [];
    return !!browser && ((path[0] === 'tasks' && path[1] === browser.taskId
      && (path.length === 2 || path.length === 3 && ['manual', 'result'].includes(path[2])))
      || path.length === 3 && path[0] === 'connections'
        && path[1] === browser.connectionId && path[2] === 'login');
  }

  reset() {
    this.live.leaveBrowserPage(this.visit);
    this.visit = crypto.randomUUID();
    this.session = '';
    this.epoch = -1;
    this.controlOwner = null;
    this.registered = false;
    this.pending = Promise.resolve();
  }

  follow(browser: BrowserSession | null | undefined): Promise<void> {
    if (!browser || ['CLOSED', 'LOST', 'CLOSING'].includes(browser.status)) {
      if (this.session) this.reset();
      return Promise.resolve();
    }
    if (this.session && this.session !== browser.id) this.reset();
    if (this.session === browser.id && this.epoch === browser.controlEpoch
      && this.controlOwner === browser.controlOwner) return this.pending;
    this.session = browser.id;
    this.epoch = browser.controlEpoch;
    this.controlOwner = browser.controlOwner;
    const visit = this.visit;
    const path = this.path();
    this.pending = this.pending.catch(() => {}).then(async () => {
      if (visit !== this.visit || this.destroy.destroyed) return;
      try {
        await this.api.mutate(path, { viewerId: browserViewerId() }, pageSchema, 'PUT');
        if (visit !== this.visit || this.destroy.destroyed) return;
        this.registered = true;
        this.live.followBrowserPage(visit);
      } catch (error: unknown) {
        if (visit === this.visit) this.epoch = -1;
        throw error;
      }
    });
    return this.pending;
  }

  async leave() {
    await this.pending;
    if (this.registered) await this.api.mutate(this.path(), {}, pageSchema, 'DELETE');
    this.reset();
  }

  private path() {
    return '/api/browser-sessions/' + this.session + '/pages/' + this.visit;
  }
}
