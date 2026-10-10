import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";
import { inspectPrivateInput, snapshotUrl } from "./browser-privacy.js";

export class BrowserRejection extends Error {
  constructor(message: string,
    readonly code?: "OBSERVATION_LIMIT_EXCEEDED" | "OBSERVATION_REFERENCE_NOT_ISSUED"
      | "OBSERVATION_EXPIRED" | "OBSERVATION_CURSOR_EXPIRED") {
    super(message);
  }
}
export class McpExecutionUnconfirmed extends Error {
  constructor() { super("Browser execution must be stopped before releasing control"); }
}
const outputDirectory = "/tmp/helm-mcp";
const refSchema = z.string().regex(/^(f\d+)?e\d+$/).max(40);
const targetSchema = z.object({ observationId: z.uuid(), ref: refSchema });
const pointSchema = z.object({ screenshotId: z.uuid(), x: z.number().int().nonnegative().max(10_000),
  y: z.number().int().nonnegative().max(10_000) }).strict();
const fields = targetSchema.shape;
const schemas: Record<string, z.ZodType> = {
  click: z.union([z.object(fields).strict(), pointSchema]),
  fill: z.object({ ...fields, text: z.string().max(50_000) }).strict(),
  press: z.object({ key: z.string().min(1).max(100) }).strict(),
  selectOption: z.object({ ...fields, values: z.array(z.string().max(1000)).min(1).max(100) }).strict(),
  check: z.object({ ...fields, checked: z.boolean() }).strict(),
  waitFor: z.object({ text: z.string().min(1).max(1000).optional(),
    textGone: z.string().min(1).max(1000).optional(), time: z.number().positive().max(30).optional()
  }).strict().refine(value => value.text !== undefined || value.textGone !== undefined || value.time !== undefined),
  navigate: z.object({ url: z.string().max(8192) }).strict(),
  newTab: z.object({ url: z.string().max(8192).optional() }).strict(),
  selectTab: z.object({ index: z.number().int().nonnegative().max(19) }).strict(),
  closeTab: z.object({}).strict(), goBack: z.object({}).strict(),
  scroll: z.object({ x: z.number().min(-10_000).max(10_000).optional(), y: z.number().min(-10_000).max(10_000) }).strict()
};

const nodeFields = {
  role: z.string().max(100), name: z.string().optional(), text: z.string().optional(),
  ref: refSchema.optional(), url: z.string().optional(), placeholder: z.string().optional(),
  checked: z.union([z.boolean(), z.literal("mixed")]).optional(), disabled: z.boolean().optional(),
  expanded: z.boolean().optional(), active: z.boolean().optional(),
  invalid: z.union([z.boolean(), z.enum(["grammar", "spelling"])]).optional(),
  level: z.number().optional(), pressed: z.union([z.boolean(), z.literal("mixed")]).optional(),
  selected: z.boolean().optional(), cursor: z.literal("pointer").optional(), ariaHidden: z.boolean().optional()
};
type NativeNode = z.infer<z.ZodObject<typeof nodeFields>> & { children?: (NativeNode | string)[] };
const nativeNode: z.ZodType<NativeNode> = z.lazy(() => z.object({
  ...nodeFields, children: z.array(z.union([z.string(), nativeNode])).optional()
}).strict());
const snapshotResult = z.object({ snapshot: z.array(nativeNode) }).strict();
type Entry = { path: number[]; node: Omit<NativeNode, "children"> | string };
type Scope = { type: "page" } | { type: "region"; observationId: string; ref: string };
type Observation = {
  id: string; time: string; page: Page; epoch: number; generation: number;
  entries: Entry[]; issued: Map<string, NativeNode>; cursor?: string; offset: number; scope: Scope;
};
type ObservationContext = Pick<Observation, "time" | "page" | "epoch" | "generation">;
type ScreenshotTarget = ObservationContext & { id: string; width: number; height: number };
export type Sequence = { operationIds: string[] };
const observeSchema = z.union([z.object({}).strict(), targetSchema.strict(),
  z.object({ cursor: z.string().min(1).max(100) }).strict()]);

