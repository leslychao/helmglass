import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** Packaging/bootstrap check only; this does not emulate or certify a ChatGPT host. */
export async function verifyWidgetResource(account, fixture, client, evidence) {
  const resource = await client.readResource({
    uri: "ui://helm-glass/browser.html",
  });
  const html = resource.contents.find(
    (item) => typeof item.text === "string",
  )?.text;
  assert.equal(typeof html, "string");
  assert.ok(
    html.includes("<hg-widget>"),
    "MCP serves the dedicated widget application",
  );
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(
    scripts.length,
    1,
    "The resource contains one self-contained script",
  );
  const hash = createHash("sha256").update(scripts[0][1]).digest("base64");
  const policy = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; object-src 'none'`;
  const secured = html.replace(
    "<head>",
    () =>
      `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`,
  );
  const browser = account.context.browser();
  assert.ok(browser);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // Establish a real trusted HTTPS origin without creating a web login. The
    // content under test comes solely from the authenticated MCP resource read.
    await page.goto(
      fixture.origin + "/auth/realms/helm/.well-known/openid-configuration",
    );
    assert.ok(
      !(await context.cookies()).some(
        (cookie) => cookie.name === "__Host-helm_session",
      ),
    );
    const requests = [];
    const errors = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url()))
        requests.push(new URL(request.url()).pathname);
    });
    page.on("pageerror", (error) => errors.push(error.name));
    await page.setContent(secured);
    await page
      .getByRole("heading", { name: "Браузер задачи", level: 1 })
      .waitFor();
    assert.equal(await page.locator(".sidebar").count(), 0);
    assert.ok(
      await page
        .locator("hg-widget img")
        .evaluate((image) => image.naturalWidth > 0),
    );
    assert.deepEqual(
      requests,
      [],
      "Widget boot cannot request cabinet scripts, styles, or identity",
    );
    assert.deepEqual(
      errors,
      [],
      "AOT widget boot works under a script hash without eval",
    );
    await page.screenshot({
      path: "/evidence/widget-resource.png",
      fullPage: true,
    });
    evidence.widgetResource = {
      status: "PASS",
      bytes: Buffer.byteLength(html),
      externalRequests: 0,
      webLoginCookie: false,
      realHost: "NOT_VERIFIED",
    };
  } finally {
    await context.close();
  }
}
