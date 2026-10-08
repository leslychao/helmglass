"""Administrative audit boundaries on disposable identities in deployed dev."""

from datetime import datetime, timedelta, timezone
import json
import hashlib
import os
import subprocess
import time
import unittest
from urllib.parse import urlencode
import uuid

import test_usage_admin as usage


class AdministrativeAuditTest(unittest.TestCase):
    setUpClass = classmethod(usage.UsageAdministrationTest.setUpClass.__func__)
    setUp = usage.UsageAdministrationTest.setUp
    fixture_sql = usage.UsageAdministrationTest.fixture_sql
    purge_identity = usage.UsageAdministrationTest.purge_identity
    wait_operation = usage.UsageAdministrationTest.wait_operation
    admin_command = usage.UsageAdministrationTest.admin_command
    create = usage.UsageAdministrationTest.create
    command = usage.UsageAdministrationTest.command
    sql = usage.UsageAdministrationTest.sql

    def tearDown(self):
        if self.admin.api("/api/admin/users/" + self.identity.id)[1]["user"]["status"] != "DELETED":
            self.purge_identity(self.identity)

    def profile_count(self, connection):
        script = ("import {DatabaseSync} from 'node:sqlite';"
                  "const db=new DatabaseSync('/data/node.sqlite',{readOnly:true});"
                  "console.log(db.prepare('SELECT count(*) AS n FROM profiles WHERE id=? AND owner=?')"
                  ".get(process.argv[1],process.argv[2]).n); db.close();")
        result = subprocess.run(["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
            "exec", "helmglass-browser-node-1", "node", "--input-type=module", "-e", script,
            str(uuid.UUID(connection)), str(uuid.UUID(self.identity.id))],
            text=True, capture_output=True, timeout=15)
        self.assertEqual(0, result.returncode)
        return int(result.stdout.strip())

    def test_audit_action_filter_intersects_search_owner_and_multiple_values(self):
        marker = "Audit action filter " + str(uuid.uuid4())
        self.assertEqual(200, self.admin_command("LIMITS", browserLimitMode="PLATFORM", reason=marker)[0])
        self.assertEqual(200, self.admin_command("STOP_ALL")[0])
        endpoint = "/api/admin/audit?" + urlencode({"user": self.identity.id, "search": marker})
        status, excluded = self.admin.api(endpoint + "&action=BLOCK")
        self.assertEqual(200, status, excluded)
        self.assertEqual((0, []), (excluded["total"], excluded["items"]))
        status, included = self.admin.api(endpoint + "&action=LIMITS")
        self.assertEqual(200, status, included)
        self.assertEqual(1, included["total"])
        self.assertEqual("LIMITS", included["items"][0]["action"])
        both = "/api/admin/audit?user=" + self.identity.id
        repeated = self.admin.api(both + "&action=LIMITS&action=STOP_ALL")[1]
        comma_separated = self.admin.api(both + "&action=LIMITS,STOP_ALL")[1]
        self.assertEqual(repeated, comma_separated)
        self.assertEqual(2, repeated["total"])
        self.assertEqual({"LIMITS", "STOP_ALL"}, {item["action"] for item in repeated["items"]})
        self.assertEqual(400, self.admin.api(both + "&" + urlencode({
            "action": ",".join("ACTION_" + str(index) for index in range(51))}))[0])

    def test_purge_resumes_after_owned_file_removal_failure(self):
        task = self.create("Disposable purge recovery", prepare=False)
        artifact_id = str(uuid.uuid4())
        artifact_path = "/data/artifacts/" + artifact_id
        docker = ["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
                  "exec", "helmglass-api-1"]
        admin_id = str(uuid.UUID(self.admin.api("/api/me")[1]["id"]))

        def published_versions():
            query = ("SELECT version FROM user_events WHERE resource='admin-user' "
                     f"AND entity_id='{uuid.UUID(self.identity.id)}' AND owner_id='{admin_id}'")
            result = subprocess.run([
                "docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
                "exec", "helmglass-postgres-1", "psql", "-U", "postgres", "-d", "helmglass",
                "-At", "-v", "ON_ERROR_STOP=1", "-c", query],
                capture_output=True, text=True, timeout=15)
            self.assertEqual(0, result.returncode)
            return [int(value) for value in result.stdout.splitlines()]

        def file_command(*arguments):
            result = subprocess.run([*docker, *arguments], capture_output=True, timeout=15)
            self.assertEqual(0, result.returncode, "Owned purge fixture file operation failed")

        self.sql("INSERT INTO artifacts(id,owner_id,task_id,name,mime_type,status,complete,relative_path) "
                 f"VALUES('{artifact_id}',:owner,'{task['id']}','Owned unavailable file',"
                 f"'application/octet-stream','FAILED',false,'{artifact_id}');")
        file_command("mkdir", artifact_path)
        file_command("touch", artifact_path + "/owned-removal-obstacle")
        try:
            self.assertEqual(200, self.admin_command("REQUEST_DELETION", reason="Purge recovery acceptance")[0])
            self.sql("UPDATE accounts SET deletion_due_at=clock_timestamp() WHERE id=:owner;")
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                detail = self.admin.api("/api/admin/users/" + self.identity.id)[1]
                if detail["user"]["status"] == "PURGING":
                    break
                time.sleep(.5)
            self.assertEqual("PURGING", detail["user"]["status"])
            self.assertIn(detail["user"]["version"], published_versions())
            self.assertEqual(403, self.client.api("/api/me")[0])
            hold = min(120, max(0, int(os.environ.get("HELM_TEST_UI_HOLD_SECONDS", "0"))))
            if hold:
                print("PURGING UI fixture " + self.identity.id, flush=True)
                time.sleep(hold)
        finally:
            file_command("rm", "-f", artifact_path + "/owned-removal-obstacle")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            detail = self.admin.api("/api/admin/users/" + self.identity.id)[1]
            if detail["user"]["status"] == "DELETED":
                break
            time.sleep(.5)
        self.assertEqual("DELETED", detail["user"]["status"])
        self.assertIn(detail["user"]["version"], published_versions())
        self.assertEqual(0, detail["user"]["pendingOperations"])
        self.assertEqual(404, self.identity.admin("/users/" + self.identity.id)[0])
        self.assertEqual(0, detail["tasks"]["total"])
        file_command("test", "!", "-e", artifact_path)
        self.assertIn(self.client.api("/api/me")[0], (401, 403))

    def test_stop_task_audit_settles_and_remains_in_owner_history(self):
        self.client.login_mcp()
        task = self.create("Administrative individual stop audit")
        error, state, _ = self.client.tool("tasks.view", {
            "taskId": task["id"], "operationKey": str(uuid.uuid4())})
        self.assertFalse(error, state)
        operation = str(uuid.uuid4())
        error, receipt, _ = self.client.tool("browser.execute", {"taskId": task["id"], "action": {
            "operationId": operation, "type": "observe", "arguments": {},
            "instructionRevision": task["instructionRevision"]}})
        self.assertFalse(error, receipt)
        self.assertEqual("SUCCEEDED", self.wait_operation(operation, self.client)["status"])
        task = self.client.api("/api/tasks/" + task["id"])[1]
        key = str(uuid.uuid4())
        path = "/api/admin/browsers/" + task["browser"]["id"] + "/stop"
        status, stopped = self.admin.api(path, "POST", {}, key)
        self.assertEqual(200, status, stopped)
        self.assertEqual((200, stopped), self.admin.api(path, "POST", {}, key))
        during = self.admin.api("/api/admin/users/" + self.identity.id)[1]
        if during["tasks"]["items"][0]["status"] == "STOPPING":
            self.assertEqual(1, during["user"]["pendingOperations"])
            self.assertEqual("STOP_TASK", during["operations"][0]["description"])
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            current = self.client.api("/api/tasks/" + task["id"])[1]
            audit = self.admin.api("/api/admin/audit?search=" + task["id"])[1]
            if current["status"] == "STOPPED" and audit["items"][0]["status"] == "SUCCEEDED":
                break
            time.sleep(.3)
        self.assertEqual("STOPPED", current["status"])
        self.assertEqual(1, audit["total"])
        row = audit["items"][0]
        self.assertEqual("SUCCEEDED", row["status"], row)
        self.assertEqual("STOP_TASK", row["action"])
        self.assertEqual(task["id"], row["target"])
        self.assertIsNone(row["reason"])
        self.assertEqual("STOPPED", json.loads(row["after"])["status"])
        self.assertEqual(0, self.admin.api("/api/admin/users/" + self.identity.id)[1]["user"]["pendingOperations"])
        owner_audit = self.admin.api("/api/admin/audit?user=" + self.identity.id + "&search=STOP_TASK")[1]
        self.assertEqual([row], owner_audit["items"])
        self.purge_identity(self.identity)
        self.assertEqual([row], self.admin.api(
            "/api/admin/audit?user=" + self.identity.id + "&search=STOP_TASK")[1]["items"])

    def test_audit_date_boundaries_retention_and_purge_preservation(self):
        now = datetime.now(timezone.utc)
        retained = (now - timedelta(days=365) + timedelta(minutes=2)).isoformat()
        expired = (now - timedelta(days=365) - timedelta(minutes=2)).isoformat()
        fixed_from = (now - timedelta(days=1)).replace(microsecond=0)
        fixed_to = fixed_from + timedelta(hours=1)
        rows = {}
        for label, created in (("expired", expired), ("retained", retained),
                               ("inclusive", fixed_from.isoformat()), ("exclusive", fixed_to.isoformat())):
            status, _ = self.admin_command("LIMITS", browserLimitMode="PLATFORM", reason=label)
            self.assertEqual(200, status)
            row = self.admin.api("/api/admin/audit?user=" + self.identity.id + "&search=" + label)[1]["items"][0]
            rows[label] = row["id"]
            self.sql("UPDATE administrative_audit SET created_at='" + created + "' "
                     "WHERE id='" + row["id"] + "' AND target_id=:owner;")
        path = "/api/admin/audit?user=" + self.identity.id
        report = self.admin.api(path)[1]
        self.assertEqual(3, report["total"])
        self.assertNotIn(rows["expired"], {row["id"] for row in report["items"]})
        selected = self.admin.api(path + "&" + urlencode({
            "from": fixed_from.isoformat(), "to": fixed_to.isoformat(), "status": "SUCCEEDED"}))[1]
        self.assertEqual([rows["inclusive"]], [row["id"] for row in selected["items"]])
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            count = self.sql("SELECT count(*) FROM administrative_audit WHERE target_id=:owner "
                             "AND id='" + rows["expired"] + "';")
            if count == "0":
                break
            time.sleep(.5)
        self.assertEqual("0", count, "The actual retention handler must remove expired audit")
        self.purge_identity(self.identity)
        preserved = self.admin.api(path)[1]
        self.assertTrue(set(rows.values()) - {rows["expired"]} <= {row["id"] for row in preserved["items"]})

    def test_active_block_self_administration_and_complete_data_purge(self):
        administrator = self.admin.api("/api/me")[1]["id"]
        status, roles, _ = self.identity.admin("/users/" + administrator + "/role-mappings/realm")
        self.assertEqual(200, status)
        role = [item for item in roles if item["name"] == "ADMIN"]
        self.assertEqual(1, len(role))
        self.assertEqual(204, self.identity.admin("/users/" + self.identity.id + "/role-mappings/realm", "POST", role)[0])
        self.client = self.identity.client()
        self.assertIn("ADMIN", self.client.login_web()["roles"])
        endpoint = "/api/admin/users/" + self.identity.id
        for kind in ("BLOCK", "REQUEST_DELETION"):
            previous = self.client.api(endpoint)[1]["user"]
            status, refusal = self.client.api(endpoint + "/commands", "POST", {
                "type": kind, "reason": "Self administration must fail",
                "expectedVersion": previous["version"]})
            self.assertEqual((409, "SELF_ADMINISTRATION"), (status, refusal["code"]))
            self.assertEqual("ACTIVE", self.client.api(endpoint)[1]["user"]["status"])
        self.client.login_mcp()
        error, state, _ = self.client.tool("tasks.create", {"operationKey": str(uuid.uuid4()), "task": {
            "title": "Block retains work until final deletion", "goal": "Preserve original saved result",
            "startUrl": "https://example.com", "prepare": True, "outputFormat": "TABLE"}})
        self.assertFalse(error, state)
        task = state["task"]
        operation = str(uuid.uuid4())
        error, receipt, _ = self.client.tool("browser.execute", {"taskId": task["id"], "action": {
            "operationId": operation, "type": "screenshot", "arguments": {},
            "instructionRevision": task["instructionRevision"]}})
        self.assertFalse(error, receipt)
        self.assertEqual("SUCCEEDED", self.wait_operation(operation, self.client)["status"])
        error, saved, _ = self.client.tool("results.publish", {"taskId": task["id"],
            "instructionRevision": task["instructionRevision"], "operationKey": str(uuid.uuid4()),
            "result": {"summary": "Saved before account block", "limitations": [], "sources": [],
                       "columns": [{"key": "value", "label": "Value", "type": "string"}]},
            "rows": [{"value": "Saved application data"}]})
        self.assertFalse(error, saved)
        error, asked, _ = self.client.tool("tasks.ask", {"taskId": task["id"],
            "instructionRevision": task["instructionRevision"], "operationKey": str(uuid.uuid4()),
            "prompt": "A durable question retained until account deletion"})
        self.assertFalse(error, asked)
        files = self.client.api("/api/tasks/" + task["id"] + "/artifacts")[1]
        self.assertEqual(1, files["total"])
        artifact = files["items"][0]
        status, original, _ = self.client.request(self.client.base + artifact["downloadUrl"])
        self.assertEqual(200, status)
        self.assertEqual(artifact["sha256"], hashlib.sha256(original).hexdigest())
        status, connection = self.client.api("/api/connections", "POST", {
            "name": "Block standalone browser", "site": "example.org", "startUrl": "https://example.org"})
        self.assertEqual(200, status)
        viewer = str(uuid.uuid4())
        login_path = "/api/connections/" + connection["id"] + "/login"
        status, login = self.client.api(login_path, "POST", {"action": "START", "viewerId": viewer})
        self.assertEqual(200, status, login)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            connected = self.client.api("/api/connections/" + connection["id"])[1]
            if connected.get("browser") and connected["browser"]["status"] == "LIVE":
                break
            time.sleep(.2)
        self.assertEqual(2, self.admin.api(endpoint)[1]["user"]["browserCount"])
        self.assertEqual(200, self.client.api(login_path, "POST", {
            "action": "SAVE", "viewerId": viewer, "accountLabel": "Synthetic anonymous profile",
            "accountSubject": "disposable-anonymous-profile"})[0])
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.client.api("/api/connections/" + connection["id"])[1]["status"] == "READY":
                break
            time.sleep(.2)
        self.assertEqual(1, self.profile_count(connection["id"]))
        waiting = self.create("Block also stops accepted waiting work")
        draft = self.create("Block retains draft until deletion", prepare=False)
        self.assertEqual(200, self.admin_command("BLOCK")[0])
        self.assertEqual(403, self.client.api("/api/tasks/" + task["id"])[0])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            detail = self.admin.api(endpoint)[1]
            if detail["user"]["browserCount"] == 0 and detail["user"]["pendingOperations"] == 0:
                break
            time.sleep(.3)
        self.assertEqual(("BLOCKED", 0, 0), tuple(detail["user"][field] for field in (
            "status", "browserCount", "pendingOperations")))
        statuses = {item["id"]: item["status"] for item in detail["tasks"]["items"]}
        self.assertEqual("STOPPED", statuses[task["id"]])
        self.assertEqual("STOPPED", statuses[waiting["id"]])
        self.assertEqual("DRAFT", statuses[draft["id"]])
        self.assertEqual(200, self.admin_command("UNBLOCK")[0])
        self.assertEqual(401, self.client.api("/api/tasks/" + task["id"])[0])
        time.sleep(1.1)
        self.client = self.identity.client()
        self.client.login_web()
        self.assertEqual("STOPPED", self.client.api("/api/tasks/" + task["id"])[1]["status"])
        self.assertEqual("STOPPED", self.client.api("/api/tasks/" + waiting["id"])[1]["status"])
        self.assertEqual(0, self.admin.api(endpoint)[1]["user"]["browserCount"])
        self.assertEqual(original, self.client.request(self.client.base + artifact["downloadUrl"])[1])
        self.assertEqual({"value": "Saved application data"}, self.client.api(
            "/api/tasks/" + task["id"] + "/result/rows")[1]["items"][0]["cells"])
        self.assertEqual(200, self.admin_command("REQUEST_DELETION")[0])
        self.purge_identity(self.identity)
        self.assertEqual(404, self.identity.admin("/users/" + self.identity.id)[0])
        self.assertEqual(0, self.profile_count(connection["id"]))
        tables = ("tasks", "connections", "browser_sessions", "operations", "artifacts", "usage_intervals",
                  "result_rows", "task_history", "task_requests", "notifications", "mcp_chats",
                  "mcp_task_chats", "idempotency_records", "user_events", "revoked_sessions",
                  "viewer_revocations", "administrative_jobs")
        owner = str(uuid.UUID(self.identity.id))
        statement = " UNION ALL ".join("SELECT '" + table + "',count(*) FROM " + table +
                                      " WHERE owner_id='" + owner + "'" for table in tables) + ";"
        result = subprocess.run(["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
            "exec", "-i", "helmglass-postgres-1", "psql", "-U", "postgres", "-d", "helmglass", "-At",
            "-v", "ON_ERROR_STOP=1"], input=statement, text=True, capture_output=True, timeout=20)
        self.assertEqual(0, result.returncode)
        self.assertEqual({table: "0" for table in tables}, dict(line.split("|") for line in result.stdout.splitlines()))
        artifact_id = str(uuid.UUID(artifact["id"]))
        for suffix in ("", ".part"):
            result = subprocess.run(["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
                "exec", "helmglass-api-1", "test", "!", "-e", "/data/artifacts/" + artifact_id + suffix],
                capture_output=True, timeout=15)
            self.assertEqual(0, result.returncode, "Purged artifact bytes must not remain")
        audit = self.admin.api("/api/admin/audit?user=" + owner)[1]
        self.assertTrue({"BLOCK", "UNBLOCK", "REQUEST_DELETION"} <= {row["action"] for row in audit["items"]})

    def test_synchronous_audit_does_not_inherit_another_pending_operation(self):
        # Two existing stop batches keep the asynchronous command observable during LIMITS.
        for index in range(101):
            self.create("Independent administrative outcome " + str(index))
        status, stopping = self.admin_command("STOP_ALL")
        self.assertEqual(200, status, stopping)
        self.assertGreater(stopping["pendingOperations"], 0)
        status, limited = self.admin_command("LIMITS", browserLimitMode="CUSTOM", browserLimit=1)
        self.assertEqual(200, status, limited)
        self.assertGreater(limited["pendingOperations"], 0, "The synchronous update must overlap actual stop work")
        path = "/api/admin/audit?user=" + self.identity.id + "&search=LIMITS"
        audit = self.admin.api(path)[1]
        self.assertEqual(1, audit["total"])
        self.assertEqual("SUCCEEDED", audit["items"][0]["status"], audit["items"][0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