/** A session-local MCP connection. Chromium, tabs and access policy belong to server.ts. */
export class BrowserMcp {
  private readonly runtimeId = randomUUID();
  private client?: Client;
  private connection?: Awaited<ReturnType<typeof createConnection>>;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private generation = 0;
  private selected?: Page;
  private observation?: Observation;
  private screenshotTarget?: ScreenshotTarget;
  private sequence?: { operationIds: string[]; next: number; observation: Observation };
  private pending?: ReturnType<Client["callTool"]>;
  private unconfirmed = false;
  private readonly listeners = new Map<Page, { changed: () => void; closed: () => void; dialog: () => void }>();
  private readonly pageAdded: (page: Page) => void;
  private captures = 0;
  private readonly metrics = { fullSnapshots: 0, targetSnapshots: 0, snapshotMillis: 0,
    fullSnapshotMillis: 0, targetSnapshotMillis: 0,
    preflights: 0, preflightMillis: 0, actions: 0, actionMillis: 0, waits: 0, waitMillis: 0 };

  get isClosing(): boolean { return this.closing !== undefined; }
  get requiresStop(): boolean { return this.unconfirmed; }

  constructor(private readonly context: BrowserContext, private readonly currentPage: () => Page,
    private readonly controlEpoch: () => number, private readonly assertAllowed: () => void) {
    this.pageAdded = page => {
      const changed = () => this.invalidate();
      const dialog = () => { if (this.pending) this.unconfirmed = true; };
      const closed = () => {
        changed();
        page.off("framenavigated", changed); page.off("close", closed); page.off("crash", changed); page.off("dialog", dialog);
        this.listeners.delete(page);
      };
      this.listeners.set(page, { changed, closed, dialog });
      page.on("framenavigated", changed);
      page.on("close", closed);
      page.on("crash", changed);
      page.on("dialog", dialog);
      this.invalidate();
    };
    for (const page of context.pages()) this.pageAdded(page);
    context.on("page", this.pageAdded);
  }

  private invalidate(): void {
    this.generation++;
    this.observation = undefined;
    this.screenshotTarget = undefined;
    this.sequence = undefined;
  }

  private async open(): Promise<void> {
    if (this.closing) throw new BrowserRejection("Browser observation is closing");
    this.opening ??= (async () => {
      this.connection = await createConnection({
        snapshot: { mode: "none" }, webmcp: false, codegen: "none", imageResponses: "omit",
        saveSession: false, timeouts: { action: 20_000, navigation: 40_000 },
        capabilities: ["vision"], outputDir: outputDirectory, sharedBrowserContext: true
      }, async () => this.context);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      this.client = new Client({ name: "Helm Glass", version: "1.0.0" });
      await this.connection.connect(serverTransport);
      await this.client.connect(clientTransport);
    })();
    await this.opening;
  }

