import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { z } from 'zod';
import { SessionMailbox } from './mailbox.js';
import { ObservationBindings, safeUrl } from './observation.js';
import type { BrowserObservation } from './observation.js';
import { PlaywrightMcpAdapter } from './playwright-mcp.js';
import { digest, safeCode, WorkerError } from './protocol.js';
import type { Assignment, Command, ControlMessage, ControlRenewMessage, ExecutionPermit, InputMessage, ProfileTransferMessage, ProfileTransferAck, ProfileCheckMessage, ViewOpen } from './protocol.js';
import { loadProfile, saveProfile } from './profile-transfer.js';
import { transferProfile } from './gateway-transfer.js';
import { MediaCapture } from './media-capture.js';
import { OriginPolicy } from './origin-policy.js';
import { ProfileSaves } from './profile-saves.js';
import { BrowserSnapshot } from './browser-snapshot.js';

export interface AttemptResult {
  schemaVersion: 1;
  commandId: string;
  attemptId: string;
  taskId: string | null;
  browserSessionId: string;
  allocationEpoch: number;
  controlEpoch: number;
  pageEpoch: number;
  privacyEpoch: number;
  status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  effectState: 'NOT_STARTED' | 'CONFIRMED' | 'UNKNOWN';
  code: string;
  observation?: BrowserObservation;
  artifact?: Record<string, unknown>;
  safeUrl?: string;
  digest: string;
}
export interface RuntimeOptions {
  stagingDirectory: string;
  proxyServer?: string;
  headless: boolean;
  display?: string;
  mediaBarrier: () => Promise<void>;
  onHardDeadline?: () => void;
}

/** One owner for Chromium, context, Page identity, epochs, and serialization. */
export class BrowserSession {
  readonly runtimeGeneration = randomUUID();
  private controlReceipt: { digest: string; value: Record<string, unknown> } | undefined;
  readonly mailbox = new SessionMailbox();
  private readonly observations = new ObservationBindings();
  private readonly mediaCapture = new MediaCapture();
  private readonly browserSnapshot = new BrowserSnapshot();
  private profileTransfer: AbortController | undefined;
  private readonly profileSaves = new ProfileSaves();
  private readonly pageIds = new Map<Page, string>();
  private readonly receipts = new Map<string, AttemptResult>();
  private readonly usedPermits = new Set<string>();
  private readonly commandDigests = new Map<string, string>();
  private readonly heldKeys = new Set<string>();
  private readonly heldButtons = new Set<'left' | 'middle' | 'right'>();
  private adapter: PlaywrightMcpAdapter | undefined;
  private mode: ControlMessage['mode'] = 'AGENT';
  private leaseExpiresAt = Number.POSITIVE_INFINITY;
  private leaseDeadline = Number.POSITIVE_INFINITY;
  private leaseTimer: NodeJS.Timeout | undefined;
  private controllerInstance: string | undefined;
  private inputSequence = 0;
  private appliedInputSequence = 0;
  private observationSequence = 0;
  private closed = false;
  private crashed = false;
  private mutationUnknown = false;
  private privateBarrier = false;
  private pendingPage: Page | undefined;
  private sourceStartedAt: string | undefined;
  private readyAt: number | undefined;
  private usageUpdatedAt = performance.now();
  private usageSequence = 0;
  private executionStartedAt: number | undefined;
  private executionMs = 0;
  private humanMs = 0;
  private loginMs = 0;
  private closedAt: number | undefined;
  private finalUsage: Record<string, unknown> | undefined;
  private closePromise: Promise<void> | undefined;
  private budgetTimer: NodeJS.Timeout | undefined;
  private hardDeadlineTimer: NodeJS.Timeout | undefined;
  private cleanupDeadline: number | undefined;
  private safePrivateExit: { pageEpoch: number; privacyEpoch: number; checkedAt: number } | undefined;

  private constructor(readonly assignment: Assignment, private readonly options: RuntimeOptions,
    private readonly browser: Browser, readonly context: BrowserContext, private selected: Page,
    private readonly outputDirectory: string, private readonly originPolicy: OriginPolicy) {
    if (assignment.purpose !== 'TASK') {
      this.mode = 'QUIESCED';
      this.privateBarrier = true;
    }
    this.trackPage(selected);
    context.on('page', (page) => {
      this.trackPage(page);
      this.observations.invalidate();
      this.pendingPage = page;
      if (context.pages().length > 5) { this.crashed = true; void page.close().catch(() => undefined); }
    });
    browser.on('disconnected', () => { this.crashed = true; this.observations.invalidate(); });
  }

