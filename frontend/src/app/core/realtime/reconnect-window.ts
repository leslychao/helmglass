/** A disconnected viewer gets two minutes of bounded retries, never a new browser session. */
export class ReconnectWindow {
  private startedAt: number | undefined;
  private attempts = 0;

  reset() {
    this.startedAt = undefined;
    this.attempts = 0;
  }

  nextDelay(now = Date.now(), retryAfterMs = 0, jitter = Math.random()): number | null {
    this.startedAt ??= now;
    const remaining = 120000 - (now - this.startedAt);
    const backoff = Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5));
    const delay = Math.max(
      retryAfterMs,
      Math.min(30000, Math.max(1000, backoff * (0.8 + jitter * 0.4))),
    );
    return delay < remaining ? delay : null;
  }
}
