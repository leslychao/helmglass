"""Removal of the standalone pause command at the deployed REST and MCP boundaries."""

import json
from pathlib import Path
import unittest
import uuid

import test_usage_admin as usage


class TaskCommandsTest(unittest.TestCase):
    setUpClass = classmethod(usage.UsageAdministrationTest.setUpClass.__func__)
    setUp = usage.UsageAdministrationTest.setUp
    tearDown = usage.UsageAdministrationTest.tearDown
    fixture_sql = usage.UsageAdministrationTest.fixture_sql
    purge_identity = usage.UsageAdministrationTest.purge_identity
    wait_operation = usage.UsageAdministrationTest.wait_operation

    def test_pause_is_not_a_published_task_command(self):
        self.client.login_mcp()
        tools = self.client.rpc("tools/list", {})["tools"]
        command = next(tool for tool in tools if tool["name"] == "tasks.command")
        values = command["inputSchema"]["properties"]["command"]["properties"]["type"]["enum"]
        self.assertNotIn("PAUSE", values)
        self.assertIn("RESUME", values)
        schema = Path("backend/api/openapi.yaml").read_text(encoding="utf-8")
        # The enum is indented more deeply than sibling schema declarations.
        lines = schema.split("    TaskCommandType:\n", 1)[1].splitlines()
        values = []
        for line in lines:
            if line.startswith("    ") and not line.startswith("      "):
                break
            if line.strip().startswith("- "):
                values.append(line.strip()[2:])
        self.assertNotIn("PAUSE", values)
        self.assertIn("RESUME", values)

    def test_rest_and_mcp_reject_repeated_pause_without_effects(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "Removed pause contract", "goal": "Observe a public page",
                "startUrl": "https://example.com", "prepare": False}})
        self.assertFalse(error, presentation)
        task_id = presentation["task"]["id"]
        path = "/api/tasks/" + task_id
        widget = {"taskId": task_id, "generation": presentation["generation"]}

        def snapshot():
            task = self.client.api(path)[1]
            browser = task.get("browser")
            return {
                "task": {key: task[key] for key in ("status", "version", "instructionRevision",
                    "allowedCommands", "request", "lastResponse", "result", "summary")},
                "browser": None if browser is None else {key: browser[key] for key in
                    ("id", "status", "controlOwner", "controlEpoch", "privateMode", "closedAt")},
                "continuation": {key: value for key, value in self.client.tool("widget.state", widget)[1].items()
                                 if key.startswith("continuation")},
                "persisted": json.loads(self.fixture_sql(self.identity,
                    "SELECT json_build_object('paused',t.paused_explicitly,'operations',"
                    "(SELECT coalesce(json_agg(o ORDER BY o.id),'[]') FROM operations o WHERE o.task_id=t.id),"
                    "'close', (SELECT close_requested FROM browser_sessions WHERE id=t.browser_session_id))"
                    " FROM tasks t WHERE t.owner_id=:owner AND t.id='" + task_id + "';")),
                "history": self.client.api(path + "/history")[1],
            }

        for scenario in ("draft", "live", "manual_return"):
            with self.subTest(scenario=scenario):
                if scenario == "live":
                    task = self.client.api(path)[1]
                    error, prepared, _ = self.client.tool("tasks.command", {
                        "taskId": task_id, "operationKey": str(uuid.uuid4()),
                        "command": {"type": "PREPARE", "expectedVersion": task["version"]}})
                    self.assertFalse(error, prepared)
                    operation = str(uuid.uuid4())
                    error, receipt, _ = self.client.execute_browser({"taskId": task_id,
                        "action": {"operationId": operation, "type": "observe", "arguments": {},
                                   "instructionRevision": presentation["task"]["instructionRevision"]}})
                    self.assertFalse(error, receipt)
                    self.assertEqual("SUCCEEDED", self.wait_operation(operation, self.client)["status"])
                elif scenario == "manual_return":
                    self.client.return_control_without_continuing(task_id)
                before = snapshot()
                self.assertNotIn("PAUSE", before["task"]["allowedCommands"])
                body = {"type": "PAUSE", "expectedVersion": before["task"]["version"]}
                key = str(uuid.uuid4())
                mcp = {"taskId": task_id, "operationKey": str(uuid.uuid4()), "command": body}
                for _ in range(2):
                    status, refusal = self.client.api(path + "/commands", "POST", body, key=key)
                    self.assertEqual((400, "INVALID_REQUEST"), (status, refusal.get("code")), refusal)
                    error, refusal, _ = self.client.tool("tasks.command", mcp)
                    self.assertTrue(error, refusal)
                    self.assertIn("input validation failed", refusal.get("message", ""), refusal)
                    self.assertIn("/command/type", refusal["message"])
                    self.assertEqual(before, snapshot())


if __name__ == "__main__":
    unittest.main()
