import { randomBytes, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";
import type { SavedCredential } from "./credential-autofill.js";

const Submission = z.discriminatedUnion("status", [
  z.object({ nonce: z.uuid(), status: z.literal("UNSUPPORTED") }).strict(),
  z
    .object({
      nonce: z.uuid(),
      status: z.literal("CAPTURED"),
      origin: z.url().max(8192),
      username: z.string().min(1).max(500),
      password: z.string().min(1).max(8192),
    })
    .strict(),
]);

export class CaptureConflict extends Error {}

/** One consent and candidate per private browser; no credentials are persisted here. */
export class CredentialCapture {
  private enabled = false;
  // A late consent from a previous browser process must not arm a new context.
  private revision = randomBytes(6).readUIntBE(0, 6);
  private nonce = "";
  private origin: string | null = null;
  private expectedRevision = 0;
  private unsupported = false;
  private candidate:
    | {
        operationId: string;
        expectedRevision: number;
        credential: SavedCredential;
      }
    | undefined;
  private lastOperation:
    { id: string; enabled: boolean; revision: number } | undefined;

  metadata() {
    let captureStatus = "DISABLED";
    if (this.enabled) {
      captureStatus = "ARMED";
      if (this.unsupported) captureStatus = "UNSUPPORTED";
      if (this.candidate) captureStatus = "CAPTURED";
    }
    return {
      captureEnabled: this.enabled,
      captureRevision: this.revision,
      captureOrigin: this.origin,
      captureStatus,
    };
  }

  clear() {
    this.enabled = false;
    this.revision++;
    this.nonce = "";
    this.origin = null;
    this.candidate = undefined;
    this.unsupported = false;
    this.lastOperation = undefined;
  }

  async consent(
    page: Page,
    enabled: boolean,
    revision: number,
    operationId: string,
    storedRevision: number,
  ) {
    if (this.lastOperation?.id === operationId) {
      if (
        this.lastOperation.enabled !== enabled ||
        this.lastOperation.revision !== revision
      )
        throw new CaptureConflict("Consent operation changed");
      return this.metadata();
    }
    if (this.revision !== revision)
      throw new CaptureConflict("Consent changed");
    const url = new URL(page.url());
    if (enabled && url.protocol !== "https:")
      throw new CaptureConflict("HTTPS login page required");
    if (enabled !== this.enabled || (enabled && url.origin !== this.origin)) {
      this.clear();
      this.enabled = enabled;
      this.origin = enabled ? url.origin : null;
      this.nonce = enabled ? randomUUID() : "";
      this.expectedRevision = storedRevision;
    }
    this.lastOperation = { id: operationId, enabled, revision };
    await this.updatePage(page);
    return this.metadata();
  }

  export() {
    return this.enabled ? (this.candidate ?? null) : null;
  }

  private settings() {
    return this.enabled ? { nonce: this.nonce, origin: this.origin } : null;
  }

  async updatePage(page: Page) {
    if (page.isClosed()) return;
    await page.evaluate((settings) => {
      const apply: unknown = Reflect.get(window, "__helmSetCredentialCapture");
      if (typeof apply === "function") apply(settings);
    }, this.settings());
  }

  async install(context: BrowserContext, allowed: (page: Page) => boolean) {
    await context.exposeBinding("__helmCredentialCapturePolicy", (source) =>
      source.frame === source.page.mainFrame() && allowed(source.page)
        ? this.settings()
        : null,
    );
    await context.exposeBinding(
      "__helmCredentialSubmitted",
      (source, payload: unknown) => {
        if (
          !this.enabled ||
          !allowed(source.page) ||
          source.frame !== source.page.mainFrame()
        )
          return;
        const parsed = Submission.safeParse(payload);
        if (
          !parsed.success ||
          parsed.data.nonce !== this.nonce ||
          new URL(source.frame.url()).origin !== this.origin
        )
          return;
        const input = parsed.data;
        if (input.status === "UNSUPPORTED") {
          this.unsupported = true;
          return;
        }
        if (input.origin !== this.origin) return;
        this.candidate = {
          operationId: randomUUID(),
          expectedRevision: this.expectedRevision,
          credential: {
            origin: input.origin,
            username: input.username,
            password: input.password,
          },
        };
        this.unsupported = false;
      },
    );
    await context.addInitScript(() => {
      let settings: { nonce: string; origin: string } | null = null;
      Object.defineProperty(window, "__helmSetCredentialCapture", {
        value: (value: typeof settings) => {
          settings = value;
        },
      });
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          const read: unknown = Reflect.get(
            window,
            "__helmCredentialCapturePolicy",
          );
          if (typeof read === "function")
            Promise.resolve(read())
              .then((value) => {
                settings = value;
              })
              .catch(() => {});
        },
        { once: true },
      );
      document.addEventListener(
        "submit",
        (event) => {
          if (
            !event.isTrusted ||
            !settings ||
            location.protocol !== "https:" ||
            location.origin !== settings.origin ||
            !(event.target instanceof HTMLFormElement)
          )
            return;
          const submit: unknown = Reflect.get(
            window,
            "__helmCredentialSubmitted",
          );
          if (typeof submit !== "function") return;
          const send = (value: object) => {
            Promise.resolve(submit({ nonce: settings?.nonce, ...value })).catch(
              () => {},
            );
          };
          const form = event.target;
          const visible = (input: HTMLInputElement) =>
            !input.disabled &&
            input.getClientRects().length > 0 &&
            getComputedStyle(input).visibility !== "hidden";
          const fields = [
            ...form.querySelectorAll<HTMLInputElement>("input"),
          ].filter(visible);
          const unsafe = fields.some(
            (input) =>
              /new-password|one-time-code|^cc-/i.test(input.autocomplete) ||
              /(?:^|[-_\s])(otp|pin|cvv|cvc|code|passcode|verification|security.?code|new.?password|confirm.?password|password.?confirmation|card)(?:$|[-_\s])/i.test(
                `${input.name} ${input.id}`,
              ),
          );
          const passwords = fields.filter((input) => input.type === "password");
          const users = fields.filter((input) =>
            input.matches(
              'input[autocomplete="username"],input[type="email"],input[type="tel"],input[name="login"],input[name="username"]',
            ),
          );
          const username = users[0]?.value,
            password = passwords[0]?.value;
          if (
            unsafe ||
            new URL(form.action || location.href, location.href).origin !==
              settings.origin ||
            passwords.length !== 1 ||
            users.length !== 1 ||
            !username ||
            username.length > 500 ||
            !password ||
            password.length > 8192
          ) {
            send({ status: "UNSUPPORTED" });
            return;
          }
          send({
            status: "CAPTURED",
            origin: location.origin,
            username,
            password,
          });
        },
        true,
      );
    });
  }
}
