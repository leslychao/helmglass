import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { uploadArtifact } from './artifact-transfer.js';
import { WorkerError } from './protocol.js';
import type { Assignment, Command } from './protocol.js';

/** One explicitly permitted viewport capture; upload retries retain these exact PNG bytes. */
export class BrowserSnapshot {
  private active: AbortController | undefined;

  cancel(): void { this.active?.abort(); }

  async capture(page: Page, assignment: Assignment, command: Command, directory: string,
    deadline: number, assertCurrent: () => void): Promise<Record<string, unknown>> {
    if (this.active) throw new WorkerError('SCREENSHOT_ACTIVE');
    assertCurrent();
    const controller = new AbortController();
    this.active = controller;
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    let staging: string | undefined;
    let png: Buffer | undefined;
    try {
      staging = await mkdtemp(join(directory, 'screenshot-'));
      controller.signal.throwIfAborted();
      png = await page.screenshot({ type: 'png', fullPage: false, scale: 'css',
        timeout: Math.max(1, Math.min(5000, deadline - Date.now())) });
      controller.signal.throwIfAborted();
      assertCurrent();
      if (!png.length || png.length > 16_777_216) throw new WorkerError('SCREENSHOT_SIZE_LIMIT');
      const viewport = page.viewportSize();
      if (!viewport || viewport.width !== assignment.viewport.width || viewport.height !== assignment.viewport.height) throw new WorkerError('SCREENSHOT_VIEWPORT_CHANGED');
      const metadata = { schemaVersion: 1 as const, commandId: command.commandId, attemptId: command.attemptId,
        browserSessionId: assignment.browserSessionId, allocationEpoch: assignment.allocationEpoch,
        pageEpoch: assignment.pageEpoch, privacyEpoch: assignment.privacyEpoch,
        kind: 'SCREENSHOT' as const, sourceKind: 'BROWSER_SCREENSHOT' as const, mimeType: 'image/png' as const,
        byteLength: png.length, sha256: createHash('sha256').update(png).digest('hex'), viewport };
      const path = join(staging, 'viewport.png');
      await writeFile(path, png, { mode: 0o600, flag: 'wx' });
      png.fill(0);
      png = undefined;
      controller.signal.throwIfAborted();
      assertCurrent();
      const receipt = await uploadArtifact(path, metadata, controller.signal);
      assertCurrent();
      return receipt;
    } finally {
      png?.fill(0);
      clearTimeout(timeout);
      this.active = undefined;
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
}
