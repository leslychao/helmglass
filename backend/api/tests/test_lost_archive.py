"""Confirmed Chromium loss preserves originals before releasing the owned slot."""

import hashlib
import json
import os
import subprocess
import time
import unittest
import uuid

import test_usage_admin as usage


class LostArchiveTest(unittest.TestCase):
    setUpClass = classmethod(usage.UsageAdministrationTest.setUpClass.__func__)
    setUp = usage.UsageAdministrationTest.setUp
    tearDown = usage.UsageAdministrationTest.tearDown
    fixture_sql = usage.UsageAdministrationTest.fixture_sql
    purge_identity = usage.UsageAdministrationTest.purge_identity
    wait_operation = usage.UsageAdministrationTest.wait_operation
    command = usage.UsageAdministrationTest.command
    admin_command = usage.UsageAdministrationTest.admin_command

    def docker(self, *arguments, script=None):
        result = subprocess.run([
            "docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375", *arguments
        ], input=script, text=True, capture_output=True, timeout=35)
        self.assertEqual(0, result.returncode, "The scoped fixture Docker operation failed")
        return result.stdout.strip()

    def worker(self, route):
        script = ("const r=await fetch('http://127.0.0.1:8090'+" + json.dumps(route)
                  + ",{headers:{'X-Worker-Token':process.env.WORKER_TOKEN}});"
                  + "console.log(JSON.stringify({status:r.status,value:await r.json()}));")
        return json.loads(self.docker("exec", "-i", "helmglass-browser-node-1", "node",
                                      "--input-type=module", script=script))

    def current(self, task, client=None):
        client = client or self.client
        status, value = client.api("/api/tasks/" + task["id"])
        self.assertEqual(200, status)
        return value

    def wait_task(self, task, predicate, client=None):
        deadline = time.monotonic() + 70
        while time.monotonic() < deadline:
            value = self.current(task, client)
            if predicate(value):
                return value
            time.sleep(.25)
        self.fail("The owned browser did not finish its expected transition")

    def execute(self, task, kind, arguments, client=None):
        client = client or self.client
        current = self.current(task, client)
        action = {"operationId": str(uuid.uuid4()), "type": kind, "arguments": arguments,
                  "instructionRevision": current["instructionRevision"]}
        if current.get("browser") and current["browser"]["status"] == "LIVE":
            action["controlEpoch"] = current["browser"]["controlEpoch"]
        error, result, _ = client.execute_in_scenario_step({"taskId": task["id"], "action": action})
        self.assertFalse(error, result)
        receipt = self.wait_operation(action["operationId"], client)
        self.assertEqual("SUCCEEDED", receipt["status"])
        return receipt

    def test_lost_browser_archives_before_release_and_requires_new_browser_consent(self):
        self.assertEqual(200, self.admin_command("LIMITS", browserLimitMode="CUSTOM", browserLimit=1)[0])
        self.client.login_mcp()
        error, presentation, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "LOST archive acceptance", "goal": "Preserve an original before cleanup",
                "startUrl": os.environ["TEST_FIXTURE_URL"], "prepare": True}})
        self.assertFalse(error, presentation)
        task = presentation["task"]
        container = None
        original = None
        corrupted = False
        neighbor_task = None
        neighbor_client = None
        expected = b"Helm Glass pre-private completed download\n"
        try:
            self.execute(task, "observe", {})
            active = self.wait_task(task, lambda value: value.get("browser")
                                    and value["browser"]["status"] == "LIVE")
            session = str(uuid.UUID(active["browser"]["id"]))
            container = "helm-browser-" + session
            inspected = json.loads(self.docker("inspect", container))[0]
            self.assertEqual(session, inspected["Config"]["Labels"]["helmglass.session"])
            scope = " WHERE owner_id=:owner AND id='" + session + "';"
            # Delay only this fixture's background import until the native file is complete.
            self.fixture_sql(self.identity, "UPDATE browser_sessions SET artifact_cursor=9007199254740991" + scope)
            self.execute(task, "click", {"selector": "#download-later"})
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                page = self.worker("/sessions/" + session + "/artifacts?archive=true")
                self.assertEqual(200, page["status"])
                if page["value"]["artifacts"]:
                    original = page["value"]["artifacts"][0]
                    break
                time.sleep(.2)
            self.assertIsNotNone(original)
            self.assertTrue(original["complete"])
            self.assertEqual(len(expected), original["sizeBytes"])
            self.assertEqual(hashlib.sha256(expected).hexdigest(), original["sha256"])
            self.assertNotIn("operationId", original)
            artifact = str(uuid.UUID(original["id"]))
            self.assertEqual("0", self.fixture_sql(self.identity,
                "SELECT count(*) FROM artifacts WHERE owner_id=:owner AND id='" + artifact + "';"))

            # Corrupt one known byte in this tiny synthetic original. The immutable metadata
            # retains its correct hash, so archival must fail without releasing the slot.
            def write_first_byte(value):
                script = ("import fs from 'node:fs';const file=fs.openSync('/data/artifacts/"
                          + artifact + "','r+');try{fs.writeSync(file,Buffer.from(["
                          + str(value) + "]),0,1,0);}finally{fs.closeSync(file);}")
                self.docker("exec", "--user", "1000", "-i", container, "node",
                            "--input-type=module", script=script)

            write_first_byte(expected[0] ^ 1)
            corrupted = True
            self.fixture_sql(self.identity, "UPDATE browser_sessions SET artifact_cursor=0" + scope)
            script = r"""import fs from 'node:fs';const pids=[];
for(const name of fs.readdirSync('/proc')){
  if(!/^\d+$/.test(name))continue;
  try{const args=fs.readFileSync(`/proc/${name}/cmdline`,'utf8').split('\0');
    if(args[0]?.endsWith('/chrome')&&!args.some(a=>a.startsWith('--type=')))pids.push(Number(name));
  }catch{}
}
if(pids.length!==1)throw Error('Expected exactly one owned main Chromium');
process.kill(pids[0],'SIGKILL');"""
            self.docker("exec", "--user", "1000", "-i", container, "node",
                        "--input-type=module", script=script)
            lost = self.wait_task(task, lambda value: value["browser"]["status"] == "LOST")
            self.assertEqual("WAITING_USER", lost["status"])
            self.assertEqual("BROWSER_LOST", lost["request"]["type"])
            self.assertEqual(session, lost["browser"]["id"])
            endpoint = "/api/admin/users/" + self.identity.id
            self.assertEqual(1, self.admin.api(endpoint)[1]["user"]["browserCount"])
            self.assertEqual("LOST", self.worker("/sessions/" + session)["value"]["status"])
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                state = self.fixture_sql(self.identity,
                    "SELECT status FROM artifacts WHERE owner_id=:owner AND id='" + artifact + "';")
                if state == "FAILED":
                    break
                time.sleep(.25)
            self.assertEqual("FAILED", state)
            status, _, _ = self.client.request(self.client.base + "/api/artifacts/" + artifact + "/download")
            self.assertEqual(409, status)
            self.assertEqual("LOST", self.current(task)["browser"]["status"])
            self.assertEqual(1, self.admin.api(endpoint)[1]["user"]["browserCount"])

            # A failed source belongs to this session. Another owner must still receive
            # a live browser and finish its action while the original stays blocked.
            neighbor_identity = usage.dev.DisposableIdentity(self.settings, self.template)
            self.addCleanup(self.purge_identity, neighbor_identity)
            neighbor_client = neighbor_identity.client()
            neighbor_client.login_web()
            neighbor_client.login_mcp()
            error, shown, _ = neighbor_client.tool("tasks.create", {
                "operationKey": str(uuid.uuid4()), "task": {
                    "title": "Progress beside a failed archive", "goal": "Read a public page",
                    "startUrl": "https://example.com", "prepare": True}})
            self.assertFalse(error, shown)
            neighbor_task = shown["task"]
            self.execute(neighbor_task, "observe", {}, neighbor_client)
            self.assertEqual("LIVE", self.current(neighbor_task, neighbor_client)["browser"]["status"])
            self.assertEqual("LOST", self.current(task)["browser"]["status"])
            node_id = self.worker("/health")["value"]["nodeId"]
            nodes = self.admin.api("/api/admin/nodes")[1]
            node = next(value for value in nodes if value["id"] == node_id)
            self.assertEqual("ONLINE", node["status"], "An artifact error must not mark the healthy node offline")

            write_first_byte(expected[0])
            corrupted = False
            closed = self.wait_task(task, lambda value: value["browser"]["status"] == "CLOSED")
            self.assertEqual("WAITING_USER", closed["status"])
            self.assertEqual("BROWSER_LOST", closed["request"]["type"])
            self.assertEqual("CLOSED", self.worker("/sessions/" + session)["value"]["status"])
            self.assertEqual(0, self.admin.api(endpoint)[1]["user"]["browserCount"])
            status, received, _ = self.client.request(self.client.base + "/api/artifacts/" + artifact + "/download")
            self.assertEqual((200, expected), (status, received))
            self.assertEqual(original["sha256"], hashlib.sha256(received).hexdigest())
            for kind, name in (("container", container), ("container", container + "-egress"),
                               ("network", container), ("volume", container + "-data")):
                options = ["-a"] if kind == "container" else []
                self.assertEqual("", self.docker(kind, "ls", *options, "--filter", "name=" + name,
                                                  "--format", "{{.Name}}" if kind in ("volume", "network") else "{{.Names}}"))
            status, refusal = self.client.api("/api/tasks/" + task["id"] + "/commands", "POST", {
                "type": "RESUME", "expectedVersion": closed["version"]})
            self.assertEqual(409, status)
            self.assertEqual("BROWSER_REPLACEMENT_CONSENT", refusal["code"])
            self.command(task, "RESUME", confirmBrowserLoss=True)
            self.execute(task, "observe", {})
            replacement = self.current(task)
            self.assertEqual(task["id"], replacement["id"])
            self.assertEqual("LIVE", replacement["browser"]["status"])
            self.assertNotEqual(session, replacement["browser"]["id"])
            self.assertEqual(1, self.admin.api(endpoint)[1]["user"]["browserCount"])
        finally:
            if corrupted:
                write_first_byte(expected[0])
            if neighbor_task:
                current = self.current(neighbor_task, neighbor_client)
                status, _ = neighbor_client.api("/api/tasks/" + neighbor_task["id"] + "/commands", "POST", {
                    "type": "STOP", "expectedVersion": current["version"]})
                self.assertEqual(200, status)
                self.wait_task(neighbor_task, lambda value: value["status"] == "STOPPED", neighbor_client)
            # No direct worker DELETE: cleanup itself must traverse the public lifecycle.
            self.command(task, "STOP")
            self.wait_task(task, lambda value: value["status"] == "STOPPED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
