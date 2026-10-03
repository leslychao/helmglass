import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { WorkerError } from './protocol.js';

export class NativeMediaHelper {
  private readonly child = spawn('helm-media-helper', [], { stdio: ['pipe', 'pipe', 'ignore'] });
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ended = false;
  constructor(private readonly onFailure: () => void) {
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (line.length > 262_144) { this.child.kill('SIGKILL'); return; }
      let value: unknown;
      try { value = JSON.parse(line); } catch { this.child.kill('SIGKILL'); return; }
      const decoded = z.object({ type: z.string(), requestId: z.uuid().optional(), code: z.string().optional() }).safeParse(value);
      if (!decoded.success) { this.child.kill('SIGKILL'); return; }
      if (!decoded.data.requestId) return;
      const pending = this.pending.get(decoded.data.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(decoded.data.requestId);
      if (decoded.data.type === 'error') pending.reject(new WorkerError('MEDIA_HELPER_REJECTED'));
      else pending.resolve(value);
    });
    const ended = () => {
      if (this.ended) return;
      this.ended = true; lines.close();
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new WorkerError('MEDIA_HELPER_LOST')); }
      this.pending.clear(); this.onFailure();
    };
    this.child.once('exit', ended); this.child.once('error', ended);
  }
  request(type: string, properties: Record<string, unknown> = {}): Promise<unknown> {
    if (this.ended) return Promise.reject(new WorkerError('MEDIA_HELPER_LOST'));
    if (this.pending.size >= 16) return Promise.reject(new WorkerError('MEDIA_BACKPRESSURE'));
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); this.child.kill('SIGKILL'); reject(new WorkerError('MEDIA_HELPER_TIMEOUT')); }, type === 'capabilities' ? 20_000 : 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ type, requestId, ...properties }) + '\n');
    });
  }
  async stop(): Promise<void> {
    const result = await this.request('stop');
    z.object({ type: z.literal('teardownAck') }).parse(result);
  }
  async shutdown(): Promise<void> {
    try { if (!this.ended) await this.stop(); }
    finally { this.child.stdin.end(); }
  }
}
