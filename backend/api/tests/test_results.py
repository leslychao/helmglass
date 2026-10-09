"""Result publication and list contracts against the deployed dev application."""

import base64
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
import unittest
from urllib.parse import urlencode
import uuid

from test_dev_contract import DevClient


class ResultContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        filename = Path(os.environ.get("HELM_TEST_ENV", "deploy/.env.dev"))
        settings = dict(line.split("=", 1) for line in filename.read_text(encoding="utf-8").splitlines()
                        if line and not line.startswith("#") and "=" in line)
        cls.settings = settings
        cls.user = DevClient(settings, "test", "KEYCLOAK_TEST_PASSWORD")
        cls.foreign = DevClient(settings, "admin", "KEYCLOAK_APP_ADMIN_PASSWORD")
        cls.user.login_web()
        cls.foreign.login_web()
        cls.user.login_mcp()

    def setUp(self):
        self.user.chat = "helm-dev-" + str(uuid.uuid4())

    def stop_task(self, task_id):
        for _ in range(5):
            status, latest = self.user.api("/api/tasks/" + task_id)
            self.assertEqual(200, status)
            status, result = self.user.api("/api/tasks/" + task_id + "/commands", "POST",
                {"type": "STOP", "expectedVersion": latest["version"]})
            if status == 200:
                return
            self.assertEqual(409, status)
            self.assertEqual("STALE_VERSION", result["code"])
            time.sleep(0.25)
        self.fail("The completed fixture did not settle for an explicit stop")

    def test_widget_continuation_ignores_a_replaced_presentation(self):
        build = subprocess.run(["node", "--input-type=module", "-e", """
import {build} from 'esbuild';
const result = await build({entryPoints:['src/main.ts'],bundle:true,format:'esm',write:false,
  plugins:[{name:'controlled-host',setup(builder){
    builder.onResolve({filter:/^@modelcontextprotocol\\/ext-apps$/},()=>({path:'host',namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const App=globalThis.WidgetTestApp'}));
  }}]});
process.stdout.write(result.outputFiles[0].text);
"""], cwd="backend/api/widget", text=True, capture_output=True, timeout=30)
        self.assertEqual(0, build.returncode, build.stderr)
        bundled = "data:text/javascript;base64," + base64.b64encode(build.stdout.encode()).decode()
        script = Path("backend/api/widget/test/continuation.mjs").read_text().replace("WIDGET_UNDER_TEST", bundled)
        checked = subprocess.run(["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
            "exec", "-i", "helmglass-browser-node-1", "node", "--input-type=module"],
            input=script, text=True, capture_output=True, timeout=30)
        self.assertEqual(0, checked.returncode, checked.stderr[-3000:])

    def test_published_widget_contains_executable_module_javascript(self):
        resources = self.user.rpc("resources/list", {})["resources"]
        self.assertEqual(1, len(resources))
        uri = resources[0]["uri"]
        resource = self.user.rpc("resources/read", {"uri": uri})
        html = resource["contents"][0]["text"]
        digest = hashlib.sha256(html.encode("utf-8")).hexdigest()
        self.assertEqual("ui://helmglass/task-" + digest + ".html", uri,
                         "Changed widget bytes must have a different host cache identity")
        self.assertEqual(uri, resource["contents"][0]["uri"])
        tools = self.user.rpc("tools/list", {})["tools"]
        for tool in tools:
            if tool["name"] in ("tasks.create", "tasks.view"):
                self.assertEqual(uri, tool["_meta"]["ui"]["resourceUri"])
        modules = re.findall(r'<script\s+type="module">(.*?)</script\s*>', html, re.S)
        self.assertEqual(1, len(modules), "The published widget must contain one application module")
        checked = subprocess.run(["docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
            "exec", "-i", "helmglass-browser-node-1", "node", "--input-type=module", "--check"],
            input=modules[0], text=True, capture_output=True, timeout=30)
        self.assertEqual(0, checked.returncode, "Published widget JavaScript fails syntax validation")

    def test_typed_results_pagination_and_exact_filtered_counters(self):
        title = "Result contract " + str(uuid.uuid4())
        error, presentation, _ = self.user.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()),
            "task": {"title": title, "goal": "Verify typed results without website changes",
                     "startUrl": "https://example.com", "outputFormat": "TABLE", "prepare": True}})
        self.assertFalse(error)
        task = presentation["task"]
        task_id = task["id"]
        try:
            result = {"summary": "Twelve verified contract rows", "limitations": ["Synthetic acceptance data"],
                      "sources": [{"title": "Public source", "url": "https://example.com"}],
                      "columns": [{"key": "ordinal", "label": "Number", "type": "number"},
                                  {"key": "caption", "label": "Text", "type": "string"},
                                  {"key": "measured", "label": "Optional number", "type": "number"},
                                  {"key": "day", "label": "Date", "type": "date"}]}
            rows = [{"ordinal": index, "caption": "Row " + str(index)} for index in range(1, 13)]
            for index, value in enumerate([None, 10, 2, 10, 0, -1, None, 100, 3, 20, 4, 8]):
                rows[index]['day'] = f'2026-07-{12-index:02}'
                if index != 6:
                    rows[index]['measured'] = value
            publish = {"taskId": task_id, "instructionRevision": task["instructionRevision"],
                       "operationKey": str(uuid.uuid4()), "result": result, "rows": rows}
            error, saved, _ = self.user.tool("results.publish", publish)
            self.assertFalse(error, saved.get("message", "Typed result publication was rejected"))
            self.assertEqual(result["columns"], saved["result"]["columns"])
            self.assertEqual(result["limitations"], saved["result"]["limitations"])
            self.assertEqual(0, saved["result"]["artifactCount"])
            self.assertNotIn("artifacts", saved["result"])
            self.assertFalse(self.user.tool("results.publish", publish)[0])
            error, visible, _ = self.user.tool("tasks.view", {
                "taskId": task_id, "operationKey": str(uuid.uuid4())})
            self.assertFalse(error)
            validation = subprocess.run(
                ["node", "--input-type=module", "-e",
                 "import {presentationSchema} from './backend/api/widget/src/presentation.ts';"
                 "let input=''; for await (const chunk of process.stdin) input+=chunk;"
                 "const result=presentationSchema.safeParse(JSON.parse(input));"
                 "if(!result.success){console.error(result.error.message);process.exit(1)}"],
                input=json.dumps(visible), text=True, capture_output=True, check=False, timeout=15)
            self.assertEqual(0, validation.returncode, validation.stderr)
            files_path = "/api/tasks/" + task_id + "/artifacts"
            status, files = self.user.api(files_path)
            self.assertEqual(200, status)
            self.assertEqual(0, files["total"])
            self.assertEqual([], files["items"])
            self.assertEqual(404, self.foreign.api(files_path)[0])
            error, mcp_files, _ = self.user.tool("artifacts.list", {"taskId": task_id})
            self.assertFalse(error)
            self.assertEqual(files, mcp_files)

            path = "/api/tasks/" + task_id + "/result/rows"
            status, first = self.user.api(path + "?pageSize=10&sort=ordinal&direction=asc")
            self.assertEqual(200, status)
            self.assertEqual(12, first["total"], "A repeated publish must not append rows twice")
            self.assertEqual(list(range(1, 11)), [item["cells"]["ordinal"] for item in first["items"]])
            status, second = self.user.api(path + "?pageSize=10&page=2&sort=ordinal&direction=asc")
            self.assertEqual(200, status)
            self.assertEqual([11, 12], [item["cells"]["ordinal"] for item in second["items"]])
            status, reverse = self.user.api(path + "?pageSize=10&sort=ordinal&direction=desc")
            self.assertEqual(200, status)
            self.assertEqual(list(range(12, 2, -1)), [item["cells"]["ordinal"] for item in reverse["items"]])
            for direction, expected in [
                ('asc', [6, 5, 3, 9, 11, 12, 2, 4, 10, 8, 1, 7]),
                ('desc', [8, 10, 2, 4, 12, 11, 9, 3, 5, 6, 1, 7]),
            ]:
                actual = []
                for number in [1, 2, 3]:
                    status, page = self.user.api(path + '?' + urlencode({
                        'page': number, 'pageSize': 5, 'sort': 'measured', 'direction': direction}))
                    self.assertEqual(200, status, page)
                    self.assertEqual(12, page['total'])
                    actual.extend(row['cells']['ordinal'] for row in page['items'])
                self.assertEqual(expected, actual, 'Numbers, stable ties, JSON null and absent cells across pages')
            dated = self.user.api(path + '?pageSize=25&sort=day&direction=asc')[1]
            self.assertEqual(25, dated['pageSize'])
            self.assertEqual(list(range(12, 0, -1)), [row['cells']['ordinal'] for row in dated['items']])
            self.assertEqual(404, self.foreign.api(path)[0])
            status, found = self.user.api(path + "?search=Row%2012")
            self.assertEqual(200, status)
            self.assertEqual(1, found["total"])
            self.assertEqual(rows[-1], found["items"][0]["cells"])

            query = urlencode({"search": title, "source": "MCP", "site": "example.com"})
            status, listing = self.user.api("/api/tasks?" + query)
            self.assertEqual(200, status)
            self.assertEqual(1, listing["total"])
            self.assertEqual(task_id, listing["items"][0]["id"])
            self.assertEqual(result["summary"], listing["items"][0]["summary"])
            status, counters = self.user.api("/api/tasks/summary?" + query)
            self.assertEqual(200, status)
            self.assertEqual(1, counters["total"])

            invalid = {**publish, "operationKey": str(uuid.uuid4()), "rows": [{"ordinal": {"nested": 1}}]}
            self.assertTrue(self.user.tool("results.publish", invalid)[0])
            changed_columns = {**result, "columns": [{"key": "other", "label": "Other", "type": "string"}]}
            self.assertTrue(self.user.tool("results.publish", {**publish, "operationKey": str(uuid.uuid4()),
                "result": changed_columns, "rows": []})[0])
            status, unchanged = self.user.api(path)
            self.assertEqual(200, status)
            self.assertEqual(12, unchanged["total"], "Rejected input must leave all saved rows intact")
        finally:
            self.stop_task(task_id)

    def test_site_filters_search_beyond_the_first_page_and_preserve_ownership(self):
        marker = "facet-" + uuid.uuid4().hex[:12]
        tasks, connections = [], []
        expected = [f"{marker}-{index:02d}.example.com" for index in range(12)]
        try:
            for site in expected:
                status, task = self.user.api("/api/tasks", "POST", {
                    "title": marker, "goal": "Draft facet contract", "prepare": False,
                    "startUrl": "https://" + site})
                self.assertEqual(200, status)
                tasks.append(task["id"])
                status, connection = self.user.api("/api/connections", "POST", {
                    "name": marker, "site": site, "startUrl": "https://" + site})
                self.assertEqual(200, status)
                connections.append(connection["id"])
            for resource in ("tasks", "connections"):
                path = "/api/" + resource + "/sites?" + urlencode({"search": marker, "pageSize": 10})
                status, first = self.user.api(path)
                self.assertEqual(200, status)
                self.assertEqual(12, first["total"])
                self.assertEqual(expected[:10], first["items"])
                status, second = self.user.api(path + "&page=2")
                self.assertEqual(200, status)
                self.assertEqual(expected[10:], second["items"])
                status, searched = self.user.api("/api/" + resource + "/sites?" + urlencode({"search": expected[-1]}))
                self.assertEqual(200, status)
                self.assertEqual([expected[-1]], searched["items"])
                self.assertEqual(0, self.foreign.api(path)[1]["total"])
            status, required_login = self.user.api("/api/connections?" + urlencode({
                "search": marker, "status": "LOGIN_REQUIRED", "pageSize": 20}))
            self.assertEqual(200, status)
            self.assertEqual(12, required_login["total"])
        finally:
            for task_id in tasks:
                self.assertEqual(200, self.user.api("/api/tasks/" + task_id, "DELETE")[0])
            for connection_id in connections:
                self.assertEqual(200, self.user.api("/api/connections/" + connection_id, "DELETE")[0])

    def test_continuation_requires_a_new_command_not_an_old_operation_receipt(self):
        error, presentation, _ = self.user.tool("tasks.create", {
            "operationKey": str(uuid.uuid4()), "task": {"title": "Continuation receipt contract",
            "goal": "Observe a public page without external changes", "startUrl": "https://example.org",
            "prepare": True}})
        self.assertFalse(error)
        task_id = presentation["task"]["id"]
        widget = {"taskId": task_id, "generation": presentation["generation"]}
        original = {"operationId": str(uuid.uuid4()), "type": "observe", "arguments": {},
                    "instructionRevision": presentation["task"]["instructionRevision"]}
        try:
            self.assertFalse(self.user.execute_in_scenario_step({"taskId": task_id, "action": original})[0])
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                error, receipt, _ = self.user.tool("operations.get", {"operationId": original["operationId"]})
                self.assertFalse(error)
                if receipt["status"] not in ("ACCEPTED", "DISPATCHED"):
                    break
                time.sleep(0.25)
            self.assertEqual("SUCCEEDED", receipt["status"])
            for command in ("PAUSE", "RESUME"):
                task = self.user.api("/api/tasks/" + task_id)[1]
                status, _ = self.user.api("/api/tasks/" + task_id + "/commands", "POST",
                                         {"type": command, "expectedVersion": task["version"]})
                self.assertEqual(200, status)
            self.assertEqual("PENDING", self.user.tool("widget.state", widget)[1]["continuationStatus"])
            self.assertFalse(self.user.execute_in_scenario_step({"taskId": task_id, "action": original})[0])
            self.assertEqual("PENDING", self.user.tool("widget.state", widget)[1]["continuationStatus"],
                             "Re-reading a completed operation must not claim a new step was accepted")
            pending = self.user.tool("widget.state", widget)[1]
            attempt = {**widget, "continuationId": pending["continuationId"]}
            self.assertTrue(self.user.tool("widget.claim", attempt)[1]["claimed"])
            self.assertFalse(self.user.tool("widget.claim", attempt)[1]["claimed"])
            error, reported, _ = self.user.tool("widget.continuation", {**attempt, "sent": True})
            self.assertFalse(error)
            self.assertEqual("MESSAGE_SENT", reported["continuationStatus"])
            current = self.user.api("/api/tasks/" + task_id)[1]
            next_action = {**original, "operationId": str(uuid.uuid4()),
                           "controlEpoch": current["browser"]["controlEpoch"]}
            self.assertFalse(self.user.execute_in_scenario_step({"taskId": task_id, "action": next_action})[0])
            self.assertEqual("ACCEPTED", self.user.tool("widget.state", widget)[1]["continuationStatus"])
        finally:
            self.stop_task(task_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
