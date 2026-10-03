import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

async function read(page, path) {
  const response = await page.request.get(path);
  assert.equal(response.status(), 200, `Read ${new URL(path).pathname}`);
  return response.json();
}

/** Real private-mode boundary with explicit USER_ASSERTED evidence on a public test page. */
export async function verifyPrivateLogin(
  account,
  fixture,
  taskId,
  call,
  client,
  evidence,
) {
  const page = account.page;
  const original = await call("tasks.get", { taskId });
  const sessionId = original.currentSession.id;
  await page.goto(fixture.origin + "/connections");
  await page
    .getByRole("button", { name: "Добавить подключение", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Название", { exact: true })
    .fill("Private boundary fixture");
  await dialog
    .getByLabel("Адрес сайта", { exact: true })
    .fill("https://www.iana.org");
  await dialog
    .getByRole("button", { name: "Добавить подключение", exact: true })
    .click();
  await page.waitForURL(/\/connections\/[0-9a-f-]{36}$/);
  const connectionId = new URL(page.url()).pathname.split("/").at(-1);
  let task = await call("tasks.get", { taskId });
  await call("connections.resolve", {
    taskId,
    url: "https://www.iana.org/domains/reserved",
    loginRequired: true,
    expectedTaskVersion: task.version,
    instructionRevision: task.instructionRevision,
    idempotencyKey: randomUUID(),
  });
  task = await call("tasks.get", { taskId });
  assert.equal(task.activeRequest?.kind, "LOGIN");
  assert.equal(task.activeRequest.connectionId, connectionId);
  await page.goto(fixture.origin + "/tasks/" + taskId);
  await page
    .getByRole("button", { name: "Войти на сайт", exact: true })
    .click();
  await page.waitForURL(/\/login-operations\/[0-9a-f-]{36}$/);
  const loginPath = "/api/v1" + new URL(page.url()).pathname;
  await page
    .getByText("Живой просмотр", { exact: true })
    .waitFor({ timeout: 40_000 });
  const login = await read(page, fixture.origin + loginPath);
  assert.equal(
    login.sessionId,
    sessionId,
    "Private login retains the same live browser",
  );
  assert.equal(login.taskId, taskId);
  assert.equal(login.state, "WAITING_USER");
  const privateTask = await call("tasks.get", { taskId });
  const denied = await client.callTool({
    name: "browser.execute",
    arguments: {
      taskId,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      expectedTaskVersion: privateTask.version,
      instructionRevision: privateTask.instructionRevision,
      action: { type: "OBSERVE" },
    },
  });
  assert.equal(
    denied.isError,
    true,
    "MCP observation is denied during private login",
  );
  const codes = denied.content
    .filter((item) => item.type === "text")
    .map((item) => {
      try {
        return JSON.parse(item.text).code;
      } catch {
        return null;
      }
    });
  assert.ok(
    codes.includes("TASK_NOT_READY"),
    "Private task rejects command admission",
  );
  await page
    .getByLabel("Название аккаунта", { exact: true })
    .fill("Isolated fixture assertion");
  await page
    .getByLabel("Использовать только в этой сессии", { exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: /Я вошёл в нужный аккаунт/ })
    .check();
  await page
    .getByRole("button", { name: "Я вошёл, завершить вход", exact: true })
    .click();
  let completed;
  const deadline = Date.now() + 60_000;
  do {
    completed = await read(page, fixture.origin + loginPath);
    evidence.privateLogin = {
      state: completed.state,
      verification: completed.verification,
      sameSession: completed.sessionId === sessionId,
      taskId,
      sessionId,
    };
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(completed.state)) break;
    await delay(300);
  } while (Date.now() < deadline);
  assert.equal(completed.state, "SUCCEEDED");
  assert.equal(completed.verification, "USER_ASSERTED");
  await page
    .getByRole("link", { name: "Вернуться к задаче", exact: true })
    .click();
  await page.waitForURL(fixture.origin + "/tasks/" + taskId);
  await page
    .getByText("Живой просмотр", { exact: true })
    .waitFor({ timeout: 40_000 });
  task = await call("tasks.get", { taskId });
  assert.equal(task.currentSession.id, sessionId);
  assert.equal(task.currentSession.privacy, "NORMAL");
  const connection = await read(
    page,
    fixture.origin + "/api/v1/connections/" + connectionId,
  );
  assert.equal(
    connection.lastSuccessfulLoginAt,
    null,
    "User assertion is not verified authentication",
  );
  evidence.privateLogin = {
    ...evidence.privateLogin,
    status: "PASS",
    publicViewRestored: true,
    mcpObservationDenied: true,
    savedProfileCreated: false,
    scope:
      "Private boundary and USER_ASSERTED handback; no external account authentication",
  };
  await page.screenshot({
    path: "/evidence/private-handback.png",
    fullPage: true,
  });
}
