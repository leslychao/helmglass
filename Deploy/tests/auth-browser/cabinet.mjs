import assert from "node:assert/strict";

/** Render the real read contracts through Angular after authenticated task creation. */
export async function verifyCabinet(account, fixture, evidence) {
  const routes = [
    { path: "/connections", api: "/connections", heading: "Подключения" },
    { path: "/usage", api: "/usage", heading: "Использование" },
    { path: "/profile", api: "/me/policy", heading: "Профиль" },
  ];
  evidence.cabinetRoutes = [];
  for (const route of routes) {
    const response = account.page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === "/api/v1" + route.api &&
        value.request().method() === "GET",
    );
    await account.page.goto(fixture.origin + route.path);
    const actual = await response;
    assert.equal(actual.status(), 200, route.api + " read contract");
    await account.page
      .getByRole("heading", { name: route.heading, level: 1 })
      .waitFor({ state: "attached" });
    if (route.path === "/connections") {
      const connections = await actual.json();
      if (!connections.items.length) {
        await account.page
          .getByRole("heading", { name: "Добавьте первое подключение" })
          .waitFor();
      } else {
        for (const connection of connections.items) {
          await account.page
            .getByRole("link", {
              name: connection.displayName,
              exact: true,
            })
            .waitFor();
        }
      }
    } else if (route.path === "/profile") {
      const policy = await actual.json();
      assert.ok(
        policy.quotas,
        "Canonical policy includes assigned and effective quotas",
      );
      await account.page
        .getByLabel("Доступ к сайтам", { exact: true })
        .waitFor();
      assert.equal(
        await account.page
          .getByLabel("Одновременные браузеры", { exact: true })
          .inputValue(),
        policy.maxBrowserSessions === null
          ? ""
          : String(policy.maxBrowserSessions),
      );
    } else {
      const usage = await actual.json();
      if (usage.taskCount === 0) {
        await account.page
          .getByRole("heading", {
            name: "За выбранный период нет данных",
            exact: true,
          })
          .waitFor();
      } else {
        await account.page.locator("hg-usage hg-metric").first().waitFor();
      }
    }
    assert.equal(
      await account.page.getByRole("alert").count(),
      0,
      route.path + " renders without API error",
    );
    await account.page.screenshot({
      path: "/evidence/cabinet-" + route.path.slice(1) + ".png",
      fullPage: true,
    });
    evidence.cabinetRoutes.push({ path: route.path, status: "PASS" });
  }
}

export async function verifyAdminReads(admin, regular, fixture, evidence) {
  const page = admin.page;
  await page.goto(fixture.origin + "/admin");
  await page
    .getByRole("heading", { name: "Нагрузка по пользователям", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: regular.me.displayName, exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("alert").count(),
    0,
    "Administrator overview renders canonical user quota rows",
  );
  await page.screenshot({
    path: "/evidence/admin-overview.png",
    fullPage: true,
  });

  const calendarResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      "/api/v1/admin/users/" + regular.me.id + "/usage",
  );
  await page.goto(fixture.origin + "/admin/users/" + regular.me.id);
  const calendar = await calendarResponse;
  assert.equal(calendar.status(), 200, "Calendar usage owner responds");
  const body = await calendar.json();
  assert.equal(body.scope, "USER_CALENDAR");
  assert.equal(body.daily.length, 7);
  await page
    .getByRole("heading", { name: "Квоты и текущая нагрузка", exact: true })
    .waitFor();
  await page.getByText("Показать измерения по дням", { exact: true }).click();
  await page.locator("hg-admin-usage tbody tr").nth(6).waitFor();
  assert.equal(
    await page.getByRole("alert").count(),
    0,
    "Administrator user view renders quotas and seven calendar days",
  );
  await page.screenshot({ path: "/evidence/admin-user.png", fullPage: true });
  evidence.adminReadRoutes = {
    overview: "PASS",
    userQuota: "PASS",
    calendarDays: 7,
  };
}

export async function verifyTaskUsage(account, taskPath, evidence) {
  const page = account.page;
  const matchesUsage = (value) =>
    new URL(value.url()).pathname === "/api/v1" + taskPath + "/usage";
  const [result] = await Promise.all([
    page.waitForResponse(matchesUsage),
    page
      .getByRole("button", { name: "Подробнее об использовании", exact: true })
      .click(),
  ]);
  assert.equal(result.status(), 200, "Task usage read owner responds");
  const usage = await result.json();
  assert.equal(usage.taskId, taskPath.split("/").at(-1));
  const dialog = page.getByRole("dialog", {
    name: "Ресурсы задачи",
    exact: true,
  });
  if (usage.measurements.items.length === 0) {
    await dialog
      .getByRole("heading", { name: "Измерений пока нет", exact: true })
      .waitFor();
  } else {
    await dialog
      .locator("tbody tr")
      .nth(usage.measurements.items.length - 1)
      .waitFor();
  }
  const [unknownResponse] = await Promise.all([
    page.waitForResponse(matchesUsage),
    dialog
      .getByRole("button", { name: "Неподтверждённые интервалы", exact: true })
      .click(),
  ]);
  assert.equal(unknownResponse.status(), 200);
  const unknown = await unknownResponse.json();
  if (unknown.unknownIntervals.items.length === 0) {
    await dialog
      .getByRole("heading", {
        name: "Неподтверждённых интервалов нет",
        exact: true,
      })
      .waitFor();
  } else {
    await dialog
      .locator("tbody tr")
      .nth(unknown.unknownIntervals.items.length - 1)
      .waitFor();
  }
  assert.equal(
    await dialog.getByRole("alert").count(),
    0,
    "Both usage tables render their actual server data",
  );
  await page.screenshot({ path: "/evidence/task-usage.png", fullPage: true });
  await dialog
    .getByRole("button", { name: "Закрыть диалог", exact: true })
    .click();
  evidence.taskUsageRead = {
    status: "PASS",
    measurements: usage.measurements.total,
    unknownIntervals: unknown.unknownIntervals.total,
  };
}
