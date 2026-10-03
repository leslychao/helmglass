import { digest, WorkerError } from './protocol.js';
import type { Assignment, LaunchPermit } from './protocol.js';

export interface SupervisedSession {
  readonly assignment: Assignment;
  inventory(): Record<string, unknown>;
  close(): Promise<void>;
  fenceDisconnected(): Promise<void>;
}

/** Owns the physical slot, including the interval before Chromium becomes observable. */
export class SessionSupervisor<T extends SupervisedSession> {
  private active: { session: T; assignmentDigest: string; permitId: string } | undefined;
  private pending: { assignment: Assignment; assignmentDigest: string; promise: Promise<T> } | undefined;
  private closing: { assignment: Assignment | undefined; promise: Promise<T | undefined> } | undefined;
  private generation = 0;
  private barrier: Promise<void> = Promise.resolve();
  private unsafe = false;

  constructor(private readonly bootId: string, private readonly create: (assignment: Assignment) => Promise<T>) {}

  get session(): T | undefined { return this.active?.session; }
  get occupied(): boolean { return this.active !== undefined || this.pending !== undefined || this.closing !== undefined; }

  assign(assignment: Assignment, authorize: (assignmentDigest: string) => Promise<LaunchPermit>): Promise<T> {
    if (this.unsafe) return Promise.reject(new WorkerError('RUNTIME_CLOSURE_UNCONFIRMED'));
    if (this.closing) return Promise.reject(new WorkerError('WORKER_CAPACITY'));
    if (assignment.workerBootId !== this.bootId) return Promise.reject(new WorkerError('BOOT_FENCED'));
    const assignmentDigest = digest(assignment);
    if (this.active) {
      return this.active.assignmentDigest === assignmentDigest
        ? Promise.resolve(this.active.session) : Promise.reject(new WorkerError('WORKER_CAPACITY'));
    }
    if (this.pending) {
      return this.pending.assignmentDigest === assignmentDigest
        ? this.pending.promise : Promise.reject(new WorkerError('WORKER_CAPACITY'));
    }
    const generation = this.generation;
    // Install the slot synchronously before either authorization or launch can yield.
    const promise = Promise.resolve().then(async () => {
      await this.barrier;
      const permit = await authorize(assignmentDigest);
      if (permit.browserSessionId !== assignment.browserSessionId || permit.workerBootId !== this.bootId
          || permit.allocationEpoch !== assignment.allocationEpoch || permit.assignmentDigest !== assignmentDigest
          || Date.parse(permit.deadline) <= Date.now() || Date.parse(permit.deadline) > Date.parse(assignment.deadline)) {
        throw new WorkerError('LAUNCH_PERMIT_FENCED');
      }
      if (generation !== this.generation) throw new WorkerError('LAUNCH_CANCELLED');
      const session = await this.create(assignment);
      if (generation !== this.generation || Date.parse(permit.deadline) <= Date.now()) {
        try { await session.close(); } catch { this.unsafe = true; throw new WorkerError('RUNTIME_CLOSURE_UNCONFIRMED'); }
        throw new WorkerError('LAUNCH_CANCELLED');
      }
      this.active = { session, assignmentDigest, permitId: permit.permitId };
      return session;
    }).catch((error: unknown) => {
      if (error instanceof WorkerError && error.code === 'RUNTIME_CLOSURE_UNCONFIRMED') this.unsafe = true;
      throw error;
    }).finally(() => { if (this.pending?.promise === promise) this.pending = undefined; });
    this.pending = { assignment, assignmentDigest, promise };
    return promise;
  }

  inventory(): Record<string, unknown> | null {
    if (this.unsafe) throw new WorkerError('RUNTIME_CLOSURE_UNCONFIRMED');
    if (this.closing?.assignment) return { browserSessionId: this.closing.assignment.browserSessionId,
      allocationEpoch: this.closing.assignment.allocationEpoch, state: 'CLOSING' };
    if (this.active) return { ...this.active.session.inventory(), startPermitId: this.active.permitId };
    if (this.pending) return { browserSessionId: this.pending.assignment.browserSessionId,
      allocationEpoch: this.pending.assignment.allocationEpoch, state: 'LAUNCHING' };
    return null;
  }

  async snapshot(): Promise<Record<string, unknown> | null> {
    await this.barrier;
    await this.pending?.promise.catch(() => undefined);
    await this.closing?.promise;
    return this.inventory();
  }

  fenceDisconnected(): Promise<void> {
    ++this.generation;
    const closing = this.closing?.promise;
    this.barrier = this.barrier.then(async () => {
      if (closing) await closing;
      else await this.active?.session.fenceDisconnected();
    });
    return this.barrier;
  }

  close(browserSessionId: string, allocationEpoch: number): Promise<T | undefined> {
    const assignment = this.active?.session.assignment ?? this.pending?.assignment ?? this.closing?.assignment;
    if (assignment && (assignment.browserSessionId !== browserSessionId || assignment.allocationEpoch !== allocationEpoch)) {
      return Promise.reject(new WorkerError('CLOSE_FENCED'));
    }
    if (this.closing) return this.closing.promise;
    ++this.generation;
    const barrier = this.barrier;
    const pending = this.pending?.promise;
    const promise = Promise.resolve().then(async () => {
      await barrier;
      await pending?.catch(() => undefined);
      if (this.unsafe) throw new WorkerError('RUNTIME_CLOSURE_UNCONFIRMED');
      const session = this.active?.session;
      if (session) {
        try { await session.close(); } catch { this.unsafe = true; throw new WorkerError('RUNTIME_CLOSURE_UNCONFIRMED'); }
        this.active = undefined;
      }
      return session;
    }).finally(() => { if (this.closing?.promise === promise) this.closing = undefined; });
    this.closing = { assignment, promise };
    return promise;
  }
}
