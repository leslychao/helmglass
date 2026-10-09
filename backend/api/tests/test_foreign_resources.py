"""Real dev ownership boundaries for live browser and connection mutations."""

import os
from pathlib import Path
import time
import unittest
import uuid

import test_dev_contract as dev
from test_dev_contract import DevClient, DisposableIdentity


class ForeignResourceTest(unittest.TestCase):
    fixture_sql = dev.DevContractTest.fixture_sql

    def test_foreign_user_and_admin_cannot_control_or_mutate_owned_resources(self):
        self.settings = dict(line.split("=", 1) for line in Path(
            os.environ.get("HELM_TEST_ENV", "deploy/.env.dev")
        ).read_text(encoding="utf-8").splitlines() if line and not line.startswith("#") and "=" in line)
        self.admin = DevClient(self.settings, "admin", "KEYCLOAK_APP_ADMIN_PASSWORD")
        self.admin.login_web()
        template = DevClient(self.settings, "test", "KEYCLOAK_TEST_PASSWORD").login_web()
        clients = []
        for _ in range(2):
            identity = DisposableIdentity(self.settings, template["id"])
            client = identity.client()
            client.login_web()
            self.addCleanup(dev.DevContractTest.purge_identity, self, identity)
            clients.append(client)
        owner, stranger = clients
        owner.login_mcp()
        error, presentation, _ = owner.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()),
            "task": {"title": "Owned resource authorization", "goal": "Check access without changing another owner",
                     "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error)
        task_id = presentation["task"]["id"]
        task_path = "/api/tasks/" + task_id

        def current():
            status, task = owner.api(task_path)
            self.assertEqual(200, status)
            return task

        def wait_task(predicate):
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                task = current()
                if predicate(task):
                    return task
                time.sleep(.2)
            self.fail("The owned task did not reach the expected state")

        def stop_task():
            task = current()
            if task["status"] != "STOPPED":
                self.assertEqual(200, owner.api(task_path + "/commands", "POST", {
                    "type": "STOP", "expectedVersion": task["version"]})[0])
            wait_task(lambda value: value["status"] == "STOPPED")

        self.addCleanup(stop_task)

        def execute(kind):
            task = current()
            action = {"operationId": str(uuid.uuid4()), "type": kind, "arguments": {},
                      "instructionRevision": task["instructionRevision"]}
            if task.get("browser"):
                action["controlEpoch"] = task["browser"]["controlEpoch"]
            error, receipt, _ = owner.execute_in_scenario_step({"taskId": task_id, "action": action})
            return error, receipt, action["operationId"]

        def complete(kind):
            error, _, operation_id = execute(kind)
            self.assertFalse(error)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                error, receipt, result = owner.tool("operations.get", {"operationId": operation_id})
                self.assertFalse(error)
                if receipt["status"] == "SUCCEEDED":
                    if kind == "screenshot":
                        images = [item for item in result["content"] if item["type"] == "image"]
                        self.assertEqual(1, len(images))
                        self.assertEqual("image/png", images[0]["mimeType"])
                    return receipt
                self.assertNotIn(receipt["status"], ("FAILED", "UNKNOWN"))
                time.sleep(.2)
            self.fail("The owned browser command did not complete")

        complete("observe")
        complete("reload")
        baseline = wait_task(lambda task: task.get("browser") is not None
                             and task["browser"]["status"] == "LIVE"
                             and task["browser"]["currentUrl"] == "https://example.com/"
                             and task["status"] == "WAITING_CHATGPT")
        browser = baseline["browser"]
        browser_path = "/api/browser-sessions/" + browser["id"]
        status, connection = owner.api("/api/connections", "POST", {
            "name": "Owned connection", "site": "example.com", "startUrl": "https://example.com"})
        self.assertEqual(200, status)
        connection_path = "/api/connections/" + connection["id"]

        for role, client in (("USER", stranger), ("ADMIN", self.admin)):
            viewer = str(uuid.uuid4())
            denied = [
                (connection_path, "GET", None),
                (connection_path, "PATCH", {"name": "Foreign change", "expectedVersion": connection["version"]}),
                (connection_path, "DELETE", None),
                (connection_path + "/login", "POST", {"action": "START", "viewerId": viewer}),
                (task_path + "/commands", "POST", {"type": "STOP", "expectedVersion": baseline["version"]}),
            ]
            denied.extend((browser_path + "/control", "POST", {"type": kind, "viewerId": viewer})
                          for kind in ("TAKE", "RETURN", "BEGIN_LOGIN", "FINISH_LOGIN"))
            denied.extend((browser_path + "/ticket", "POST", {"role": kind, "viewerId": viewer})
                          for kind in ("VIEWER", "CONTROLLER"))
            for path, method, body in denied:
                with self.subTest(role=role, method=method, resource=path.rsplit("/", 1)[-1], body_type=(body or {}).get("type")):
                    status, error = client.api(path, method, body)
                    self.assertEqual(404, status)
                    self.assertEqual("NOT_FOUND", error["code"])
                    self.assertNotIn("ticket", error)
            self.assertEqual(connection, owner.api(connection_path)[1])
            actual = current()
            self.assertEqual(baseline["version"], actual["version"])
            self.assertEqual(browser, actual["browser"])

        # The authorized owner still uses the same routes and the same live browser.
        status, renamed = owner.api(connection_path, "PATCH", {
            "name": "Renamed by owner", "expectedVersion": connection["version"]})
        self.assertEqual(200, status)
        self.assertEqual("Renamed by owner", renamed["name"])
        self.assertEqual(connection["version"] + 1, renamed["version"])
        viewer = str(uuid.uuid4())
        self.assertEqual(200, owner.api(browser_path + "/ticket", "POST", {
            "role": "VIEWER", "viewerId": viewer})[0])

        # Ordinary page commands do not generate screen recordings or screenshots.
        status, artifacts = owner.api(task_path + "/artifacts")
        self.assertEqual(200, status)
        self.assertEqual(0, artifacts["total"])
        screenshot = complete("screenshot")
        status, artifacts = owner.api(task_path + "/artifacts")
        self.assertEqual(200, status)
        self.assertEqual(1, artifacts["total"])
        artifact_id = artifacts["items"][0]["id"]

        # MCP grants enforce the same owner boundary, including for an ADMIN grant.
        for role, client in (("USER", stranger), ("ADMIN", self.admin)):
            client.login_mcp()
            failed, own_presentation, _ = client.tool("tasks.create", {
                "operationKey": str(uuid.uuid4()),
                "task": {"title": "Foreign artifact access boundary",
                         "goal": "Use an owned chat binding while refusing a foreign file",
                         "startUrl": "https://example.com", "prepare": False}})
            self.assertFalse(failed)
            own_task = own_presentation["task"]["id"]

            def delete_draft(transport=client, draft_id=own_task):
                self.assertEqual(200, transport.api("/api/tasks/" + draft_id, "DELETE")[0])

            self.addCleanup(delete_draft)
            denied_tools = [
                ("tasks.get", {"taskId": task_id}),
                ("artifacts.list", {"taskId": task_id}),
                ("operations.get", {"operationId": screenshot["operationId"]}),
                ("audio.get", {"taskId": own_task, "artifactId": artifact_id}),
            ]
            for name, arguments in denied_tools:
                with self.subTest(role=role, mcp_tool=name):
                    failed, refusal, result = client.tool(name, arguments)
                    self.assertTrue(failed)
                    self.assertEqual("NOT_FOUND", refusal["code"])
                    self.assertFalse(any(item["type"] in ("audio", "image", "resource")
                                         for item in result.get("content", [])))
            self.assertEqual(artifacts, owner.api(task_path + "/artifacts")[1])

        self.assertEqual(200, owner.api(browser_path + "/control", "POST", {
            "type": "BEGIN_LOGIN", "viewerId": viewer})[0])
        self.assertTrue(current()["browser"]["privateMode"])
        error, _, _ = execute("screenshot")
        self.assertTrue(error, "Explicit screenshot must still be denied during private login")
        for client in (stranger, self.admin):
            self.assertEqual(404, client.api(browser_path + "/ticket", "POST", {
                "role": "CONTROLLER", "viewerId": str(uuid.uuid4())})[0])
        self.assertEqual(browser["id"], current()["browser"]["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
