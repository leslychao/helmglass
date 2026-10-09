import type { CDPSession, Page } from "playwright";
import { z } from "zod";
import { ProfileExportError, profileLimits } from "./profile-format.js";

export const profileExportUrl = "about:blank#helm-profile-export";
const messageSchema = z.object({
  id: z.number().optional(), result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  method: z.string().optional(), params: z.unknown().optional(),
});

// Headed Chromium exposes hidden pages as "other" targets, which Playwright does
// not wrap as Page objects. Keep this channel private to the profile exporter.
export class ProfileTarget {
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(
    private readonly protocol: CDPSession,
    private readonly targetId: string,
    private readonly sessionId: string,
    private readonly write: (value: string) => Promise<void>,
  ) {
    protocol.on("Target.receivedMessageFromTarget", (event: { sessionId: string; message: string }) => {
      if (event.sessionId === sessionId) void this.receive(event.message).catch(error => this.fail(error));
    });
    protocol.on("close", () => this.fail(new Error("Profile target closed")));
  }

  static async create(selected: Page, write: (value: string) => Promise<void>): Promise<ProfileTarget> {
    const protocol = await selected.context().newCDPSession(selected);
    try {
      const { targetInfo } = await protocol.send("Target.getTargetInfo");
      const { targetId } = await protocol.send("Target.createTarget", {
        url: profileExportUrl, browserContextId: targetInfo.browserContextId,
        hidden: true, background: true,
      });
      const { sessionId } = await protocol.send("Target.attachToTarget", { targetId, flatten: false });
      const target = new ProfileTarget(protocol, targetId, sessionId, write);
      await target.request("Network.setBypassServiceWorker", { bypass: true });
      await target.request("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await target.request("Runtime.enable", {});
      await target.request("Runtime.addBinding", { name: "__helmProfileChunk" });
      return target;
    } catch (error) { await protocol.detach(); throw error; }
  }

  async navigate(origin: string): Promise<void> {
    await this.request("Page.navigate", { url: origin });
    await this.evaluate(`new Promise(resolve => document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', () => resolve(), {once:true}) : resolve())`);
    await this.evaluate(`window.__helmProfileWrite = value => new Promise((resolve, reject) => {
      window.__helmProfileAck = error => error ? reject(new Error(error)) : resolve();
      window.__helmProfileChunk(value);
    })`);
  }

  async evaluate(expression: string, timeout = 20_000): Promise<unknown> {
    const result = z.object({ result: z.object({ value: z.unknown().optional() }),
      exceptionDetails: z.unknown().optional() }).parse(await this.request("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, timeout));
    if (result.exceptionDetails) throw new ProfileExportError(409, "Profile evaluation failed", "PROFILE_SNAPSHOT_CHANGED");
    return result.result.value;
  }

  private request(method: string, params: object, timeout = 20_000): Promise<unknown> {
    if (this.pending.size >= 8) return Promise.reject(new Error("Profile protocol queue full"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error("Profile protocol timed out"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      void this.protocol.send("Target.sendMessageToTarget", {
        sessionId: this.sessionId, message: JSON.stringify({ id, method, params }),
      }).catch(error => this.fail(error));
    });
  }

  private async receive(raw: string): Promise<void> {
    const message = messageSchema.parse(JSON.parse(raw));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else if (message.method === "Fetch.requestPaused") {
      const { requestId } = z.object({ requestId: z.string() }).parse(message.params);
      await this.request("Fetch.fulfillRequest", { requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html" }],
        body: Buffer.from("<!doctype html>").toString("base64") });
    } else if (message.method === "Runtime.bindingCalled") {
      const event = z.object({ name: z.literal("__helmProfileChunk"), payload: z.string(),
        executionContextId: z.number().int() }).parse(message.params);
      let failure: string | null = null;
      try {
        if (Buffer.byteLength(event.payload) > profileLimits.chunk) {
          throw new ProfileExportError(422, "Invalid profile chunk", "PROFILE_INVALID");
        }
        await this.write(event.payload);
      } catch (error) {
        failure = error instanceof ProfileExportError ? error.code : "PROFILE_SAVE_FAILED";
      }
      await this.request("Runtime.evaluate", { contextId: event.executionContextId,
        expression: `window.__helmProfileAck(${JSON.stringify(failure)})` });
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.fail(new Error("Profile export finished"));
    try { await this.protocol.send("Target.closeTarget", { targetId: this.targetId }); }
    finally { await this.protocol.detach(); }
  }
}