  private async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.open();
    this.assertAllowed();
    signal?.throwIfAborted();
    if (this.unconfirmed) throw new McpExecutionUnconfirmed();
    let result;
    // SDK cancellation and transport disposal do not acknowledge handler completion.
    // Let the native RPC settle; the session's deadline watchdog bounds a stalled handler.
    this.pending = this.client!.callTool({ name, arguments: { ...args, _meta: { json: true } } },
      undefined, { timeout: 90_000 });
    try {
      result = await this.pending;
    } catch {
      this.unconfirmed = true;
      throw new McpExecutionUnconfirmed();
    } finally { this.pending = undefined; }
    if (this.unconfirmed) throw new McpExecutionUnconfirmed();
    signal?.throwIfAborted();
    if (result.isError) {
      // Upstream error text is neither a public contract nor safe site data.
      throw new Error("Browser tool failed");
    }
    const content = z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).length(1).safeParse(result.content);
    if (!content.success) throw new Error("Invalid browser response");
    if (Buffer.byteLength(content.data[0]!.text) > 2_097_152) {
      if (name === "browser_snapshot")
        throw new BrowserRejection("Browser response exceeds limit", "OBSERVATION_LIMIT_EXCEEDED");
      throw new Error("Browser response exceeds limit");
    }
    return JSON.parse(content.data[0]!.text) as unknown;
  }

  private async synchronize(signal?: AbortSignal): Promise<Page> {
    this.assertAllowed();
    const page = this.currentPage();
    const pages = this.context.pages();
    if (page.isClosed() || pages.length > 20 || !pages.includes(page))
      throw new BrowserRejection("Selected page is unavailable");
    if (this.selected !== page) {
      this.invalidate();
      if (this.selected === undefined) await this.call("browser_tabs", { action: "list" }, signal);
      await this.call("browser_tabs", { action: "select", index: pages.indexOf(page) }, signal);
      if (this.currentPage() !== page || this.context.pages()[pages.indexOf(page)] !== page)
        throw new BrowserRejection("Selected page changed");
      this.selected = page;
    }
    return page;
  }

  private async capture(signal?: AbortSignal, ref?: string): Promise<NativeNode[]> {
    this.captures++;
    if (ref) this.metrics.targetSnapshots++; else this.metrics.fullSnapshots++;
    const started = performance.now();
    try {
      const snapshot = snapshotResult.parse(await this.call("browser_snapshot", ref ? { target: ref } : {}, signal)).snapshot;
      await this.filterObservation(snapshot, signal);
      return snapshot;
    }
    finally {
      const elapsed = performance.now() - started;
      this.metrics.snapshotMillis += elapsed;
      if (ref) this.metrics.targetSnapshotMillis += elapsed; else this.metrics.fullSnapshotMillis += elapsed;
    }
  }

  private async filterObservation(snapshot: NativeNode[], signal?: AbortSignal): Promise<void> {
    const pending: NativeNode[] = [];
    const visit = (nodes: (NativeNode | string)[]) => {
      for (const node of nodes) {
        if (typeof node === "string") continue;
        if (node.url !== undefined) node.url = snapshotUrl(node.url);
        if (node.ref) pending.push(node);
        if (node.children) visit(node.children);
      }
    };
    visit(snapshot);
    const page = this.currentPage();
    for (let offset = 0; offset < pending.length; offset += 16) {
      signal?.throwIfAborted();
      await Promise.all(pending.slice(offset, offset + 16).map(async node => {
        const inspected = await page.locator(`aria-ref=${node.ref}`).evaluate(inspectPrivateInput, node.name ?? "")
          .catch(() => ({ protectedInput: true, hiddenName: true }));
        if (inspected.hiddenName) delete node.name;
        if (inspected.protectedInput) {
          delete node.text; delete node.placeholder; delete node.children;
        }
      }));
    }
  }

  private checkObservation(value: ObservationContext): void {
    this.assertAllowed();
    if (value.page !== this.currentPage() || value.generation !== this.generation
      || value.epoch !== this.controlEpoch() || Date.now() - Date.parse(value.time) > 60_000)
      throw new BrowserRejection("Observation expired or page changed; observe again", "OBSERVATION_EXPIRED");
  }

  async observe(args: Record<string, unknown> = {}, signal?: AbortSignal,
    operationId?: string, sequence?: Sequence): Promise<object> {
    const input = observeSchema.parse(args);
    const page = await this.synchronize(signal);
    if ("cursor" in input) {
      if (!this.observation || input.cursor !== this.observation.cursor)
        throw new BrowserRejection("Observation cursor expired", "OBSERVATION_CURSOR_EXPIRED");
      this.checkObservation(this.observation);
    } else {
      let issued: NativeNode | undefined;
      const scope: Scope = "ref" in input ? { type: "region", ...targetSchema.parse(input) } : { type: "page" };
      if ("ref" in input) {
        if (sequence && sequence.operationIds.at(-1) !== operationId)
          throw new BrowserRejection("Region observation must be the last sequence command");
        issued = this.issuedTarget(input, operationId, sequence).issued;
      }
      this.observation = undefined;
      this.sequence = undefined;
      const generation = this.generation, epoch = this.controlEpoch(), time = new Date().toISOString();
      const snapshot = await this.capture(signal, "ref" in input ? input.ref : undefined);
      if (issued && "ref" in input) this.checkNativeTarget(snapshot, input.ref, issued);
      this.publish(snapshot, { page, generation, epoch, time, scope });
    }
    return this.observationPage();
  }

  private publish(snapshot: NativeNode[], context: Pick<Observation, "page" | "generation" | "epoch" | "time" | "scope">): void {
    const entries: Entry[] = [];
    const visit = (nodes: (NativeNode | string)[], parent: number[]) => {
      for (const [index, node] of nodes.entries()) {
        const path = [...parent, index];
        if (typeof node === "string") entries.push({ path, node });
        else {
          const { children, ...data } = node;
          entries.push({ path, node: data });
          if (children) visit(children, path);
        }
      }
    };
    visit(snapshot, []);
    const observation: Observation = { ...context, id: randomUUID(), entries, issued: new Map(), offset: 0 };
    this.checkObservation(observation);
    this.observation = observation;
    this.sequence = undefined;
  }

  private observationPage(): object {
    const observation = this.observation!;
    const entries: Entry[] = [];
    let bytes = 0;
    while (observation.offset < observation.entries.length && entries.length < 200) {
      const entry = observation.entries[observation.offset]!;
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > 26_000) break;
      entries.push(entry); bytes += size; observation.offset++;
      if (typeof entry.node !== "string" && entry.node.ref) observation.issued.set(entry.node.ref, entry.node);
    }
    const complete = observation.offset === observation.entries.length;
    // A single over-limit native node is not silently shortened into a new name/ref.
    if (!entries.length && !complete)
      throw new BrowserRejection("Snapshot node exceeds response limit", "OBSERVATION_LIMIT_EXCEEDED");
    observation.cursor = complete ? undefined : randomUUID();
    return { observationId: observation.id, runtimeId: this.runtimeId, pageGeneration: observation.generation,
      controlEpoch: observation.epoch, privacyGeneration: this.runtimeId,
      observedAt: observation.time, expiresAt: new Date(Date.parse(observation.time) + 60_000).toISOString(),
      format: "playwright-aria-json-paths-v1", scope: observation.scope, snapshot: entries, complete, limited: !complete,
      cursor: observation.cursor, metrics: { snapshots: this.captures, snapshotBytes: bytes, ...this.metrics } };
  }

  private issuedTarget(args: Record<string, unknown>, operationId?: string, sequence?: Sequence):
    { observation: Observation; issued: NativeNode; ref: string } {
    const input = targetSchema.parse(args);
    const position = sequence?.operationIds.indexOf(operationId ?? "");
    if (sequence && (position === -1 || sequence.operationIds.length > 8
      || new Set(sequence.operationIds).size !== sequence.operationIds.length))
      throw new BrowserRejection("Invalid operation sequence");
    if (this.sequence && (!sequence || JSON.stringify(sequence.operationIds) !== JSON.stringify(this.sequence.operationIds)))
      this.sequence = undefined;
    const reserved = this.sequence;
    const observation = reserved && position !== undefined && position >= reserved.next
      ? reserved.observation : this.observation;
    if (!observation || observation.id !== input.observationId)
      throw new BrowserRejection("Observation was replaced; observe again", "OBSERVATION_EXPIRED");
    if (!observation.issued.has(input.ref))
      throw new BrowserRejection("Reference was not issued; continue the current observation with its cursor",
        "OBSERVATION_REFERENCE_NOT_ISSUED");
    this.checkObservation(observation);
    if (sequence && !reserved) this.sequence = { operationIds: sequence.operationIds, next: position!, observation };
    return { observation, issued: observation.issued.get(input.ref)!, ref: input.ref };
  }

  private checkNativeTarget(snapshot: (NativeNode | string)[], ref: string, issued: NativeNode): void {
    const contains = (nodes: (NativeNode | string)[]): boolean => nodes.some(node => typeof node !== "string"
      && (node.ref === ref && node.role === issued.role && node.name === issued.name
        || node.children !== undefined && contains(node.children)));
    if (!contains(snapshot)) throw new BrowserRejection("Reference is stale; observe again");
  }

  private async checkPrivateInput(page: Page, ref: string, name: string, signal: AbortSignal): Promise<void> {
    const inspected = await page.locator(`aria-ref=${ref}`).evaluate(inspectPrivateInput, name, { signal })
      .catch(() => { throw new BrowserRejection("Reference is unavailable"); });
    if (inspected.protectedInput) throw new BrowserRejection("Private input requires the user");
  }

  private async checkFocus(page: Page, signal: AbortSignal): Promise<void> {
    for (const frame of page.frames()) {
      signal.throwIfAborted();
      if (frame.isDetached()) continue;
      const focus = frame.locator(":focus");
      try {
        if (await focus.count() === 0) continue;
        const inspected = await focus.evaluate(inspectPrivateInput, "", { signal });
        if (inspected.protectedInput) throw new BrowserRejection("Private input requires the user");
      } catch (error) {
        if (error instanceof BrowserRejection) throw error;
        throw new BrowserRejection("Keyboard focus could not be verified");
      }
    }
  }

  private async checkPoint(page: Page, args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const point = pointSchema.parse(args);
    const screenshot = this.screenshotTarget;
    if (!screenshot || screenshot.id !== point.screenshotId)
      throw new BrowserRejection("Screenshot was not issued or was revoked; take another screenshot");
    this.checkObservation(screenshot);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (viewport.width !== screenshot.width || viewport.height !== screenshot.height
      || point.x >= screenshot.width || point.y >= screenshot.height)
      throw new BrowserRejection("Screenshot viewport changed or point is outside it");
    let frame = page.mainFrame();
    let position = { x: point.x, y: point.y };
    for (let depth = 0; depth < 16; depth++) {
      signal.throwIfAborted();
      const handle = await frame.evaluateHandle(({ x, y }) => {
        let element = document.elementFromPoint(x, y);
        for (let depth = 0; element?.shadowRoot && depth < 16; depth++) {
          const inner = element.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === element) break;
          element = inner;
        }
        const label = element?.closest("label");
        if (label instanceof HTMLLabelElement && label.control) return label.control;
        return element?.closest('input, textarea, select, [contenteditable], [role="textbox"]') ?? element;
      }, position);
      try {
        const element = handle.asElement();
        if (!element) throw new BrowserRejection("Screenshot point has no target");
        const inspected = await element.evaluate(inspectPrivateInput, "");
        signal.throwIfAborted();
        if (inspected.protectedInput) throw new BrowserRejection("Private input requires the user");
        const child = await element.contentFrame();
        if (!child) {
          this.checkObservation(screenshot);
          return;
        }
        const geometry = await element.evaluate(element => {
          if (!(element instanceof HTMLIFrameElement)) return null;
          let inspected = 0;
          for (let parent: Element | null = element; parent;) {
            if (++inspected > 128) return null;
            const style = getComputedStyle(parent);
            if (style.transform !== "none" || style.rotate !== "none" || style.scale !== "none"
              || style.perspective !== "none" || !["1", "normal"].includes(style.zoom)) return null;
            const root = parent.getRootNode();
            parent = parent.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
          }
          const rect = element.getBoundingClientRect();
          return { x: rect.x + element.clientLeft, y: rect.y + element.clientTop };
        });
        if (!geometry) throw new BrowserRejection("Frame point could not be verified");
        position = { x: position.x - geometry.x, y: position.y - geometry.y };
        frame = child;
      } finally { await handle.dispose(); }
    }
    throw new BrowserRejection("Screenshot target exceeds frame limit");
  }

  async act(type: string, args: Record<string, unknown>, operationId: string, sequence: Sequence | undefined,
    signal: AbortSignal): Promise<void> {
    let dispatched = false;
    try {
      if (!schemas[type]) throw new BrowserRejection("Unsupported browser action");
      schemas[type]!.parse(args);
      const page = await this.synchronize(signal);
      const position = sequence?.operationIds.indexOf(operationId);
      if (sequence && (position === -1 || new Set(sequence.operationIds).size !== sequence.operationIds.length))
        throw new BrowserRejection("Invalid operation sequence");
      if (this.sequence && (!sequence
        || JSON.stringify(sequence.operationIds) !== JSON.stringify(this.sequence.operationIds))) this.sequence = undefined;
      const coordinateClick = type === "click" && "screenshotId" in args;
      const targeted = !coordinateClick && ["click", "fill", "selectOption", "check"].includes(type);
      let ref: string | undefined;
      let target: ReturnType<BrowserMcp["issuedTarget"]> | undefined;
      if (targeted || coordinateClick) {
        const preflightStarted = performance.now();
        this.metrics.preflights++;
        try {
          if (coordinateClick) await this.checkPoint(page, args, signal);
          else {
            target = this.issuedTarget(args, operationId, sequence);
            ref = target.ref;
            await this.checkPrivateInput(page, ref, target.issued.name ?? "", signal);
            this.checkObservation(target.observation);
          }
        } finally { this.metrics.preflightMillis += performance.now() - preflightStarted; }
      }
      if (type === "press") await this.checkFocus(page, signal);
      signal.throwIfAborted();
      this.observation = undefined;
      this.screenshotTarget = undefined;
      dispatched = true;
      const actionStarted = performance.now();
      if (type === "waitFor") this.metrics.waits++; else this.metrics.actions++;
      try {
        switch (type) {
          case "click":
            await this.call(coordinateClick ? "browser_mouse_click_xy" : "browser_click",
              coordinateClick ? { x: args["x"], y: args["y"] } : { target: ref }, signal);
            break;
          case "fill": await this.call("browser_type", { target: ref, text: args["text"] }, signal); break;
          case "check": await this.call("browser_fill_form", { fields: [{ target: ref, name: "Field", type: "checkbox", value: String(args["checked"]) }] }, signal); break;
          case "selectOption": await this.call("browser_select_option", { target: ref, values: args["values"] }, signal); break;
          case "navigate": await this.call("browser_navigate", { url: args["url"] }, signal); break;
          case "goBack": await this.call("browser_navigate_back", {}, signal); break;
          case "newTab": await this.call("browser_tabs", { action: "new", ...args }, signal); break;
          case "selectTab": await this.call("browser_tabs", { action: "select", ...args }, signal); break;
          case "closeTab": await this.call("browser_tabs", { action: "close" }, signal); break;
          case "press": await this.call("browser_press_key", { key: args["key"] }, signal); break;
          case "waitFor": await this.call("browser_wait_for", args, signal); break;
          case "scroll": await this.call("browser_mouse_wheel", { deltaX: args["x"] ?? 0, deltaY: args["y"] }, signal); break;
        }
        if (this.sequence) {
          this.sequence.next = (position ?? this.sequence.next) + 1;
          if (this.sequence.next === this.sequence.operationIds.length) this.sequence = undefined;
        }
      } catch (error) {
        this.sequence = undefined;
        await this.close();
        throw error;
      } finally {
        if (type === "waitFor") this.metrics.waitMillis += performance.now() - actionStarted;
        else this.metrics.actionMillis += performance.now() - actionStarted;
      }
    } catch (error) {
      if (!dispatched && !(error instanceof z.ZodError) && !(error instanceof McpExecutionUnconfirmed))
        throw new BrowserRejection(error instanceof BrowserRejection ? error.message : "Browser target could not be verified; observe again",
          error instanceof BrowserRejection ? error.code : undefined);
      throw error;
    }
  }

  async screenshot(operationId: string, signal: AbortSignal): Promise<{ filename: string; target: object }> {
    const page = await this.synchronize(signal);
    this.screenshotTarget = undefined;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const target: ScreenshotTarget = { id: z.uuid().parse(operationId), page,
      epoch: this.controlEpoch(), generation: this.generation, time: new Date().toISOString(), ...viewport };
    const filename = path.posix.join(outputDirectory, `screenshot-${z.uuid().parse(operationId)}.png`);
    try {
      await this.call("browser_take_screenshot", { type: "png", filename, fullPage: false, scale: "css" }, signal);
      this.checkObservation(target);
      this.screenshotTarget = target;
    }
    catch (error) { await rm(filename, { force: true }); throw error; }
    return { filename, target: { screenshotId: target.id, width: target.width, height: target.height,
      observedAt: target.time, expiresAt: new Date(Date.parse(target.time) + 60_000).toISOString() } };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.invalidate();
    return this.closing ??= Promise.resolve().then(async () => {
      let failure: unknown;
      try { await this.opening; } catch (error) { failure = error; }
      try { await this.pending; } catch { this.unconfirmed = true; }
      try { await this.connection?.close(); } catch (error) { failure ??= error; }
      try { await this.client?.close(); } catch (error) { failure ??= error; }
      this.context.off("page", this.pageAdded);
      for (const [page, { changed, closed, dialog }] of this.listeners) {
        page.off("framenavigated", changed); page.off("close", closed); page.off("crash", changed); page.off("dialog", dialog);
      }
      this.listeners.clear(); this.client = undefined; this.connection = undefined;
      if (this.unconfirmed) throw new McpExecutionUnconfirmed();
      if (failure) throw new Error("Browser observation disposal failed", { cause: failure });
    });
  }
}
