import { WorkerError } from './protocol.js';

/** All Page operations and control transitions share this bounded serial queue. */
export class SessionMailbox {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WorkerError('SESSION_CLOSED'));
    if (this.pending >= 64) return Promise.reject(new WorkerError('INPUT_BACKPRESSURE'));
    this.pending++;
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined).finally(() => { this.pending--; });
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
