"""Real admission fairness with two unlimited disposable owners and occupied slots."""

import time
import unittest
import uuid

import test_dev_contract as dev
import test_usage_admin as usage


class UnlimitedFairnessTest(unittest.TestCase):
    setUpClass = classmethod(usage.UsageAdministrationTest.setUpClass.__func__)
    setUp = usage.UsageAdministrationTest.setUp
    tearDown = usage.UsageAdministrationTest.tearDown
    fixture_sql = usage.UsageAdministrationTest.fixture_sql
    purge_identity = usage.UsageAdministrationTest.purge_identity
    wait_operation = usage.UsageAdministrationTest.wait_operation

    def limits(self, identity):
        path = "/api/admin/users/" + identity.id
        user = self.admin.api(path)[1]["user"]
        status, result = self.admin.api(path + "/commands", "POST", {
            "type": "LIMITS", "expectedVersion": user["version"],
            "reason": "Unlimited fairness acceptance", "browserLimitMode": "UNLIMITED"})
        self.assertEqual(200, status, result)

    def test_unlimited_owners_alternate_without_reserving_slots_and_keep_fifo(self):
        nodes = self.admin.api("/api/admin/nodes")[1]
        self.assertEqual(1, len(nodes), "This isolated dev case needs the documented single node")
        self.assertEqual(("ONLINE", 0, 4), (nodes[0]["status"], nodes[0]["occupied"], nodes[0]["capacity"]))
        peer = dev.DisposableIdentity(self.settings, self.template)
        peer_client = peer.client()
        peer_client.login_web()
        self.addCleanup(self.purge_identity, peer)
        self.limits(self.identity)
        self.limits(peer)
        holders = []
        for index in range(4):
            status, connection = self.client.api("/api/connections", "POST", {
                "name": "Physical occupied slot " + str(index), "site": "example.com",
                "startUrl": "https://example.com"})
            self.assertEqual(200, status, connection)
            viewer = str(uuid.uuid4())
            status, login = self.client.api("/api/connections/" + connection["id"] + "/login", "POST", {
                "action": "START", "viewerId": viewer})
            self.assertEqual(200, status, login)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                current = self.client.api("/api/connections/" + connection["id"])[1]
                if current.get("browser") and current["browser"]["status"] == "LIVE":
                    break
                time.sleep(.2)
            self.assertEqual("LIVE", current["browser"]["status"])
            holders.append((connection["id"], viewer))
        self.assertEqual(4, self.admin.api("/api/admin/nodes")[1][0]["occupied"])
        queued = {self.identity.id: [], peer.id: []}
        for identity, client in ((self.identity, self.client), (peer, peer_client)):
            client.login_mcp()
            for index in range(2):
                transport = identity.client()
                transport.token = client.token
                error, state, _ = transport.tool("tasks.create", {"operationKey": str(uuid.uuid4()), "task": {
                    "title": "Unlimited owner FIFO " + str(index), "goal": "Observe alternating admission",
                    "startUrl": "https://example.org", "prepare": True}})
                self.assertFalse(error, state)
                task = state["task"]
                operation = str(uuid.uuid4())
                error, receipt, _ = transport.tool("browser.execute", {"taskId": task["id"], "action": {
                    "operationId": operation, "type": "observe", "arguments": {},
                    "instructionRevision": task["instructionRevision"]}})
                self.assertFalse(error, receipt)
                queued[identity.id].append((task["id"], operation, transport, client))
        all_tasks = queued[self.identity.id] + queued[peer.id]
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            states = [client.api("/api/tasks/" + task)[1] for task, _, _, client in all_tasks]
            if all(state.get("browser") and state["browser"]["status"] == "QUEUED" for state in states):
                break
            time.sleep(.2)
        self.assertTrue(all(state["browser"]["status"] == "QUEUED" for state in states))
        self.assertTrue(all(state["waitReason"] == "BROWSER_CAPACITY" for state in states))
        expected = [queued[peer.id][0], queued[self.identity.id][0],
                    queued[peer.id][1], queued[self.identity.id][1]]
        admitted = set()
        for (connection, viewer), (task, operation, transport, client) in zip(holders, expected):
            self.assertEqual(200, self.client.api("/api/connections/" + connection + "/login", "POST", {
                "action": "CLOSE", "viewerId": viewer})[0])
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                current = client.api("/api/tasks/" + task)[1]
                if current.get("browser") and current["browser"]["status"] == "LIVE":
                    break
                time.sleep(.2)
            self.assertEqual("LIVE", current["browser"]["status"], current["status"])
            self.assertEqual("SUCCEEDED", self.wait_operation(operation, transport)["status"])
            admitted.add(task)
            for pending, _, _, pending_client in all_tasks:
                if pending not in admitted:
                    self.assertEqual("QUEUED", pending_client.api("/api/tasks/" + pending)[1]["browser"]["status"])
        ended_task, _, _, ended_client = expected[-1]
        current = ended_client.api("/api/tasks/" + ended_task)[1]
        self.assertEqual(200, ended_client.api("/api/tasks/" + ended_task + "/commands", "POST", {
            "type": "END_SESSION", "expectedVersion": current["version"]})[0])
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            ended = ended_client.api("/api/tasks/" + ended_task)[1]
            if ended["browser"]["status"] == "CLOSED":
                break
            time.sleep(.2)
        self.assertEqual(("PAUSED", "CLOSED", "Сессия браузера закрыта"),
                         (ended["status"], ended["browser"]["status"], ended["summary"]))
        for identity in (self.identity, peer):
            self.assertEqual(200, self.admin.api("/api/admin/users/" + identity.id + "/commands", "POST", {
                "type": "STOP_ALL"})[0])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.admin.api("/api/admin/nodes")[1][0]["occupied"] == 0:
                break
            time.sleep(.3)
        self.assertEqual(0, self.admin.api("/api/admin/nodes")[1][0]["occupied"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
