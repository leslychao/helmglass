"""Application regression checks against an already deployed dev instance.

Run from the repository root with HELM_TEST_ENV pointing to its existing dev env file.
No containers, local server, authentication bypass, or infrastructure fixtures are created.
"""

import base64
import atexit
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import unittest
import uuid
from html.parser import HTMLParser
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, Request, build_opener


class LoginForm(HTMLParser):
    def __init__(self):
        super().__init__()
        self.action = None
        self.fields = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.action = attrs.get("action")
        if tag == "input" and attrs.get("name") and attrs.get("type") == "hidden":
            self.fields[attrs["name"]] = attrs.get("value", "")


class CallbackRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        if new_url.startswith("https://chatgpt.com/connector_platform_oauth_redirect"):
            return None
        return super().redirect_request(request, response, code, message, headers, new_url)


class DevClient:
    def __init__(self, settings, user, password_key):
        self.settings = settings
        self.base = settings["PUBLIC_URL"].rstrip("/")
        self.cookies = CookieJar()
        self.http = build_opener(HTTPCookieProcessor(self.cookies), CallbackRedirect())
        self.user = user
        self.password_key = password_key
        self.token = None
        self.chat = "helm-dev-" + str(uuid.uuid4())
        self.mcp_session = None
        self.mcp_capabilities = {"elicitation": {"form": {}}}
        self.elicitation_handler = None

    def request(self, url, method="GET", data=None, headers=None):
        request = Request(url, data=data, method=method, headers=headers or {})
        try:
            response = self.http.open(request, timeout=55)
        except HTTPError as error:
            response = error
        return response.status, response.read(), response.headers

    def submit_login(self, html):
        form = LoginForm()
        form.feed(html.decode())
        if not form.action:
            raise AssertionError("The normal Keycloak login/consent form was not returned")
        fields = dict(form.fields)
        if 'type="password"' in html.decode() or 'name="password"' in html.decode():
            fields.update(username=self.user, password=self.settings[self.password_key])
        else:
            fields["accept"] = "Yes"
        return self.request(urljoin(self.base, form.action), "POST", urlencode(fields).encode(),
                            {"Content-Type": "application/x-www-form-urlencoded"})

    def login_web(self):
        status, html, _ = self.request(self.base + "/oauth2/start?rd=/tasks")
        if status != 200:
            raise AssertionError("OIDC login did not return a page")
        if b"<form" in html:
            self.submit_login(html)
        status, me = self.api("/api/me")
        if status != 200:
            raise AssertionError(f"OIDC cabinet login returned {status}")
        return me

    def login_mcp(self):
        self.close_mcp()
        status, raw, _ = self.request(self.base + "/.well-known/oauth-protected-resource/mcp")
        if status != 200:
            raise AssertionError(f"Protected resource discovery returned {status}")
        metadata = json.loads(raw)
        if metadata.get("resource") != self.base + "/mcp":
            raise AssertionError("Discovery returned an incorrect public resource identifier")
        issuers = metadata.get("authorization_servers", [])
        if issuers != [self.base + "/auth/realms/helmglass"]:
            raise AssertionError("Discovery did not identify the configured authorization server")
        status, raw, _ = self.request(issuers[0] + "/.well-known/openid-configuration")
        if status != 200:
            raise AssertionError(f"Authorization server discovery returned {status}")
        discovery = json.loads(raw)
        if discovery.get("issuer") != issuers[0] or "S256" not in discovery.get("code_challenge_methods_supported", []):
            raise AssertionError("Authorization server identity or PKCE support does not match the contract")
        authorization_endpoint = discovery["authorization_endpoint"]
        self.token_endpoint = discovery["token_endpoint"]
        if not all(endpoint.startswith(issuers[0] + "/") for endpoint in (authorization_endpoint, self.token_endpoint)):
            raise AssertionError("Authorization endpoints do not belong to the discovered issuer")
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        redirect = "https://chatgpt.com/connector_platform_oauth_redirect"
        state = secrets.token_urlsafe(24)
        query = urlencode({"client_id": "helmglass-chatgpt", "redirect_uri": redirect,
                           "response_type": "code", "scope": "openid profile email offline_access",
                           "code_challenge": challenge, "code_challenge_method": "S256",
                           "state": state, "resource": self.base + "/mcp"})
        status, page, headers = self.request(authorization_endpoint + "?" + query)
        for _ in range(3):
            if status in (302, 303) and headers.get("Location", "").startswith(redirect):
                break
            status, page, headers = self.submit_login(page)
        callback = parse_qs(urlparse(headers.get("Location", "")).query)
        if callback.get("state") != [state] or "code" not in callback:
            raise AssertionError("PKCE authorization code was not returned")
        data = urlencode({"client_id": "helmglass-chatgpt", "grant_type": "authorization_code",
                          "redirect_uri": redirect, "code": callback["code"][0],
                          "code_verifier": verifier, "resource": self.base + "/mcp"}).encode()
        status, raw, _ = self.request(self.token_endpoint,
                                      "POST", data, {"Content-Type": "application/x-www-form-urlencoded"})
        if status != 200:
            raise AssertionError(f"PKCE token exchange returned {status}")
        tokens = json.loads(raw)
        self.token = tokens["access_token"]
        self.refresh_token = tokens["refresh_token"]

    def api(self, path, method="GET", body=None, key=None):
        csrf = next((cookie.value for cookie in self.cookies if cookie.name == "XSRF-TOKEN"), "")
        headers = {"Content-Type": "application/json", "X-XSRF-TOKEN": csrf,
                   "Idempotency-Key": key or str(uuid.uuid4())}
        status, raw, _ = self.request(self.base + path, method,
                                      None if body is None else json.dumps(body).encode(), headers)
        return status, json.loads(raw) if raw and raw[:1] in (b"{", b"[") else {}

    def mcp_headers(self):
        headers = {"Authorization": "Bearer " + self.token,
                   "Accept": "application/json, text/event-stream",
                   "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25"}
        if self.mcp_session:
            headers["Mcp-Session-Id"] = self.mcp_session
        return headers

    def return_control_without_continuing(self, task_id):
        """Enter internal PAUSED through a real manual handoff of a live browser."""
        path = "/api/tasks/" + task_id
        viewer = str(uuid.uuid4())
        for kind, expected_owner in (("TAKE_CONTROL", "USER"), ("RETURN_CONTROL", "CHATGPT")):
            status, task = self.api(path)
            if status != 200:
                raise AssertionError((status, task))
            status, receipt = self.api(path + "/commands", "POST", {
                "type": kind, "expectedVersion": task["version"], "viewerId": viewer,
                "resume": False})
            if status != 200:
                raise AssertionError((status, receipt))
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                status, task = self.api(path)
                if status != 200:
                    raise AssertionError((status, task))
                if task["browser"]["controlOwner"] == expected_owner:
                    break
                time.sleep(.2)
            else:
                raise AssertionError("Manual control transfer was not confirmed")
        if task["status"] != "PAUSED":
            raise AssertionError(task["status"])
        return task

    def observe_task_browser(self, task_id):
        """Explicitly start and finish a read before testing browser lifetime transitions."""
        if self.token is None:
            self.login_mcp()
        status, task = self.api("/api/tasks/" + task_id)
        if status != 200:
            raise AssertionError((status, task))
        if not task["chatBound"]:
            error, receipt, _ = self.tool("tasks.bind", {
                "taskId": task_id, "operationKey": str(uuid.uuid4())})
            if error:
                raise AssertionError(receipt)
        operation = str(uuid.uuid4())
        action = {"operationId": operation, "type": "observe", "arguments": {},
                  "instructionRevision": task["instructionRevision"]}
        if task.get("browser"):
            action["controlEpoch"] = task["browser"]["controlEpoch"]
        error, receipt, _ = self.execute_in_scenario_step({"taskId": task_id, "action": action})
        if error:
            raise AssertionError(receipt)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            error, receipt, _ = self.tool("operations.get", {"operationId": operation})
            if error:
                raise AssertionError(receipt)
            if receipt["status"] not in ("ACCEPTED", "DISPATCHED"):
                break
            time.sleep(.2)
        if receipt["status"] != "SUCCEEDED":
            raise AssertionError(receipt)
        self.complete_scenario_step(task_id, operation)
        return self.api("/api/tasks/" + task_id)[1]

    def close_mcp(self):
        if self.mcp_session:
            self.request(self.base + "/mcp", "DELETE", headers=self.mcp_headers())
            self.mcp_session = None

    def rpc(self, method, params, *, reinitialize=True):
        if method != "initialize" and self.mcp_session is None:
            self.rpc("initialize", {"protocolVersion": "2025-11-25",
                "capabilities": self.mcp_capabilities,
                "clientInfo": {"name": "helm-dev-contract", "version": "1"}})
            self.request(self.base + "/mcp", "POST", json.dumps({"jsonrpc": "2.0",
                "method": "notifications/initialized"}).encode(), self.mcp_headers())
        body = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params}
        request = Request(self.base + "/mcp", data=json.dumps(body).encode(), method="POST",
                          headers=self.mcp_headers())
        try:
            opened = self.http.open(request, timeout=55)
        except HTTPError as error:
            opened = error
        with opened:
            if opened.status == 404 and self.mcp_session and method != 'initialize' and reinitialize:
                # Streamable HTTP requires a fresh transport after an expired server session.
                # The tool operation identity stays unchanged; timeouts are never replayed.
                opened.close()
                self.mcp_session = None
                return self.rpc(method, params, reinitialize=False)
            if opened.status != 200:
                raise AssertionError(f"MCP {method} returned HTTP {opened.status}")
            if method == "initialize":
                self.mcp_session = opened.headers.get("Mcp-Session-Id")
                if not self.mcp_session:
                    raise AssertionError("MCP initialize omitted transport session")
            if "text/event-stream" not in opened.headers.get("Content-Type", ""):
                response = json.load(opened)
            else:
                response = None
                data = []
                for line in opened:
                    if line.startswith(b"data:"):
                        data.append(line[5:].strip())
                    elif line.strip() == b"" and data:
                        message = json.loads(b"\n".join(data))
                        data = []
                        if message.get("method") == "elicitation/create":
                            if self.elicitation_handler is None:
                                answer = {"action": "cancel"}
                            else:
                                answer = self.elicitation_handler(message["params"])
                            status, _, _ = self.request(self.base + "/mcp", "POST",
                                json.dumps({"jsonrpc": "2.0", "id": message["id"],
                                            "result": answer}).encode(), self.mcp_headers())
                            if status != 202:
                                raise AssertionError(f"MCP host response returned HTTP {status}")
                        elif message.get("id") == body["id"]:
                            response = message
                            break
                if response is None:
                    raise AssertionError("MCP stream ended without the request result")
        if "error" in response:
            raise AssertionError(f"MCP {method} returned protocol error {response['error']['code']}")
        return response["result"]

    def respond(self, task, content=None, action="accept", operation_key=None):
        pending = task["request"]
        arguments = {"taskId": task["id"], "requestId": pending["id"],
            "requestVersion": pending["version"], "operationKey": operation_key or str(uuid.uuid4())}
        if pending["type"] == "UNKNOWN_RESULT" and action == "accept" and content is not None:
            observation = content.get("observationOperationId")
            if observation is None:
                observation = str(uuid.uuid4())
                error, receipt, _ = self.execute_in_scenario_step({"taskId": task["id"], "action": {
                    "operationId": observation, "type": "observe", "arguments": {},
                    "instructionRevision": task["instructionRevision"], "observeAfter": False}})
                if error:
                    return error, receipt, None
                deadline = time.monotonic() + 60
                while receipt["status"] in ("ACCEPTED", "DISPATCHED") and time.monotonic() < deadline:
                    time.sleep(.2)
                    error, receipt, _ = self.tool("operations.get", {"operationId": observation})
                    if error:
                        return error, receipt, None
                if receipt["status"] != "SUCCEEDED":
                    raise AssertionError(receipt)
            arguments["verification"] = {**content, "observationOperationId": observation}
            return self.tool("tasks.respond", arguments)
        previous = self.elicitation_handler
        self.elicitation_handler = lambda form: {"action": action, **({"content": content} if content is not None else {})}
        try:
            return self.tool("tasks.respond", arguments)
        finally:
            self.elicitation_handler = previous

    def refresh_mcp(self):
        data = urlencode({"grant_type": "refresh_token", "client_id": "helmglass-chatgpt",
                          "refresh_token": self.refresh_token}).encode()
        status, raw, _ = self.request(self.token_endpoint,
                                      "POST", data, {"Content-Type": "application/x-www-form-urlencoded"})
        if status == 200:
            value = json.loads(raw)
            self.token = value["access_token"]
            self.refresh_token = value.get("refresh_token", self.refresh_token)
        return status

    def scenario_step(self, task_id):
        """Explicit business-step fixture for pre-existing browser acceptance scenarios."""
        error, page, _ = self.tool("steps.list", {"taskId": task_id})
        if error:
            raise AssertionError(f"Cannot read scenario step: {page}")
        step = next((item for item in page["items"]
                     if item["operationKey"] == "verify-acceptance-scenario"), None)
        error, task, _ = self.tool("tasks.get", {"taskId": task_id})
        if error:
            raise AssertionError(f"Cannot read scenario task: {task}")

        def command(kind, **fields):
            error, result, _ = self.tool("steps.command", {
                "taskId": task_id, "operationKey": str(uuid.uuid4()), "command": {
                    "type": kind, "instructionRevision": task["instructionRevision"], **fields}})
            if error:
                raise AssertionError(f"Cannot {kind} scenario step: {result}")
            return result

        if step is None:
            step = command("DECLARE", operationKey="verify-acceptance-scenario", objectKey=task_id,
                           title="Проверить условия сценария приёмки",
                           completionCriterion="Результаты действий соответствуют проверяемому сценарию")
        if task["status"] in ("QUEUED", "RUNNING", "STARTING", "WAITING_CHATGPT"):
            if step["status"] == "PLANNED":
                step = command("START", stepId=step["id"], expectedVersion=step["version"])
            elif step["status"] in ("FAILED", "PARTIAL", "SKIPPED"):
                step = command("RETRY", stepId=step["id"], expectedVersion=step["version"])
        return step

    def execute_in_scenario_step(self, arguments):
        action = arguments["action"]
        if "stepId" not in action:
            action["stepId"] = self.scenario_step(arguments["taskId"])["id"]
            if "controlEpoch" not in action:
                error, task, _ = self.tool("tasks.get", {"taskId": arguments["taskId"]})
                if error:
                    raise AssertionError(f"Cannot read scenario browser: {task}")
                if task.get("browser"):
                    action["controlEpoch"] = task["browser"]["controlEpoch"]
        return self.tool("browser.execute", arguments)

    def browser_observation(self, task_id, step_id=None, navigate=None):
        deadline = time.monotonic() + 60
        while True:
            error, task, _ = self.tool("tasks.get", {"taskId": task_id})
            if error:
                raise AssertionError(task)
            if task.get("browser") and task["browser"]["status"] == "LIVE":
                break
            if time.monotonic() > deadline:
                raise AssertionError("Browser did not become live")
            time.sleep(.2)
        step_id = step_id or self.scenario_step(task_id)["id"]
        operation = str(uuid.uuid4())
        error, receipt, _ = self.tool("browser.execute", {"taskId": task_id, "action": {
            "operationId": operation, "stepId": step_id, "type": "navigate" if navigate else "observe",
            "arguments": {"url": navigate} if navigate else {},
            "instructionRevision": task["instructionRevision"], "controlEpoch": task["browser"]["controlEpoch"]}})
        while not error and receipt["status"] in ("ACCEPTED", "DISPATCHED") and time.monotonic() < deadline:
            time.sleep(.2)
            error, receipt, _ = self.tool("operations.get", {"operationId": operation})
        if error or receipt["status"] != "SUCCEEDED":
            raise AssertionError(receipt)
        return receipt["result"]["observation"] if navigate else receipt["result"]

    def browser_fixture_url(self):
        if not hasattr(self, '_browser_fixture_url'):
            filename = 'execution-' + uuid.uuid4().hex + '.html'
            destination = '/usr/share/nginx/html/' + filename
            docker = ['docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375']
            html = (Path(__file__).parent / 'fixtures' / 'browser-execution.html').read_text(encoding='utf-8')
            subprocess.run(docker + ['exec', '-i', '-u', '0', 'helmglass-frontend-1', 'sh', '-c',
                'cat > ' + destination], input=html, encoding='utf-8', capture_output=True, check=True, timeout=20)
            atexit.register(subprocess.run, docker + ['exec', '-u', '0', 'helmglass-frontend-1',
                'rm', '-f', destination], capture_output=True, timeout=20)
            self._browser_fixture_url = self.base + '/' + filename
        return self._browser_fixture_url

    def browser_target(self, task_id, name, step_id=None, uncertain=False):
        """Select only a reference actually issued by the deployed browser contract."""
        navigate = self.browser_fixture_url() if uncertain else None
        observation = self.browser_observation(task_id, step_id, navigate)
        nodes = [entry['node'] for entry in observation['snapshot'] if isinstance(entry['node'], dict)
                 and entry['node'].get('name') == name and entry['node'].get('ref')]
        if len(nodes) != 1:
            raise AssertionError('Expected one native reference for ' + name)
        return {'observationId': observation['observationId'], 'ref': nodes[0]['ref']}

    def complete_scenario_step(self, task_id, operation_id, outcome="SUCCEEDED"):
        step = self.scenario_step(task_id)
        error, task, _ = self.tool("tasks.get", {"taskId": task_id})
        if error:
            raise AssertionError(f"Cannot read scenario task: {task}")
        error, result, _ = self.tool("steps.command", {
            "taskId": task_id, "operationKey": str(uuid.uuid4()), "command": {
                "type": "COMPLETE", "stepId": step["id"], "expectedVersion": step["version"],
                "instructionRevision": task["instructionRevision"], "outcome": outcome,
                "result": "Результат проверяемого действия зафиксирован",
                "evidence": [{"type": "OPERATION", "operationId": operation_id}]}})
        if error:
            raise AssertionError(f"Cannot complete scenario step: {result}")
        return result

    def tool(self, name, arguments):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments,
                                          "_meta": {"openai/session": self.chat}})
        if "structuredContent" in result:
            return result.get("isError", False), result["structuredContent"], result
        content = next((item["text"] for item in result.get("content", []) if item.get("type") == "text"), "{}")
        try:
            value = json.loads(content)
        except json.JSONDecodeError:
            value = {"message": content}
        return result.get("isError", False), value, result


