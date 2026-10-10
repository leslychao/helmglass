"""Real dev private-login and paused task lifetime, with no connected viewers."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

import test_dev_contract as dev
from test_dev_contract import DevClient, DisposableIdentity


class BrowserLifetimeTest(unittest.TestCase):
    fixture_sql = dev.DevContractTest.fixture_sql

    def test_private_login_and_paused_task_keep_the_same_live_page(self):
        settings = dict(line.split("=", 1) for line in Path(
            os.environ.get("HELM_TEST_ENV", "deploy/.env.dev")
        ).read_text(encoding="utf-8").splitlines() if line and not line.startswith("#") and "=" in line)
        self.settings = settings
        self.admin = DevClient(settings, "admin", "KEYCLOAK_APP_ADMIN_PASSWORD")
        self.admin.login_web()
        template = DevClient(settings, "test", "KEYCLOAK_TEST_PASSWORD").login_web()
        identity = DisposableIdentity(settings, template["id"])
        self.addCleanup(dev.DevContractTest.purge_identity, self, identity)
        client = identity.client(); client.login_web(); client.login_mcp()
        error, presentation, _ = client.tool("tasks.create", {"operationKey": str(uuid.uuid4()),
            "task": {"title": "Browser lifetime contract", "goal": "Preserve private and paused page state",
                     "startUrl": client.browser_fixture_url(), "prepare": True}})
        self.assertFalse(error); task_id = presentation["task"]["id"]

        def current():
            status, task = client.api("/api/tasks/" + task_id); self.assertEqual(200, status); return task

        def wait_task(predicate):
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                task = current()
                if predicate(task):
                    return task
                time.sleep(0.2)
            self.fail("Expected task transition did not finish")

        def execute(kind, arguments):
            task = current()
            action = {"operationId": str(uuid.uuid4()), "type": kind, "arguments": arguments,
                      "instructionRevision": task["instructionRevision"]}
            if task.get("browser"):
                action["controlEpoch"] = task["browser"]["controlEpoch"]
            error, result, _ = client.execute_browser({"taskId": task_id, "action": action})
            return error, result, action["operationId"]

        def completed(kind, arguments):
            error, _, operation_id = execute(kind, arguments); self.assertFalse(error)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                error, operation, _ = client.tool("operations.get", {"operationId": operation_id})
                self.assertFalse(error)
                if operation["status"] == "SUCCEEDED":
                    return operation
                self.assertNotIn(operation["status"], ("FAILED", "UNKNOWN"))
                time.sleep(0.2)
            self.fail("Browser action did not finish")

        def process(browser_id):
            raw = subprocess.check_output(["docker", "--host", "tcp://" + settings["DEV_HOST"] + ":2375",
                "inspect", "--format", '{{json .State}}', "helm-browser-" + browser_id], text=True, timeout=15)
            state = json.loads(raw); self.assertTrue(state["Running"])
            return state["Pid"], state["StartedAt"]

        def command(kind, **values):
            task = current()
            status, result = client.api("/api/tasks/" + task_id + "/commands", "POST",
                {"type": kind, "expectedVersion": task["version"], **values})
            self.assertEqual(200, status, result.get("code"))

        def worker_artifacts(browser_id):
            route = "/sessions/" + str(uuid.UUID(browser_id)) + "/artifacts"
            script = ("const r=await fetch('http://127.0.0.1:8090'+" + json.dumps(route)
                + ",{headers:{'X-Worker-Token':process.env.WORKER_TOKEN}});"
                + "if(!r.ok)throw Error('Artifact metadata unavailable');console.log(JSON.stringify(await r.json()));")
            result = subprocess.run(["docker", "--host", "tcp://" + settings["DEV_HOST"] + ":2375",
                "exec", "-i", "helmglass-browser-node-1", "node", "--input-type=module"],
                input=script, text=True, capture_output=True, timeout=20)
            self.assertEqual(0, result.returncode, "Owned browser metadata request failed")
            return json.loads(result.stdout)["artifacts"]

        stopped = False
        try:
            completed("observe", {})
            marker = "retained-page-" + str(uuid.uuid4())
            completed("fill", {**client.browser_target(task_id, 'Comment'), 'text': marker})
            task = current(); browser = task["browser"]["id"]; original_process = process(browser)
            viewer = str(uuid.uuid4())
            command("BEGIN_LOGIN", viewerId=viewer)
            task = wait_task(lambda value: value["browser"]["privateMode"]
                             and value["status"] == "WAITING_USER"
                             and value["browser"]["controlOwner"] == "USER")
            # This exceeds the 60-second one-use viewer ticket lifetime without any viewer socket.
            time.sleep(75)
            task = current()
            self.assertEqual(browser, task["browser"]["id"])
            self.assertTrue(task["browser"]["privateMode"])
            self.assertEqual(original_process, process(browser))
            command("FINISH_LOGIN", viewerId=viewer)
            wait_task(lambda value: value["status"] == "WAITING_CHATGPT"
                      and not value["browser"]["privateMode"])
            client.return_control_without_continuing(task_id)
            time.sleep(75)
            task = current()
            self.assertEqual("PAUSED", task["status"])
            self.assertEqual("LIVE", task["browser"]["status"])
            self.assertEqual(browser, task["browser"]["id"])
            self.assertEqual(original_process, process(browser))
            error, denied, _ = execute("observe", {})
            self.assertTrue(error); self.assertEqual("TASK_NOT_RUNNING", denied["code"])
            command("RESUME")
            wait_task(lambda value: value["status"] == "WAITING_CHATGPT")
            observation = completed("observe", {})
            self.assertIn(marker, json.dumps(observation))
            self.assertEqual(original_process, process(browser))

            # Hold only this fixture's importer cursor to reproduce a completed native
            # download that has not reached backend storage before private input starts.
            scope = " WHERE owner_id=:owner AND id='" + str(uuid.UUID(browser)) + "';"
            self.fixture_sql(identity, "UPDATE browser_sessions SET artifact_cursor=9007199254740991" + scope)
            completed("click", client.browser_target(task_id, 'Download a completed result after this action returns'))
            deadline = time.monotonic() + 20
            artifacts = []
            while time.monotonic() < deadline:
                artifacts = worker_artifacts(browser)
                if artifacts:
                    break
                time.sleep(0.25)
            self.assertEqual(1, len(artifacts)); original = artifacts[0]
            expected = b"Helm Glass pre-private completed download\n"
            self.assertTrue(original["complete"])
            self.assertEqual(len(expected), original["sizeBytes"])
            self.assertEqual(hashlib.sha256(expected).hexdigest(), original["sha256"])
            self.assertNotIn("operationId", original, "Delayed native download must be independent of the completed click")
            command("BEGIN_LOGIN", viewerId=viewer)
            wait_task(lambda value: value["browser"]["privateMode"] and value["status"] == "WAITING_USER")
            self.assertEqual("0", self.fixture_sql(identity,
                "SELECT count(*) FROM artifacts WHERE owner_id=:owner AND id='" + str(uuid.UUID(original["id"])) + "';"))
            self.fixture_sql(identity, "UPDATE browser_sessions SET artifact_cursor=0" + scope)
            command("STOP")
            wait_task(lambda value: value["status"] == "STOPPED"
                      and value["browser"]["cleanupState"] == "COMPLETE"); stopped = True
            status, data, _ = client.request(client.base + "/api/artifacts/" + original["id"] + "/download")
            self.assertEqual(200, status)
            self.assertEqual(expected, data)
            self.assertEqual(original["sha256"], hashlib.sha256(data).hexdigest())
        finally:
            if not stopped:
                command("STOP")
                wait_task(lambda value: value["status"] == "STOPPED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
