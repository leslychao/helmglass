import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { observeMedia, verifyMediaAndControl } from "./media.mjs";
import { verifyWidgetResource } from "./widget-resource.mjs";
import { verifyPrivateLogin } from "./private-login.mjs";
import { verifyTaskUsage } from "./cabinet.mjs";

const require = createRequire("/app/package.json");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

async function authorize(context, origin) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomUUID();
  const redirect = origin + "/mcp-test/callback";
  const endpoint = origin + "/auth/realms/helm/protocol/openid-connect/";
  const url = new URL(endpoint + "auth");
  url.search = new URLSearchParams({
    client_id: "helm-mcp",
    redirect_uri: redirect,
    response_type: "code",
    scope:
      "openid tasks:read tasks:write browser:view browser:execute results:write",
    state,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  const page = await context.newPage();
  try {
    await page.goto(url.href);
    await page.waitForURL(
      (value) => value.origin + value.pathname === redirect,
    );
    const callback = new URL(page.url());
    assert.equal(
      callback.searchParams.get("state"),
      state,
      "OAuth state binding",
    );
    const code = callback.searchParams.get("code");
    assert.ok(
      code,
      "Authorization code is issued through the actual browser session",
    );
    const response = await fetch(endpoint + "token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "helm-mcp",
        redirect_uri: redirect,
        code,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, "PKCE code exchange");
    const tokens = await response.json();
    assert.equal(
      typeof tokens.access_token,
      "string",
      "MCP access token is issued",
    );
    return tokens.access_token;
  } finally {
    await page.close();
  }
}

/** Real MCP transport and native command; no direct automation of the worker's Page. */
export async function verifyMcpWorker(account, fixture, evidence) {
  if (!fixture.workerAcceptance) return;
  const token = await authorize(account.context, fixture.origin);
  const client = new Client({
    name: "helm-isolated-acceptance",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(fixture.origin + "/mcp"),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
  let taskId;
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 30_000,
    });
    if (result.isError) {
      const codes = result.content
        .filter((item) => item.type === "text")
        .map((item) => {
          try {
            return JSON.parse(item.text).code;
          } catch {
            return "MCP_TOOL_REJECTED";
          }
        });
      throw new Error(
        `${name}: ${codes.filter((code) => /^[A-Z][A-Z0-9_]+$/.test(code)).join(",")}`,
      );
    }
    assert.ok(
      result.structuredContent && typeof result.structuredContent === "object",
      name + " returns the canonical structured response",
    );
    return result.structuredContent;
  }
  try {
    await client.connect(transport);
    await verifyWidgetResource(account, fixture, client, evidence);
    const created = await call("tasks.create", {
      idempotencyKey: randomUUID(),
      goal: "Read IANA's reserved domains reference in the isolated acceptance run",
      startUrl: "https://www.iana.org/domains/reserved",
      connectionIds: [],
      outputFormat: "TEXT",
      browserTimeLimitSeconds: 1800,
      confirmImportantActions: false,
      intent: "PREPARE",
    });
    taskId = created.resource.id;
    let task = await call("tasks.get", { taskId });
    assert.equal(task.state, "WAITING_AGENT");
    const commandId = randomUUID();
    await call("browser.execute", {
      taskId,
      commandId,
      idempotencyKey: randomUUID(),
      expectedTaskVersion: task.version,
      instructionRevision: task.instructionRevision,
      action: {
        type: "NAVIGATE",
        url: "https://www.iana.org/domains/reserved",
      },
    });
    const deadline = Date.now() + 90_000;
    let command;
    do {
      command = await call("commands.get", { taskId, commandId });
      if (["SUCCEEDED", "FAILED", "UNKNOWN"].includes(command.state)) break;
      await delay(500);
    } while (Date.now() < deadline);
    evidence.nativeCommandReceipt = {
      state: command.state,
      effectState: command.effectState,
      failureCode: command.failureCode,
      resultStatus: command.result?.status,
      resultCode: command.result?.code,
      resultErrorCode: command.result?.error?.code,
    };
    assert.equal(
      command.state,
      "SUCCEEDED",
      "Native navigation command reaches a durable successful receipt",
    );
    assert.equal(command.effectState, "CONFIRMED");
    const observation = command.result?.observation;
    assert.equal(
      observation?.title,
      "IANA-managed Reserved Domains",
      "Title comes from the actual worker observation",
    );
    assert.equal(observation?.snapshotFormat, "playwright-aria-json-1.64");
    assert.ok(
      Array.isArray(observation.snapshot) && observation.snapshot.length > 0,
    );
    task = await call("tasks.get", { taskId });
    assert.ok(task.currentSession?.id, "The task owns a live browser session");
    await observeMedia(account.page, evidence);
    await account.page.goto(fixture.origin + "/tasks/" + taskId);
    await account.page.getByRole("heading", { level: 1 }).waitFor();
    await account.page.screenshot({
      path: "/evidence/native-task.png",
      fullPage: true,
    });
    evidence.nativeMcpCommand = {
      status: "PASS",
      taskId,
      commandId,
      state: command.state,
      effectState: command.effectState,
      title: observation.title,
      snapshotFormat: observation.snapshotFormat,
    };
    await verifyTaskUsage(account, "/tasks/" + taskId, evidence);
    await verifyMediaAndControl(account.page, evidence);
    await verifyPrivateLogin(account, fixture, taskId, call, client, evidence);
    await call("tasks.stop", { taskId, idempotencyKey: randomUUID() });
  } finally {
    await client.close();
  }
}
