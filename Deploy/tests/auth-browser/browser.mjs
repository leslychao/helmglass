import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { verifyMcpWorker } from "./mcp.mjs";
import { verifyCabinet, verifyAdminReads } from "./cabinet.mjs";
const require = createRequire("/app/package.json");
const { chromium } = require("playwright");
const fixture = JSON.parse(await readFile("/fixture/browser.json", "utf8"));
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
});
const evidence = {
  accounts: [],
  errors: [],
  websockets: [],
  handshakeHeaders: [],
  mutations: [],
};
const sessionKeys = {};

function redisSessionKey(value) {
  const encoded = Buffer.from(value.split("|")[0], "base64url").toString();
  assert.ok(encoded.startsWith("v2."), "Pinned OAuth2 Proxy Redis ticket version");
  return Buffer.from(encoded.split(".")[1], "base64url").toString();
}

async function read(account, path) {
  return account.page.evaluate(async (path) => {
    const response = await fetch(path);
    return {
      status: response.status,
      serverDate: response.headers.get("date"),
      body: await response.json().catch(() => null),
    };
  }, path);
}

async function signIn(username) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
  });
  const page = await context.newPage();
  let firstCsrfValue;
  await page.addInitScript(() => {
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/v1/me") {
        window.helmBootstrapRequest = {
          origin: location.origin,
          credentials: init?.credentials ?? "default",
          mode: init?.mode ?? "default",
          effectiveCredentials: new Request(input, init).credentials,
        };
      }
      return nativeFetch(input, init);
    };
  });
  page.on("response", async (response) => {
    const cookies = (await response.headersArray()).filter(
      (header) =>
        header.name.toLowerCase() === "set-cookie" &&
        header.value.startsWith("__Host-helm_csrf="),
    );
    for (const cookie of cookies) {
      const value = cookie.value.split(";")[0];
      firstCsrfValue ??= value;
      (evidence.csrfCookieHistory ??= []).push({
        path: new URL(response.url()).pathname,
        empty: cookie.value.startsWith("__Host-helm_csrf=;"),
        attributes: cookie.value.split(";").slice(1),
        validValue: /^__Host-helm_csrf=[A-Za-z0-9_-]{43};/.test(cookie.value),
        equalsFirst: value === firstCsrfValue,
      });
    }
  });
  const protocol = await context.newCDPSession(page);
  await protocol.send("Network.enable");
  await protocol.send("Audits.enable");
  protocol.on("Audits.issueAdded", ({ issue }) => {
    if (issue.code !== "CookieIssue") return;
    const details = issue.details.cookieIssueDetails;
    (evidence.cookieIssues ??= []).push({
      name: details.cookie?.name,
      operation: details.operation,
      exclusions: details.cookieExclusionReasons,
      warnings: details.cookieWarningReasons,
    });
  });
  protocol.on("Network.responseReceivedExtraInfo", (event) => {
    for (const cookie of event.blockedCookies ?? []) {
      (evidence.blockedCookies ??= []).push({
        reasons: cookie.blockedReasons,
        name: cookie.cookie?.name,
      });
    }
  });
  protocol.on("Network.webSocketWillSendHandshakeRequest", (event) => {
    const headers = Object.fromEntries(
      Object.entries(event.request.headers).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    evidence.handshakeHeaders.push({
      origin: headers.origin,
      fetchSite: headers["sec-fetch-site"],
      upgrade: headers.upgrade,
    });
  });
  protocol.on("Network.webSocketHandshakeResponseReceived", ({ response }) => {
    for (const [header, value] of Object.entries(response.headers)) {
      if (header.toLowerCase() !== "set-cookie") continue;
      for (const cookie of String(value).split("\n")) {
        const [pair, ...attributes] = cookie.split(";");
        (evidence.handshakeCookies ??= []).push({
          name: pair.split("=")[0],
          empty: pair.endsWith("="),
          attributes,
          equalsFirst: pair === firstCsrfValue,
        });
      }
    }
  });
  let websocketReady = false;
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/events/v1/user")) return;
    const observed = { username, frames: [], error: null, closed: false };
    evidence.websockets.push(observed);
    socket.on("socketerror", (error) => {
      observed.error = String(error);
    });
    socket.on("close", () => {
      observed.closed = true;
    });
    socket.on("framereceived", (frame) => {
      try {
        const type = JSON.parse(String(frame.payload)).type;
        if (typeof type === "string") observed.frames.push(type);
        websocketReady ||= type === "ready";
      } catch {
        observed.error = "Malformed frame";
      }
    });
  });
  page.on("pageerror", (error) => evidence.errors.push(error.name));
  await page.goto(fixture.origin + "/tasks?sort=updated");
  await page.locator("#username").waitFor();
  assert.equal(await page.locator(".auth-story").count(), 1, "Helm Glass owns the login design");
  assert.equal(await page.locator("#kc-page-title").innerText(), "Войти в Helm Glass");
  assert.equal(await page.getByText("Войти через Keycloak", { exact: true }).count(), 0);
  assert.equal(new URL(page.url()).origin, fixture.origin, "Login stays on the application origin");
  assert.equal(
    new URL(page.url()).searchParams.get("prompt"),
    "login",
    "Every new web authorization requires a fresh password login",
  );
  await page.locator("#username").fill(username);
  if (username === "admin") {
    const toggle = page.getByRole("button", { name: "Показать пароль", exact: true });
    await toggle.click();
    assert.equal(await page.locator("#password").getAttribute("type"), "text");
    await page.getByRole("button", { name: "Скрыть пароль", exact: true }).click();
    assert.equal(await page.locator("#password").getAttribute("type"), "password");
    assert.equal(await toggle.innerText(), "", "Password visibility uses only the eye icon");
    await page.locator("#username").focus();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "/evidence/helm-login.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: "/evidence/helm-login-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.locator("#password").fill("incorrect-fixture-password");
    await page.locator("#kc-login").click();
    await page.locator("#input-error").waitFor();
    assert.equal(await page.locator("#username").inputValue(), username);
    assert.equal(await page.locator("#password").inputValue(), "");
    evidence.invalidPassword = "PASS";
  }
  await page.locator("#password").fill(fixture[username].password);
  const bootstrap = page.waitForResponse(
    (response) => response.url() === fixture.origin + "/api/v1/me",
  );
  await page.locator("#kc-login").click();
  const bootstrapResponse = await bootstrap;
  evidence.profileBootstrap = {
    status: bootstrapResponse.status(),
    csrfCookies: (await bootstrapResponse.headersArray())
      .filter(
        (header) =>
          header.name.toLowerCase() === "set-cookie" &&
          header.value.startsWith("__Host-helm_csrf="),
      )
      .map((header) => ({
        empty: header.value.startsWith("__Host-helm_csrf=;"),
        attributes: header.value.split(";").slice(1),
      })),
  };
  if (bootstrapResponse.status() !== 200) {
    const cookie = (await context.cookies())
      .map((value) => value.name + "=" + value.value)
      .join("; ");
    const forward = await fetch("http://oauth2-proxy:4180/oauth2/auth", {
      headers: { Cookie: cookie },
    });
    const token = forward.headers.get("x-auth-request-access-token");
    const claims = token
      ? JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
      : {};
    const internal = token
      ? await fetch("http://api:8080/api/v1/me", {
          headers: { Authorization: "Bearer " + token },
        })
      : null;
    const internalBody = internal
      ? await internal.json().catch(() => null)
      : null;
    await writeFile(
      "/evidence/bootstrap-failure.json",
      JSON.stringify(
        {
          status: bootstrapResponse.status(),
          forwardStatus: forward.status,
          audience: claims.aud,
          client: claims.azp,
          issuer: claims.iss,
          hasAuthTime: typeof claims.auth_time === "number",
          hasSession: typeof claims.sid === "string",
          internalStatus: internal?.status,
          internalCode: internalBody?.code,
        },
        null,
        2,
      ),
    );
    throw new Error("Authenticated profile bootstrap was rejected");
  }
  await page.waitForURL(fixture.origin + "/tasks?sort=updated", { timeout: 30000 });
  await page.getByRole("heading", { name: "Задачи", exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".sidebar")
      .evaluate((element) => getComputedStyle(element).width),
    "230px",
    "External production styles must load under the canonical Content Security Policy",
  );
  const me = await bootstrapResponse.json();
  for (let attempt = 0; !websocketReady && attempt < 50; attempt++)
    await delay(100);
  const cookies = await context.cookies();
  evidence.cookieObservation = {
    browserTime: await page.evaluate(() => Date.now()),
    runnerTime: Date.now(),
    bootstrapRequest: await page.evaluate(() => window.helmBootstrapRequest),
    cookieMetadata: cookies.map(
      ({ name, domain, path, expires, secure, httpOnly, sameSite }) => ({
        name,
        domain,
        path,
        expires,
        secure,
        httpOnly,
        sameSite,
      }),
    ),
  };
  const csrfCookie = cookies.find(
    (cookie) => cookie.name === "__Host-helm_csrf",
  );
  if (!csrfCookie) {
    const target = await protocol.send("Target.getTargetInfo");
    const storage = await protocol.send("Storage.getCookies", {
      browserContextId: target.targetInfo.browserContextId,
    });
    evidence.cookieStorageDiagnostic = {
      storage: storage.cookies.map(
        ({ name, domain, path, secure, httpOnly, session }) => ({
          name,
          domain,
          path,
          secure,
          httpOnly,
          session,
        }),
      ),
      documentNames: await page.evaluate(() =>
        document.cookie
          .split(";")
          .map((cookie) => cookie.split("=")[0].trim())
          .filter(Boolean),
      ),
    };
    const repeated = await page.evaluate(async () => {
      const response = await fetch("/api/v1/me", {
        credentials: "same-origin",
      });
      await response.arrayBuffer();
      return {
        status: response.status,
        names: document.cookie
          .split(";")
          .map((cookie) => cookie.split("=")[0].trim())
          .filter(Boolean),
      };
    });
    evidence.cookieStorageDiagnostic.repeatedRead = repeated;
    evidence.cookieStorageDiagnostic.afterRead = (await context.cookies()).map(
      ({ name, domain, path, secure, httpOnly }) => ({
        name,
        domain,
        path,
        secure,
        httpOnly,
      }),
    );
  }
  assert.ok(
    csrfCookie?.secure && !csrfCookie.httpOnly && csrfCookie.path === "/",
    "Profile bootstrap supplies the readable session-bound CSRF token",
  );
  const ticket = cookies.find(
    (cookie) => cookie.name === "__Host-helm_session",
  );
  assert.ok(ticket?.secure && ticket?.httpOnly && ticket?.path === "/");
  assert.ok(
    ticket.value.length < 4000,
    "Only the bounded session ticket belongs in the browser",
  );
  assert.ok(
    !cookies.some((cookie) => /access_token|refresh_token/i.test(cookie.name)),
  );
  sessionKeys[username] = redisSessionKey(ticket.value);
  const authorization = await fetch("http://oauth2-proxy:4180/oauth2/auth", {
    headers: {
      Cookie: cookies
        .map((cookie) => cookie.name + "=" + cookie.value)
        .join("; "),
    },
  });
  assert.equal(authorization.status, 202);
  const token = authorization.headers.get("x-auth-request-access-token");
  assert.ok(
    token,
    "The protected proxy session retains its access token server-side",
  );
  const authTime = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString(),
  ).auth_time;
  assert.equal(typeof authTime, "number");
  evidence.accounts.push({
    username,
    id: me.id,
    permissions: me.permissions,
    ticketCookie: true,
    websocketReady,
    authTime,
  });
  await page.screenshot({
    path: `/evidence/${username}-tasks.png`,
    fullPage: true,
  });
  return { context, page, me, authTime };
}

