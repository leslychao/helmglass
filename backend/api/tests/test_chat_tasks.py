"""Chat ownership, autonomous commands and durable widget state on deployed dev."""

from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPSConnection
import json
from pathlib import Path
import time
import unittest
import uuid
from urllib.parse import urlparse

import test_usage_admin as usage


class ChatTaskTest(unittest.TestCase):
    setUpClass = classmethod(usage.UsageAdministrationTest.setUpClass.__func__)
    tearDown = usage.UsageAdministrationTest.tearDown
    fixture_sql = usage.UsageAdministrationTest.fixture_sql
    purge_identity = usage.UsageAdministrationTest.purge_identity
    wait_operation = usage.UsageAdministrationTest.wait_operation
    command = usage.UsageAdministrationTest.command
    create = usage.UsageAdministrationTest.create

    def setUp(self):
        usage.UsageAdministrationTest.setUp(self)
        self.client.login_mcp()

    def transport(self, chat=None):
        client = self.identity.client()
        client.token = self.client.token
        client.chat = chat or self.client.chat
        return client

    def create_input(self, title="Single chat task"):
        return {"operationKey": str(uuid.uuid4()), "task": {"title": title,
            "goal": "Observe the public example without external writes",
            "startUrl": self.client.browser_fixture_url(), "prepare": True}}

    def start(self):
        error, state, _ = self.client.tool("tasks.create", self.create_input())
        self.assertFalse(error, state)
        return state

    def current(self, task):
        status, value = self.client.api("/api/tasks/" + task["id"])
        self.assertEqual(200, status, value)
        return value

    def mcp_command(self, task, kind, **fields):
        value = self.current(task)
        if kind in ("ANSWER", "CONFIRM", "REJECT"):
            args = {"taskId": task["id"], "operationKey": str(uuid.uuid4()),
                    "requestId": fields["requestId"], "requestVersion": fields["requestVersion"]}
            content = {"answer": fields["text"]} if kind == "ANSWER" else {"proceed": kind == "CONFIRM"}
            error, result, _ = self.client.respond(value, content, operation_key=args["operationKey"])
            self.assertFalse(error, result)
            return result, args
        args = {"taskId": task["id"], "operationKey": str(uuid.uuid4()), "command": {
            "type": kind, "expectedVersion": value["version"], **fields}}
        error, result, _ = self.client.tool("tasks.command", args)
        self.assertFalse(error, result)
        return result, args

    def wait_task(self, task, predicate):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            value = self.current(task)
            if predicate(value):
                return value
            time.sleep(.2)
        self.fail("Task did not reach the required state: " + value["status"])

    def test_concurrent_create_rolls_back_losers_and_replays_winner(self):
        # Concurrent calls must resolve ownership and idempotency in the database.
        requests = [self.create_input("Creation race " + str(i)) for i in range(2)]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda args: self.transport().tool("tasks.create", args), requests))
        winners = [i for i, result in enumerate(results) if not result[0]]
        self.assertEqual(1, len(winners), results)
        index = winners[0]
        state = results[index][1]
        task = state["task"]
        self.assertTrue(task["chatBound"])
        for i, (error, value, raw) in enumerate(results):
            if i != index:
                self.assertTrue(error)
                self.assertEqual(("CHAT_TASK_IN_PROGRESS", task["id"]),
                    (value["code"], value["currentTaskId"]))
                self.assertEqual(value, raw["structuredContent"])
        self.assertEqual(1, self.client.api("/api/tasks")[1]["total"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            repeated = list(pool.map(lambda _: self.transport().tool("tasks.create", requests[index]), range(2)))
        for error, replay, _ in repeated:
            self.assertFalse(error, replay)
            self.assertEqual(state, replay)
        error, refusal, _ = self.client.tool("tasks.create", self.create_input())
        self.assertTrue(error)
        self.assertEqual(task["id"], refusal["currentTaskId"])
        independent = self.transport("independent-" + str(uuid.uuid4()))
        self.assertFalse(independent.tool("tasks.create", self.create_input())[0])
        self.assertEqual(2, self.client.api("/api/tasks")[1]["total"])

    def test_bind_create_and_reopen_share_the_same_database_guard(self):
        first = self.start()["task"]
        # Queue explanations may advance the version before this fixture finishes its empty task.
        for attempt in range(3):
            current = self.current(first)
            status, completed = self.client.api('/api/tasks/' + first['id'] + '/commands', 'POST', {
                'type': 'FINISH', 'expectedVersion': current['version'],
                'outcome': 'SUCCEEDED', 'text': 'Recorded result A'})
            if status == 200:
                break
            self.assertEqual('STALE_VERSION', completed.get('code'), completed)
        self.assertEqual(200, status, completed)
        cabinet = self.create("Existing cabinet task", site=self.client.browser_fixture_url().removeprefix("https://"))
        commands = [
            ("tasks.command", {"taskId": first["id"], "operationKey": str(uuid.uuid4()),
                "command": {"type": "RESUME", "expectedVersion": completed["version"]}}),
            ("tasks.bind", {"taskId": cabinet["id"], "operationKey": str(uuid.uuid4())}),
            ("tasks.create", self.create_input("Competing new task")),
        ]
        resume_client = self.identity.client()
        resume_client.login_web()

        def compete(entry):
            name, arguments = entry
            if name == "tasks.command":
                status, value = resume_client.api("/api/tasks/" + first["id"] + "/commands",
                    "POST", arguments["command"])
                return status != 200, value, {}
            return self.transport().tool(name, arguments)

        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(compete, commands))
        winners = [i for i, result in enumerate(results) if not result[0]]
        self.assertEqual(1, len(winners), results)
        index = winners[0]
        winner = results[index][1]
        task = winner["task"] if index == 2 else winner
        for i, (error, value, _) in enumerate(results):
            if i != index:
                self.assertTrue(error)
                if i == 0 and value.get('code') == 'STALE_VERSION':
                    self.assertEqual('SUCCEEDED', self.current(first)['status'])
                    continue
                self.assertEqual("CHAT_TASK_IN_PROGRESS", value.get("code"), value)
                self.assertEqual(("CHAT_TASK_IN_PROGRESS", task["id"]),
                    (value["code"], value["currentTaskId"]))
        self.assertEqual(3 if index == 2 else 2, self.client.api("/api/tasks")[1]["total"])
        self.assertEqual(index == 1, self.current(cabinet)["chatBound"])

    def test_finished_history_does_not_replace_current_task_and_stop_is_final(self):
        original = self.start()
        first = original["task"]
        self.command(first, "FINISH", outcome="SUCCEEDED", text="Retained result A")
        history = self.client.api("/api/tasks/" + first["id"] + "/history")[1]
        second = self.start()
        current = second["task"]
        self.assertEqual("Retained result A", self.current(first)["result"]["summary"])
        self.assertEqual(history, self.client.api("/api/tasks/" + first["id"] + "/history")[1])
        stale = {"taskId": first["id"], "generation": original["generation"]}
        self.assertEqual("STALE_WIDGET", self.client.tool("widget.state", stale)[1]["code"])
        for tool, fields in (("widget.steps", {}), ("widget.browser", {"viewerId": str(uuid.uuid4())}),
                             ("widget.claim", {"continuationId": str(uuid.uuid4())})):
            error, refusal, _ = self.client.tool(tool, {**stale, **fields})
            self.assertTrue(error)
            self.assertEqual("STALE_WIDGET", refusal["code"])
        self.assertEqual("CHAT_TASK_IN_PROGRESS", self.client.tool("tasks.view", {
            "taskId": first["id"], "operationKey": str(uuid.uuid4())})[1]["code"])
        status, refusal = self.client.api("/api/tasks/" + first["id"] + "/commands", "POST", {
            "type": "RESUME", "expectedVersion": self.current(first)["version"]})
        self.assertEqual((409, "CHAT_TASK_IN_PROGRESS", current["id"]),
            (status, refusal["code"], refusal["currentTaskId"]))
        retained = self.client.tool("widget.state", {"taskId": current["id"],
            "generation": second["generation"]})[1]
        self.assertEqual(current["id"], retained["task"]["id"])
        self.assertEqual(current["title"], retained["task"]["title"])
        self.assertGreaterEqual(retained["task"]["version"], current["version"])
        self.command(current, "STOP")
        stopped = self.wait_task(current, lambda value: value["status"] == "STOPPED")
        self.assertNotIn("RESUME", stopped["allowedCommands"])
        for channel in ("WEB", "MCP"):
            command = {"type": "RESUME", "expectedVersion": stopped["version"], "confirmBrowserLoss": True}
            if channel == "WEB":
                status, refusal = self.client.api("/api/tasks/" + current["id"] + "/commands", "POST", command)
                self.assertEqual(409, status)
            else:
                error, refusal, _ = self.client.tool("tasks.command", {"taskId": current["id"],
                    "operationKey": str(uuid.uuid4()), "command": command})
                self.assertTrue(error)
            self.assertEqual("ACTION_UNAVAILABLE", refusal["code"])
        resumed, _ = self.mcp_command(first, "RESUME", confirmBrowserLoss=True)
        self.assertEqual(first["id"], resumed["id"])
        self.assertEqual("Retained result A", resumed["result"]["summary"])
        self.assertEqual("WAITING_CHATGPT", resumed["status"])
        self.assertEqual(first["instructionRevision"] + 1, resumed["instructionRevision"])

    def test_completed_browser_control_does_not_reopen_previous_chat_task(self):
        first = self.start()["task"]
        self.wait_task(first, lambda task: task.get("browser")
                       and task["browser"]["status"] == "LIVE")
        completed = self.command(first, "FINISH", outcome="NOT_ACHIEVED", text="Retained outcome")
        arguments = self.create_input("Next task remains current")
        arguments["task"]["prepare"] = False
        error, second, _ = self.client.tool("tasks.create", arguments)
        self.assertFalse(error, second)
        current = second["task"]
        viewer = str(uuid.uuid4())
        path = "/api/browser-sessions/" + completed["browser"]["id"] + "/control"
        history = self.client.api("/api/tasks/" + first["id"] + "/history")[1]
        for kind, control, private, resume in (
                ("TAKE", "USER", False, False), ("RETURN", "CHATGPT", False, False),
                ("BEGIN_LOGIN", "USER", True, False),
                ("FINISH_LOGIN", "CHATGPT", False, True)):
            with self.subTest(command=kind):
                status, receipt = self.client.api(path, "POST", {
                    "type": kind, "viewerId": viewer, "resume": resume})
                self.assertEqual(200, status, receipt)
                task = self.wait_task(first, lambda value:
                    value["browser"]["controlOwner"] == control)
                self.assertEqual(private, task["browser"]["privateMode"])
                for field in ("status", "outcome", "version", "instructionRevision", "result", "timing"):
                    self.assertEqual(completed[field], task[field], field)
                self.assertEqual(history, self.client.api("/api/tasks/" + first["id"] + "/history")[1])
                error, card, _ = self.client.tool("widget.state", {
                    "taskId": current["id"], "generation": second["generation"]})
                self.assertFalse(error, card)
        error, refusal, _ = self.client.tool("tasks.command", {
            "taskId": first["id"], "operationKey": str(uuid.uuid4()),
            "command": {"type": "RESUME", "expectedVersion": completed["version"]}})
        self.assertTrue(error, refusal)
        self.assertEqual(("CHAT_TASK_IN_PROGRESS", current["id"]),
                         (refusal["code"], refusal.get("currentTaskId")))
        self.mcp_command(current, "STOP")
        error, third, _ = self.client.tool("tasks.create", {
            **arguments, "operationKey": str(uuid.uuid4())})
        self.assertFalse(error, third)
        self.mcp_command(third["task"], "STOP")
        resumed, _ = self.mcp_command(first, "RESUME")
        self.assertEqual(("WAITING_CHATGPT", completed["instructionRevision"] + 1),
                         (resumed["status"], resumed["instructionRevision"]))

    def test_stop_previous_task_preserves_current_chat_and_replays(self):
        first = self.start()["task"]
        self.wait_task(first, lambda task: task.get("browser")
                       and task["browser"]["status"] == "LIVE")
        self.command(first, "FINISH", outcome="NOT_ACHIEVED", text="Retained result")
        arguments = self.create_input("Current draft")
        arguments["task"]["prepare"] = False
        error, second, _ = self.client.tool("tasks.create", arguments)
        self.assertFalse(error, second)
        wrong_chat = self.transport("other-" + str(uuid.uuid4()))
        stop = {"taskId": first["id"], "operationKey": str(uuid.uuid4()),
                "command": {"type": "STOP", "expectedVersion": self.current(first)["version"]}}
        error, refusal, _ = wrong_chat.tool("tasks.command", stop)
        self.assertTrue(error)
        self.assertEqual("ORIGINAL_CHAT_REQUIRED", refusal["code"])
        error, refusal, _ = self.client.tool("tasks.command", {
            **stop, "operationKey": str(uuid.uuid4()),
            "command": {**stop["command"], "expectedVersion": stop["command"]["expectedVersion"] - 1}})
        self.assertTrue(error)
        self.assertEqual("STALE_VERSION", refusal["code"])
        error, receipt, _ = self.client.tool("tasks.command", stop)
        self.assertFalse(error, receipt)
        self.wait_task(first, lambda task: task["status"] == "STOPPED")
        error, replay, _ = self.client.tool("tasks.command", stop)
        self.assertFalse(error, replay)
        self.assertEqual(receipt, replay)
        error, card, _ = self.client.tool("widget.state", {
            "taskId": second["task"]["id"], "generation": second["generation"]})
        self.assertFalse(error, card)
        self.assertEqual(second["task"]["id"], card["task"]["id"])
        self.assertEqual("Retained result", self.current(first)["result"]["summary"])

    def test_stop_recovers_noncurrent_task_reopened_by_old_browser_control(self):
        first = self.start()["task"]
        self.wait_task(first, lambda task: task.get("browser")
                       and task["browser"]["status"] == "LIVE")
        self.command(first, "FINISH", outcome="NOT_ACHIEVED", text="Retained result")
        arguments = self.create_input("Stopped current draft")
        arguments["task"]["prepare"] = False
        error, second, _ = self.client.tool("tasks.create", arguments)
        self.assertFalse(error, second)
        self.mcp_command(second["task"], "STOP")
        # Reproduce the persisted incident only inside this disposable account.
        self.fixture_sql(self.identity, "UPDATE tasks SET status='WAITING_CHATGPT',completed_at=NULL,"
            "version=version+1 WHERE owner_id=:owner AND id='" + first["id"] + "';")
        error, refusal, _ = self.client.tool("tasks.create", {
            **arguments, "operationKey": str(uuid.uuid4())})
        self.assertTrue(error)
        self.assertEqual(("CHAT_TASK_IN_PROGRESS", first["id"]),
                         (refusal["code"], refusal["currentTaskId"]))
        self.mcp_command(first, "STOP")
        self.wait_task(first, lambda task: task["status"] == "STOPPED")
        error, created, _ = self.client.tool("tasks.create", {
            **arguments, "operationKey": str(uuid.uuid4())})
        self.assertFalse(error, created)

    def test_user_clarification_returns_a_new_card_for_the_same_task_and_browser(self):
        initialized = self.client.rpc("initialize", {"protocolVersion": "2025-11-25",
            "capabilities": self.client.mcp_capabilities,
            "clientInfo": {"name": "helm-clarification-regression", "version": "1"}})
        self.assertIn("For each new user clarification, call tasks.view once", initialized["instructions"])
        tools = {tool["name"]: tool for tool in self.client.rpc("tools/list", {})["tools"]}
        self.assertIn("уточнен", tools["tasks.view"]["description"])
        self.assertNotIn("если она нужна", tools["tasks.view"]["description"])
        self.assertIn("tasks.view", tools["tasks.command"]["description"])

        original = self.start()
        task = self.wait_task(original["task"], lambda value: value.get("browser")
                              and value["browser"]["status"] == "LIVE")
        view = {"taskId": task["id"], "operationKey": str(uuid.uuid4())}
        error, shown, _ = self.client.tool("tasks.view", view)
        self.assertFalse(error, shown)
        self.assertNotEqual(original["generation"], shown["generation"])
        self.assertEqual(task["browser"]["id"], shown["task"]["browser"]["id"])
        amended, _ = self.mcp_command(task, "AMEND", title=task["title"],
            goal="Observe only the public fixture, preserving the current browser",
            startUrl=task["startUrl"])
        self.assertEqual(task["instructionRevision"] + 1, amended["instructionRevision"])
        binding = {"taskId": task["id"], "generation": shown["generation"]}
        error, current, _ = self.client.tool("widget.state", binding)
        self.assertFalse(error, current)
        self.assertEqual(amended["goal"], current["task"]["goal"])
        self.assertEqual(task["browser"]["id"], current["task"]["browser"]["id"])
        error, replay, _ = self.client.tool("tasks.view", view)
        self.assertFalse(error, replay)
        self.assertEqual(shown["generation"], replay["generation"])
        stale = {"taskId": task["id"], "generation": original["generation"]}
        error, refusal, _ = self.client.tool("widget.state", stale)
        self.assertFalse(error, refusal)
        self.assertEqual("STALE_WIDGET", refusal["code"])
        self.assertNotIn("task", refusal)
        error, refusal, _ = self.client.tool("widget.browser", {
            **stale, "viewerId": str(uuid.uuid4())})
        self.assertTrue(error)
        self.assertEqual("STALE_WIDGET", refusal["code"])

    def test_chat_answers_do_not_send_another_turn_and_widget_rotation_preserves_intent(self):
        state = self.start()
        task = state["task"]
        binding = {"taskId": task["id"], "generation": state["generation"]}
        self.client.observe_task_browser(task["id"])
        self.client.return_control_without_continuing(task["id"])
        self.command(task, "RESUME")

        def ask():
            error, value, _ = self.client.tool("tasks.ask", {"taskId": task["id"],
                "operationKey": str(uuid.uuid4()), "instructionRevision": task["instructionRevision"],
                "prompt": "Which public example should be observed?"})
            self.assertFalse(error, value)
            return value["request"]

        request = ask()
        answered, args = self.mcp_command(task, "ANSWER", requestId=request["id"],
            requestVersion=request["version"], text="Use example.com")
        self.assertIsNone(answered["request"])
        self.assertEqual("Use example.com", answered["lastResponse"]["text"])
        self.assertNotEqual("PENDING", self.client.tool("widget.state", binding)[1]["continuationStatus"])
        self.assertEqual(answered["lastResponse"], self.client.tool("tasks.respond", args)[1]["lastResponse"])
        request = ask()
        self.command(task, "ANSWER", requestId=request["id"], requestVersion=request["version"], text="Same site")
        pending = self.client.tool("widget.state", binding)[1]
        error, resumed, _ = self.client.tool("tasks.get", {"taskId": task["id"]})
        self.assertFalse(error, resumed)
        response = resumed["lastResponse"]
        self.assertEqual((request["id"], request["version"], task["instructionRevision"],
                          "QUESTION", request["prompt"], "ANSWER", "Same site"),
            tuple(response[field] for field in ("requestId", "requestVersion", "instructionRevision",
                "type", "prompt", "command", "text")))
        self.assertEqual(response, self.current(task)["lastResponse"])
        self.assertIsNone(response["operationId"])
        self.assertIsNone(response["connectionId"])
        self.assertTrue(response["answeredAt"])
        self.assertEqual("ACCEPTED", pending["continuationStatus"])
        self.client.return_control_without_continuing(task["id"])
        self.command(task, "RESUME")
        pending = self.client.tool("widget.state", binding)[1]
        shown = self.client.tool("tasks.view", {"taskId": task["id"], "operationKey": str(uuid.uuid4())})[1]
        for field in ("continuationId", "continuationRevision", "continuationStatus", "continuationReason"):
            self.assertEqual(pending[field], shown[field])
        binding["generation"] = shown["generation"]
        claim = {**binding, "continuationId": shown["continuationId"]}
        self.assertTrue(self.client.tool("widget.claim", claim)[1]["claimed"])
        self.assertFalse(self.client.tool("widget.claim", claim)[1]["claimed"])
        sent = self.client.tool("widget.continuation", {**claim, "sent": True})[1]
        self.assertEqual("MESSAGE_SENT", sent["continuationStatus"])
        obsolete = ask()
        self.assertNotEqual("PENDING", self.client.tool("widget.state", binding)[1]["continuationStatus"])
        amended = self.command(task, "AMEND", title=task["title"], goal="A changed instruction",
            startUrl=task["startUrl"])
        self.assertIsNone(amended["lastResponse"])
        self.assertIsNone(self.client.tool("tasks.get", {"taskId": task["id"]})[1]["lastResponse"])
        error, refusal, _ = self.client.tool("tasks.respond", {"taskId": task["id"],
            "operationKey": str(uuid.uuid4()), "requestId": obsolete["id"],
            "requestVersion": obsolete["version"]})
        self.assertTrue(error)
        self.assertEqual("STALE_REQUEST", refusal["code"])

    def test_steps_are_paged_without_technical_events_and_are_chat_bound(self):
        state = self.start()
        task = state["task"]
        binding = {"taskId": task["id"], "generation": state["generation"]}
        self.command(task, "AMEND", title=task["title"], goal="Updated instruction",
            startUrl=task["startUrl"])
        baseline = self.client.tool("widget.steps", binding)[1]["total"]

        def read_state():
            error, result, _ = self.client.tool("tasks.get", {"taskId": task["id"]})
            self.assertFalse(error, result)

        for _ in range(12):
            read_state()
        error, first, _ = self.client.tool("widget.steps", binding)
        self.assertFalse(error, first)
        self.assertEqual((10, 10, baseline + 12),
                         (len(first["items"]), first["pageSize"], first["total"]))
        older = {**binding, "page": 2, "beforeSequence": first["items"][0]["sequence"]}
        retained = self.client.tool("widget.steps", older)[1]
        read_state()
        self.assertEqual(retained, self.client.tool("widget.steps", older)[1])
        wrong = self.transport("unrelated-chat")
        for name in ("widget.steps", "widget.state"):
            error, refusal, _ = wrong.tool(name, binding)
            self.assertTrue(error)
            self.assertEqual("ORIGINAL_CHAT_REQUIRED", refusal["code"])

    def test_only_native_host_response_can_answer_and_transport_is_owner_bound(self):
        task = self.start()["task"]
        self.assertIsNotNone(task["browser"], "Creation immediately prepares the task browser")
        error, asked, _ = self.client.tool("tasks.ask", {"taskId": task["id"],
            "operationKey": str(uuid.uuid4()), "instructionRevision": task["instructionRevision"],
            "prompt": "Choose the public page to inspect"})
        self.assertFalse(error, asked)
        pending = asked["request"]
        forbidden = {"type": "ANSWER", "expectedVersion": asked["version"],
            "requestId": pending["id"], "requestVersion": pending["version"], "text": "Forged answer"}
        status, refusal = self.client.api("/api/tasks/" + task["id"] + "/commands", "POST", forbidden)
        self.assertEqual((409, "HOST_RESPONSE_REQUIRED"), (status, refusal["code"]))
        error, _, _ = self.client.tool("tasks.command", {"taskId": task["id"],
            "operationKey": str(uuid.uuid4()), "command": forbidden})
        self.assertTrue(error)
        args = {"taskId": task["id"], "requestId": pending["id"],
            "requestVersion": pending["version"], "operationKey": str(uuid.uuid4())}
        error, _, _ = self.client.tool("tasks.respond", {**args, "answer": "Forged answer"})
        self.assertTrue(error)
        error, refusal, _ = self.client.tool("tasks.respond", {**args,
            "operationKey": str(uuid.uuid4()), "verification": {
                "outcome": "SUCCEEDED", "evidence": "A model cannot answer this question",
                "observationOperationId": str(uuid.uuid4())}})
        self.assertTrue(error, refusal)
        self.assertEqual("HOST_RESPONSE_REQUIRED", refusal["code"])
        self.assertEqual(pending, self.current(task)["request"])
        wrong = self.transport("another-original-chat")
        error, refusal, _ = wrong.tool("tasks.respond", args)
        self.assertTrue(error)
        self.assertEqual("ORIGINAL_CHAT_REQUIRED", refusal["code"])
        wrong.close_mcp()
        unsupported = self.transport()
        unsupported.mcp_capabilities = {}
        error, refusal, _ = unsupported.tool("tasks.respond", args)
        self.assertTrue(error)
        self.assertEqual("ELICITATION_UNAVAILABLE", refusal["code"])
        unsupported.close_mcp()
        cancelled, refusal, _ = self.client.respond(asked, action="cancel",
            operation_key=args["operationKey"])
        self.assertTrue(cancelled)
        self.assertEqual("ELICITATION_CANCELLED", refusal["code"])
        self.assertEqual(pending, self.current(task)["request"])
        error, refusal, _ = self.client.tool("tasks.respond", args)
        self.assertTrue(error)
        self.assertEqual("ELICITATION_NOT_REPLAYED", refusal["code"])
        error, answered, _ = self.client.respond(asked, {"answer": "Inspect example.com"})
        self.assertFalse(error, answered)
        self.assertEqual("Inspect example.com", answered["lastResponse"]["text"])
        self.assertIsNone(answered["request"])
        previous_session = self.client.mcp_session
        self.client.close_mcp()
        error, reopened, _ = self.client.tool("tasks.get", {"taskId": task["id"]})
        self.assertFalse(error, reopened)
        self.assertNotEqual(previous_session, self.client.mcp_session)
        self.assertEqual(answered["lastResponse"], reopened["lastResponse"])
        stale_headers = {**self.client.mcp_headers(), "Mcp-Session-Id": previous_session}
        self.assertEqual(404, self.client.request(self.client.base + "/mcp", "DELETE",
                                                headers=stale_headers)[0])
        self.admin.login_mcp()
        headers = self.admin.mcp_headers()
        headers["Mcp-Session-Id"] = self.client.mcp_session
        for method in ("GET", "DELETE"):
            self.assertEqual(404, self.admin.request(self.admin.base + "/mcp", method,
                                                    headers=headers)[0])
        forged = json.dumps({"jsonrpc": "2.0", "id": "foreign-response",
                             "result": {"action": "accept", "content": {"answer": "Forged"}}}).encode()
        self.assertEqual(404, self.admin.request(self.admin.base + "/mcp", "POST",
                                                data=forged, headers=headers)[0])

    def disconnect_mcp_listener(self, client):
        endpoint = urlparse(client.base)
        connection = HTTPSConnection(endpoint.hostname, endpoint.port, timeout=.5)
        try:
            connection.request("GET", (endpoint.path or "") + "/mcp",
                               headers=client.mcp_headers())
            try:
                response = connection.getresponse()
                self.assertEqual(200, response.status)
                response.close()
            except TimeoutError:
                pass
        finally:
            connection.close()

    def open_mcp_listener(self, client, readers, timeout=8):
        endpoint = urlparse(client.base)
        connection = HTTPSConnection(endpoint.hostname, endpoint.port, timeout=timeout)
        connection.request("GET", (endpoint.path or "") + "/mcp",
                           headers=client.mcp_headers())

        def read_to_eof():
            try:
                response = connection.getresponse()
                return response.status, response.read(1)
            finally:
                connection.close()

        result = readers.submit(read_to_eof)
        # This SDK does not flush GET headers until it sends or closes the stream.
        # Give the short registration request time to reach the public dev gateway.
        time.sleep(.3)
        return result

    def test_replacing_listening_stream_closes_previous_without_closing_session(self):
        self.client.rpc("tools/list", {})
        with ThreadPoolExecutor(max_workers=3) as readers:
            try:
                first = self.open_mcp_listener(self.client, readers)
                second = self.open_mcp_listener(self.client, readers)
                self.assertEqual((200, b""), first.result(timeout=5))
                self.assertFalse(second.done(), "Previous completion closed its replacement")
                third = self.open_mcp_listener(self.client, readers)
                self.assertEqual((200, b""), second.result(timeout=5))
                self.assertFalse(third.done(), "An older completion cleared the current listener")
                self.assertIn("tools", self.client.rpc("tools/list", {}, reinitialize=False))
            finally:
                self.client.close_mcp()
            self.assertEqual((200, b""), third.result(timeout=5))

    def test_disconnected_get_streams_release_transport_capacity(self):
        transports = []
        try:
            for _ in range(20):
                current = self.transport()
                transports.append(current)
                deadline = time.monotonic() + 25
                while True:
                    try:
                        self.assertIn("tools", current.rpc("tools/list", {}))
                        break
                    except AssertionError as error:
                        if "HTTP 429" not in str(error) or time.monotonic() >= deadline:
                            raise
                        time.sleep(.5)
                # A real host may disconnect its listening GET without issuing DELETE.
                # Reading with a deadline establishes the stream, then closes that socket.
                self.disconnect_mcp_listener(current)
        finally:
            for current in transports:
                current.close_mcp()

    def test_transport_capacity_reclaims_own_idle_and_preserves_pending_response(self):
        task = self.start()["task"]
        error, asked, _ = self.client.tool("tasks.ask", {"taskId": task["id"],
            "operationKey": str(uuid.uuid4()), "instructionRevision": task["instructionRevision"],
            "prompt": "Keep this native response pending while transport sessions rotate"})
        self.assertFalse(error, asked)
        self.admin.login_mcp()
        self.admin.rpc("tools/list", {})
        foreign_session = self.admin.mcp_session
        idle = self.transport()
        idle.rpc("tools/list", {})
        active_session = self.client.mcp_session
        transports = [idle]
        listeners = []
        readers = ThreadPoolExecutor(max_workers=3)

        def rotate_transports(form):
            first = self.open_mcp_listener(self.client, readers)
            second = self.open_mcp_listener(self.client, readers, timeout=75)
            listeners.append(second)
            self.assertEqual((200, b""), first.result(timeout=5))
            self.assertFalse(second.done(), "Replacing GET cancelled the active listener")
            reclaimed = self.open_mcp_listener(idle, readers, timeout=75)
            for _ in range(20):
                current = self.transport()
                transports.append(current)
                self.assertIn("tools", current.rpc("tools/list", {}))
                self.disconnect_mcp_listener(current)
            self.assertEqual((200, b""), reclaimed.result(timeout=5))
            self.assertFalse(second.done(), "LRU closed the active POST's listener")
            with self.assertRaisesRegex(AssertionError, "HTTP 404"):
                idle.rpc("tools/list", {}, reinitialize=False)
            self.assertIn("tools", self.admin.rpc("tools/list", {}, reinitialize=False))
            self.assertEqual(foreign_session, self.admin.mcp_session)
            return {"action": "accept", "content": {"answer": "Native response survived capacity"}}

        self.client.elicitation_handler = rotate_transports
        try:
            error, answered, _ = self.client.tool("tasks.respond", {
                "taskId": task["id"], "requestId": asked["request"]["id"],
                "requestVersion": asked["request"]["version"], "operationKey": str(uuid.uuid4())})
            self.assertFalse(error, answered)
            self.assertEqual(active_session, self.client.mcp_session)
            self.assertEqual("Native response survived capacity", answered["lastResponse"]["text"])
        finally:
            self.client.elicitation_handler = None
            for current in transports:
                current.close_mcp()
            self.client.close_mcp()
            self.admin.close_mcp()
            try:
                for listener in listeners:
                    self.assertEqual((200, b""), listener.result(timeout=5))
            finally:
                readers.shutdown(wait=True)

    def test_instruction_changed_while_native_form_is_open_rejects_late_answer(self):
        task = self.start()["task"]
        _, asked, _ = self.client.tool("tasks.ask", {"taskId": task["id"],
            "operationKey": str(uuid.uuid4()), "instructionRevision": task["instructionRevision"],
            "prompt": "Answer for the current revision only"})
        def change_instruction(form):
            self.mcp_command(task, "AMEND", title=task["title"], goal="Superseding instruction",
                             startUrl=task["startUrl"])
            return {"action": "accept", "content": {"answer": "Late answer"}}
        self.client.elicitation_handler = change_instruction
        try:
            error, refusal, _ = self.client.tool("tasks.respond", {"taskId": task["id"],
                "requestId": asked["request"]["id"], "requestVersion": asked["request"]["version"],
                "operationKey": str(uuid.uuid4())})
        finally:
            self.client.elicitation_handler = None
        self.assertTrue(error)
        self.assertEqual("STALE_REQUEST", refusal["code"])
        self.assertIsNone(self.current(task)["lastResponse"])

    def test_saved_receipt_without_response_fields_remains_replayable(self):
        task = self.start()["task"]
        key = str(uuid.uuid4())
        arguments = {"taskId": task["id"], "operationKey": key,
            "instructionRevision": task["instructionRevision"], "prompt": "Retained pending question"}
        error, asked, _ = self.client.tool("tasks.ask", arguments)
        self.assertFalse(error, asked)
        self.fixture_sql(self.identity,
            "UPDATE idempotency_records SET response=jsonb_set(response-'lastResponse',"
            "'{request}',(response->'request')-'instructionRevision') "
            f"WHERE owner_id=:owner AND key='{key}';")
        view = {"taskId": task["id"], "operationKey": str(uuid.uuid4())}
        error, shown, _ = self.client.tool("tasks.view", view)
        self.assertFalse(error, shown)
        self.fixture_sql(self.identity,
            "UPDATE idempotency_records SET response=jsonb_set(response,'{task}',"
            "jsonb_set((response->'task')-'lastResponse','{request}',"
            "(response->'task'->'request')-'instructionRevision')) "
            f"WHERE owner_id=:owner AND key='{view['operationKey']}';")
        # Apply the actual data projection only to this disposable owner's old-format receipts.
        migration = Path('backend/api/src/main/resources/db/014-request-receipts.sql').read_text()
        self.fixture_sql(self.identity, migration.replace('WHERE ', 'WHERE owner_id=:owner AND '))
        error, replay, _ = self.client.tool("tasks.ask", arguments)
        self.assertFalse(error, replay)
        self.assertIsNone(replay["lastResponse"])
        self.assertEqual(asked["request"]["id"], replay["request"]["id"])
        self.assertEqual(task["instructionRevision"], replay["request"]["instructionRevision"])
        error, card, _ = self.client.tool("tasks.view", view)
        self.assertFalse(error, card)
        self.assertEqual(shown, card)
        # The snapshot is old, but answering always validates the current persisted request.
        answered, _ = self.mcp_command(task, "ANSWER", requestId=replay["request"]["id"],
            requestVersion=replay["request"]["version"], text="Answer after application update")
        self.assertEqual(task["instructionRevision"], answered["lastResponse"]["instructionRevision"])

    def test_autonomous_steps_and_confirmation_after_manual_control(self):
        state = self.start()
        task = state["task"]

        def action(kind, arguments, prompt=None):
            current = self.current(task)
            command = {"operationId": str(uuid.uuid4()), "type": kind, "arguments": arguments,
                "instructionRevision": current["instructionRevision"]}
            if current.get("browser"):
                command["controlEpoch"] = current["browser"]["controlEpoch"]
            if prompt:
                command["confirmationPrompt"] = prompt
            error, receipt, _ = self.client.execute_browser({"taskId": task["id"], "action": command})
            self.assertFalse(error, receipt)
            return command, receipt

        for kind, arguments in (("observe", {}), ("newTab", {"url": self.client.browser_fixture_url()})):
            command, receipt = action(kind, arguments)
            self.assertNotEqual("AWAITING_CONFIRMATION", receipt["status"])
            self.assertEqual("SUCCEEDED", self.wait_operation(command["operationId"], self.client)["status"])
        live = self.current(task)["browser"]["id"]
        paused = self.client.return_control_without_continuing(task["id"])
        self.assertEqual(("PAUSED", live), (paused["status"], paused["browser"]["id"]))
        self.mcp_command(task, "RESUME")
        command, receipt = action("newTab", {"url": self.client.browser_fixture_url()}, "Open one additional tab?")
        self.assertEqual("AWAITING_CONFIRMATION", receipt["status"])
        error, refusal, _ = self.client.execute_browser({"taskId": task["id"],
            "action": {**command, "confirmationPrompt": "Changed decision"}})
        self.assertTrue(error)
        self.assertEqual("IDEMPOTENCY_CONFLICT", refusal["code"])
        request = self.current(task)["request"]
        accepted, approval = self.mcp_command(task, "CONFIRM", requestId=request["id"],
            requestVersion=request["version"])
        self.assertEqual((live, "LIVE"), (accepted["browser"]["id"], accepted["browser"]["status"]))
        self.assertEqual("SUCCEEDED", self.wait_operation(command["operationId"], self.client)["status"])
        self.assertEqual(accepted["lastResponse"], self.client.tool("tasks.respond", approval)[1]["lastResponse"])
        observation, _ = action("observe", {})
        self.assertEqual(3, len(self.wait_operation(observation["operationId"], self.client)["result"]["tabs"]))
        denied, _ = action("newTab", {"url": self.client.browser_fixture_url()}, "Open a rejected tab?")
        request = self.current(task)["request"]
        rejected, _ = self.mcp_command(task, "REJECT", requestId=request["id"], requestVersion=request["version"])
        self.assertEqual(("REJECT", denied["operationId"], request["prompt"]),
            (rejected["lastResponse"]["command"], rejected["lastResponse"]["operationId"],
             rejected["lastResponse"]["prompt"]))
        self.assertEqual("CANCELLED", self.client.tool("operations.get", {"operationId": denied["operationId"]})[1]["status"])
        declined, _ = action("newTab", {"url": self.client.browser_fixture_url()}, "Decline this specific action?")
        error, rejected, _ = self.client.respond(self.current(task), action="decline")
        self.assertFalse(error, rejected)
        self.assertEqual("REJECT", rejected["lastResponse"]["command"])
        self.assertEqual(declined["operationId"], rejected["lastResponse"]["operationId"])
        self.assertEqual("CANCELLED", self.client.tool("operations.get", {
            "operationId": declined["operationId"]})[1]["status"])
        self.command(task, "STOP")
        stopped = self.wait_task(task, lambda value: value["status"] == "STOPPED")
        self.assertEqual((live, "CLOSED"), (stopped["browser"]["id"], stopped["browser"]["status"]))

    def test_stop_waits_for_dispatched_outcome_and_confirmed_browser_close(self):
        task = self.start()["task"]
        operation = str(uuid.uuid4())
        error, receipt, _ = self.client.execute_browser({"taskId": task["id"], "action": {
            "operationId": operation, "type": "waitFor", "arguments": {'textGone': 'Increment'},
            "instructionRevision": task["instructionRevision"]}})
        self.assertFalse(error, receipt)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            receipt = self.client.tool("operations.get", {"operationId": operation})[1]
            if receipt["status"] == "DISPATCHED":
                break
            time.sleep(.2)
        self.assertEqual("DISPATCHED", receipt["status"])
        stopping = self.command(task, "STOP")
        self.assertEqual("STOPPING", stopping["status"])
        stopped = self.wait_task(task, lambda value: value["status"] == "STOPPED")
        self.assertEqual("CLOSED", stopped["browser"]["status"])
        self.assertIn(self.client.tool("operations.get", {"operationId": operation})[1]["status"],
            ("SUCCEEDED", "FAILED", "UNKNOWN"))
        self.assertEqual(stopping["browser"]["id"], stopped["browser"]["id"])

    def test_removed_commands_and_policy_are_rejected_and_failed_task_can_reopen(self):
        task = self.start()["task"]
        for kind in ("COPY", "END_SESSION"):
            command = {"type": kind, "expectedVersion": task["version"]}
            self.assertEqual(400, self.client.api("/api/tasks/" + task["id"] + "/commands", "POST", command)[0])
            self.assertTrue(self.client.tool("tasks.command", {"taskId": task["id"],
                "operationKey": str(uuid.uuid4()), "command": command})[0])
        self.assertEqual(400, self.client.api("/api/tasks", "POST", {
            "title": "Obsolete setting", "prepare": False, "requireConfirmation": False})[0])
        self.assertEqual(1, self.client.api("/api/tasks")[1]["total"])
        # FAILED is a persisted technical outcome, not a user-selectable FINISH result.
        self.fixture_sql(self.identity, "UPDATE tasks SET status='FAILED',completed_at=now(),"
            "version=version+1 WHERE owner_id=:owner AND id='" + task["id"] + "';")
        resumed, _ = self.mcp_command(task, "RESUME")
        self.assertEqual((task["id"], "WAITING_CHATGPT"), (resumed["id"], resumed["status"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
