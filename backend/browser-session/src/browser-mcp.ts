import { randomUUID } from "node:crypto";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";

export class BrowserRejection extends Error {
  constructor(message: string, readonly code?: "OBSERVATION_LIMIT_EXCEEDED") {
    super(message);
  }
}
const refSchema = z.string().regex(/^(f\d+)?e\d+$/).max(40);
const targetSchema = z.object({ observationId: z.uuid(), ref: refSchema });
const fields = targetSchema.shape;
const schemas: Record<string, z.ZodType> = {
  click: z.object(fields).strict(),
  fill: z.object({ ...fields, text: z.string().max(50_000) }).strict(),
  press: z.object({ ...fields, key: z.string().min(1).max(100) }).strict(),
  selectOption: z.object({ ...fields, values: z.array(z.string().max(1000)).min(1).max(100) }).strict(),
  check: z.object({ ...fields, checked: z.boolean() }).strict(),
  waitFor: z.object({ ...fields, state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible") }).strict(),
  navigate: z.object({ url: z.string().max(8192) }).strict(),
  newTab: z.object({ url: z.string().max(8192).optional() }).strict(),
  selectTab: z.object({ index: z.number().int().nonnegative().max(19) }).strict(),
  closeTab: z.object({}).strict(), goBack: z.object({}).strict(), reload: z.object({}).strict(),
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
type Observation = {
  id: string; time: string; page: Page; epoch: number; generation: number;
  entries: Entry[]; issued: Map<string, NativeNode>; cursor?: string; offset: number;
};
export type Sequence = { operationIds: string[] };

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
  private sequence?: { operationIds: string[]; next: number; observation: Observation };
  private readonly listeners = new Map<Page, { changed: () => void; closed: () => void }>();
  private readonly pageAdded: (page: Page) => void;
  private captures = 0;

  get isClosing(): boolean { return this.closing !== undefined; }

  constructor(private readonly context: BrowserContext, private readonly currentPage: () => Page,
    private readonly controlEpoch: () => number, private readonly assertAllowed: () => void) {
    this.pageAdded = page => {
      const changed = () => this.invalidate();
      const closed = () => {
        changed();
        page.off("framenavigated", changed); page.off("close", closed); page.off("crash", changed);
        this.listeners.delete(page);
      };
      this.listeners.set(page, { changed, closed });
      page.on("framenavigated", changed);
      page.on("close", closed);
      page.on("crash", changed);
      this.invalidate();
    };
    for (const page of context.pages()) this.pageAdded(page);
    context.on("page", this.pageAdded);
  }

  private invalidate(): void {
    this.generation++;
    this.observation = undefined;
    this.sequence = undefined;
  }

  private async open(): Promise<void> {
    if (this.closing) throw new BrowserRejection("Browser observation is closing");
    this.opening ??= (async () => {
      this.connection = await createConnection({
        snapshot: { mode: "none" }, webmcp: false, codegen: "none", imageResponses: "omit",
        saveSession: false, timeouts: { action: 20_000, navigation: 40_000 },
        outputDir: "/tmp/helm-mcp", sharedBrowserContext: true
      }, async () => this.context);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      this.client = new Client({ name: "Helm Glass", version: "1.0.0" });
      await this.connection.connect(serverTransport);
      await this.client.connect(clientTransport);
      const initialized = await this.client.callTool({ name: "browser_tabs", arguments: { action: "list", _meta: { json: true } } });
      if (initialized.isError) throw new BrowserRejection("MCP initialization failed");
    })();
    await this.opening;
  }

  private async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.open();
    this.assertAllowed();
    signal?.throwIfAborted();
    let result;
    try {
      result = await this.client!.callTool({ name, arguments: { ...args, _meta: { json: true } } },
        undefined, { signal, timeout: 45_000 });
    } catch (error) {
      await this.close();
      throw error;
    }
    if (result.isError) {
      // Upstream error text is neither a public contract nor safe site data.
      if (name === "browser_snapshot" && Array.isArray(result.content)) {
        for (const item of result.content) {
          const limit = item.type === "text" && typeof item.text === "string"
            ? /HELM_SNAPSHOT_LIMIT(?:_(TEXT|TIME|NODES|DEPTH))?/.exec(item.text) : null;
          if (limit) throw new BrowserRejection(`Page snapshot exceeds capture limits: ${limit[1] ?? "CAPTURE"}`, "OBSERVATION_LIMIT_EXCEEDED");
        }
      }
      throw new Error("Browser tool failed");
    }
    const content = z.array(z.object({ type: z.literal("text"), text: z.string().max(2_097_152) }).strict()).length(1).parse(result.content);
    return JSON.parse(content[0]!.text) as unknown;
  }

  private async synchronize(signal?: AbortSignal): Promise<Page> {
    this.assertAllowed();
    const page = this.currentPage();
    const pages = this.context.pages();
    if (page.isClosed() || pages.length > 20 || !pages.includes(page))
      throw new BrowserRejection("Selected page is unavailable");
    if (this.selected !== page) {
      this.invalidate();
      await this.call("browser_tabs", { action: "select", index: pages.indexOf(page) }, signal);
      if (this.currentPage() !== page || this.context.pages()[pages.indexOf(page)] !== page)
        throw new BrowserRejection("Selected page changed");
      this.selected = page;
    }
    return page;
  }

  private async capture(signal?: AbortSignal): Promise<NativeNode[]> {
    this.captures++;
    return snapshotResult.parse(await this.call("browser_snapshot", {}, signal)).snapshot;
  }

  private checkObservation(value: Observation): void {
    this.assertAllowed();
    if (value.page !== this.currentPage() || value.generation !== this.generation
      || value.epoch !== this.controlEpoch() || Date.now() - Date.parse(value.time) > 60_000)
      throw new BrowserRejection("Observation expired or page changed; observe again");
  }

  async observe(args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<object> {
    const input = z.object({ cursor: z.string().max(100).optional() }).strict().parse(args);
    const page = await this.synchronize(signal);
    if (input.cursor) {
      if (!this.observation || input.cursor !== this.observation.cursor)
        throw new BrowserRejection("Observation cursor expired");
      this.checkObservation(this.observation);
    } else {
      this.observation = undefined;
      this.sequence = undefined;
      const generation = this.generation, epoch = this.controlEpoch(), time = new Date().toISOString();
      const snapshot = await this.capture(signal);
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
      const observation: Observation = { id: randomUUID(), time, page, epoch, generation, entries, issued: new Map(), offset: 0 };
      this.checkObservation(observation);
      this.observation = observation;
    }
    const observation = this.observation;
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
      format: "playwright-aria-json-paths-v1", snapshot: entries, complete, limited: !complete,
      cursor: observation.cursor, metrics: { snapshots: this.captures, snapshotBytes: bytes } };
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
      const targeted = ["click", "fill", "press", "selectOption", "check", "waitFor"].includes(type);
      let ref: string | undefined;
      if (targeted) {
        const input = targetSchema.parse(args);
        const reserved = this.sequence;
        let observation = this.observation;
        // The Java dispatcher owns execution order. Media reads between native
        // actions do not consume or replace the accepted sequence's references.
        if (reserved && position !== undefined && position >= reserved.next) observation = reserved.observation;
        if (!observation || observation.id !== input.observationId || !observation.issued.has(input.ref))
          throw new BrowserRejection("Reference was not issued for this operation; observe again");
        this.checkObservation(observation);
        const issued = observation.issued.get(input.ref)!;
        // Native refresh preserves the full reference scope for subsequent batch fields.
        const snapshot = await this.capture(signal);
        const contains = (nodes: (NativeNode | string)[]): boolean => nodes.some(node => typeof node !== "string"
          && (node.ref === input.ref && node.role === issued.role && node.name === issued.name
            || node.children !== undefined && contains(node.children)));
        if (!contains(snapshot)) throw new BrowserRejection("Reference is stale; observe again");
        this.checkObservation(observation);
        ref = input.ref;
        if (sequence && !reserved) {
          if (position === undefined || sequence.operationIds.length > 8)
            throw new BrowserRejection("Invalid operation sequence");
          this.sequence = { operationIds: sequence.operationIds, next: position, observation };
        }
        const protectedInput = await page.locator(`aria-ref=${ref}`).evaluate((element, accessibleName) => {
          const typeValue = element.getAttribute("type") ?? "";
          const values = ["autocomplete", "name", "id", "aria-label"].map(key => element.getAttribute(key) ?? "");
          if (typeValue.length > 100 || values.some(value => value.length > 1000)) return true;
          const type = typeValue.toLowerCase();
          const hints = values.join(" ") + (element.matches('input, textarea, select, [contenteditable], [role="textbox"]') ? " " + accessibleName : "");
          return ["password", "hidden"].includes(type) || /password|passwd|one.?time.?code|otp|verification.?code|security.?code|cc-|cc_?(?:number|exp|csc)|card.?number|cvc|cvv|payment|парол|однораз|код.подтверж|номер.карт/i.test(hints);
        }, issued.name ?? "", { signal }).catch(() => { throw new BrowserRejection("Reference is unavailable"); });
        if (protectedInput) throw new BrowserRejection("Private input requires the user");
        this.checkObservation(observation);
      }
      signal.throwIfAborted();
      this.observation = undefined;
      dispatched = true;
      try {
        switch (type) {
          case "click": await this.call("browser_click", { target: ref }, signal); break;
          case "fill": await this.call("browser_type", { target: ref, text: args["text"] }, signal); break;
          case "check": await this.call("browser_fill_form", { fields: [{ target: ref, name: "Field", type: "checkbox", value: String(args["checked"]) }] }, signal); break;
          case "selectOption": await this.call("browser_select_option", { target: ref, values: args["values"] }, signal); break;
          case "navigate": await this.call("browser_navigate", { url: args["url"] }, signal); break;
          case "goBack": await this.call("browser_navigate_back", {}, signal); break;
          case "newTab": await this.call("browser_tabs", { action: "new", ...args }, signal); break;
          case "selectTab": await this.call("browser_tabs", { action: "select", ...args }, signal); break;
          case "closeTab": await this.call("browser_tabs", { action: "close" }, signal); break;
          case "press": await page.locator(`aria-ref=${ref}`).press(z.string().parse(args["key"]), { signal }); break;
          case "waitFor": await page.locator(`aria-ref=${ref}`).waitFor({ state: z.enum(["visible", "hidden", "attached", "detached"]).parse(args["state"] ?? "visible"), timeout: 20_000, signal }); break;
          case "reload": await page.reload({ waitUntil: "domcontentloaded", signal }); break;
          case "scroll": await page.mouse.wheel(z.number().parse(args["x"] ?? 0), z.number().parse(args["y"])); break;
        }
        if (this.sequence) {
          this.sequence.next = (position ?? this.sequence.next) + 1;
          if (this.sequence.next === this.sequence.operationIds.length) this.sequence = undefined;
        }
      } catch (error) {
        this.sequence = undefined;
        // Client cancellation is not a disposal acknowledgement. The patched server
        // awaits the actual handler before releasing listeners and the context.
        await this.close();
        throw error;
      }
    } catch (error) {
      if (!dispatched && !(error instanceof z.ZodError))
        throw new BrowserRejection(error instanceof BrowserRejection ? error.message : "Browser target could not be verified; observe again");
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.invalidate();
    return this.closing ??= Promise.resolve().then(async () => {
      let failure: unknown;
      try { await this.opening; } catch (error) { failure = error; }
      try { await this.connection?.close(); } catch (error) { failure ??= error; }
      try { await this.client?.close(); } catch (error) { failure ??= error; }
      for (const page of this.context.pages()) {
        for (const frame of page.frames()) {
          try { await frame.locator(":root").ariaSnapshotJSON({ mode: "ai", depth: -1, timeout: 20_000 }); }
          catch (error) { if (!frame.isDetached() && !page.isClosed()) failure ??= error; }
        }
      }
      this.context.off("page", this.pageAdded);
      for (const [page, { changed, closed }] of this.listeners) {
        page.off("framenavigated", changed); page.off("close", closed); page.off("crash", changed);
      }
      this.listeners.clear(); this.client = undefined; this.connection = undefined;
      if (failure) throw new Error("Browser observation disposal failed", { cause: failure });
    });
  }
}
