"""Automatic per-tool accounting through the deployed dev REST/MCP contracts."""

from concurrent.futures import ThreadPoolExecutor
import json
import unittest
import uuid

import test_usage_admin as usage


class AgentStepsTest(unittest.TestCase):
    setUpClass = classmethod(usage.UsageAdministrationTest.setUpClass.__func__)
    setUp = usage.UsageAdministrationTest.setUp
    tearDown = usage.UsageAdministrationTest.tearDown
    fixture_sql = usage.UsageAdministrationTest.fixture_sql
    purge_identity = usage.UsageAdministrationTest.purge_identity
    wait_operation = usage.UsageAdministrationTest.wait_operation

    def create(self, prepare=False):
        self.client.login_mcp()
        self.creation_request = {
            "stepTitle": "Создать задачу для проверки учёта вызовов агента",
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "Учёт вызовов агента", "goal": "Прочитать страницу два раза",
                "startUrl": "https://example.com", "prepare": prepare}}
        error, presentation, result = self.client.tool("tasks.create", self.creation_request)
        self.assertFalse(error, presentation)
        self.task = presentation["task"]
        self.widget = {"taskId": self.task["id"], "generation": presentation["generation"]}
        self.events_url = result["_meta"]["eventsUrl"]
        return self.task

    def listing(self, **query):
        status, page = self.client.api("/api/tasks/" + self.task["id"] + "/steps?" +
                                      usage.urlencode(query))
        self.assertEqual(200, status, page)
        return page

    def current(self):
        status, task = self.client.api("/api/tasks/" + self.task["id"])
        self.assertEqual(200, status, task)
        return task

    def test_each_actual_tool_call_is_a_step_and_widget_reads_are_free(self):
        self.create()
        baseline = self.listing()["total"]
        version = self.current()["version"]
        calls = []
        for _ in range(2):
            request = {"taskId": self.task["id"], "callId": str(uuid.uuid4())}
            calls.append(request)
            error, result, _ = self.client.tool("tasks.get", request)
            self.assertFalse(error, result)
        page = self.listing()
        self.assertEqual(baseline + 2, page["total"])
        self.assertEqual(version, self.current()["version"])
        for call in calls:
            step = next(item for item in page["items"] if item["id"] == call["callId"])
            self.assertEqual(("tasks.get", "SUCCEEDED"), (step["tool"], step["status"]))
            self.assertGreaterEqual(step["durationMs"], 0)
            self.assertIsNotNone(step["completedAt"])
        for _ in range(2):
            for name in ("widget.steps", "widget.state"):
                self.assertFalse(self.client.tool(name, self.widget)[0])
        self.assertEqual(page, self.listing())

    def test_replay_reconnect_concurrency_and_conflicting_call_id(self):
        self.create()
        request = {"taskId": self.task["id"], "callId": str(uuid.uuid4())}
        self.assertFalse(self.client.tool("tasks.get", request)[0])
        first = self.listing()
        self.client.close_mcp()
        self.client.rpc("tools/list", {})
        with ThreadPoolExecutor(max_workers=2) as executor:
            replies = list(executor.map(lambda _: self.client.tool("tasks.get", request), range(2)))
        self.assertTrue(all(not item[0] for item in replies), replies)
        self.assertEqual(first, self.listing())
        error, refusal, _ = self.client.tool("tasks.get", {
            **request, "stepTitle": "Проверить другое условие выполнения задания"})
        self.assertTrue(error, refusal)
        self.assertEqual("IDEMPOTENCY_CONFLICT", refusal["code"])
        self.assertEqual(first, self.listing())
        error, refusal, _ = self.client.tool("steps.list", request)
        self.assertTrue(error, refusal)
        self.assertEqual("IDEMPOTENCY_CONFLICT", refusal["code"])
        self.assertEqual(first, self.listing())

    def test_browser_calls_link_operations_and_batch_is_one_invocation(self):
        self.create(prepare=True)
        self.client.browser_observation(self.task["id"])
        baseline = self.listing()["total"]
        task = self.current()
        request = {"taskId": task["id"], "callId": str(uuid.uuid4()),
                   "stepTitle": "Прочитать инструкцию и проверить доступные элементы задания",
                   "actions": [
            {"operationId": str(uuid.uuid4()), "type": "observe", "arguments": {},
             "instructionRevision": task["instructionRevision"],
             "controlEpoch": task["browser"]["controlEpoch"]} for _ in range(2)]}
        error, receipt, _ = self.client.tool("browser.execute", request)
        self.assertFalse(error, receipt)
        self.assertTrue(receipt["complete"], receipt)
        self.assertEqual(2, len(receipt["operations"]))
        self.assertEqual({request["callId"]}, {item["stepId"] for item in receipt["operations"]})
        page = self.listing()
        self.assertEqual(baseline + 1, page["total"])
        step = next(item for item in page["items"] if item["id"] == request["callId"])
        self.assertEqual("browser.execute", step["tool"])
        self.assertEqual(request["stepTitle"], step["title"])
        self.assertFalse(self.client.tool("browser.execute", request)[0])
        self.assertEqual(page, self.listing())

    def test_rejected_calls_are_recorded_without_private_arguments(self):
        self.create()
        task = self.current()
        request = {"taskId": task["id"], "callId": str(uuid.uuid4()), "action": {
            "operationId": str(uuid.uuid4()), "type": "fill", "arguments": {
                "text": "synthetic-private-value"}, "instructionRevision": task["instructionRevision"]}}
        baseline = self.listing()["total"]
        self.assertTrue(self.client.tool("browser.execute", request)[0])
        page = self.listing()
        self.assertEqual(baseline + 1, page["total"])
        step = next(item for item in page["items"] if item["id"] == request["callId"])
        self.assertEqual("FAILED", step["status"])
        self.assertNotIn("synthetic-private-value", str(page))
        self.assertEqual("0", self.fixture_sql(self.identity,
            "SELECT count(*) FROM operations WHERE owner_id=:owner AND id='" +
            request["action"]["operationId"] + "';"))

    def test_pagination_shared_views_and_foreign_access(self):
        self.create()
        baseline = self.listing()["total"]
        for _ in range(12):
            self.assertFalse(self.client.tool("tasks.get", {"taskId": self.task["id"]})[0])
        first = self.listing()
        self.assertEqual(baseline + 12, first["total"])
        self.assertEqual(10, len(first["items"]))
        before = first["items"][0]["sequence"]
        older = self.listing(page=2, beforeSequence=before)
        self.assertFalse(self.client.tool("tasks.get", {"taskId": self.task["id"]})[0])
        self.assertEqual(older, self.listing(page=2, beforeSequence=before))
        error, widget, _ = self.client.tool("widget.steps", self.widget)
        self.assertFalse(error, widget)
        self.assertEqual(self.listing(), widget)
        status, _ = self.admin.api("/api/tasks/" + self.task["id"] + "/steps")
        self.assertEqual(404, status)
        schema = self.client.rpc("tools/list", {})["tools"]
        self.assertNotIn("steps.command", {item["name"] for item in schema})
        browser = next(item for item in schema if item["name"] == "browser.execute")
        self.assertIn("callId", browser["inputSchema"]["required"])
        self.assertIn("stepTitle", browser["inputSchema"]["required"])

    def test_business_titles_are_shared_searchable_and_creation_replay_is_checked(self):
        self.create()
        creation = next(item for item in self.listing()["items"]
                        if item["id"] == self.creation_request["callId"])
        self.assertEqual(self.creation_request["stepTitle"], creation["title"])
        request = {"taskId": self.task["id"], "stepTitle": "Проверить готовность записи к анализу"}
        self.assertFalse(self.client.tool("tasks.get", request)[0])
        page = self.listing(search="готовность записи")
        self.assertEqual(1, page["total"])
        self.assertEqual(request["stepTitle"], page["items"][0]["title"])
        error, widget, _ = self.client.tool("widget.steps", {
            **self.widget, "search": "готовность записи"})
        self.assertFalse(error, widget)
        self.assertEqual(page, widget)
        before = self.listing()
        self.assertFalse(self.client.tool("tasks.create", self.creation_request)[0])
        error, refusal, _ = self.client.tool("tasks.create", {
            **self.creation_request, "stepTitle": "Создать другое задание"})
        self.assertTrue(error, refusal)
        self.assertEqual("IDEMPOTENCY_CONFLICT", refusal["code"])
        self.assertEqual(before, self.listing())

    def test_invalid_title_is_rejected_before_task_commands_or_step_registration(self):
        self.create()
        before, task = self.listing(), self.current()
        for title in (None, "", "  ", 5, "x" * 301, "Строка\nСтрока", "Строка\rСтрока",
                      "Строка\u2028Строка", "Строка\u2029Строка"):
            with self.subTest(title=title):
                arguments = {"taskId": self.task["id"], "callId": str(uuid.uuid4()),
                             "stepTitle": title, "command": {"type": "RESUME",
                             "expectedVersion": task["version"]}, "operationKey": str(uuid.uuid4())}
                result = self.client.rpc("tools/call", {
                    "name": "tasks.command", "arguments": arguments})
                self.assertTrue(result.get("isError"), result)
                self.assertIn("stepTitle", str(result))
        arguments.pop("stepTitle")
        result = self.client.rpc("tools/call", {"name": "tasks.command", "arguments": arguments})
        self.assertTrue(result.get("isError"), result)
        self.assertIn("stepTitle", str(result))
        self.assertEqual(before, self.listing())
        self.assertEqual(task, self.current())

    def test_connection_context_shared_reads_updates_and_foreign_access(self):
        self.create(prepare=True)
        self.client.browser_observation(self.task["id"])
        task = self.current()
        self.assertIsNone(task["browser"]["connectionInfo"])
        status, connection = self.client.api("/api/connections", "POST", {
            "name": "Подключение к тестовому заданию", "site": "example.com",
            "startUrl": "https://example.com"})
        self.assertEqual(200, status, connection)
        self.fixture_sql(self.identity, "UPDATE connections SET account_label='Тестовый аккаунт'"
            " WHERE id='" + connection["id"] + "'; UPDATE browser_sessions SET connection_id='"
            + connection["id"] + "' WHERE id='" + task["browser"]["id"] + "';")
        expected = {"name": connection["name"], "site": "example.com",
                    "accountLabel": "Тестовый аккаунт", "version": connection["version"]}
        self.assertEqual(expected, self.current()["browser"]["connectionInfo"])
        error, widget, _ = self.client.tool("widget.state", self.widget)
        self.assertFalse(error, widget)
        self.assertEqual(expected, widget["task"]["browser"]["connectionInfo"])
        status, detail = self.client.api("/api/connections/" + connection["id"])
        self.assertEqual(200, status, detail)
        self.assertEqual(expected, detail["browser"]["connectionInfo"])
        status, browser = self.client.api("/api/browser-sessions/" + task["browser"]["id"]
                                         + "/keep-open", "POST", {})
        self.assertEqual(200, status, browser)
        self.assertEqual(expected, browser["connectionInfo"])
        def event(stream):
            for _ in range(100):
                line = stream.readline()
                if not line:
                    self.fail("The connection event stream ended unexpectedly")
                if line.startswith(b"data:"):
                    return json.loads(line[5:])
            self.fail("The connection event stream did not deliver metadata")

        with (
            self.client.http.open(self.client.base + "/api/events", timeout=10) as cabinet_stream,
            self.client.http.open(self.events_url, timeout=10) as widget_stream,
        ):
            self.assertEqual("sync", event(cabinet_stream)["resource"])
            self.assertEqual("sync", event(widget_stream)["resource"])
            status, unrelated = self.client.api("/api/connections", "POST", {
                "name": "Unrelated connection", "site": "iana.org",
                "startUrl": "https://www.iana.org"})
            self.assertEqual(200, status, unrelated)
            status, renamed = self.client.api("/api/connections/" + connection["id"], "PATCH", {
                "name": "Обновлённое подключение", "expectedVersion": connection["version"]})
            self.assertEqual(200, status, renamed)
            delivered = []
            for _ in range(20):
                change = event(cabinet_stream)
                if change["resource"] == "connection":
                    delivered.append(change)
                    if change["entityId"] == connection["id"]:
                        break
            self.assertEqual([unrelated["id"], connection["id"]],
                             [change["entityId"] for change in delivered])
            for _ in range(20):
                change = event(widget_stream)
                if change["resource"] == "connection":
                    self.assertEqual(connection["id"], change["entityId"])
                    self.assertEqual(renamed["version"], change["version"])
                    break
            else:
                self.fail("The widget did not receive its associated connection change")
        expected.update(name=renamed["name"], version=renamed["version"])
        self.assertEqual(expected, self.current()["browser"]["connectionInfo"])
        self.assertEqual(404, self.admin.api("/api/connections/" + connection["id"])[0])
        self.assertEqual(404, self.admin.api("/api/tasks/" + task["id"])[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
