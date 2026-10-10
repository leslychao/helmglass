"""Task command and recorded response contracts at the deployed REST/MCP boundaries."""

import json
from pathlib import Path
import subprocess
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

    def test_unbound_draft_cannot_be_stopped(self):
        status, draft = self.client.api('/api/tasks', 'POST', {
            'title': 'Unbound draft stop regression'})
        self.assertEqual(200, status, draft)
        self.assertEqual('DRAFT', draft['status'])
        self.assertFalse(draft['chatBound'])
        self.assertIsNone(draft['browser'])
        path = '/api/tasks/' + draft['id']
        status, page = self.client.api('/api/tasks')
        self.assertEqual(200, status, page)
        self.assertEqual([draft], page['items'])
        with self.subTest(boundary='available commands'):
            self.assertNotIn('STOP', draft['allowedCommands'])
        with self.subTest(boundary='command execution'):
            status, refusal = self.client.api(path + '/commands', 'POST', {
                'type': 'STOP', 'expectedVersion': draft['version']})
            self.assertEqual((409, 'ACTION_UNAVAILABLE'), (status, refusal.get('code')))
            self.assertEqual((200, draft), self.client.api(path))

    def test_new_chat_task_starts_without_preparation_option(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool('tasks.create', {
            'operationKey': str(uuid.uuid4()), 'task': {
                'title': 'New chat task without preparation',
                'goal': 'Observe the public fixture',
                'startUrl': self.client.browser_fixture_url()}})
        self.assertFalse(error, presentation)
        task = presentation['task']
        self.assertTrue(task['chatBound'])
        self.assertNotEqual('DRAFT', task['status'])
        self.assertTrue(task['timing']['running'])
        self.assertIsNotNone(task['browser'])

    def test_saved_draft_starts_from_chat_and_replays_same_task(self):
        status, draft = self.client.api('/api/tasks', 'POST', {
            'title': 'Saved draft execution', 'goal': 'Observe the public fixture',
            'startUrl': self.client.browser_fixture_url(), 'outputFormat': 'TEXT'})
        self.assertEqual(200, status, draft)
        self.assertEqual('DRAFT', draft['status'])
        self.assertIsNone(draft['browser'])
        self.assertIsNone(draft['timing']['elapsedSeconds'])
        path = '/api/tasks/' + draft['id']
        status, refusal = self.client.api(path + '/commands', 'POST', {
            'type': 'RESUME', 'expectedVersion': draft['version']})
        self.assertEqual((409, 'ORIGINAL_CHAT_REQUIRED'), (status, refusal.get('code')))
        self.assertEqual(400, self.client.api(path + '/commands', 'POST', {
            'type': 'PREPARE', 'expectedVersion': draft['version']})[0])

        self.client.login_mcp()
        tools = self.client.rpc('tools/list', {})['tools']
        command_tool = next(tool for tool in tools if tool['name'] == 'tasks.command')
        commands = command_tool['inputSchema']['properties']['command']['properties']['type']['enum']
        self.assertNotIn('PREPARE', commands)
        self.assertIn('RESUME', commands)
        error, viewed, _ = self.client.tool('tasks.get', {'taskId': draft['id']})
        self.assertFalse(error, viewed)
        current = self.client.api(path)[1]
        self.assertEqual('DRAFT', current['status'])
        self.assertFalse(current['chatBound'])
        self.assertIsNone(current['browser'])

        arguments = {'taskId': draft['id'], 'operationKey': str(uuid.uuid4())}
        error, started, _ = self.client.tool('tasks.bind', arguments)
        self.assertFalse(error, started)
        self.assertEqual(draft['id'], started['id'])
        self.assertEqual(draft['goal'], started['goal'])
        self.assertTrue(started['chatBound'])
        self.assertNotEqual('DRAFT', started['status'])
        self.assertTrue(started['timing']['running'])
        for _ in range(2):
            error, replay, _ = self.client.tool('tasks.bind', arguments)
            self.assertFalse(error, replay)
            self.assertEqual(started, replay)

        operation = str(uuid.uuid4())
        error, receipt, _ = self.client.execute_browser({'taskId': draft['id'], 'action': {
            'operationId': operation, 'type': 'observe', 'arguments': {},
            'instructionRevision': started['instructionRevision']}})
        self.assertFalse(error, receipt)
        self.assertEqual('SUCCEEDED', self.wait_operation(operation, self.client)['status'])
        counts = json.loads(self.fixture_sql(self.identity,
            "SELECT json_build_object('tasks',(SELECT count(*) FROM tasks WHERE owner_id=:owner),"
            "'browsers',(SELECT count(*) FROM browser_sessions WHERE owner_id=:owner),"
            "'starts',(SELECT count(*) FROM task_history WHERE owner_id=:owner "
            "AND title='Задача принята к выполнению'));"))
        self.assertEqual({'tasks': 1, 'browsers': 1, 'starts': 1}, counts)

    def test_incomplete_draft_bind_rolls_back_until_details_are_saved(self):
        status, draft = self.client.api('/api/tasks', 'POST', {'title': 'Incomplete saved draft'})
        self.assertEqual(200, status, draft)
        self.client.login_mcp()
        error, refusal, _ = self.client.tool('tasks.bind', {
            'taskId': draft['id'], 'operationKey': str(uuid.uuid4())})
        self.assertTrue(error, refusal)
        self.assertEqual('VALIDATION', refusal.get('code'), refusal)
        self.assertIn('goal', refusal['fieldErrors'])
        path = '/api/tasks/' + draft['id']
        current = self.client.api(path)[1]
        self.assertEqual('DRAFT', current['status'])
        self.assertFalse(current['chatBound'])
        self.assertIsNone(current['browser'])
        self.assertIsNone(current['timing']['elapsedSeconds'])
        status, saved = self.client.api(path + '/commands', 'POST', {
            'type': 'AMEND', 'expectedVersion': current['version'],
            'goal': 'Observe the public fixture', 'startUrl': self.client.browser_fixture_url()})
        self.assertEqual(200, status, saved)
        self.assertEqual('DRAFT', saved['status'])
        error, started, _ = self.client.tool('tasks.bind', {
            'taskId': draft['id'], 'operationKey': str(uuid.uuid4())})
        self.assertFalse(error, started)
        self.assertEqual(draft['id'], started['id'])
        self.assertTrue(started['chatBound'])
        self.assertNotEqual('DRAFT', started['status'])

    def test_unconfirmed_response_preserves_task_list_and_detail_contracts(self):
        status, task = self.client.api("/api/tasks", "POST", {
            "title": "Recorded unconfirmed response", "goal": "Read a saved verification",
            "prepare": False})
        self.assertEqual(200, status)
        request_id = str(uuid.uuid4())
        self.fixture_sql(self.identity,
            "INSERT INTO task_requests(id,task_id,owner_id,type,prompt,status,"
            "instruction_revision,answer,answer_command,answer_source,verification,answered_at) "
            f"VALUES('{request_id}','{task['id']}',:owner,'UNKNOWN_RESULT','Check the result',"
            f"'ANSWERED',{task['instructionRevision']},'Continue without replaying the action',"
            "'PROCEED','MCP_VERIFICATION','{\"outcome\":\"UNCONFIRMED\"}',now());")
        status, page = self.client.api("/api/tasks?pageSize=5")
        self.assertEqual(200, status)
        self.assertEqual(1, page["total"])
        status, current = self.client.api("/api/tasks/" + task["id"])
        self.assertEqual(200, status)
        self.assertEqual(page["items"][0], current)
        self.assertEqual("PROCEED", current["lastResponse"]["command"])

        validation = subprocess.run(["node", "--input-type=module", "-e", """
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {pageSchema, taskSchema, responseSchema} from './frontend/src/app/core/models.ts';
const page = JSON.parse(readFileSync(0, 'utf8'));
const parsed = pageSchema(taskSchema).safeParse(page);
assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
const response = page.items[0].lastResponse;
for (const command of ['ANSWER', 'CONFIRM', 'REJECT', 'CHOOSE_CONNECTION', 'PROCEED']) {
  assert.equal(responseSchema.safeParse({...response, command}).success, true, command);
}
assert.equal(responseSchema.safeParse({...response, command: 'RETRY'}).success, false);
"""], input=json.dumps(page), text=True, capture_output=True, timeout=15)
        self.assertEqual(0, validation.returncode, validation.stderr)

    def test_published_mcp_accepts_unconfirmed_recorded_response(self):
        self.client.login_mcp()
        tools = self.client.rpc("tools/list", {})["tools"]
        for name in ("tasks.create", "tasks.view", "widget.continuation", "widget.state"):
            schema = next(tool for tool in tools if tool["name"] == name)["outputSchema"]
            if name == "widget.state":
                schema = schema["anyOf"][0]
            response = schema["properties"]["task"]["properties"]["lastResponse"]
            self.assertIn("PROCEED", response["properties"]["command"]["enum"], name)

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
                        "command": {"type": "RESUME", "expectedVersion": task["version"]}})
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
