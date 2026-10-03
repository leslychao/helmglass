import type { Assignment } from './protocol.js';

/** Exact site origins, shared by Chromium requests and the authenticated media downloader. */
export class OriginPolicy {
  private readonly allowed: ReadonlySet<string>;
  private readonly denied: ReadonlySet<string>;

  constructor(private readonly assignment: Assignment) {
    this.allowed = new Set(assignment.allowedOrigins);
    this.denied = new Set(assignment.deniedOrigins ?? []);
  }

  permits(url: URL): boolean {
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return false;
    if (this.assignment.originPolicy === 'ALLOWLIST') return this.allowed.has(url.origin);
    if (this.assignment.originPolicy === 'DENYLIST') {
      return this.assignment.deniedOrigins !== undefined && !this.denied.has(url.origin);
    }
    return true;
  }

  permitsWebSocket(rawUrl: string): boolean {
    const url = new URL(rawUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false;
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    return this.permits(url);
  }
}