  static async create(assignment: Assignment, options: RuntimeOptions): Promise<BrowserSession> {
    await mkdir(options.stagingDirectory, { recursive: true, mode: 0o700 });
    const outputDirectory = await mkdtemp(join(options.stagingDirectory, 'session-'));
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
      headless: options.headless, chromiumSandbox: true,
      ...(options.proxyServer ? { proxy: { server: options.proxyServer } } : {}),
      args: ['--disable-dev-shm-usage', '--disable-breakpad', '--no-default-browser-check', '--disable-component-update',
        '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--kiosk', `--window-size=${assignment.viewport.width},${assignment.viewport.height}`, '--window-position=0,0'],
      ...(options.display ? { env: { ...process.env, DISPLAY: options.display } } : {}),
      });
      const context = await browser.newContext({ viewport: assignment.viewport, serviceWorkers: 'block', acceptDownloads: true });
      context.setDefaultTimeout(10_000);
      const policy = new OriginPolicy(assignment);
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (policy.permits(url)) await route.continue();
        else await route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', async (route) => {
        if (policy.permitsWebSocket(route.url())) route.connectToServer();
        else await route.close({ code: 1008, reason: 'ORIGIN_FORBIDDEN' });
      });
      const page = await context.newPage();
      const session = new BrowserSession(assignment, options, browser, context, page, outputDirectory, policy);
      await session.configureSurface(page);
      if (assignment.purpose === 'TASK') {
        session.adapter = await PlaywrightMcpAdapter.create(context, outputDirectory);
        await session.adapter.selectPage(context, page);
      }
      session.scheduleBudgetExpiry();
      return session;
    } catch (error) {
      try { await browser?.close(); }
      catch { throw new WorkerError('RUNTIME_CLOSURE_UNCONFIRMED'); }
      await rm(outputDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  inventory(): Record<string, unknown> {
    return { browserSessionId: this.assignment.browserSessionId, taskId: this.assignment.taskId,
      runtimeGeneration: this.runtimeGeneration, pageId: this.pageIds.get(this.selected),
      allocationEpoch: this.assignment.allocationEpoch, controlEpoch: this.assignment.controlEpoch,
      pageEpoch: this.assignment.pageEpoch, privacyEpoch: this.assignment.privacyEpoch,
      mode: this.mode, closed: this.closed, unknown: this.mutationUnknown, pendingResults: [...this.receipts.keys()],
      pendingProfileTransfers: this.profileSaves.pending(),
      lastAcceptedInputSequence: this.inputSequence, lastAppliedInputSequence: this.appliedInputSequence };
  }

  markReady(browserSessionId: string, allocationEpoch: number): Promise<Record<string, unknown>> {
    return this.mailbox.run(async () => {
      this.assertLive();
      if (browserSessionId !== this.assignment.browserSessionId || allocationEpoch !== this.assignment.allocationEpoch) throw new WorkerError('READY_FENCED');
      if (this.readyAt === undefined) {
        this.sourceStartedAt = new Date().toISOString();
        this.readyAt = performance.now();
        this.usageUpdatedAt = this.readyAt;
      }
      const usage = this.usageCheckpoint();
      if (!usage) throw new WorkerError('READY_UNCONFIRMED');
      return usage;
    });
  }

  usageCheckpoint(): Record<string, unknown> | undefined {
    if (this.finalUsage) return this.finalUsage;
    if (this.readyAt === undefined) {
      if (this.closedAt === undefined) return undefined;
      this.finalUsage = { sourceId: this.assignment.workerBootId + ':' + this.assignment.browserSessionId,
        sourceStartedAt: new Date().toISOString(), sourceSequence: ++this.usageSequence,
        browserMs: 0, executionMs: 0, humanMs: 0, loginMs: 0, browserComplete: true, mediaComplete: false, neverReady: true };
      return this.finalUsage;
    }
    const now = this.closedAt ?? performance.now();
    this.accountUsage(now);
    const checkpoint = { sourceId: this.assignment.workerBootId + ':' + this.assignment.browserSessionId, sourceStartedAt: this.sourceStartedAt,
      sourceSequence: ++this.usageSequence, browserMs: Math.floor(now - this.readyAt),
      executionMs: Math.floor(this.executionMs + (this.executionStartedAt === undefined ? 0 : now - this.executionStartedAt)),
      humanMs: Math.floor(this.humanMs), loginMs: Math.floor(this.loginMs),
      browserComplete: this.closedAt !== undefined, mediaComplete: false };
    if (this.closedAt !== undefined) this.finalUsage = checkpoint;
    return checkpoint;
  }

  execute(command: Command, getPermit: (actionDigest: string) => Promise<ExecutionPermit>): Promise<AttemptResult> {
    return this.mailbox.run(async () => {
      const receipt = this.receipts.get(command.attemptId);
      if (receipt) {
        if (this.commandDigests.get(command.attemptId) !== digest(command)) throw new WorkerError('ATTEMPT_REUSED');
        return receipt;
      }
      let dispatched = false;
      if (this.receipts.size >= 10_000) throw new WorkerError('SESSION_COMMAND_LIMIT');
      this.commandDigests.set(command.attemptId, digest(command));
      const readOnly = command.action.type === 'OBSERVE' || command.action.type === 'WAIT_FOR' || command.action.type === 'READ_MEDIA' || command.action.type === 'SNAPSHOT';
      let result: Omit<AttemptResult, 'digest'>;
      try {
        this.assertExecutionOwner(command, readOnly);
        await this.synchronizePage();
        const standalone = this.assignment.purpose !== 'TASK';
        const human = command.executionMode !== undefined;
        const adapter = standalone || human ? undefined : this.requireAdapter();
        if ('target' in command.action) {
          if (!adapter) throw new WorkerError('STANDALONE_COMMAND_FORBIDDEN');
          const expected = this.observations.require(command.action.observationId, command.action.target, this.assignment);
          this.observations.verifyTarget(await adapter.snapshot(), command.action.target, expected);
        }
        if (command.action.type === 'NAVIGATE') this.assertAllowedUrl(command.action.url);
        const permit = await getPermit(digest(command.action));
        this.assertPermit(command, permit);
        this.assignment.instructionRevision = permit.instructionRevision;
        this.usedPermits.add(permit.permitId);
        if (command.action.type !== 'OBSERVE') this.observations.invalidate();
        dispatched = true;
        // Human navigation is already part of the active human/login lease interval.
        if (!human && this.readyAt !== undefined) this.executionStartedAt = performance.now();
        let artifact: Record<string, unknown> | undefined;
        if (command.action.type === 'READ_MEDIA') {
          artifact = await this.mediaCapture.capture(this.selected, this.assignment, command, command.action, this.outputDirectory, this.options.proxyServer);
        } else if (command.action.type === 'SNAPSHOT') {
          const page = this.selected;
          const pageEpoch = this.assignment.pageEpoch;
          artifact = await this.browserSnapshot.capture(page, this.assignment, command, this.outputDirectory,
            Math.min(Date.parse(permit.deadline), Date.parse(this.assignment.deadline), this.leaseExpiresAt), () => {
              this.assertExecutionOwner(command, true);
              if (this.selected !== page || this.pendingPage || this.assignment.pageEpoch !== pageEpoch) throw new WorkerError('SCREENSHOT_PAGE_CHANGED');
            });
        } else {
          this.mediaCapture.invalidate();
          const timeout = Math.max(1, Math.min(20_000, Date.parse(permit.deadline) - Date.now(),
            human ? this.leaseDeadline - performance.now() : Number.POSITIVE_INFINITY));
          if (human || standalone) {
            await this.navigate(command.action, timeout);
          } else {
            if (!adapter) throw new WorkerError('STANDALONE_COMMAND_FORBIDDEN');
            await adapter.execute(command.action, this.selected, timeout);
          }
        }
        this.assertLive();
        await this.synchronizePage();
        // Handler completion and the following observation have separate dispositions.
        let observation: BrowserObservation | undefined;
        try { if (!standalone && !human) observation = await this.observe(command.action.type === 'OBSERVE' ? command.action.depth : undefined); }
        catch (error) { if (command.action.type === 'OBSERVE') throw error; }
        result = { ...this.resultIdentity(command), status: 'SUCCEEDED', effectState: 'CONFIRMED',
          code: standalone || human || observation ? 'HANDLER_COMPLETED' : 'HANDLER_COMPLETED_OBSERVATION_UNAVAILABLE',
          ...(observation ? { observation } : {}), ...(artifact ? { artifact } : {}),
          ...(command.executionMode === 'HUMAN' ? { safeUrl: safeUrl(this.selected.url()) } : {}) };
      } catch (error) {
        const unknown = dispatched && (!readOnly || safeCode(error) === 'ARTIFACT_TRANSFER_UNKNOWN');
        if (unknown && !readOnly) this.mutationUnknown = true;
        result = { ...this.resultIdentity(command), status: unknown ? 'UNKNOWN' : 'FAILED',
          effectState: unknown ? 'UNKNOWN' : 'NOT_STARTED', code: safeCode(error) };
      }
      if (this.executionStartedAt !== undefined) {
        this.executionMs += performance.now() - this.executionStartedAt;
        this.executionStartedAt = undefined;
      }
      const receiptWithDigest = { ...result, digest: digest(result) };
      // A used attempt remains tombstoned for the complete runtime, including after ACK.
      this.receipts.set(command.attemptId, receiptWithDigest);
      return receiptWithDigest;
    });
  }

  control(message: ControlMessage): Promise<Record<string, unknown>> {
    const { requestId: _requestId, ...control } = message;
    const controlDigest = digest(control);
    if (this.controlReceipt?.digest !== controlDigest) {
      this.mediaCapture.cancel();
      this.browserSnapshot.cancel();
      this.profileTransfer?.abort();
      this.observations.invalidate();
    }
    return this.mailbox.run(async () => {
      this.assertPhysicalRuntime();
      if (this.controlReceipt?.digest === controlDigest) return this.controlReceipt.value;
      const cleanupDeadline = message.cleanupDeadline === undefined ? undefined : Date.parse(message.cleanupDeadline);
      if (cleanupDeadline !== undefined && (message.mode !== 'QUIESCED' || cleanupDeadline <= Date.now()
          || cleanupDeadline > Math.min(Date.now() + 120_000, Date.parse(this.assignment.deadline) + 120_000)
          || (this.cleanupDeadline !== undefined && cleanupDeadline > this.cleanupDeadline))) throw new WorkerError('CLEANUP_DEADLINE_INVALID');
      if (Date.now() >= Date.parse(this.assignment.deadline) && cleanupDeadline === undefined) throw new WorkerError('BROWSER_DEADLINE');
      if (message.browserSessionId !== this.assignment.browserSessionId || message.allocationEpoch !== this.assignment.allocationEpoch
          || message.controlEpoch < this.assignment.controlEpoch || message.privacyEpoch < this.assignment.privacyEpoch
          || message.pageEpoch < this.assignment.pageEpoch) throw new WorkerError('STALE_CONTROL');
      if ((message.connectionId === undefined) !== (message.scopeVersion === undefined)) throw new WorkerError('CONNECTION_BINDING_FENCED');
      if (message.connectionId !== undefined) {
        const existing = this.assignment.connectionId !== undefined;
        if (existing ? message.connectionId !== this.assignment.connectionId || message.scopeVersion !== this.assignment.scopeVersion
          : message.mode !== 'HUMAN_PRIVATE') throw new WorkerError('CONNECTION_BINDING_FENCED');
      }
      const wasPrivate = this.privateBarrier;
      if (wasPrivate && message.mode === 'AGENT' && (!this.safePrivateExit
          || this.safePrivateExit.pageEpoch !== this.assignment.pageEpoch || this.safePrivateExit.privacyEpoch !== this.assignment.privacyEpoch
          || performance.now() - this.safePrivateExit.checkedAt > 10_000)) throw new WorkerError('SAFE_POST_LOGIN_PAGE_REQUIRED');
      this.accountUsage(performance.now());
      const previousInputCheckpoint = { controlEpoch: this.assignment.controlEpoch,
        ...(this.controllerInstance ? { controllerInstance: this.controllerInstance } : {}),
        lastAcceptedInputSequence: this.inputSequence, lastAppliedInputSequence: this.appliedInputSequence };
      this.mode = 'QUIESCED';
      await this.options.mediaBarrier();
      await this.releaseInput();
      if (message.mode === 'HUMAN_PRIVATE' || wasPrivate) {
        this.privateBarrier = true;
        await this.adapter?.close();
        this.adapter = undefined;
        await this.clearOutput();
      }
      if (wasPrivate && message.mode === 'AGENT') {
        // API must verify the post-login page before requesting this transition.
        for (const page of this.context.pages()) { await page.clearConsoleMessages(); await page.clearPageErrors(); }
        this.adapter = await PlaywrightMcpAdapter.create(this.context, this.outputDirectory);
        await this.adapter.selectPage(this.context, this.selected);
        this.privateBarrier = false;
        this.safePrivateExit = undefined;
      }
      if (this.mutationUnknown && message.mode !== 'QUIESCED') throw new WorkerError('UNKNOWN_EFFECT_BARRIER');
      if (message.controlEpoch > this.assignment.controlEpoch) { this.inputSequence = 0; this.appliedInputSequence = 0; }
      Object.assign(this.assignment, { controlEpoch: message.controlEpoch, privacyEpoch: message.privacyEpoch, pageEpoch: message.pageEpoch, policyVersion: message.policyVersion });
      if (message.connectionId !== undefined) {
        this.assignment.connectionId = message.connectionId;
        this.assignment.scopeVersion = message.scopeVersion;
      }
      this.controllerInstance = message.controllerInstance;
      this.leaseExpiresAt = message.mode === 'AGENT' ? Number.POSITIVE_INFINITY : Date.parse(message.leaseExpiresAt);
      this.leaseDeadline = performance.now() + Math.max(0, this.leaseExpiresAt - Date.now());
      this.mode = message.mode;
      if (cleanupDeadline !== undefined) {
        this.cleanupDeadline = cleanupDeadline;
        this.scheduleHardDeadline(cleanupDeadline);
      }
      this.scheduleLeaseExpiry();
      const receipt = { ...this.inventory(), previousInputCheckpoint, lastAcceptedInputSequence: this.inputSequence, lastAppliedInputSequence: this.appliedInputSequence };
      this.controlReceipt = { digest: controlDigest, value: receipt };
      return receipt;
    });
  }

  renewControl(message: ControlRenewMessage): Record<string, unknown> {
    this.assertLive();
    if (message.browserSessionId !== this.assignment.browserSessionId || message.controlEpoch !== this.assignment.controlEpoch
        || message.controllerInstance !== this.controllerInstance || (this.mode !== 'HUMAN' && this.mode !== 'HUMAN_PRIVATE')
        || this.leaseExpiresAt <= Date.now()) throw new WorkerError('CONTROL_LEASE_FENCED');
    const expiry = Date.parse(message.leaseExpiresAt);
    if (expiry <= this.leaseExpiresAt || expiry > Date.now() + 30_000) throw new WorkerError('CONTROL_LEASE_INVALID');
    this.leaseExpiresAt = expiry;
    this.leaseDeadline = performance.now() + Math.max(0, expiry - Date.now());
    this.scheduleLeaseExpiry();
    return { browserSessionId: message.browserSessionId, controlEpoch: message.controlEpoch, leaseExpiresAt: message.leaseExpiresAt };
  }

  checkProfile(message: ProfileCheckMessage): Promise<Record<string, unknown>> {
    return this.mailbox.run(async () => {
      this.assertLive();
      for (const field of ['browserSessionId', 'allocationEpoch', 'controlEpoch', 'privacyEpoch', 'policyVersion'] as const) {
        if (message[field] !== this.assignment[field]) throw new WorkerError('PROFILE_CHECK_FENCED');
      }
      clearTimeout(this.leaseTimer);
      this.controlReceipt = undefined;
      this.accountUsage(performance.now());
      this.mode = 'QUIESCED';
      await this.options.mediaBarrier();
      await this.releaseInput();
      this.safePrivateExit = undefined;
      const checkedPageEpoch = this.assignment.pageEpoch;
      const checkedUrl = this.selected.url();
      let status: 'SAFE' | 'AUTH_REQUIRED' | 'UNKNOWN' = 'UNKNOWN';
      let verification: 'AUTHENTICATED' | 'USER_ASSERTED' | 'UNKNOWN' = 'UNKNOWN';
      // This fixed, local verifier returns only a boolean disposition, never private DOM.
      const password = this.selected.locator('input[type="password"]:visible');
      if (await password.count()) status = 'AUTH_REQUIRED';
      else {
        const current = new URL(this.selected.url());
        const expected = new URL(message.expectedOrigin);
        if (expected.origin === message.expectedOrigin && current.origin === expected.origin && !current.username && !current.password) {
          const path = message.postLoginPathPrefix;
          const evidence = message.accountEvidenceText;
          if (path !== undefined && evidence !== undefined && (current.pathname === path || current.pathname.startsWith(path.replace(/\/$/, '') + '/'))
              && await this.selected.getByText(evidence, { exact: true }).count() === 1
              && await this.selected.getByText(evidence, { exact: true }).isVisible()) verification = 'AUTHENTICATED';
          else if (message.userAsserted) verification = 'USER_ASSERTED';
          if (verification !== 'UNKNOWN') {
            status = 'SAFE'; this.safePrivateExit = { pageEpoch: this.assignment.pageEpoch, privacyEpoch: this.assignment.privacyEpoch, checkedAt: performance.now() };
          }
        }
      }
      if (this.assignment.pageEpoch !== checkedPageEpoch || this.selected.url() !== checkedUrl) {
        status = 'UNKNOWN';
        verification = 'UNKNOWN';
        this.safePrivateExit = undefined;
      }
      return { browserSessionId: message.browserSessionId, status, verification,
        allocationEpoch: this.assignment.allocationEpoch, controlEpoch: this.assignment.controlEpoch, pageEpoch: this.assignment.pageEpoch,
        privacyEpoch: this.assignment.privacyEpoch, policyVersion: this.assignment.policyVersion };
    });
  }

  transferProfile(message: ProfileTransferMessage): Promise<Record<string, unknown>> {
    return this.mailbox.run(async () => {
      this.assertPhysicalRuntime();
      if (message.type === 'profileSave' && !message.reuseOnly) {
        const completed = this.profileSaves.completed(message);
        if (completed) return { ...completed };
      }
      if (Date.parse(this.assignment.deadline) <= Date.now()
          && (message.type !== 'profileSave' || this.mode !== 'QUIESCED'
            || this.cleanupDeadline === undefined || this.cleanupDeadline <= Date.now())) throw new WorkerError('BROWSER_DEADLINE');
      if (message.browserSessionId !== this.assignment.browserSessionId || message.allocationEpoch !== this.assignment.allocationEpoch
          || message.privacyEpoch !== this.assignment.privacyEpoch || message.binding.userId !== this.assignment.userId
          || message.binding.connectionId !== this.assignment.connectionId || message.binding.scopeVersion !== this.assignment.scopeVersion
          || message.controlEpoch !== this.assignment.controlEpoch || message.policyVersion !== this.assignment.policyVersion
          || Date.parse(message.expiresAt) <= Date.now()) throw new WorkerError('PROFILE_BINDING_FENCED');
      if (message.type === 'profileSave') {
        if (this.mode !== 'QUIESCED') throw new WorkerError('PROFILE_SAVE_NOT_QUIESCED');
        const completed = this.profileSaves.completed(message);
        if (completed) return { ...completed };
      }
      const controller = new AbortController();
      this.profileTransfer = controller;
      const allowedDeadline = message.type === 'profileSave' && this.cleanupDeadline !== undefined
        ? this.cleanupDeadline : Date.parse(this.assignment.deadline);
      const timeout = setTimeout(() => controller.abort(), Math.max(0, Math.min(allowedDeadline, Date.parse(message.expiresAt)) - Date.now()));
      const key = Buffer.from(message.dek, 'base64');
      try {
        if (message.type === 'profileSave') {
          const saved = await this.profileSaves.save(message, async () => {
            controller.signal.throwIfAborted();
            return saveProfile(this.context, key, message.binding);
          }, blob => transferProfile(message.transferId, message.transferToken, controller.signal, blob));
          return { ...saved };
        }
        if (this.selected.url() !== 'about:blank' || this.context.pages().length !== 1 || this.receipts.size !== 0) throw new WorkerError('PROFILE_LOAD_NOT_EMPTY');
        const blob = await transferProfile(message.transferId, message.transferToken, controller.signal);
        controller.signal.throwIfAborted();
        await loadProfile(this.context, blob, key, message.binding);
        controller.signal.throwIfAborted();
        return { transferId: message.transferId, byteLength: blob.length, sha256: createHash('sha256').update(blob).digest('hex') };
      } finally {
        key.fill(0);
        clearTimeout(timeout);
        this.profileTransfer = undefined;
      }
    });
  }

  acknowledgeProfile(message: ProfileTransferAck): Promise<void> {
    return this.mailbox.run(async () => {
      this.assertPhysicalRuntime();
      if (message.browserSessionId !== this.assignment.browserSessionId || message.allocationEpoch !== this.assignment.allocationEpoch) throw new WorkerError('PROFILE_ACK_FENCED');
      this.profileSaves.acknowledge(message.transferId, message.sha256);
    });
  }

  captureBinding(message: Pick<ViewOpen, 'browserSessionId' | 'allocationEpoch' | 'controlEpoch' | 'pageEpoch' | 'privacyEpoch' | 'surface' | 'controllerInstance'>): Promise<{ pid: number; width: number; height: number }> {
    return this.mailbox.run(async () => {
      this.assertLive();
      for (const field of ['browserSessionId', 'allocationEpoch', 'controlEpoch', 'pageEpoch', 'privacyEpoch'] as const) {
        if (message[field] !== this.assignment[field]) throw new WorkerError('VIEW_BINDING_FENCED');
      }
      if (this.privateBarrier && (message.surface !== 'WEB' || message.controllerInstance !== this.controllerInstance || this.leaseExpiresAt <= Date.now())) throw new WorkerError('PRIVATE_VIEW_FORBIDDEN');
      if (this.mode === 'QUIESCED') throw new WorkerError('VIEW_QUIESCED');
      await this.selected.bringToFront();
      const browserSession = await this.browser.newBrowserCDPSession();
      const pageSession = await this.context.newCDPSession(this.selected);
      try {
        const processes = z.object({ processInfo: z.array(z.object({ type: z.string(), id: z.number().int().positive() })) }).parse(await browserSession.send('SystemInfo.getProcessInfo'));
        const browserProcess = processes.processInfo.filter((process) => process.type === 'browser');
        if (browserProcess.length !== 1 || !browserProcess[0]) throw new WorkerError('SURFACE_PROCESS_AMBIGUOUS');
        const window = z.object({ bounds: z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number(), windowState: z.string() }) }).parse(await pageSession.send('Browser.getWindowForTarget'));
        const { width, height } = this.assignment.viewport;
        if (window.bounds.windowState !== 'fullscreen' || window.bounds.left !== 0 || window.bounds.top !== 0 || window.bounds.width !== width || window.bounds.height !== height) throw new WorkerError('SURFACE_GEOMETRY_MISMATCH');
        return { pid: browserProcess[0].id, width, height };
      } finally { await pageSession.detach(); await browserSession.detach(); }
    });
  }

  input(message: InputMessage): Promise<Record<string, unknown>> {
    return this.mailbox.run(async () => {
      this.assertLive();
      if ((this.mode !== 'HUMAN' && this.mode !== 'HUMAN_PRIVATE') || this.leaseExpiresAt <= Date.now()
          || message.controllerInstance !== this.controllerInstance || message.controlEpoch !== this.assignment.controlEpoch
          || message.pageEpoch !== this.assignment.pageEpoch || this.mutationUnknown) throw new WorkerError('INPUT_FENCED');
      if (message.inputSequence <= this.inputSequence) throw new WorkerError('INPUT_REPLAY');
      this.inputSequence = message.inputSequence;
      const action = message.action;
      if ('x' in action && (action.x > this.assignment.viewport.width || action.y > this.assignment.viewport.height)) throw new WorkerError('INPUT_OUTSIDE_VIEWPORT');
      try {
        switch (action.type) {
          case 'pointerMove': await this.selected.mouse.move(action.x, action.y); break;
          case 'pointerDown': {
            const button = this.button(action.button); this.heldButtons.add(button);
            await this.selected.mouse.move(action.x, action.y); await this.selected.mouse.down({ button }); break;
          }
          case 'pointerUp': {
            const button = this.button(action.button);
            await this.selected.mouse.move(action.x, action.y); await this.selected.mouse.up({ button }); this.heldButtons.delete(button); break;
          }
          case 'wheel': await this.selected.mouse.wheel(action.deltaX, action.deltaY); break;
          case 'keyDown': this.heldKeys.add(action.key); await this.selected.keyboard.down(action.key); break;
          case 'keyUp': await this.selected.keyboard.up(action.key); this.heldKeys.delete(action.key); break;
          case 'committedText': await this.selected.keyboard.insertText(action.text); break;
          case 'heartbeat': break;
        }
        this.appliedInputSequence = message.inputSequence;
      } catch (error) { this.mutationUnknown = true; throw error; }
      return { inputSequence: this.appliedInputSequence, activity: action.type !== 'heartbeat', inputPageEpoch: message.pageEpoch, allocationEpoch: this.assignment.allocationEpoch,
        controlEpoch: this.assignment.controlEpoch, pageEpoch: this.assignment.pageEpoch, privacyEpoch: this.assignment.privacyEpoch };
    });
  }

  async fenceDisconnected(): Promise<void> {
    this.controlReceipt = undefined;
    clearTimeout(this.leaseTimer);
    this.mediaCapture.cancel();
    this.browserSnapshot.cancel();
    this.profileTransfer?.abort();
    this.leaseExpiresAt = 0;
    this.observations.invalidate();
    await this.options.mediaBarrier();
    await this.mailbox.run(async () => { this.accountUsage(performance.now()); this.mode = 'QUIESCED'; await this.releaseInput(); });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    clearTimeout(this.leaseTimer);
    clearTimeout(this.budgetTimer);
    clearTimeout(this.hardDeadlineTimer);
    this.mediaCapture.cancel();
    this.browserSnapshot.cancel();
    this.profileTransfer?.abort();
    this.closed = true;
    await this.options.mediaBarrier();
    await this.mailbox.close();
    try { await this.adapter?.close(); }
    finally {
      this.profileSaves.close();
      await this.browser.close(); await this.clearOutput(); this.closedAt = performance.now(); this.accountUsage(this.closedAt);
    }
  }

  private async observe(depth?: number): Promise<BrowserObservation> {
    const raw = await this.requireAdapter().snapshot(depth);
    this.assertLive();
    const pageId = this.pageIds.get(this.selected);
    if (!pageId) throw new WorkerError('PAGE_BINDING_LOST');
    const observation = this.observations.issue(this.assignment, pageId, this.runtimeGeneration, ++this.observationSequence,
      raw, this.selected.url(), await this.selected.title(), this.selected.frames().length);
    observation.media = await this.mediaCapture.inspect(this.selected, observation.observationId, this.assignment);
    return observation;
  }
  private assertExecutionOwner(command: Command, readOnly: boolean): void {
    this.assertLive();
    if (command.browserSessionId !== this.assignment.browserSessionId || command.taskId !== this.assignment.taskId) throw new WorkerError('ASSIGNMENT_MISMATCH');
    if (command.instructionRevision < this.assignment.instructionRevision) throw new WorkerError('INSTRUCTION_SUPERSEDED');
    if (command.executionMode !== undefined) {
      if (command.executionMode !== this.mode || command.controllerInstance !== this.controllerInstance
          || this.leaseExpiresAt <= Date.now() || this.leaseDeadline <= performance.now()) throw new WorkerError('CONTROL_FENCED');
      if (command.action.type === 'SNAPSHOT') {
        if (command.executionMode !== 'HUMAN' || this.privateBarrier) throw new WorkerError('SCREENSHOT_PRIVATE');
      } else if (!['NAVIGATE', 'BACK', 'FORWARD', 'RELOAD'].includes(command.action.type)) throw new WorkerError('HUMAN_COMMAND_FORBIDDEN');
      if (this.mutationUnknown) throw new WorkerError('UNKNOWN_EFFECT_BARRIER');
      return;
    }
    if (command.controllerInstance !== undefined) throw new WorkerError('CONTROL_FENCED');
    if (command.action.type === 'SNAPSHOT') throw new WorkerError('HUMAN_COMMAND_REQUIRED');
    if (this.assignment.purpose !== 'TASK') {
      if (this.assignment.taskId !== null || command.action.type !== 'NAVIGATE' || this.mode !== 'QUIESCED'
          || this.receipts.size > 0 || !this.privateBarrier) throw new WorkerError('STANDALONE_COMMAND_FORBIDDEN');
      return;
    }
    if (this.assignment.taskId === null) throw new WorkerError('STANDALONE_COMMAND_FORBIDDEN');
    if (this.mode !== 'AGENT') throw new WorkerError('CONTROL_FENCED');
    if (this.mutationUnknown && !readOnly) throw new WorkerError('UNKNOWN_EFFECT_BARRIER');
  }
  private assertPermit(command: Command, permit: ExecutionPermit): void {
    this.assertExecutionOwner(command, command.action.type === 'OBSERVE' || command.action.type === 'WAIT_FOR' || command.action.type === 'READ_MEDIA');
    for (const field of ['taskId', 'userId', 'browserSessionId', 'workerBootId', 'allocationEpoch', 'controlEpoch', 'pageEpoch', 'privacyEpoch', 'policyVersion', 'connectionId', 'scopeVersion', 'continuationClaimId'] as const) {
      if (permit[field] !== this.assignment[field]) throw new WorkerError('PERMIT_FENCED');
    }
    if (permit.instructionRevision !== command.instructionRevision) throw new WorkerError('PERMIT_FENCED');
    if (permit.commandId !== command.commandId || permit.attemptId !== command.attemptId || permit.actionDigest !== digest(command.action)
        || permit.executionMode !== command.executionMode || permit.controllerInstance !== command.controllerInstance
        || (command.executionMode !== undefined && Date.parse(permit.deadline) > this.leaseExpiresAt)
        || Date.parse(permit.deadline) <= Date.now() || this.usedPermits.has(permit.permitId)) throw new WorkerError('PERMIT_INVALID');
  }
  private async navigate(action: Command['action'], timeout: number): Promise<void> {
    const options = { timeout, waitUntil: 'domcontentloaded' as const };
    switch (action.type) {
      case 'NAVIGATE': await this.selected.goto(action.url, options); return;
      case 'BACK': await this.selected.goBack(options); return;
      case 'FORWARD': await this.selected.goForward(options); return;
      case 'RELOAD': await this.selected.reload(options); return;
      default: throw new WorkerError('HUMAN_COMMAND_FORBIDDEN');
    }
  }
  private assertLive(): void {
    this.assertPhysicalRuntime();
    if (Date.parse(this.assignment.deadline) <= Date.now()) throw new WorkerError('BROWSER_DEADLINE');
  }
  private assertPhysicalRuntime(): void {
    if (this.closed || this.crashed || !this.browser.isConnected() || this.selected.isClosed()) throw new WorkerError('SESSION_LOST');
  }
  private assertAllowedUrl(raw: string): void {
    const url = new URL(raw);
    if (!this.originPolicy.permits(url)) throw new WorkerError('ORIGIN_FORBIDDEN');
  }
  private trackPage(page: Page): void {
    this.pageIds.set(page, randomUUID());
    page.on('crash', () => { if (this.selected === page) this.crashed = true; });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && page === this.selected) {
        this.assignment.pageEpoch++; this.observations.invalidate();
        this.mediaCapture.cancel();
        this.browserSnapshot.cancel();
        void this.options.mediaBarrier().catch(() => { this.crashed = true; });
      }
    });
  }
  private async synchronizePage(): Promise<void> {
    if (this.pendingPage) {
      const page = this.pendingPage;
      if (page.isClosed()) throw new WorkerError('PAGE_LOST');
      if (page.url() !== 'about:blank') this.assertAllowedUrl(page.url());
      await this.options.mediaBarrier();
      await page.bringToFront();
      await this.configureSurface(page);
      await this.adapter?.selectPage(this.context, page);
      this.selected = page;
      this.pendingPage = undefined;
      this.assignment.pageEpoch++;
      this.observations.invalidate();
    }
    this.assertLive();
  }
  private requireAdapter(): PlaywrightMcpAdapter {
    if (!this.adapter) throw new WorkerError('PRIVATE_MODE');
    return this.adapter;
  }
  private async configureSurface(page: Page): Promise<void> {
    if (this.options.headless) return;
    const cdp = await this.context.newCDPSession(page);
    try {
      const window = z.object({ windowId: z.number().int() }).parse(await cdp.send('Browser.getWindowForTarget'));
      await cdp.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { left: 0, top: 0, ...this.assignment.viewport } });
      await cdp.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'fullscreen' } });
    } finally { await cdp.detach(); }
  }
  private resultIdentity(command: Command): Pick<AttemptResult, 'schemaVersion' | 'commandId' | 'attemptId' | 'taskId' | 'browserSessionId' | 'allocationEpoch' | 'controlEpoch' | 'pageEpoch' | 'privacyEpoch'> {
    return { schemaVersion: 1, commandId: command.commandId, attemptId: command.attemptId, taskId: command.taskId, browserSessionId: command.browserSessionId,
      allocationEpoch: this.assignment.allocationEpoch, controlEpoch: this.assignment.controlEpoch,
      pageEpoch: this.assignment.pageEpoch, privacyEpoch: this.assignment.privacyEpoch };
  }
  private async releaseInput(): Promise<void> {
    for (const key of this.heldKeys) await this.selected.keyboard.up(key);
    for (const button of this.heldButtons) await this.selected.mouse.up({ button });
    this.heldKeys.clear(); this.heldButtons.clear();
  }
  private scheduleLeaseExpiry(): void {
    clearTimeout(this.leaseTimer);
    if (this.mode !== 'HUMAN' && this.mode !== 'HUMAN_PRIVATE') return;
    const epoch = this.assignment.controlEpoch;
    const deadline = this.leaseDeadline;
    this.leaseTimer = setTimeout(() => {
      this.browserSnapshot.cancel();
      void this.mailbox.run(async () => {
        if (this.closed || this.assignment.controlEpoch !== epoch || this.leaseDeadline !== deadline) return;
        this.accountUsage(performance.now());
        this.mode = 'QUIESCED';
        this.controlReceipt = undefined;
        await this.options.mediaBarrier();
        await this.releaseInput();
      }).catch(() => { this.crashed = true; this.mutationUnknown = true; });
    }, Math.max(0, deadline - performance.now()));
    this.leaseTimer.unref();
  }
  private button(button: 'LEFT' | 'MIDDLE' | 'RIGHT'): 'left' | 'middle' | 'right' {
    return button === 'LEFT' ? 'left' : button === 'MIDDLE' ? 'middle' : 'right';
  }
  private async clearOutput(): Promise<void> {
    const root = resolve(this.outputDirectory);
    const staging = resolve(this.options.stagingDirectory);
    if (!root.startsWith(`${staging}${process.platform === 'win32' ? '\\' : '/'}`)) throw new WorkerError('INVALID_STAGING_PATH');
    for (const entry of await readdir(root)) await rm(join(root, entry), { recursive: true, force: true });
  }

  private accountUsage(now: number): void {
    if (this.readyAt === undefined) { this.usageUpdatedAt = now; return; }
    const elapsed = Math.max(0, Math.min(now, this.leaseDeadline) - this.usageUpdatedAt);
    if (this.mode === 'HUMAN') this.humanMs += elapsed;
    if (this.mode === 'HUMAN_PRIVATE') this.loginMs += elapsed;
    this.usageUpdatedAt = now;
  }

  private scheduleBudgetExpiry(): void {
    const deadline = Date.parse(this.assignment.deadline);
    this.scheduleHardDeadline(deadline + 120_000);
    this.budgetTimer = setTimeout(() => {
      this.mediaCapture.cancel();
      this.browserSnapshot.cancel();
      this.observations.invalidate();
      void this.options.mediaBarrier().catch(() => { this.crashed = true; });
      void this.mailbox.run(async () => {
        if (this.closed) return;
        this.accountUsage(performance.now());
        this.mode = 'QUIESCED';
        this.controlReceipt = undefined;
        clearTimeout(this.leaseTimer);
        await this.releaseInput();
      }).catch(() => { this.crashed = true; this.mutationUnknown = true; });
    }, Math.max(0, deadline - Date.now()));
    this.budgetTimer.unref();
  }

  private scheduleHardDeadline(deadline: number): void {
    clearTimeout(this.hardDeadlineTimer);
    this.hardDeadlineTimer = setTimeout(() => {
      this.mediaCapture.cancel();
      this.browserSnapshot.cancel();
      this.profileTransfer?.abort();
      this.options.onHardDeadline?.();
    }, Math.max(0, deadline - Date.now()));
    this.hardDeadlineTimer.unref();
  }
}
