import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
const { CredentialCapture } = await import(
  pathToFileURL(path.resolve("dist/credential-capture.js"))
);

// Run in an owned deployed browser-session container as uid 1000. The routed
// HTTPS fixture isolates form semantics; it does not claim external-site login.
test(
  "native login submission needs exact-origin consent and keeps one private candidate",
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
    });
    try {
      const context = await browser.newContext();
      const capture = new CredentialCapture();
      let allowed = true;
      await capture.install(context, () => allowed);
      const html = (
        mode = "",
      ) => `<!doctype html><form action="${mode === "foreign" ? "https://other.example" : "/login"}">
      ${mode === "password-only" ? "" : '<input name="username" autocomplete="username" value="synthetic-user">'}
      <input name="${mode === "otp" ? "otp" : "password"}" type="password" autocomplete="${mode === "new" ? "new-password" : mode === "otp" ? "one-time-code" : "current-password"}" value="synthetic-value">
      ${mode === "two-passwords" ? '<input type="password" value="second">' : ""}
      <button>Log in</button></form><script>document.querySelector('form').addEventListener('submit',e=>e.preventDefault())</script>`;
      await context.route("https://login.example/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: html(
            new URL(route.request().url()).searchParams.get("mode") ?? "",
          ),
        }),
      );
      await context.route("https://other.example/**", (route) =>
        route.fulfill({ contentType: "text/html", body: html() }),
      );
      const page = await context.newPage();
      await page.goto("https://login.example/");
      const restarted = new CredentialCapture();
      await assert.rejects(
        restarted.consent(
          page, true, capture.metadata().captureRevision, randomUUID(), 7,
        ),
        /Consent changed/,
        "A delayed consent must not arm a replacement browser process",
      );
      assert.equal(restarted.metadata().captureEnabled, false);
      await page.getByRole("button", { name: "Log in" }).click();
      assert.equal(capture.export(), null);
      const operation = randomUUID();
      const revision = capture.metadata().captureRevision;
      const consent = await capture.consent(page, true, revision, operation, 7);
      assert.deepEqual(
        await capture.consent(page, true, revision, operation, 7),
        consent,
      );
      await assert.rejects(
        capture.consent(page, false, revision, randomUUID(), 7),
      );
      await page.getByRole("button", { name: "Log in" }).click();
      await assertEventually(
        () => capture.metadata().captureStatus === "CAPTURED",
      );
      const candidate = capture.export();
      assert.equal(candidate.expectedRevision, 7);
      assert.equal(candidate.credential.username, "synthetic-user");
      assert.equal(candidate.credential.password, "synthetic-value");
      assert.equal(
        JSON.stringify(capture.metadata()).includes("synthetic-value"),
        false,
      );
      assert.equal(
        capture.export().operationId,
        candidate.operationId,
        "Failed save/retry must keep the same candidate identity",
      );
      allowed = false;
      await page.locator("[name=password]").fill("different-synthetic");
      await page.getByRole("button", { name: "Log in" }).click();
      assert.equal(
        capture.export().operationId,
        candidate.operationId,
        "Profile export freezes new capture",
      );
      allowed = true;
      for (const mode of [
        "otp",
        "new",
        "password-only",
        "two-passwords",
        "foreign",
      ]) {
        capture.clear();
        await page.goto("https://login.example/?mode=" + mode);
        await capture.consent(
          page,
          true,
          capture.metadata().captureRevision,
          randomUUID(),
          7,
        );
        await page.getByRole("button", { name: "Log in" }).click();
        await assertEventually(
          () => capture.metadata().captureStatus === "UNSUPPORTED",
        );
        assert.equal(capture.export(), null, mode);
      }
      capture.clear();
      await page.goto("https://login.example/");
      await capture.consent(
        page,
        true,
        capture.metadata().captureRevision,
        randomUUID(),
        7,
      );
      await page.goto("https://other.example/");
      await page.getByRole("button", { name: "Log in" }).click();
      assert.equal(capture.export(), null, "Consent must not cross origins");
      await capture.consent(
        page,
        false,
        capture.metadata().captureRevision,
        randomUUID(),
        7,
      );
      assert.equal(capture.metadata().captureEnabled, false);
      assert.equal(capture.metadata().captureOrigin, null);
    } finally {
      await browser.close();
    }
  },
);

async function assertEventually(predicate) {
  const until = Date.now() + 3000;
  while (!predicate() && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate());
}
