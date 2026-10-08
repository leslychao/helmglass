"""Real public WSS grant revocation against deployed dev, preserving its Chromium."""

import base64
import os
from pathlib import Path
import secrets
import socket
import ssl
import time
import unittest
import uuid
from urllib.parse import parse_qs, urljoin, urlparse

import test_dev_contract as dev
from test_dev_contract import DevClient, DisposableIdentity


class ViewerSocket:
    def __init__(self, public_url, ticket):
        base = urlparse(public_url)
        path = "/" + parse_qs(urlparse(ticket["url"]).query)["path"][0]
        self.socket = ssl.create_default_context().wrap_socket(
            socket.create_connection((base.hostname, base.port or 443), timeout=5),
            server_hostname=base.hostname)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.socket.sendall(("GET " + path + " HTTP/1.1\r\nHost: " + base.netloc
            + "\r\nOrigin: " + public_url + "\r\nUpgrade: websocket\r\nConnection: Upgrade"
            + "\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n\r\n").encode())
        response = b""
        while b"\r\n\r\n" not in response and len(response) < 16384:
            value = self.socket.recv(4096)
            if not value:
                break
            response += value
        self.status = int(response.split(b" ", 2)[1])
        if self.status == 101:
            payload = response.split(b"\r\n\r\n", 1)[1]
            while b"RFB 003.008\n" not in payload and len(payload) < 16384:
                value = self.socket.recv(4096)
                if not value:
                    raise AssertionError("Viewer closed before its real RFB greeting")
                payload += value

    def closed(self, seconds):
        self.socket.settimeout(seconds)
        try:
            data = self.socket.recv(4096)
            return not data or data[0] & 15 == 8
        except (ConnectionError, ssl.SSLEOFError):
            return True
        except TimeoutError:
            return False

    def close(self):
        self.socket.close()


class ViewerRevocationTest(unittest.TestCase):
    fixture_sql = dev.DevContractTest.fixture_sql

    def test_web_logout_and_mcp_revoke_close_only_their_open_grant(self):
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
            "task": {"title": "Viewer grant revocation contract", "goal": "Verify selective live socket revocation",
                     "startUrl": "https://example.com", "requireConfirmation": False, "prepare": True}})
        self.assertFalse(error); task_id = presentation["task"]["id"]
        viewers = []; cleanup_client = client; logout = None

        def current(web=client):
            status, task = web.api("/api/tasks/" + task_id); self.assertEqual(200, status); return task

        def wait_task(predicate, web=client):
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                task = current(web)
                if predicate(task):
                    return task
                time.sleep(0.2)
            self.fail("Expected browser state was not confirmed")

        def connect(ticket):
            viewer = ViewerSocket(client.base, ticket); viewers.append(viewer)
            self.assertEqual(101, viewer.status); return viewer

        try:
            observation_id = str(uuid.uuid4())
            error, _, _ = client.tool("browser.execute", {"taskId": task_id, "action": {
                "operationId": observation_id, "type": "observe", "arguments": {},
                "instructionRevision": presentation["task"]["instructionRevision"]}})
            self.assertFalse(error)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                failed, operation, _ = client.tool("operations.get", {"operationId": observation_id})
                self.assertFalse(failed)
                if operation["status"] == "SUCCEEDED":
                    break
                self.assertNotIn(operation["status"], ("FAILED", "UNKNOWN"))
                time.sleep(0.2)
            else:
                self.fail("Initial browser observation did not finish")
            task = wait_task(lambda value: value.get("browser") and value["browser"]["status"] == "LIVE"
                             and value["status"] == "WAITING_CHATGPT")
            browser = task["browser"]["id"]; web_viewer = str(uuid.uuid4())
            status, transfer = client.api("/api/tasks/" + task_id + "/commands", "POST", {
                "type": "TAKE_CONTROL", "expectedVersion": task["version"], "viewerId": web_viewer})
            self.assertEqual(200, status, transfer.get("code"))
            task = wait_task(lambda value: value["browser"]["controlOwner"] == "USER")
            epoch = task["browser"]["controlEpoch"]
            error, state, _ = client.tool("tasks.view", {"taskId": task_id, "operationKey": str(uuid.uuid4())})
            self.assertFalse(error)

            def mcp_ticket():
                error, ticket, _ = client.tool("widget.browser", {"taskId": task_id,
                    "generation": state["generation"], "viewerId": str(uuid.uuid4())})
                self.assertFalse(error); return ticket

            status, ticket = client.api("/api/browser-sessions/" + browser + "/ticket", "POST",
                                       {"role": "CONTROLLER", "viewerId": web_viewer})
            self.assertEqual(200, status); web_socket = connect(ticket); mcp_socket = connect(mcp_ticket())
            status, stale_web = client.api("/api/browser-sessions/" + browser + "/ticket", "POST",
                                          {"role": "VIEWER", "viewerId": str(uuid.uuid4())})
            self.assertEqual(200, status)
            status, logout = client.api("/api/auth/logout", "POST", {})
            self.assertEqual(200, status)
            self.assertEqual("COMPLETED", logout["status"])
            self.assertTrue(web_socket.closed(3), "Server must revoke an already-open WEB controller")
            self.assertFalse(mcp_socket.closed(0.3), "Independent MCP view must survive WEB logout")
            stale = ViewerSocket(client.base, stale_web); viewers.append(stale); self.assertEqual(403, stale.status)
            client.request(urljoin(client.base, logout["redirectUrl"]))
            replacement = identity.client(); replacement.login_web(); cleanup_client = replacement
            task = current(replacement)
            self.assertEqual(browser, task["browser"]["id"]); self.assertEqual(epoch, task["browser"]["controlEpoch"])
            status, ticket = replacement.api("/api/browser-sessions/" + browser + "/ticket", "POST",
                                            {"role": "VIEWER", "viewerId": str(uuid.uuid4())})
            self.assertEqual(200, status); replacement_socket = connect(ticket); stale_mcp = mcp_ticket()
            status, revoked = replacement.api("/api/integrations/chatgpt/revoke", "POST", {})
            self.assertEqual(200, status); self.assertEqual("COMPLETED", revoked["status"])
            self.assertTrue(mcp_socket.closed(3), "Server must revoke the already-open MCP view")
            self.assertFalse(replacement_socket.closed(0.3), "Independent WEB view must survive MCP revoke")
            stale = ViewerSocket(client.base, stale_mcp); viewers.append(stale); self.assertEqual(403, stale.status)
            task = current(replacement)
            self.assertEqual(browser, task["browser"]["id"]); self.assertEqual("LIVE", task["browser"]["status"])
            self.assertEqual(epoch, task["browser"]["controlEpoch"])
        finally:
            for viewer in viewers:
                viewer.close()
            if cleanup_client.api("/api/tasks/" + task_id)[0] != 200:
                if logout:
                    client.request(urljoin(client.base, logout["redirectUrl"]))
                cleanup_client = identity.client(); cleanup_client.login_web()
            task = current(cleanup_client)
            self.assertEqual(200, cleanup_client.api("/api/tasks/" + task_id + "/commands", "POST",
                {"type": "STOP", "expectedVersion": task["version"]})[0])
            wait_task(lambda value: value["status"] == "STOPPED", cleanup_client)


if __name__ == "__main__":
    unittest.main(verbosity=2)
