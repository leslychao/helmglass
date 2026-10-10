"""Durable object-level progress through the deployed REST/MCP contracts."""

from concurrent.futures import ThreadPoolExecutor
import time
import unittest
import uuid

import test_usage_admin as usage


class BusinessStepsTest(unittest.TestCase):
    setUpClass = classmethod(usage.UsageAdministrationTest.setUpClass.__func__)
    setUp = usage.UsageAdministrationTest.setUp
    tearDown = usage.UsageAdministrationTest.tearDown
    fixture_sql = usage.UsageAdministrationTest.fixture_sql
    purge_identity = usage.UsageAdministrationTest.purge_identity
    wait_operation = usage.UsageAdministrationTest.wait_operation
    command = usage.UsageAdministrationTest.command

    def create(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {
                "title": "Проверить цены товаров", "goal": "Проверить цену каждого товара",
                "startUrl": "https://example.com", "prepare": True}})
        self.assertFalse(error, presentation)
        self.task = presentation["task"]
        self.widget = {"taskId": self.task["id"], "generation": presentation["generation"]}
        return self.task

    def current(self):
        status, task = self.client.api("/api/tasks/" + self.task["id"])
        self.assertEqual(200, status, task)
        return task

    def step(self, kind, existing=None, key=None, **fields):
        command = {"type": kind, "instructionRevision": self.current()["instructionRevision"], **fields}
        if existing:
            command.update(stepId=existing["id"], expectedVersion=existing["version"])
        request = {"taskId": self.task["id"], "operationKey": key or str(uuid.uuid4()), "command": command}
        error, result, _ = self.client.tool("steps.command", request)
        self.assertFalse(error, result)
        return result

    def declare(self, number=1):
        return self.step("DECLARE", operationKey="check-product-price", objectKey=f"product-{number}",
                         title=f"Проверить цену товара {number}",
                         completionCriterion="Текущая цена товара получена из указанного источника")

    def listing(self, **query):
        error, result, _ = self.client.tool("steps.list", {"taskId": self.task["id"], **query})
        self.assertFalse(error, result)
        return result

    def actual_step(self, step):
        for page in range(1, 4):
            for item in self.listing(page=page)["items"]:
                if item["id"] == step["id"]:
                    return item
        self.fail("Business step disappeared")

    def browser_action(self, step, kind="observe", arguments=None):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            task = self.current()
            if task.get("browser", {}).get("status") == "LIVE":
                break
            time.sleep(.25)
        self.assertEqual("LIVE", task["browser"]["status"])
        action = {"operationId": str(uuid.uuid4()), "stepId": step["id"], "type": kind,
                  "arguments": arguments or {}, "instructionRevision": task["instructionRevision"],
                  "controlEpoch": task["browser"]["controlEpoch"]}
        error, receipt, _ = self.client.tool("browser.execute", {"taskId": task["id"], "action": action})
        self.assertFalse(error, receipt)
        result = self.wait_operation(action["operationId"], self.client)
        self.assertEqual(step["id"], result["stepId"])
        return action, result

    def test_twenty_objects_replay_concurrency_and_shared_views(self):
        self.create()
        declared = [self.declare(number) for number in range(1, 21)]
        self.assertEqual(20, self.listing()["total"])
        with ThreadPoolExecutor(max_workers=2) as executor:
            duplicates = list(executor.map(lambda _: self.declare(20), range(2)))
        self.assertEqual([declared[-1]["id"]] * 2, [item["id"] for item in duplicates])
        self.assertEqual(20, self.listing()["total"])
        first = self.step("START", declared[0])
        error, refusal, _ = self.client.tool("steps.command", {
            "taskId": self.task["id"], "operationKey": str(uuid.uuid4()), "command": {
                "type": "START", "stepId": declared[1]["id"], "expectedVersion": 1,
                "instructionRevision": self.current()["instructionRevision"]}})
        self.assertTrue(error, refusal)
        self.assertEqual("STEP_IN_PROGRESS", refusal["code"])
        action, observed = self.browser_action(first)
        self.assertEqual("SUCCEEDED", observed["status"])
        self.assertEqual("RUNNING", self.actual_step(first)["status"], "Tool success is not goal success")
        error, _, _ = self.client.tool("browser.execute", {"taskId": self.task["id"], "action": action})
        self.assertFalse(error)
        self.browser_action(first)
        self.client.close_mcp()
        error, operations, _ = self.client.tool("operations.list", {"taskId": self.task["id"], "stepId": first["id"]})
        self.assertFalse(error, operations)
        self.assertEqual(2, operations["total"])
        self.assertIn(observed["id"], [item["id"] for item in operations["items"]])
        self.assertEqual(20, self.listing()["total"])
        before = self.listing()["items"][0]["sequence"]
        finished = self.step("COMPLETE", self.actual_step(first), outcome="SUCCEEDED",
                             result="Цена проверена по исходной странице",
                             evidence=[{"type": "OPERATION", "operationId": observed["id"]}])
        old_page = self.listing(page=2, beforeSequence=before)
        self.assertEqual("SUCCEEDED", next(item for item in old_page["items"] if item["id"] == first["id"])["status"])
        self.assertEqual(first["sequence"], finished["sequence"])
        rest = self.client.api("/api/tasks/" + self.task["id"] + "/steps")[1]
        error, widget, _ = self.client.tool("widget.steps", self.widget)
        self.assertFalse(error, widget)
        self.assertEqual(rest, widget)
        self.assertEqual(rest, self.listing())
        error, presentation, _ = self.client.tool("tasks.view", {
            "taskId": self.task["id"], "operationKey": str(uuid.uuid4())})
        self.assertFalse(error, presentation)
        self.assertTrue(self.client.tool("widget.steps", self.widget)[0])
        self.assertEqual(20, self.client.tool("widget.steps", {
            "taskId": self.task["id"], "generation": presentation["generation"]})[1]["total"])
        technical = self.client.api("/api/tasks/" + self.task["id"] + "/history")[1]
        self.assertGreater(technical["total"], 20)

    def test_failure_retry_partial_finish_and_resume(self):
        self.create()
        first = self.step("START", self.declare())
        remaining = self.declare(2)
        _, failed = self.browser_action(first, "waitFor", {'textGone': 'Learn more'})
        self.assertEqual("FAILED", failed["status"])
        self.assertEqual("RUNNING", self.actual_step(first)["status"])
        _, observed = self.browser_action(first)
        self.assertEqual("SUCCEEDED", observed["status"])
        first = self.step("COMPLETE", self.actual_step(first), outcome="FAILED", result="Цена не найдена")
        first = self.step("RETRY", first)
        first = self.step("COMPLETE", first, outcome="PARTIAL", result="Найдено предложение без текущей цены",
                          evidence=[{"type": "MODEL_RESULT", "text": "На странице указано описание товара без цены",
                                     "sources": [{"title": "Исходная страница", "url": "https://example.com"}]}])
        current = self.current()
        error, refusal, _ = self.client.tool("tasks.command", {"taskId": self.task["id"],
            "operationKey": str(uuid.uuid4()), "command": {"type": "FINISH", "outcome": "PARTIAL",
            "text": "Получена часть данных", "expectedVersion": current["version"]}})
        self.assertTrue(error, refusal)
        self.assertEqual("STEPS_UNFINISHED", refusal["code"])
        self.step("SKIP", remaining, result="Не выполнялся: источник недоступен")
        browser = self.current()["browser"]["id"]
        self.command(self.task, "FINISH", outcome="PARTIAL", text="Получена часть данных")
        self.assertEqual(browser, self.current()["browser"]["id"])
        self.command(self.task, "RESUME")
        retried = self.step("RETRY", first)
        self.assertEqual(first["id"], retried["id"])
        self.assertEqual(2, self.listing()["total"])
        self.assertEqual(browser, self.current()["browser"]["id"])

    def test_unknown_wait_user_manual_control_and_stop(self):
        self.create()
        step = self.step("START", self.declare())
        self.declare(2)
        error, question, _ = self.client.tool("tasks.ask", {"taskId": self.task["id"],
            "operationKey": str(uuid.uuid4()), "instructionRevision": self.current()["instructionRevision"],
            "prompt": "Какую цену проверять: обычную или со скидкой?"})
        self.assertFalse(error, question)
        self.assertEqual("WAITING", self.actual_step(step)["status"])
        self.command(self.task, "ANSWER", text="Обычную цену")
        self.assertEqual("RUNNING", self.actual_step(step)["status"])
        self.browser_action(step, "observe", {})
        self.client.return_control_without_continuing(self.task["id"])
        self.assertEqual("WAITING", self.actual_step(step)["status"])
        self.command(self.task, "RESUME")
        self.assertEqual("RUNNING", self.actual_step(step)["status"])
        _, unknown = self.browser_action(step, "click", self.client.browser_target(self.task['id'], 'Slow effect', step['id'], uncertain=True))
        self.assertEqual("UNKNOWN", unknown["status"])
        self.assertEqual("UNKNOWN", self.actual_step(step)["status"])
        self.command(self.task, "REJECT", text="Проверено: действие не выполнено")
        self.assertEqual("RUNNING", self.actual_step(step)["status"])
        self.command(self.task, "STOP")
        deadline = time.monotonic() + 45
        while self.current()["status"] != "STOPPED" and time.monotonic() < deadline:
            time.sleep(.25)
        states = {item["status"] for item in self.listing()["items"]}
        self.assertEqual({"FAILED", "SKIPPED"}, states)

    def test_stop_preserves_unknown_and_foreign_evidence_is_rejected(self):
        self.create()
        step = self.step("START", self.declare())
        self.declare(2)
        foreign = usage.dev.DisposableIdentity(self.settings, self.template)
        try:
            foreign_client = foreign.client()
            foreign_client.login_web()
            foreign_client.login_mcp()
            error, presentation, _ = foreign_client.tool("tasks.create", {
                "operationKey": str(uuid.uuid4()), "task": {
                    "title": "Foreign evidence fixture", "goal": "Check isolation",
                    "startUrl": "https://example.com", "prepare": False}})
            self.assertFalse(error, presentation)
            foreign_task = presentation["task"]["id"]
            operation = str(uuid.uuid4())
            artifact = str(uuid.uuid4())
            self.fixture_sql(foreign, "INSERT INTO operations(id,owner_id,task_id,type,arguments,status,mutating,"
                "instruction_revision,instruction_snapshot) VALUES ('" + operation + "',:owner,'"
                + foreign_task + "','observe','{}','SUCCEEDED',false,1,'{}');"
                "INSERT INTO artifacts(id,owner_id,task_id,name,mime_type,status,complete,relative_path) VALUES ('"
                + artifact + "',:owner,'" + foreign_task + "','foreign fixture','text/plain','READY',true,'"
                + artifact + "');")
            for evidence in ({"type": "OPERATION", "operationId": operation},
                             {"type": "ARTIFACT", "artifactId": artifact}):
                error, refusal, _ = self.client.tool("steps.command", {
                    "taskId": self.task["id"], "operationKey": str(uuid.uuid4()), "command": {
                        "type": "COMPLETE", "stepId": step["id"], "expectedVersion": step["version"],
                        "instructionRevision": self.current()["instructionRevision"], "outcome": "SUCCEEDED",
                        "result": "Чужое подтверждение недопустимо", "evidence": [evidence]}})
                self.assertTrue(error, refusal)
                self.assertEqual("VALIDATION", refusal["code"])
            error, _, _ = foreign_client.tool("operations.list", {"taskId": self.task["id"]})
            self.assertTrue(error)
        finally:
            self.purge_identity(foreign)
        _, operation = self.browser_action(step, "click", self.client.browser_target(self.task['id'], 'Slow effect', step['id'], uncertain=True))
        self.assertEqual("UNKNOWN", operation["status"])
        self.command(self.task, "STOP")
        deadline = time.monotonic() + 45
        while self.current()["status"] != "STOPPED" and time.monotonic() < deadline:
            time.sleep(.25)
        self.assertEqual("STOPPED", self.current()["status"])
        self.assertEqual({"UNKNOWN", "SKIPPED"}, {item["status"] for item in self.listing()["items"]})
        self.assertEqual("UNKNOWN", self.client.tool("operations.get", {"operationId": operation["id"]})[1]["status"])

    def test_boundaries_evidence_versions_and_legacy(self):
        self.create()
        self.assertEqual(0, self.listing()["total"], "Do not convert existing technical history")
        step = self.step("START", self.declare())
        action, observed = self.browser_action(step)
        del action["stepId"]
        action["operationId"] = str(uuid.uuid4())
        error, refusal, _ = self.client.tool("browser.execute", {"taskId": self.task["id"], "action": action})
        self.assertTrue(error, refusal)
        valid = {"type": "COMPLETE", "stepId": step["id"], "expectedVersion": step["version"],
                 "instructionRevision": self.current()["instructionRevision"], "outcome": "SUCCEEDED",
                 "result": "Проверено", "evidence": [{"type": "OPERATION", "operationId": observed["id"]}]}
        for override, code in [({"expectedVersion": 1}, "STALE_STEP"),
                               ({"instructionRevision": 999999}, "STALE_INSTRUCTION"),
                               ({"evidence": []}, "VALIDATION"),
                               ({"evidence": [{"type": "OPERATION", "operationId": str(uuid.uuid4())}]}, "VALIDATION")]:
            error, refusal, _ = self.client.tool("steps.command", {"taskId": self.task["id"],
                "operationKey": str(uuid.uuid4()), "command": {**valid, **override}})
            self.assertTrue(error, refusal)
            self.assertEqual(code, refusal["code"])
        request = {"taskId": self.task["id"], "operationKey": str(uuid.uuid4()), "command": valid}
        error, saved, _ = self.client.tool("steps.command", request)
        self.assertFalse(error, saved)
        self.assertEqual(saved, self.client.tool("steps.command", request)[1])
        self.assertEqual(1, self.listing()["total"])
        self.assertEqual(404, self.admin.api("/api/tasks/" + self.task["id"] + "/steps")[0])
        changes = self.fixture_sql(self.identity, "SELECT count(*) FROM task_history WHERE owner_id=:owner AND step_id IS NOT NULL;")
        self.assertEqual("3", changes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
