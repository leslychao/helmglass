"""Real dev API admission retains an unreachable, still-running owned browser."""

import json
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

import test_dev_contract as dev


class UnknownOccupancyTest(unittest.TestCase):
    fixture_sql = dev.DevContractTest.fixture_sql
    wait_operation = dev.DevContractTest.wait_operation

    def test_unreachable_browser_keeps_custom_limit_slot_until_confirmed_close(self):
        self.settings = dict(line.split("=", 1) for line in Path(
            os.environ.get("HELM_TEST_ENV", "deploy/.env.dev")
        ).read_text(encoding="utf-8").splitlines() if line and not line.startswith("#") and "=" in line)
        self.admin = dev.DevClient(self.settings, "admin", "KEYCLOAK_APP_ADMIN_PASSWORD")
        self.admin.login_web()
        template = dev.DevClient(self.settings, "test", "KEYCLOAK_TEST_PASSWORD").login_web()
        identity = dev.DisposableIdentity(self.settings, template["id"])
        self.user = identity.client()
        self.user.login_web()
        self.user.login_mcp()
        self.addCleanup(dev.DevContractTest.purge_identity, self, identity)
        endpoint = "/api/admin/users/" + identity.id
        detail = self.admin.api(endpoint)[1]
        self.assertEqual(200, self.admin.api(endpoint + "/commands", "POST", {
            "type": "LIMITS", "expectedVersion": detail["user"]["version"],
            "reason": "Disposable UNKNOWN occupancy acceptance", "browserLimitMode": "CUSTOM",
            "browserLimit": 1})[0])

        def task_state(task):
            status, value = self.user.api("/api/tasks/" + task)
            self.assertEqual(200, status)
            return value

        def wait_task(task, predicate):
            deadline = time.monotonic() + 100
            while time.monotonic() < deadline:
                value = task_state(task)
                if predicate(value):
                    return value
                time.sleep(.3)
            self.fail("The owned browser did not reach the expected lifecycle state")

        tasks = []

        def stop_tasks():
            # Stop queued work first so freeing the active slot cannot launch it.
            for task in reversed(tasks):
                value = task_state(task)
                if value["status"] != "STOPPED":
                    self.assertEqual(200, self.user.api("/api/tasks/" + task + "/commands", "POST", {
                        "type": "STOP", "expectedVersion": value["version"]})[0])
                wait_task(task, lambda state: state["status"] == "STOPPED")

        self.addCleanup(stop_tasks)

        def request_browser(label):
            # Separate original chats avoid superseding the first task's binding.
            transport = identity.client()
            transport.login_mcp()
            error, shown, _ = transport.tool("tasks.create", {"operationKey": str(uuid.uuid4()),
                "task": {"title": label, "goal": "Verify occupancy without stopping another owner",
                         "startUrl": "https://example.com", "requireConfirmation": False, "prepare": True}})
            self.assertFalse(error)
            task = shown["task"]
            tasks.append(task["id"])
            operation = str(uuid.uuid4())
            error, _, _ = transport.tool("browser.execute", {"taskId": task["id"], "action": {
                "operationId": operation, "type": "observe", "arguments": {},
                "instructionRevision": task["instructionRevision"]}})
            self.assertFalse(error)
            return task["id"], operation, transport

        active, observation, transport = request_browser("UNKNOWN occupied slot")
        self.assertEqual("SUCCEEDED", self.wait_operation(observation, transport)["status"])
        original = wait_task(active, lambda task: task.get("browser") and task["browser"]["status"] == "LIVE")
        session = str(uuid.UUID(original["browser"]["id"]))
        container = "helm-browser-" + session
        network = container

        def docker(*arguments):
            completed = subprocess.run(["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
                                        *arguments], capture_output=True, text=True, timeout=30)
            self.assertEqual(0, completed.returncode,
                             "The scoped disposable browser Docker operation failed: " + completed.stderr[-500:])
            return completed.stdout.strip()

        networks = json.loads(docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", container))
        self.assertEqual([network], list(networks), "Only the owned private bridge may be disconnected")
        address = networks[network]["IPAddress"]
        process = json.loads(docker("inspect", "--format", "{{json .State}}", container))
        self.assertTrue(process["Running"])
        self.assertEqual(1, self.admin.api(endpoint)[1]["user"]["browserCount"])

        disconnected = False
        try:
            docker("network", "disconnect", network, container)
            disconnected = True
            unavailable = wait_task(active, lambda task: task["browser"]["status"] == "UNREACHABLE")
            self.assertEqual(session, unavailable["browser"]["id"])
            self.assertEqual(1, self.admin.api(endpoint)[1]["user"]["browserCount"])
            queued, _, _ = request_browser("Wait behind UNKNOWN occupied slot")
            waiting = wait_task(queued, lambda task: task.get("browser") and task["browser"]["status"] == "QUEUED")
            self.assertEqual("QUEUED", waiting["status"])
            time.sleep(4)
            self.assertEqual("QUEUED", task_state(queued)["browser"]["status"])
            self.assertEqual(1, self.admin.api(endpoint)[1]["user"]["browserCount"])
            still_running = json.loads(docker("inspect", "--format", "{{json .State}}", container))
            self.assertTrue(still_running["Running"])
            self.assertEqual((process["Pid"], process["StartedAt"]),
                             (still_running["Pid"], still_running["StartedAt"]))
        finally:
            if disconnected:
                docker("network", "connect", network, container)
                reconnected = json.loads(docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", container))
                self.assertEqual(address, reconnected[network]["IPAddress"],
                                 "The isolated fixture route must be restored to its original address")

        restored = wait_task(active, lambda task: task["browser"]["status"] == "LIVE")
        self.assertEqual(session, restored["browser"]["id"])
        recovered_process = json.loads(docker("inspect", "--format", "{{json .State}}", container))
        self.assertEqual((process["Pid"], process["StartedAt"]),
                         (recovered_process["Pid"], recovered_process["StartedAt"]))
        stop_tasks()
        self.assertEqual(0, self.admin.api(endpoint)[1]["user"]["browserCount"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
