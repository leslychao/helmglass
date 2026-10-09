"""Instruction changes and explicit continuation against disposable dev tasks."""

import time
import unittest
import uuid

import test_usage_admin as usage


class TaskContinuationTest(unittest.TestCase):
    setUpClass = classmethod(usage.UsageAdministrationTest.setUpClass.__func__)
    setUp = usage.UsageAdministrationTest.setUp
    tearDown = usage.UsageAdministrationTest.tearDown
    fixture_sql = usage.UsageAdministrationTest.fixture_sql
    purge_identity = usage.UsageAdministrationTest.purge_identity
    wait_operation = usage.UsageAdministrationTest.wait_operation
    command = usage.UsageAdministrationTest.command

    def test_stale_widget_read_is_typed_but_stale_commands_remain_denied(self):
        self.client.login_mcp()
        error, initial, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "Terminal stale widget contract", "goal": "No browser needed", "prepare": False}})
        self.assertFalse(error, initial)
        task_id = initial["task"]["id"]
        error, current, _ = self.client.tool("tasks.view", {
            "taskId": task_id, "operationKey": str(uuid.uuid4())})
        self.assertFalse(error, current)
        stale_input = {"taskId": task_id, "generation": initial["generation"]}
        error, stale, raw = self.client.tool("widget.state", stale_input)
        self.assertFalse(error, stale)
        self.assertEqual("STALE_WIDGET", stale["code"])
        self.assertEqual({"code", "message"}, stale.keys())
        self.assertEqual(stale, raw["structuredContent"])
        self.assertFalse(raw.get("_meta"), "A stale read must not expose a new stream token")
        for name, extra in (("widget.claim", {"continuationId": str(uuid.uuid4())}),
                            ("widget.continuation", {"continuationId": str(uuid.uuid4()), "sent": True}),
                            ("widget.browser", {"viewerId": str(uuid.uuid4())})):
            error, refusal, _ = self.client.tool(name, {**stale_input, **extra})
            self.assertTrue(error, name)
            self.assertEqual("STALE_WIDGET", refusal["code"])
        error, retained, _ = self.client.tool("widget.state", {
            "taskId": task_id, "generation": current["generation"]})
        self.assertFalse(error, retained)
        self.assertEqual(current, retained)

    def test_stop_invalidates_pending_continuation_and_late_host_ack(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "Cancelled continuation acceptance", "goal": "Stop after manual control",
                "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error, presentation)
        task = presentation["task"]
        widget = {"taskId": task["id"], "generation": presentation["generation"]}
        self.client.observe_task_browser(task["id"])
        self.client.return_control_without_continuing(task["id"])
        self.command(task, "RESUME")
        pending = self.client.tool("widget.state", widget)[1]
        attempt = {**widget, "continuationId": pending["continuationId"]}
        self.assertTrue(self.client.tool("widget.claim", attempt)[1]["claimed"])
        self.command(task, "STOP")
        self.assertEqual("IDLE", self.client.tool("widget.state", widget)[1]["continuationStatus"])
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if self.client.api("/api/tasks/" + task["id"])[1]["status"] == "STOPPED":
                break
            time.sleep(.2)
        error, reported, _ = self.client.tool("widget.continuation", {**attempt, "sent": True})
        self.assertFalse(error, reported)
        self.assertEqual("STOPPED", reported["task"]["status"])
        self.assertEqual("IDLE", reported["continuationStatus"])
        self.assertIsNone(reported["continuationRevision"])
        self.assertIsNone(reported["continuationId"])
        self.assertFalse(self.client.tool("widget.claim", attempt)[1]["claimed"])
        status, refusal = self.client.api("/api/tasks/" + task["id"] + "/commands", "POST", {
            "type": "RESUME", "expectedVersion": reported["task"]["version"], "confirmBrowserLoss": True})
        self.assertEqual((409, "ACTION_UNAVAILABLE"), (status, refusal["code"]))

    def test_continuation_revision_and_reply_are_not_replayed(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "Continuation revisions", "goal": "Observe only",
                "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error, presentation)
        task = presentation["task"]
        widget = {"taskId": task["id"], "generation": presentation["generation"]}
        self.client.observe_task_browser(task["id"])
        self.client.return_control_without_continuing(task["id"])
        amended = self.command(task, "AMEND", title=task["title"], goal="Paused revision",
                               startUrl="https://example.com")
        self.assertEqual("PAUSED", amended["status"])
        self.assertEqual("IDLE", self.client.tool("widget.state", widget)[1]["continuationStatus"])
        self.command(task, "RESUME")
        old = self.client.tool("widget.state", widget)[1]
        amended = self.command(task, "AMEND", title=task["title"], goal="Active revised continuation",
                               startUrl="https://example.com")
        self.assertEqual("ACCEPTED", self.client.tool("widget.state", widget)[1]["continuationStatus"])
        self.client.return_control_without_continuing(task["id"])
        self.command(task, "RESUME")
        changed = self.client.tool("widget.state", widget)[1]
        self.assertEqual("PENDING", changed["continuationStatus"])
        self.assertEqual(amended["instructionRevision"], changed["continuationRevision"])
        self.assertNotEqual(old["continuationId"], changed["continuationId"])
        self.assertFalse(self.client.tool("widget.claim", {**widget, "continuationId": old["continuationId"]})[1]["claimed"])
        fresh = {**widget, "continuationId": changed["continuationId"]}
        self.assertTrue(self.client.tool("widget.claim", fresh)[1]["claimed"])
        error, question, _ = self.client.tool("tasks.ask", {"taskId": task["id"],
            "instructionRevision": amended["instructionRevision"], "operationKey": str(uuid.uuid4()),
            "prompt": "A new request supersedes the pending host continuation"})
        self.assertFalse(error, question)
        late = self.client.tool("widget.continuation", {**fresh, "sent": True})[1]
        self.assertEqual(("WAITING_USER", "ACCEPTED"), (late["task"]["status"], late["continuationStatus"]))
        self.command(task, "ANSWER", requestId=question["request"]["id"],
                     requestVersion=question["request"]["version"], text="Confirmed current question")
        answered = self.client.tool("widget.state", widget)[1]
        self.assertEqual("ACCEPTED", answered["continuationStatus"])
        publish = {"taskId": task["id"], "operationKey": str(uuid.uuid4()),
                   "instructionRevision": amended["instructionRevision"],
                   "result": {"summary": "A fresh result confirms continuation", "limitations": [],
                              "sources": [], "columns": []}, "rows": []}
        error, refusal, _ = self.client.tool("results.publish", {
            **publish, "instructionRevision": amended["instructionRevision"] - 1})
        self.assertTrue(error, refusal)
        self.assertEqual("STALE_INSTRUCTION", refusal["code"])
        unchanged = self.client.tool("widget.state", widget)[1]
        self.assertEqual(("ACCEPTED", answered["continuationId"]),
                         (unchanged["continuationStatus"], unchanged["continuationId"]))
        error, saved, _ = self.client.tool("results.publish", publish)
        self.assertFalse(error, saved)
        self.assertEqual("ACCEPTED", self.client.tool("widget.state", widget)[1]["continuationStatus"])
        self.client.return_control_without_continuing(task["id"])
        self.command(task, "RESUME")
        current = self.client.tool("widget.state", widget)[1]
        error, replay, _ = self.client.tool("results.publish", publish)
        self.assertFalse(error, replay)
        self.assertEqual(saved, replay)
        unchanged = self.client.tool("widget.state", widget)[1]
        self.assertEqual(("PENDING", current["continuationId"]),
                         (unchanged["continuationStatus"], unchanged["continuationId"]))
        error, finished, _ = self.client.tool("tasks.command", {
            "taskId": task["id"], "operationKey": str(uuid.uuid4()), "command": {
                "type": "FINISH", "expectedVersion": current["task"]["version"],
                "outcome": "SUCCEEDED", "text": "A fresh completion command acknowledges the attempt"}})
        self.assertFalse(error, finished)
        self.assertEqual("SUCCEEDED", finished["status"])
        self.assertEqual("ACCEPTED", self.client.tool("widget.state", widget)[1]["continuationStatus"])

    def test_amend_preserves_work_and_stopped_task_is_final(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "Instruction and continuation acceptance", "goal": "Preserve collected work",
                "startUrl": "https://example.com/retained-page", "outputFormat": "TABLE",
                "prepare": True}})
        self.assertFalse(error, presentation)
        task = presentation["task"]
        path = "/api/tasks/" + task["id"]

        def current():
            status, value = self.client.api(path)
            self.assertEqual(200, status, value)
            return value

        def execute(kind, arguments):
            value = current()
            action = {"operationId": str(uuid.uuid4()), "type": kind, "arguments": arguments,
                      "instructionRevision": value["instructionRevision"]}
            if value.get("browser") and value["browser"]["status"] == "LIVE":
                action["controlEpoch"] = value["browser"]["controlEpoch"]
            error, receipt, _ = self.client.execute_in_scenario_step({"taskId": task["id"], "action": action})
            self.assertFalse(error, receipt)
            return action["operationId"]

        def amend(goal):
            return self.command(task, "AMEND", title=task["title"], goal=goal,
                                startUrl="https://example.com/?amended-start=1", outputFormat="TABLE",
                                preferredConnectionIds=[])

        navigation = execute("navigate", {"url": "https://example.com/retained-page"})
        self.assertEqual("SUCCEEDED", self.wait_operation(navigation, self.client)["status"])
        screenshot = execute("screenshot", {})
        self.assertEqual("SUCCEEDED", self.wait_operation(screenshot, self.client)["status"])
        browser = current()["browser"]["id"]
        error, saved, _ = self.client.tool("results.publish", {
            "taskId": task["id"], "operationKey": str(uuid.uuid4()),
            "instructionRevision": task["instructionRevision"],
            "result": {"summary": "Collected before revision", "limitations": [], "sources": [],
                       "columns": [{"key": "value", "label": "Value", "type": "string"}]},
            "rows": [{"value": "Original collected row"}]})
        self.assertFalse(error, saved)
        files = self.client.api(path + "/artifacts")[1]
        artifact = files["items"][0]
        status, original, _ = self.client.request(self.client.base + artifact["downloadUrl"])
        self.assertEqual(200, status)
        rows = self.client.api(path + "/result/rows")[1]
        history = self.client.api(path + "/history")[1]
        history_cutoff = history["items"][0]["sequence"]

        self.client.return_control_without_continuing(task["id"])
        revised = amend("Changed after manual control without continuation")
        self.assertEqual("PAUSED", revised["status"])
        self.assertEqual(browser, revised["browser"]["id"])
        self.assertEqual(task["instructionRevision"] + 1, revised["instructionRevision"])
        self.assertEqual(rows, self.client.api(path + "/result/rows")[1])
        self.command(task, "RESUME")
        observed = self.wait_operation(execute("observe", {}), self.client)
        self.assertEqual("SUCCEEDED", observed["status"], observed.get("errorCode"))
        self.assertIn("/retained-page", observed["result"]["url"])

        pending = execute("waitFor", {"selector": "[data-instruction-acceptance-never-present]"})
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            receipt = self.client.tool("operations.get", {"operationId": pending})[1]
            if receipt["status"] == "DISPATCHED":
                break
            time.sleep(.1)
        self.assertEqual("DISPATCHED", receipt["status"])
        queued = execute("reload", {})
        revised = amend("Changed after a read was dispatched")
        self.assertEqual("RUNNING", revised["status"])
        self.assertEqual("CANCELLED", self.wait_operation(queued, self.client)["status"])
        next_operation = execute("observe", {})
        self.assertEqual("ACCEPTED", self.client.tool("operations.get", {"operationId": next_operation})[1]["status"])
        self.assertEqual("FAILED", self.wait_operation(pending, self.client)["status"])
        self.assertEqual("SUCCEEDED", self.wait_operation(next_operation, self.client)["status"])
        self.assertEqual(browser, current()["browser"]["id"])

        self.command(task, "STOP")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and current()["status"] != "STOPPED":
            time.sleep(.2)
        self.assertEqual("STOPPED", current()["status"])
        revised = amend("Changed after explicit stop")
        self.assertEqual(("STOPPED", "CLOSED"), (revised["status"], revised["browser"]["status"]))
        status, refusal = self.client.api(path + "/commands", "POST", {
            "type": "RESUME", "expectedVersion": revised["version"]})
        self.assertEqual((409, "ACTION_UNAVAILABLE"), (status, refusal["code"]))
        status, refusal = self.client.api(path + "/commands", "POST", {
            "type": "RESUME", "expectedVersion": revised["version"], "confirmBrowserLoss": True})
        self.assertEqual((409, "ACTION_UNAVAILABLE"), (status, refusal["code"]))
        error, refusal, _ = self.client.tool("tasks.command", {"taskId": task["id"],
            "operationKey": str(uuid.uuid4()), "command": {"type": "RESUME",
            "expectedVersion": revised["version"], "confirmBrowserLoss": True}})
        self.assertTrue(error)
        self.assertEqual("ACTION_UNAVAILABLE", refusal["code"])
        self.assertEqual(saved["result"], current()["result"])
        self.assertEqual(rows, self.client.api(path + "/result/rows")[1])
        self.assertEqual(files, self.client.api(path + "/artifacts")[1])
        status, retained, _ = self.client.request(self.client.base + artifact["downloadUrl"])
        self.assertEqual((200, original), (status, retained))
        retained_history = self.client.api(path + "/history?beforeSequence=" + str(history_cutoff))[1]
        self.assertEqual(history, retained_history)

    def test_partial_result_retains_browser_for_resume_and_explicit_stop(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "Retained partial result browser", "goal": "Observe only",
                "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error, presentation)
        task = presentation["task"]
        path = "/api/tasks/" + task["id"]

        def observe():
            current = self.client.api(path)[1]
            action = {"operationId": str(uuid.uuid4()), "type": "observe", "arguments": {},
                      "instructionRevision": current["instructionRevision"]}
            if current.get("browser"):
                action["controlEpoch"] = current["browser"]["controlEpoch"]
            error, receipt, _ = self.client.execute_in_scenario_step({"taskId": task["id"], "action": action})
            self.assertFalse(error, receipt)
            return self.wait_operation(action["operationId"], self.client)

        initial_observation = observe()
        self.assertEqual("SUCCEEDED", initial_observation["status"])
        browser_id = self.client.api(path)[1]["browser"]["id"]
        for outcome in ("PARTIAL", "NOT_ACHIEVED"):
            with self.subTest(outcome=outcome):
                self.client.complete_scenario_step(task["id"], initial_observation["id"], "PARTIAL")
                finished = self.command(task, "FINISH", outcome=outcome, text="Retained result")
                self.assertEqual(outcome, finished["status"])
                self.assertIn("STOP", finished["allowedCommands"])
                self.assertEqual("f", self.fixture_sql(self.identity,
                    "SELECT close_requested FROM browser_sessions WHERE owner_id=:owner AND id='"
                    + str(uuid.UUID(browser_id)) + "';"))
                time.sleep(4)
                retained = self.client.api(path)[1]
                self.assertEqual((browser_id, "LIVE"), (retained["browser"]["id"], retained["browser"]["status"]))
                if outcome == "PARTIAL":
                    resumed = self.command(task, "RESUME")
                    self.assertEqual(browser_id, resumed["browser"]["id"])
                    result = observe()
                    self.assertEqual("SUCCEEDED", result["status"])
                    self.assertEqual(initial_observation["result"]["url"], result["result"]["url"])
        self.command(task, "STOP")
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            stopped = self.client.api(path)[1]
            if stopped["status"] == "STOPPED":
                break
            time.sleep(.2)
        self.assertEqual(("STOPPED", "CLOSED"), (stopped["status"], stopped["browser"]["status"]))
        self.assertEqual("Retained result", stopped["summary"])

    def test_amend_unknown_result_preserves_pause_and_stop(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "Uncertain amendment acceptance", "goal": "Preserve an explicit stop",
                "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error, presentation)
        task = presentation["task"]
        path = "/api/tasks/" + task["id"]
        operation = str(uuid.uuid4())
        error, receipt, _ = self.client.execute_in_scenario_step({
            "taskId": task["id"], "action": {
                "operationId": operation, "type": "click",
                "arguments": {"selector": "[data-amend-unknown-never-present]"},
                "instructionRevision": task["instructionRevision"]}})
        self.assertFalse(error, receipt)
        self.assertEqual("UNKNOWN", self.wait_operation(operation, self.client)["status"])
        self.command(task, "CLOSE_BROWSER")
        paused = self.command(task, "AMEND", title=task["title"],
                              goal="Revised while paused with an unknown effect",
                              startUrl="https://example.com")
        self.assertEqual("PAUSED", paused["status"])
        self.assertEqual("UNKNOWN_RESULT", paused["request"]["type"])
        self.assertEqual(operation, paused["request"]["operationId"])
        self.command(task, "STOP")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            stopped = self.client.api(path)[1]
            if stopped["status"] == "STOPPED":
                break
            time.sleep(.2)
        self.assertEqual(("STOPPED", "CLOSED"), (stopped["status"], stopped["browser"]["status"]))
        revised = self.command(task, "AMEND", title=task["title"],
                               goal="Revised after stop with an unknown effect",
                               startUrl="https://example.com")
        self.assertEqual("STOPPED", revised["status"])
        self.assertEqual(operation, revised["request"]["operationId"])
        verified = self.command(task, "REJECT", requestId=revised["request"]["id"],
                                requestVersion=revised["request"]["version"],
                                text="The target element does not exist and no external effect was observed")
        self.assertEqual(("STOPPED", "CLOSED"), (verified["status"], verified["browser"]["status"]))
        self.assertIsNone(verified["request"])
        self.assertEqual("FAILED", self.client.tool("operations.get", {"operationId": operation})[1]["status"])


if __name__ == "__main__":
    unittest.main()
