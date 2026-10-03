import { createHash } from 'node:crypto';
import { digest, safeCode, WorkerError } from './protocol.js';
import type { ProfileSaveMessage } from './protocol.js';

export interface ProfileSaveReceipt { transferId: string; sha256: string; byteLength: number }
interface SavedTransfer {
  fingerprint: string;
  captureFingerprint: string;
  receipt?: Readonly<ProfileSaveReceipt>;
  ciphertext?: Buffer | undefined;
  uploaded: boolean;
  captureFailure?: string;
}

/** Session-mailbox owned: capture once, retain identical ciphertext until the publication ACK. */
export class ProfileSaves {
  private readonly transfers = new Map<string, SavedTransfer>();
  private pendingId: string | undefined;

  completed(message: ProfileSaveMessage): Readonly<ProfileSaveReceipt> | undefined {
    const existing = this.find(message);
    return existing?.uploaded ? existing.receipt : undefined;
  }

  async save(message: ProfileSaveMessage, capture: () => Promise<Buffer>,
    upload: (ciphertext: Buffer) => Promise<unknown>): Promise<Readonly<ProfileSaveReceipt>> {
    let entry = this.find(message);
    if (!entry) {
      if (this.pendingId) throw new WorkerError('PROFILE_SAVE_PENDING');
      if (this.transfers.size >= 1000) throw new WorkerError('PROFILE_SAVE_HISTORY_LIMIT');
      entry = { fingerprint: this.fingerprint(message), captureFingerprint: this.captureFingerprint(message), uploaded: false };
      this.transfers.set(message.transferId, entry);
      this.pendingId = message.transferId;
      try {
        entry.ciphertext = await capture();
        if (entry.ciphertext.length < 32 || entry.ciphertext.length > 33_554_464) throw new WorkerError('PROFILE_SIZE_LIMIT');
        entry.receipt = Object.freeze({ transferId: message.transferId, byteLength: entry.ciphertext.length,
          sha256: createHash('sha256').update(entry.ciphertext).digest('hex') });
      } catch (error) {
        entry.ciphertext?.fill(0);
        entry.ciphertext = undefined;
        entry.captureFailure = safeCode(error);
        this.pendingId = undefined;
        throw error;
      }
    }
    if (entry.captureFailure) throw new WorkerError(entry.captureFailure);
    if (!entry.receipt) throw new WorkerError('PROFILE_CAPTURE_UNCONFIRMED');
    if (!entry.uploaded) {
      if (!entry.ciphertext) throw new WorkerError('PROFILE_CIPHERTEXT_UNAVAILABLE');
      await upload(entry.ciphertext);
      entry.uploaded = true;
    }
    return entry.receipt;
  }

  acknowledge(transferId: string, sha256: string): void {
    const entry = this.transfers.get(transferId);
    if (!entry?.receipt || entry.receipt.sha256 !== sha256) throw new WorkerError('PROFILE_ACK_FENCED');
    entry.uploaded = true;
    entry.ciphertext?.fill(0);
    entry.ciphertext = undefined;
    if (this.pendingId === transferId) this.pendingId = undefined;
  }

  pending(): (ProfileSaveReceipt & { state: 'UPLOADING' | 'UPLOADED' })[] {
    const entry = this.pendingId ? this.transfers.get(this.pendingId) : undefined;
    return entry?.receipt ? [{ ...entry.receipt, state: entry.uploaded ? 'UPLOADED' : 'UPLOADING' }] : [];
  }

  close(): void {
    for (const entry of this.transfers.values()) entry.ciphertext?.fill(0);
    this.transfers.clear();
    this.pendingId = undefined;
  }

  private find(message: ProfileSaveMessage): SavedTransfer | undefined {
    const entry = this.transfers.get(message.transferId);
    if (message.reuseOnly) {
      if (!entry?.receipt || (!entry.uploaded && !entry.ciphertext)) throw new WorkerError('PROFILE_SNAPSHOT_UNAVAILABLE');
      if (entry.captureFingerprint !== this.captureFingerprint(message)) throw new WorkerError('PROFILE_TRANSFER_REUSED');
      return entry;
    }
    if (entry && entry.fingerprint !== this.fingerprint(message)) throw new WorkerError('PROFILE_TRANSFER_REUSED');
    return entry;
  }

  private captureFingerprint(message: ProfileSaveMessage): string {
    return digest({ transferId: message.transferId, dek: message.dek, binding: message.binding,
      browserSessionId: message.browserSessionId, allocationEpoch: message.allocationEpoch });
  }

  private fingerprint(message: ProfileSaveMessage): string {
    const { requestId: _requestId, ...grant } = message;
    return digest(grant);
  }
}
