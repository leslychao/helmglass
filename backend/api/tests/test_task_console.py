"""Targeted dev console checks with explicitly owned temporary task records.

The historical cohort exercises labels, not execution transitions. The interactive
case verifies an actual UNKNOWN action and STOP pending physical browser closure.
Only the created task IDs are removed; the managed account is retained.
"""

import json
import os
from pathlib import Path
import subprocess
import time
import unittest
from urllib.parse import urlencode
import uuid

import test_dev_contract as dev


class TaskConsoleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        filename = Path(os.environ.get("HELM_TEST_ENV", "deploy/.env.dev"))
        cls.settings = dict(line.split("=", 1) for line in filename.read_text(encoding="utf-8").splitlines()
                            if line and not line.startswith("#") and "=" in line)
        cls.admin = dev.DevClient(cls.settings, "admin", "KEYCLOAK_APP_ADMIN_PASSWORD")
        cls.admin.login_web()

    wait_operation = dev.DevContractTest.wait_operation

    @unittest.skipUnless(os.environ.get("HELM_INTERACTIVE_UI") == "1",
                         "Requires the authorized dev console operator")
    def test_unknown_verification_and_pending_stop_in_console(self):
        self.admin.login_mcp()
        owner = str(uuid.UUID(self.admin.api("/api/me")[1]["id"]))
        marker = "UI-runtime-" + uuid.uuid4().hex[:12]
        create_key = str(uuid.uuid4())
        error, presentation, _ = self.admin.tool("tasks.create", {
            "operationKey": create_key, "task": {
                "title": marker, "goal": "Observe UNKNOWN verification and pending STOP",
                "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error, presentation)
        task_id = str(uuid.UUID(presentation["task"]["id"]))
        path = "/api/tasks/" + task_id
        container = None
        paused = False

        def current():
            status, value = self.admin.api(path)
            self.assertEqual(200, status, value)
            return value

        def until(predicate, seconds=90):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                value = current()
                if predicate(value):
                    return value
                time.sleep(.3)
            self.fail("The interactive owned task did not reach its expected state")

        def docker(*arguments, data=None):
            result = subprocess.run([
                "docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375", *arguments],
                input=data, capture_output=True, text=True, timeout=35)
            self.assertEqual(0, result.returncode, "The owned UI fixture command failed")
            return result.stdout.strip()

        def execute(kind, arguments):
            task = current()
            operation = str(uuid.uuid4())
            action = {"operationId": operation, "type": kind, "arguments": arguments,
                      "instructionRevision": task["instructionRevision"]}
            if task.get("browser"):
                action["controlEpoch"] = task["browser"]["controlEpoch"]
            error, receipt, _ = self.admin.execute_in_scenario_step({"taskId": task_id, "action": action})
            self.assertFalse(error, receipt)
            return self.wait_operation(operation, self.admin)

        try:
            self.assertEqual("SUCCEEDED", execute("observe", {})["status"])
            self.assertEqual("UNKNOWN", execute("click", self.admin.browser_target(task_id, 'Slow effect', uncertain=True))["status"])
            unknown = current()
            self.assertEqual("UNKNOWN_RESULT", unknown["request"]["type"])
            print("UNKNOWN UI " + self.admin.base + path.replace("/api", "", 1), flush=True)
            observed = execute('observe', {})
            pending = unknown['request']
            error, verified, _ = self.admin.tool('tasks.respond', {
                'taskId': task_id, 'requestId': pending['id'], 'requestVersion': pending['version'],
                'operationKey': str(uuid.uuid4()), 'verification': {
                    'outcome': 'UNCONFIRMED', 'observationOperationId': observed['id'],
                    'evidence': 'The page is readable; stop without replaying the old click.'}})
            self.assertFalse(error, verified)
            until(lambda value: value["request"] is None)
            session = str(uuid.UUID(current()["browser"]["id"]))
            container = "helm-browser-" + session
            inspected = json.loads(docker("inspect", container))[0]
            self.assertEqual(session, inspected["Config"]["Labels"]["helmglass.session"])
            docker("pause", container)
            paused = True
            print("STOP UI READY " + task_id, flush=True)
            until(lambda value: value["status"] == "STOPPING")
            print("STOPPING UI " + task_id, flush=True)
            time.sleep(20)
            docker("unpause", container)
            paused = False
            stopped = until(lambda value: value["status"] == "STOPPED")
            self.assertEqual("CLOSED", stopped["browser"]["status"])
            print("STOPPED UI " + task_id, flush=True)
            time.sleep(25)
        finally:
            if paused:
                docker("unpause", container)
            task = current()
            if task["status"] not in ("STOPPED", "STOPPING"):
                status, receipt = self.admin.api(path + "/commands", "POST", {
                    "type": "STOP", "expectedVersion": task["version"]})
                self.assertEqual(200, status, receipt)
            until(lambda value: value["status"] == "STOPPED")
            scope = "owner_id='" + owner + "' AND task_id='" + task_id + "'"
            statements = [
                "BEGIN",
                "SELECT id FROM tasks WHERE id='" + task_id + "' AND owner_id='" + owner
                + "' AND title='" + marker + "' AND status='STOPPED' FOR UPDATE",
                "DELETE FROM user_events WHERE owner_id='" + owner + "' AND (entity_id='" + task_id
                + "' OR entity_id IN (SELECT id FROM operations WHERE " + scope
                + ") OR entity_id IN (SELECT id FROM browser_sessions WHERE " + scope + "))",
                "DELETE FROM idempotency_records WHERE owner_id='" + owner + "' AND (key='"
                + create_key + "' OR scope='tasks:" + task_id + "')",
                *["DELETE FROM " + table + " WHERE " + scope for table in (
                    "mcp_chats", "mcp_task_chats", "task_requests", "task_history", "notifications",
                    "result_rows", "usage_intervals", "operations")],
                "UPDATE tasks SET browser_session_id=NULL WHERE id='" + task_id + "' AND owner_id='" + owner + "'",
                "DELETE FROM browser_sessions WHERE " + scope + " AND status='CLOSED'",
                "DELETE FROM tasks WHERE id='" + task_id + "' AND owner_id='" + owner + "' AND title='" + marker + "'",
                "COMMIT"]
            docker("exec", "-i", "helmglass-postgres-1", "psql", "-U", "postgres", "-d", "helmglass",
                   "-At", "-v", "ON_ERROR_STOP=1", data=";\n".join(statements) + ";")

    def test_historical_state_labels_in_console(self):
        owner = str(uuid.UUID(self.admin.api("/api/me")[1]["id"]))
        marker = "UI-state-" + uuid.uuid4().hex[:12]
        states = ("DRAFT", "WAITING_CHATGPT", "QUEUED", "STARTING", "RUNNING",
                  "WAITING_USER", "PAUSING", "PAUSED", "STOPPING", "SUCCEEDED",
                  "PARTIAL", "NOT_ACHIEVED", "FAILED", "STOPPED")
        created = []
        keys = []

        def sql(statement):
            result = subprocess.run([
                "docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
                "exec", "helmglass-postgres-1", "psql", "-U", "postgres", "-d", "helmglass",
                "-At", "-v", "ON_ERROR_STOP=1", "-c", statement],
                capture_output=True, text=True, timeout=20)
            self.assertEqual(0, result.returncode, "The scoped UI fixture SQL failed")
            return result.stdout.strip()

        try:
            for state in states:
                key = str(uuid.uuid4())
                status, task = self.admin.api("/api/tasks", "POST", {
                    "title": marker + " " + state, "goal": "Historical rendering fixture only",
                    "startUrl": "https://example.com", "outputFormat": "TEXT", "prepare": False}, key=key)
                self.assertEqual(200, status, task)
                created.append(str(uuid.UUID(task["id"])))
                keys.append(key)
                sql("UPDATE tasks SET status='" + state + "',wait_reason="
                    + ("'BROWSER_CAPACITY'" if state == "QUEUED" else "NULL")
                    + " WHERE id='" + created[-1] + "' AND owner_id='" + owner + "';")
            query = urlencode({"search": marker, "pageSize": 20, "page": 1})
            status, page = self.admin.api("/api/tasks?" + query)
            self.assertEqual(200, status, page)
            self.assertEqual(len(states), page["total"])
            self.assertEqual(set(states), {item["status"] for item in page["items"]})
            print("HISTORICAL UI " + self.admin.base + "/tasks?" + query, flush=True)
            hold = min(180, max(30, int(os.environ.get("HELM_TEST_UI_HOLD_SECONDS", "90"))))
            time.sleep(hold)
        finally:
            if created:
                identifiers = ",".join("'" + value + "'" for value in created)
                scope = "owner_id='" + owner + "' AND id IN (" + identifiers + ")"
                self.assertEqual(str(len(created)), sql(
                    "SELECT count(*) FROM tasks WHERE " + scope + " AND title LIKE '" + marker + " %';"))
                self.assertEqual("0", sql("SELECT count(*) FROM browser_sessions WHERE task_id IN (" + identifiers + ");"))
                scoped_tasks = "owner_id='" + owner + "' AND task_id IN (" + identifiers + ")"
                receipt_keys = ",".join("'" + key + "'" for key in keys)
                sql("BEGIN; DELETE FROM task_history WHERE " + scoped_tasks
                    + "; DELETE FROM notifications WHERE " + scoped_tasks
                    + "; DELETE FROM user_events WHERE owner_id='" + owner + "' AND entity_id IN (" + identifiers + ")"
                    + "; DELETE FROM idempotency_records WHERE owner_id='" + owner + "' AND key IN (" + receipt_keys + ")"
                    + "; DELETE FROM tasks WHERE " + scope + "; COMMIT;")


if __name__ == "__main__":
    unittest.main(verbosity=2)