class DisposableIdentity:
    """Creates only a test-owned Keycloak USER; never changes managed test/admin identities."""

    def __init__(self, settings, template_id):
        self.settings = settings
        self.base = settings["PUBLIC_URL"].rstrip("/")
        self.http = build_opener()
        body = urlencode({"grant_type": "client_credentials", "client_id": "helmglass-lifecycle",
                          "client_secret": settings["KEYCLOAK_LIFECYCLE_SECRET"]}).encode()
        request = Request(self.base + "/auth/realms/helmglass/protocol/openid-connect/token", data=body,
                          headers={"Content-Type": "application/x-www-form-urlencoded"})
        with self.http.open(request, timeout=25) as response:
            self.token = json.load(response)["access_token"]
        self.username = "dev-contract-" + uuid.uuid4().hex[:16]
        self.password = secrets.token_urlsafe(32)
        status, _, headers = self.admin("/users", "POST", {"username": self.username,
            "email": self.username + "@example.com", "firstName": "Dev", "lastName": "Contract",
            "enabled": True, "emailVerified": True, "requiredActions": [],
            "credentials": [{"type": "password", "value": self.password, "temporary": False}]})
        if status != 201:
            raise AssertionError(f"Disposable identity creation returned {status}")
        self.id = headers["Location"].rsplit("/", 1)[1]
        uuid.UUID(self.id)
        status, roles, _ = self.admin("/users/" + template_id + "/role-mappings/realm")
        allowed = [role for role in roles if role.get("name") == "USER"]
        if status != 200 or len(allowed) != 1:
            raise AssertionError("The managed USER role could not be read for the disposable fixture")
        status, _, _ = self.admin("/users/" + self.id + "/role-mappings/realm", "POST", allowed)
        if status != 204:
            raise AssertionError(f"Disposable USER role assignment returned {status}")

    def admin(self, path, method="GET", body=None):
        # Keycloak administration has no public route. Use its existing internal network.
        config = '\n'.join([
            "url = " + json.dumps("http://keycloak:8080/auth/admin/realms/helmglass" + path),
            "request = " + json.dumps(method),
            "header = " + json.dumps("Authorization: Bearer " + self.token),
            "header = " + json.dumps("Content-Type: application/json"),
            *( [] if body is None else ["data = " + json.dumps(json.dumps(body))] )])
        command = ["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375", "exec", "-i",
                   "helmglass-api-1", "curl", "--silent", "--show-error", "--max-time", "25",
                   "--write-out", "\n%{http_code}\n%header{location}", "--config", "-"]
        completed = subprocess.run(command, input=config, text=True, capture_output=True, timeout=35)
        if completed.returncode != 0:
            raise AssertionError("The internal Keycloak fixture administration request failed")
        raw, status, location = completed.stdout.rsplit("\n", 2)
        return int(status), json.loads(raw) if raw else {}, {"Location": location}

    def client(self):
        values = {**self.settings, "DISPOSABLE_PASSWORD": self.password}
        return DevClient(values, self.username, "DISPOSABLE_PASSWORD")


class DevContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        filename = Path(os.environ.get("HELM_TEST_ENV", "deploy/.env.dev"))
        cls.settings = dict(line.split("=", 1) for line in filename.read_text(encoding="utf-8").splitlines()
                            if line and not line.startswith("#") and "=" in line)
        cls.user = DevClient(cls.settings, "test", "KEYCLOAK_TEST_PASSWORD")
        cls.admin = DevClient(cls.settings, "admin", "KEYCLOAK_APP_ADMIN_PASSWORD")
        cls.me = cls.user.login_web()
        cls.admin.login_web()
        cls.user.login_mcp()

    def setUp(self):
        self.user.chat = "helm-dev-" + str(uuid.uuid4())

    def test_owner_authorization_idempotency_and_draft(self):
        self.assertEqual(403, self.user.api("/api/admin/users")[0])
        self.assertEqual(200, self.admin.api("/api/admin/users")[0])
        body = {"title": "Dev regression draft", "goal": "Verify ownership and durable receipt",
                "startUrl": "https://example.com", "prepare": False}
        key = str(uuid.uuid4())
        status, created = self.user.api("/api/tasks", "POST", body, key)
        self.assertEqual(200, status)
        try:
            status, duplicate = self.user.api("/api/tasks", "POST", body, key)
            self.assertEqual(200, status)
            self.assertEqual(created["id"], duplicate["id"])
            self.assertEqual(409, self.user.api("/api/tasks", "POST", {**body, "goal": "different"}, key)[0])
            self.assertEqual(404, self.admin.api("/api/tasks/" + created["id"])[0])
            self.assertEqual(409, self.user.api("/api/tasks/" + created["id"] + "/commands", "POST",
                                               {"type": "PREPARE", "expectedVersion": created["version"] - 1})[0])
        finally:
            self.assertEqual(200, self.user.api("/api/tasks/" + created["id"], "DELETE")[0])

    def test_usage_queries_and_admin_detail(self):
        for path in ["/api/usage", "/api/usage?from=2026-01-01&to=2026-12-31",
                     "/api/tasks/summary", "/api/connections/sites"]:
            self.assertEqual(200, self.user.api(path)[0], path)
        status, report = self.user.api("/api/usage?timezone=Europe%2FSaratov&daysPage=1&sitesPage=1&pageSize=10")
        self.assertEqual(200,status)
        for field in ("days","sites"):
            self.assertLessEqual(len(report[field]["items"]),10)
            self.assertEqual(10,report[field]["pageSize"])
            self.assertGreaterEqual(report[field]["total"],len(report[field]["items"]))
        self.assertEqual(400,self.user.api("/api/usage?timezone=invalid-timezone")[0])
        self.assertEqual(400,self.user.api("/api/usage?pageSize=999")[0])
        self.assertEqual(200, self.admin.api("/api/admin/users/" + self.me["id"])[0])

    def test_web_logout_preserves_mcp_and_revoke_requires_new_grant(self):
        identity = DisposableIdentity(self.settings, self.me["id"])
        self.addCleanup(self.purge_identity, identity)
        client = identity.client()
        client.login_web()
        client.login_mcp()
        self.assertIn("tools", client.rpc("tools/list", {}))
        status, receipt = client.api("/api/auth/logout", "POST", {})
        self.assertEqual(200, status)
        client.request(urljoin(client.base, receipt["redirectUrl"]))
        self.assertIn("tools", client.rpc("tools/list", {}))
        self.assertEqual(200, client.refresh_mcp(), "The independent offline grant must survive WEB SSO logout")
        self.assertIn("tools", client.rpc("tools/list", {}))
        client.login_web()
        status, _ = client.api("/api/integrations/chatgpt/revoke", "POST", {})
        self.assertEqual(200, status)
        with self.assertRaisesRegex(AssertionError, "HTTP 403"):
            client.rpc("tools/list", {})
        if client.refresh_mcp() == 200:
            with self.assertRaisesRegex(AssertionError, "HTTP 403"):
                client.rpc("tools/list", {})
        # auth_time has whole-second precision; ensure the new grant is strictly after revocation.
        time.sleep(1.1)
        client.login_mcp()
        self.assertIn("tools", client.rpc("tools/list", {}))

    def purge_identity(self, identity):
        endpoint = "/api/admin/users/" + identity.id
        status, detail = self.admin.api(endpoint)
        self.assertEqual(200, status)
        if detail["user"]["status"] in ("ACTIVE", "BLOCKED"):
            self.assertEqual(200, self.admin.api(endpoint + "/commands", "POST", {
                "type": "REQUEST_DELETION", "expectedVersion": detail["user"]["version"],
                "reason": "Remove disposable acceptance identity"})[0])
        self.fixture_sql(identity, "UPDATE accounts SET deletion_due_at=clock_timestamp() WHERE id=:owner;")
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if self.admin.api(endpoint)[1]["user"]["status"] == "DELETED":
                return
            time.sleep(.5)
        self.fail("Disposable identity purge was not confirmed")

    def fixture_sql(self, identity, statement):
        owner = str(uuid.UUID(identity.id))
        command = ["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375", "exec", "-i",
                   "helmglass-postgres-1", "psql", "-U", "postgres", "-d", "helmglass", "-At",
                   "-v", "ON_ERROR_STOP=1"]
        guard = "SELECT email FROM accounts WHERE id='" + owner + "';"
        result = subprocess.run(command, input=guard, capture_output=True, text=True, timeout=20)
        self.assertEqual(0, result.returncode)
        self.assertEqual(identity.username + "@example.com", result.stdout.strip())
        result = subprocess.run(command, input=statement.replace(":owner", "'" + owner + "'"),
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(0, result.returncode, "The fixture database operation failed")
        return result.stdout.strip()

    def test_administration_limits_block_and_deletion_boundary(self):
        identity = DisposableIdentity(self.settings, self.me["id"])
        client = identity.client()
        me = client.login_web()
        self.assertEqual(identity.id, me["id"])
        client.login_mcp()
        endpoint = "/api/admin/users/" + identity.id

        def command(kind, **fields):
            status, detail = self.admin.api(endpoint)
            self.assertEqual(200, status)
            return self.admin.api(endpoint + "/commands", "POST",
                                  {"type": kind, "expectedVersion": detail["user"]["version"],
                                   "reason": "Disposable dev contract acceptance", **fields})

        status, _ = command("LIMITS", browserLimitMode="CUSTOM", browserLimit=1, waitingLimit=0)
        self.assertEqual(200, status)
        body = {"title": "Disposable limit draft", "goal": "Verify zero waiting admission limit",
                "startUrl": "https://example.com", "prepare": False}
        status, draft = client.api("/api/tasks", "POST", body)
        self.assertEqual(200, status)
        status, refusal = client.api("/api/tasks/" + draft["id"] + "/commands", "POST",
                                    {"type": "PREPARE", "expectedVersion": draft["version"]})
        self.assertEqual(409, status)
        self.assertEqual("WAITING_LIMIT", refusal["code"])
        status, _ = command("BLOCK")
        self.assertEqual(200, status)
        self.assertEqual(403, client.api("/api/me")[0])
        with self.assertRaisesRegex(AssertionError, "HTTP 403"):
            client.rpc("tools/list", {})
        self.assertEqual(200, command("UNBLOCK")[0])
        self.assertEqual(401, client.api("/api/me")[0], "The old WEB grant must require new authentication after unblock")
        with self.assertRaisesRegex(AssertionError, "HTTP 401"):
            client.rpc("tools/list", {})
        time.sleep(1.1)
        client = identity.client()
        client.login_web()
        client.login_mcp()
        self.assertIn("tools", client.rpc("tools/list", {}))
        started = datetime.now(timezone.utc)
        status, pending = command("REQUEST_DELETION")
        self.assertEqual(200, status)
        due = datetime.fromisoformat(pending["deleteUntil"].replace("Z", "+00:00"))
        self.assertLess(abs((due - started).total_seconds() - 168 * 3600), 5)
        self.assertEqual(403, client.api("/api/me")[0])
        status, restored = command("CANCEL_DELETION")
        self.assertEqual(200, status)
        self.assertEqual("ACTIVE", restored["status"])
        self.assertEqual(200, command("BLOCK")[0])
        self.assertEqual(200, command("REQUEST_DELETION")[0])
        status, restored = command("CANCEL_DELETION")
        self.assertEqual(200, status)
        self.assertEqual("BLOCKED", restored["status"])
        self.assertEqual(200, command("REQUEST_DELETION")[0])
        self.fixture_sql(identity, "UPDATE accounts SET deletion_due_at=clock_timestamp() WHERE id=:owner;")
        status, refusal = command("CANCEL_DELETION")
        self.assertEqual(409, status)
        self.assertEqual("DELETION_EXPIRED", refusal["code"])
        if os.environ.get("HELM_TEST_PURGE_RESTART") == "1":
            # A committed PURGING state represents an interrupted owner. The operator restarts the deployed API.
            self.fixture_sql(identity, "UPDATE accounts SET status='PURGING' WHERE id=:owner;")
            print("Committed disposable PURGING fixture for API restart: " + identity.id, flush=True)
            time.sleep(10)
        deadline = time.monotonic() + 100
        while time.monotonic() < deadline:
            status, detail = self.admin.api(endpoint)
            if status == 200 and detail["user"]["status"] == "DELETED":
                break
            time.sleep(1)
        else:
            self.fail("The durable purge owner did not finish within its bounded two-cycle wait")
        self.assertEqual(404, identity.admin("/users/" + identity.id)[0])
        self.assertEqual("", detail["user"]["email"])
        self.assertEqual(0, detail["tasks"]["total"])
        self.assertGreater(detail["audit"]["total"], 0, "The 365-day administrative audit survives account purge")
        with self.assertRaisesRegex(AssertionError, "HTTP 403"):
            client.rpc("tools/list", {})

    def test_malformed_mcp_keeps_private_payload_out_of_errors_and_logs(self):
        marker = "HELM_PRIVATE_MARKER_" + uuid.uuid4().hex
        requests = [
            {"jsonrpc": "2.0", "id": "privacy", "method": "initialize", "params": {
                "protocolVersion": "2025-11-25", "capabilities": marker,
                "clientInfo": {"name": "contract", "version": "1"}}},
            {"jsonrpc": "2.0", "id": "privacy", "method": "tools/call",
             "params": {"name": "tasks.get", "arguments": marker}}]
        for payload in requests:
            _, raw, _ = self.user.request(self.user.base + "/mcp", "POST", json.dumps(payload).encode(),
                {"Authorization": "Bearer " + self.user.token, "Accept": "application/json, text/event-stream",
                 "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25"})
            self.assertNotIn(marker.encode(), raw)
        logs = subprocess.run(["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
                               "logs", "--since", "30s", "helmglass-api-1"], text=True, capture_output=True, timeout=20)
        self.assertEqual(0, logs.returncode)
        self.assertNotIn(marker, logs.stdout + logs.stderr)

    def test_sse_reconnect_replays_bounded_backlog_then_sync(self):
        def event(stream):
            for _ in range(100):
                line = stream.readline()
                if not line:
                    self.fail("The authorized SSE stream ended before its synchronization marker")
                if line.startswith(b"data:"):
                    return json.loads(line[5:])
            self.fail("The SSE stream did not deliver a bounded metadata event")

        with self.user.http.open(self.user.base + "/api/events", timeout=10) as initial:
            sync = event(initial)
            self.assertEqual("sync", sync["resource"])
        drafts = []
        try:
            # Every real task creation emits task and history changes, crossing the 100-event replay batch.
            for index in range(52):
                status, task = self.user.api("/api/tasks", "POST", {
                    "title": "SSE replay draft " + str(index), "goal": "Bounded committed event replay", "prepare": False})
                self.assertEqual(200, status)
                drafts.append(task["id"])
            seen = set()
            last = sync["id"]
            count = 0
            with self.user.http.open(self.user.base + "/api/events?cursor=" + str(last), timeout=10) as replay:
                for _ in range(1000):
                    change = event(replay)
                    self.assertGreaterEqual(change["id"], last)
                    last = change["id"]
                    if change["resource"] == "sync":
                        break
                    count += 1
                    if change["resource"] == "task":
                        seen.add(change["entityId"])
                else:
                    self.fail("SSE replay did not deliver its completion marker")
            self.assertGreater(count, 100)
            self.assertTrue(set(drafts).issubset(seen))
            with self.user.http.open(self.user.base + "/api/events?cursor=" + str(last), timeout=10) as resumed:
                self.assertEqual("sync", event(resumed)["resource"])
                status, task = self.user.api("/api/tasks", "POST", {
                    "title": "SSE live draft", "goal": "Push from another HTTP request", "prepare": False})
                self.assertEqual(200, status)
                drafts.append(task["id"])
                delivered = [event(resumed) for _ in range(2)]
                self.assertTrue(any(change["entityId"] == task["id"] for change in delivered))
        finally:
            for task_id in drafts:
                self.assertEqual(200, self.user.api("/api/tasks/" + task_id, "DELETE")[0])

    def test_concurrent_admission_limits_and_per_owner_fifo(self):
        identities = [DisposableIdentity(self.settings, self.me["id"]) for _ in range(2)]
        owners = []
        entries = []
        try:
            for identity in identities:
                primary = identity.client()
                primary.login_web()
                primary.login_mcp()
                endpoint = "/api/admin/users/" + identity.id
                status, detail = self.admin.api(endpoint)
                self.assertEqual(200,status)
                self.assertEqual(200,self.admin.api(endpoint + "/commands","POST", {
                    "type":"LIMITS","expectedVersion":detail["user"]["version"],
                    "reason":"Disposable concurrent admission acceptance", "browserLimitMode":"CUSTOM",
                    "browserLimit":1,"waitingLimit":None})[0])
                queue = []
                for index in range(3):
                    client = identity.client()
                    client.token = primary.token
                    error,presentation,_ = client.tool("tasks.create",{"operationKey":str(uuid.uuid4()),"task":{
                        "title":"FIFO task " + str(index),"goal":"Verify bounded admission without site changes",
                        "startUrl":"https://example.com","prepare":True}})
                    self.assertFalse(error,presentation)
                    entry = {"client":client,"task":presentation["task"],"primary":primary,"operationId":str(uuid.uuid4())}
                    entries.append(entry)
                    queue.append(entry)
                owners.append((identity,primary,queue))

            def enqueue(queue):
                for entry in queue:
                    error,receipt,_ = entry["client"].execute_in_scenario_step({"taskId":entry["task"]["id"],"action":{
                        "operationId":entry["operationId"],"type":"observe","arguments":{},
                        "instructionRevision":entry["task"]["instructionRevision"]}})
                    self.assertFalse(error,receipt)

            with ThreadPoolExecutor(max_workers=2) as parallel:
                list(parallel.map(enqueue,[owner[2] for owner in owners]))
            deadline = time.monotonic()+100
            while time.monotonic()<deadline:
                ready = True
                for identity,primary,queue in owners:
                    _,detail = self.admin.api("/api/admin/users/"+identity.id)
                    self.assertLessEqual(detail["user"]["browserCount"],1,"Concurrent starts exceeded the account limit")
                    states = [primary.api("/api/tasks/"+entry["task"]["id"])[1] for entry in queue]
                    ready = ready and states[0].get("browser") is not None and states[0]["browser"]["status"]=="LIVE"
                    ready = ready and all(value.get("browser") is not None and value["browser"]["status"]=="QUEUED" for value in states[1:])
                if ready:
                    break
                time.sleep(0.5)
            self.assertTrue(ready,"Both owners must make progress while additional work stays queued")
            for _,_,queue in owners:
                self.assertEqual("SUCCEEDED",self.wait_operation(queue[0]["operationId"],queue[0]["client"])["status"])

            def stop(entry):
                _,task = entry["primary"].api("/api/tasks/"+entry["task"]["id"])
                status,_ = entry["primary"].api("/api/tasks/"+task["id"]+"/commands","POST",{
                    "type":"STOP","expectedVersion":task["version"]})
                self.assertEqual(200,status)

            with ThreadPoolExecutor(max_workers=2) as parallel:
                list(parallel.map(stop,[owner[2][0] for owner in owners]))
            for identity,primary,queue in owners:
                self.assertEqual("SUCCEEDED",self.wait_operation(queue[1]["operationId"],queue[1]["client"])["status"])
                _,third = primary.api("/api/tasks/"+queue[2]["task"]["id"])
                self.assertEqual("QUEUED",third["browser"]["status"],"The later task must not overtake FIFO work")
                _,detail = self.admin.api("/api/admin/users/"+identity.id)
                self.assertLessEqual(detail["user"]["browserCount"],1)
        finally:
            for identity in identities:
                endpoint = "/api/admin/users/"+identity.id
                status,detail = self.admin.api(endpoint)
                if status==200 and detail["user"]["status"] in ("ACTIVE","BLOCKED"):
                    status,_ = self.admin.api(endpoint+"/commands","POST",{
                        "type":"REQUEST_DELETION","expectedVersion":detail["user"]["version"],
                        "reason":"Remove disposable admission acceptance identity"})
                    self.assertEqual(200,status)
                    self.fixture_sql(identity,"UPDATE accounts SET deletion_due_at=clock_timestamp() WHERE id=:owner;")
            deadline = time.monotonic()+100
            while time.monotonic()<deadline:
                if all(self.admin.api("/api/admin/users/"+identity.id)[1].get("user",{}).get("status")=="DELETED" for identity in identities):
                    break
                time.sleep(1)
            else:
                self.fail("Disposable concurrent fixtures were not purged")

    def test_mcp_revision_and_final_stop(self):
        initialized = self.user.rpc("initialize", {"protocolVersion": "2025-11-25",
                                                   "capabilities": {}, "clientInfo": {"name": "helm-dev-regression", "version": "1"}})
        self.assertIn("serverInfo", initialized)
        tools = self.user.rpc("tools/list", {})
        self.assertIn("browser.execute", {item["name"] for item in tools["tools"]})
        error, presentation, _ = self.user.tool("tasks.create", {"operationKey": str(uuid.uuid4()),
            "task": {"title": "Dev regression task", "goal": "Verify revisions and stop consent",
                     "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error)
        task = presentation.get("task", presentation)
        self.assertIn("id", task)
        task_id = task["id"]
        try:
            error, refusal, _ = self.user.tool("results.publish", {"taskId": task_id,
                "operationKey": str(uuid.uuid4()), "instructionRevision": task["instructionRevision"] + 1,
                "result": {"summary": "stale"}, "rows": []})
            self.assertTrue(error)
            self.assertEqual("STALE_INSTRUCTION", refusal["code"])
            error, answered, _ = self.user.tool("tasks.ask", {"taskId": task_id,
                "operationKey": str(uuid.uuid4()), "instructionRevision": task["instructionRevision"],
                "prompt": "Confirm test input"})
            self.assertFalse(error)
            self.assertEqual("WAITING_USER", answered["status"])
            task = answered
        finally:
            _, task = self.user.api("/api/tasks/" + task_id)
            status, stopped = self.user.api("/api/tasks/" + task_id + "/commands", "POST",
                {"type": "STOP", "expectedVersion": task["version"]})
            self.assertEqual(200, status)
            status, refusal = self.user.api("/api/tasks/" + task_id + "/commands", "POST",
                {"type": "RESUME", "expectedVersion": stopped["version"]})
            self.assertEqual(409, status)
            self.assertEqual("ACTION_UNAVAILABLE", refusal["code"])

    def wait_task(self, task_id, predicate, seconds=100):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            status, task = self.user.api("/api/tasks/" + task_id)
            self.assertEqual(200, status)
            if predicate(task):
                return task
            time.sleep(0.5)
        self.fail("The expected task transition was not confirmed within the bounded wait")

    def wait_operation(self, operation_id, client=None):
        client = client or self.user
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            error, receipt, _ = client.tool("operations.get", {"operationId": operation_id})
            self.assertFalse(error)
            if receipt["status"] not in ("ACCEPTED", "DISPATCHED"):
                return receipt
            time.sleep(0.3)
        self.fail("The accepted operation did not settle within its bounded wait")

    def test_confirmation_is_bound_to_current_instruction_and_operation(self):
        error, state, _ = self.user.tool("tasks.create", {"operationKey": str(uuid.uuid4()),
            "task": {"title": "Confirmation regression", "goal": "Open exactly one approved extra tab",
                     "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error)
        task = state["task"]
        task_id = task["id"]
        try:
            old_id = str(uuid.uuid4())
            error, pending, _ = self.user.execute_in_scenario_step({"taskId": task_id,
                "action": {"operationId": old_id, "type": "newTab", "confirmationPrompt": "Open the additional tab?", "arguments": {"url": "https://example.com"},
                           "instructionRevision": task["instructionRevision"]}})
            self.assertFalse(error)
            self.assertEqual("AWAITING_CONFIRMATION", pending["status"])
            _, task = self.user.api("/api/tasks/" + task_id)
            old_request = task["request"]
            self.assertIsNotNone(task["browser"], "Task creation prepares the browser before a decision")
            error, task, _ = self.user.tool("tasks.command", {"taskId": task_id,
                "operationKey": str(uuid.uuid4()), "command": {
                "type": "AMEND", "expectedVersion": task["version"], "title": task["title"],
                "goal": "Revised instruction: open one approved tab", "startUrl": "https://example.com",
                "preferredConnectionIds": []}})
            self.assertFalse(error, task)
            error, refusal, _ = self.user.tool("tasks.respond", {"taskId": task_id,
                "operationKey": str(uuid.uuid4()), "requestId": old_request["id"],
                "requestVersion": old_request["version"]})
            self.assertTrue(error)
            self.assertEqual("STALE_REQUEST", refusal["code"])
            error, cancelled, _ = self.user.tool("operations.get", {"operationId": old_id})
            self.assertFalse(error)
            self.assertEqual("CANCELLED", cancelled["status"])
            new_id = str(uuid.uuid4())
            error, pending, _ = self.user.execute_in_scenario_step({"taskId": task_id,
                "action": {"operationId": new_id, "type": "newTab", "confirmationPrompt": "Open the additional tab?", "arguments": {"url": "https://example.com"},
                           "instructionRevision": task["instructionRevision"]}})
            self.assertFalse(error)
            self.assertEqual("AWAITING_CONFIRMATION", pending["status"])
            _, task = self.user.api("/api/tasks/" + task_id)
            current = task["request"]
            key = str(uuid.uuid4())
            self.assertFalse(self.user.respond(task, {"proceed": True}, operation_key=key)[0])
            self.assertFalse(self.user.tool("tasks.respond", {"taskId": task_id,
                "requestId": current["id"], "requestVersion": current["version"], "operationKey": key})[0])
            task = self.wait_task(task_id, lambda value: value.get("browser") is not None
                and value["browser"]["status"] == "LIVE" and value["status"] == "WAITING_CHATGPT")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                error, receipt, _ = self.user.tool("operations.get", {"operationId": new_id})
                self.assertFalse(error)
                if receipt["status"] == "SUCCEEDED":
                    break
                time.sleep(0.5)
            self.assertEqual("SUCCEEDED", receipt["status"])
            _, task = self.user.api("/api/tasks/" + task_id)
            observation_id = str(uuid.uuid4())
            error, _, _ = self.user.execute_in_scenario_step({"taskId": task_id, "action": {
                "operationId": observation_id, "type": "observe", "arguments": {},
                "instructionRevision": task["instructionRevision"], "controlEpoch": task["browser"]["controlEpoch"]}})
            self.assertFalse(error)
            observed = self.wait_operation(observation_id)
            self.assertEqual("SUCCEEDED", observed["status"])
            self.assertEqual(2, len(observed["result"]["tabs"]))
            _, task = self.user.api("/api/tasks/" + task_id)
            old_browser = task["browser"]["id"]
            self.assertNotIn("END_SESSION", task["allowedCommands"])
            status, stopped = self.user.api("/api/tasks/" + task_id + "/commands", "POST", {
                "type": "STOP", "expectedVersion": task["version"]})
            self.assertEqual(200, status)
            task = self.wait_task(task_id, lambda value: value["status"] == "STOPPED")
            self.assertEqual("CLOSED", task["browser"]["status"])
            self.assertEqual(409, self.user.api("/api/browser-sessions/" + old_browser + "/ticket", "POST",
                {"role": "VIEWER", "viewerId": str(uuid.uuid4())})[0])
            for consent in (False, True):
                status, refusal = self.user.api("/api/tasks/" + task_id + "/commands", "POST", {
                    "type": "RESUME", "expectedVersion": task["version"], "confirmBrowserLoss": consent})
                self.assertEqual((409, "ACTION_UNAVAILABLE"), (status, refusal["code"]))

        finally:
            _, task = self.user.api("/api/tasks/" + task_id)
            self.assertEqual(200, self.user.api("/api/tasks/" + task_id + "/commands", "POST",
                {"type": "STOP", "expectedVersion": task["version"]})[0])
            self.wait_task(task_id, lambda value: value["status"] == "STOPPED")

    def test_browser_control_private_unknown_and_widget_generation(self):
        error, state, _ = self.user.tool("tasks.create", {"operationKey": str(uuid.uuid4()),
            "task": {"title": "Dev regression browser", "goal": "Verify shared browser safety on example.com",
                     "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error)
        task = state["task"]
        task_id = task["id"]
        saved_connection = None
        try:
            show_key = str(uuid.uuid4())
            error, current, _ = self.user.tool("tasks.view", {"taskId": task_id, "operationKey": show_key})
            self.assertFalse(error)
            error, repeated, _ = self.user.tool("tasks.view", {"operationKey": show_key, "taskId": task_id})
            self.assertFalse(error, "JSON object key order must not change command identity")
            self.assertEqual(current["generation"], repeated["generation"])
            error, stale, _ = self.user.tool("widget.state", {"taskId": task_id, "generation": state["generation"]})
            self.assertFalse(error)
            self.assertEqual("STALE_WIDGET", stale["code"])
            observation_id = str(uuid.uuid4())
            action = {"operationId": observation_id, "type": "observe", "arguments": {},
                      "instructionRevision": task["instructionRevision"]}
            error, _, _ = self.user.execute_in_scenario_step({"taskId": task_id, "action": action})
            self.assertFalse(error)
            task = self.wait_task(task_id, lambda value: value.get("browser") is not None
                and value["browser"]["status"] == "LIVE" and value["status"] == "WAITING_CHATGPT")
            self.assertEqual("SUCCEEDED", self.wait_operation(observation_id)["status"])
            _, task = self.user.api("/api/tasks/" + task_id)
            original_browser = task["browser"]["id"]
            original_epoch = task["browser"]["controlEpoch"]
            viewer = str(uuid.uuid4())
            status, _ = self.user.api("/api/browser-sessions/" + original_browser + "/ticket", "POST",
                                       {"role": "VIEWER", "viewerId": viewer})
            self.assertEqual(200, status)
            for control in ["TAKE_CONTROL", "BEGIN_LOGIN"]:
                status, task = self.user.api("/api/tasks/" + task_id + "/commands", "POST",
                    {"type": control, "expectedVersion": task["version"], "viewerId": viewer})
                self.assertEqual(200, status, task)
                task = self.wait_task(task_id, lambda value: value["browser"]["controlOwner"] == "USER")
            self.assertTrue(task["browser"]["privateMode"])
            error, hidden, _ = self.user.tool("operations.get", {"operationId": observation_id})
            self.assertTrue(error)
            self.assertEqual("ACCESS_DENIED", hidden["code"])
            status, _ = self.user.api("/api/browser-sessions/" + original_browser + "/ticket", "POST",
                {"role": "VIEWER", "viewerId": str(uuid.uuid4())})
            self.assertEqual(403, status)
            status, connection = self.user.api("/api/connections", "POST", {
                "name": "Dev private login profile", "site": "example.com", "startUrl": "https://example.com"})
            self.assertEqual(200, status)
            saved_connection = connection["id"]
            status, task = self.user.api("/api/tasks/" + task_id + "/commands", "POST",
                {"type": "FINISH_LOGIN", "expectedVersion": task["version"], "viewerId": viewer,
                 "resume": True, "saveConnection": True, "connectionId": saved_connection,
                 "accountLabel": "Disposable anonymous example", "accountSubject": "dev-anonymous-example"})
            self.assertEqual(200, status)
            task = self.wait_task(task_id, lambda value: value["browser"]["controlOwner"] == "CHATGPT")
            self.assertEqual(original_browser, task["browser"]["id"])
            status, connection = self.user.api("/api/connections/" + saved_connection)
            self.assertEqual(200, status)
            self.assertEqual("READY", connection["status"])
            self.assertEqual(original_browser, connection["browser"]["id"])
            error, stale, _ = self.user.execute_in_scenario_step({"taskId": task_id,
                "action": {"operationId": str(uuid.uuid4()), "type": "observe", "arguments": {},
                           "instructionRevision": task["instructionRevision"], "controlEpoch": original_epoch}})
            self.assertTrue(error)
            self.assertEqual("STALE_CONTROL", stale["code"])
            missing = {"operationId": str(uuid.uuid4()), "type": "click",
                       "arguments": self.user.browser_target(task_id, 'Slow effect', uncertain=True),
                       "instructionRevision": task["instructionRevision"], "controlEpoch": task["browser"]["controlEpoch"]}
            error, _, _ = self.user.execute_in_scenario_step({"taskId": task_id, "action": missing})
            self.assertFalse(error)
            task = self.wait_task(task_id, lambda value: value.get("request") is not None
                                  and value["request"]["type"] == "UNKNOWN_RESULT")
            error, receipt, _ = self.user.execute_in_scenario_step({"taskId": task_id, "action": missing})
            self.assertFalse(error)
            self.assertEqual("UNKNOWN", receipt["status"])
            error, blocked, _ = self.user.execute_in_scenario_step({"taskId": task_id,
                "action": {**missing, "operationId": str(uuid.uuid4()), "type": "click"}})
            self.assertTrue(error)
            self.assertEqual("UNKNOWN_RESULT", blocked["code"])
            observed_id = str(uuid.uuid4())
            error, observed, _ = self.user.execute_in_scenario_step({"taskId": task_id, "action": {
                "operationId": observed_id, "type": "observe", "arguments": {},
                "instructionRevision": task["instructionRevision"]}})
            self.assertFalse(error, observed)
            self.assertEqual("SUCCEEDED", self.wait_operation(observed_id, self.user)["status"])
            status, _ = self.user.api("/api/tasks/" + task_id + "/commands", "POST",
                {"type": "STOP", "expectedVersion": task["version"]})
            self.assertEqual(200, status)
            task = self.wait_task(task_id, lambda value: value["status"] == "STOPPED")
            self.assertIsNotNone(task["request"], "Stopping preserves the UNKNOWN verification request")
            error, task, _ = self.user.respond(task, {
                "outcome": "SUCCEEDED", "evidence": "The synthetic effect counter was inspected before stopping.",
                "observationOperationId": observed_id})
            self.assertFalse(error, task)
            self.assertIsNone(task["request"])
            self.assertEqual("STOPPED", task["status"], "Verification does not implicitly resume a stopped task")
        finally:
            _, task = self.user.api("/api/tasks/" + task_id)
            status, _ = self.user.api("/api/tasks/" + task_id + "/commands", "POST",
                                     {"type": "STOP", "expectedVersion": task["version"]})
            self.assertEqual(200, status)
            self.wait_task(task_id, lambda value: value["status"] == "STOPPED")
            if saved_connection is not None:
                self.assertEqual(200, self.user.api("/api/connections/" + saved_connection, "DELETE")[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)