try {
  const admin = await signIn("admin");
  let regular = await signIn("angelina");
  assert.equal(
    await regular.page.evaluate(async () => {
      const response = await fetch("/api/v1/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ goal: "Rejected without CSRF" }),
      });
      return response.status;
    }),
    403,
    "Authenticated writes without the CSRF token must be rejected",
  );
  evidence.csrfRejection = "PASS";
  const adminOverview = await read(admin, "/api/v1/admin/overview");
  assert.equal(adminOverview.status, 200, "Administrator API access");
  assert.equal(
    (await read(regular, "/api/v1/admin/overview")).status,
    403,
    "Regular account must not access administrator data",
  );
  for (const [username, account] of [
    ["admin", admin],
    ["angelina", regular],
  ]) {
    await account.page
      .getByRole("link", { name: "Новая задача", exact: true })
      .click();
    await account.page
      .getByLabel("Что нужно сделать")
      .fill(`Acceptance ${username}`);
    const created = account.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() === fixture.origin + "/api/v1/tasks",
    );
    await account.page
      .getByRole("button", { name: "Сохранить как черновик", exact: true })
      .click();
    const createResponse = await created;
    const createHeaders = await createResponse.request().allHeaders();
    const currentCsrf = (await account.context.cookies()).find(
      (cookie) => cookie.name === "__Host-helm_csrf",
    );
    evidence.mutations.push({
      username,
      status: createResponse.status(),
      origin: createHeaders.origin,
      fetchSite: createHeaders["sec-fetch-site"],
      hasCsrfHeader: Boolean(createHeaders["x-xsrf-token"]),
      csrfMatchesCookie: Boolean(
        currentCsrf && createHeaders["x-xsrf-token"] === currentCsrf.value,
      ),
      hasBody: Boolean(createResponse.request().postData()),
      browserContext: await account.page.evaluate(() => ({
        href: location.href,
        csrfCookieVisible: document.cookie
          .split(";")
          .some((cookie) => cookie.trim().startsWith("__Host-helm_csrf=")),
      })),
      code: (await createResponse.json().catch(() => null))?.code,
    });
    assert.ok(
      createResponse.ok(),
      "UI task creation succeeds with the session CSRF token",
    );
    await account.page.waitForURL(/\/tasks\/[0-9a-f-]+$/);
    const taskPath = new URL(account.page.url()).pathname;
    const task = await read(account, "/api/v1" + taskPath);
    assert.equal(task.status, 200, username + " owns created task");
    const other = username === "admin" ? regular : admin;
    assert.equal(
      (await read(other, "/api/v1" + taskPath)).status,
      404,
      "A role must not bypass task ownership",
    );
    evidence.accounts.find((item) => item.username === username).taskPath =
      taskPath;
  }
  await verifyCabinet(regular, fixture, evidence);
  await verifyAdminReads(admin, regular, fixture, evidence);
  await verifyMcpWorker(regular, fixture, evidence);
  await admin.page.goto(fixture.origin + "/admin/users/" + regular.me.id);
  await admin.page
    .getByRole("button", { name: "Заблокировать", exact: true })
    .click();
  await admin.page
    .getByRole("dialog")
    .getByLabel("Причина")
    .fill("Isolated browser acceptance");
  await admin.page
    .getByRole("dialog")
    .getByRole("button", { name: "Подтвердить", exact: true })
    .click();
  await admin.page
    .getByRole("button", { name: "Разблокировать", exact: true })
    .waitFor();
  const blockedLogin = await read(regular, "/api/v1/me");
  assert.equal(
    blockedLogin.status,
    403,
    "Blocked account access must end immediately",
  );
  evidence.blockedAccount = "PASS";
  await admin.page
    .getByRole("button", { name: "Разблокировать", exact: true })
    .click();
  await admin.page
    .getByRole("dialog")
    .getByLabel("Причина")
    .fill("Finish isolated browser acceptance");
  const unblockResponse = admin.page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/admin/users/${regular.me.id}/unblock`)
      && response.request().method() === "POST",
  );
  await admin.page
    .getByRole("dialog")
    .getByRole("button", { name: "Подтвердить", exact: true })
    .click();
  const unblock = await (await unblockResponse).json();
  let unblockState;
  const unblockDeadline = Date.now() + 30_000;
  do {
    const operation = await read(admin, `/api/v1/admin/operations/${unblock.operationId}`);
    assert.equal(operation.status, 200);
    unblockState = operation.body.state;
    if (unblockState === "SUCCEEDED") break;
    assert.ok(["PENDING", "RUNNING"].includes(unblockState), "Unblock must remain recoverable");
    await delay(250);
  } while (Date.now() < unblockDeadline);
  assert.equal(unblockState, "SUCCEEDED", "Unblock includes the provider identity update");
  await admin.page
    .getByRole("button", { name: "Заблокировать", exact: true })
    .waitFor();
  const revokedLogin = await read(regular, "/api/v1/me");
  assert.equal(
    revokedLogin.status,
    401,
    "Unblocking must not revive a revoked application login",
  );
  // OIDC auth_time is second-granular; a same-second authentication cannot prove
  // it happened after the precise account reauthentication barrier.
  assert.ok(
    revokedLogin.serverDate,
    "The gateway supplies a server clock boundary",
  );
  await delay(
    Math.max(0, Date.parse(revokedLogin.serverDate) + 1000 - Date.now()) + 25,
  );
  evidence.reauthenticationBoundary =
    "Password entered after the next server-clock second";
  const previousAuthTime = regular.authTime;
  await regular.context.close();
  regular = await signIn("angelina");
  assert.ok(
    regular.authTime > previousAuthTime,
    "Fresh password authentication advances auth_time",
  );
  await regular.page.getByRole("button", { name: "Меню профиля" }).click();
  await regular.page
    .getByRole("button", { name: "Выйти", exact: true })
    .click();
  await regular.page.locator("#password").waitFor();
  assert.equal(await regular.page.locator(".auth-story").count(), 1);
  assert.equal(await regular.page.locator("#username").inputValue(), "", "Logout forgets the previous account");
  assert.ok(
    !(await regular.context.cookies()).some(
      (cookie) => cookie.name === "__Host-helm_session",
    ),
  );
  assert.equal((await read(regular, "/api/v1/me")).status, 401);
  // Reuse the same browser, including the old provider cookies. Logout must not
  // silently sign the user back in or let a revoked sid break a fresh login.
  await regular.page.locator("#username").fill("angelina");
  await regular.page.locator("#password").fill(fixture.angelina.password);
  await regular.page.locator("#kc-login").click();
  await regular.page.waitForURL(fixture.origin + "/tasks");
  assert.equal((await read(regular, "/api/v1/me")).status, 200);
  const renewedTicket = (await regular.context.cookies()).find((cookie) => cookie.name === "__Host-helm_session");
  assert.ok(renewedTicket);
  sessionKeys.angelina = redisSessionKey(renewedTicket.value);
  await regular.page.reload();
  await regular.page.getByRole("button", { name: "Меню профиля" }).click();
  await regular.page.getByRole("button", { name: "Выйти", exact: true }).click();
  await regular.page.locator("#password").waitFor();
  assert.equal((await read(regular, "/api/v1/me")).status, 401);
  evidence.sameBrowserRelogin = "PASS";
  evidence.logout = "PASS";
  assert.ok(
    evidence.accounts.every((account) => account.websocketReady),
    "Every login establishes the authenticated realtime WebSocket",
  );
  await writeFile(
    "/verification/session-keys.json",
    JSON.stringify(sessionKeys),
    { mode: 0o600 },
  );
  assert.deepEqual(evidence.errors, [], "No Angular browser errors");
  await writeFile(
    "/evidence/browser-result.json",
    JSON.stringify({ ...evidence, status: "PASS" }, null, 2),
  );
  process.stdout.write(
    "PASS: real browser login, account roles, own task creation/read, cross-owner denial and logout.\n",
  );
} catch (error) {
  for (const [index, context] of browser.contexts().entries()) {
    const page = context.pages()[0];
    if (page) {
      await page
        .screenshot({ path: `/evidence/failure-${index}.png`, fullPage: true })
        .catch(() => {});
      await writeFile(
        `/evidence/failure-${index}.txt`,
        await page
          .locator("body")
          .innerText()
          .catch(() => "Page unavailable"),
      );
    }
  }
  await writeFile(
    "/evidence/browser-result.json",
    JSON.stringify(
      { ...evidence, status: "FAILED", error: error.message },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
