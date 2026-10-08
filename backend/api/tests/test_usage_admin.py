"""Numeric reporting and administration contracts against deployed PostgreSQL/API.

Historical times and unavailable measurements are controlled only for disposable
owners. Task creation, outcomes, permissions and administrative commands use HTTP.
"""

from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
from urllib.parse import urlencode
from urllib.request import Request
import uuid
import wave

import test_dev_contract as dev


class UsageAdministrationTest(unittest.TestCase):
    fixture_sql = dev.DevContractTest.fixture_sql
    purge_identity = dev.DevContractTest.purge_identity
    wait_operation = dev.DevContractTest.wait_operation

    @classmethod
    def setUpClass(cls):
        filename = Path(os.environ.get("HELM_TEST_ENV", "deploy/.env.dev"))
        cls.settings = dict(line.split("=", 1) for line in filename.read_text(encoding="utf-8").splitlines()
                            if line and not line.startswith("#") and "=" in line)
        user = dev.DevClient(cls.settings, "test", "KEYCLOAK_TEST_PASSWORD")
        cls.template = user.login_web()["id"]
        cls.admin = dev.DevClient(cls.settings, "admin", "KEYCLOAK_APP_ADMIN_PASSWORD")
        cls.admin.login_web()

    def setUp(self):
        self.identity = dev.DisposableIdentity(self.settings, self.template)
        self.client = self.identity.client()
        self.client.login_web()

    def tearDown(self):
        self.purge_identity(self.identity)

    def create(self, title, prepare=True, site="example.com"):
        status, task = self.client.api("/api/tasks", "POST", {
            "title": title, "goal": "Disposable numeric reporting acceptance",
            "startUrl": "https://" + site if site else None,
            "outputFormat": "TEXT", "prepare": prepare})
        self.assertEqual(200, status, task)
        return task

    def command(self, task, kind, **fields):
        status, current = self.client.api("/api/tasks/" + task["id"])
        self.assertEqual(200, status, current)
        status, result = self.client.api("/api/tasks/" + task["id"] + "/commands", "POST", {
            "type": kind, "expectedVersion": current["version"], **fields})
        self.assertEqual(200, status, result)
        return result

    def sql(self, statement):
        return self.fixture_sql(self.identity, statement)

    def interval(self, task, kind, start, seconds, incomplete=False):
        task_id = "NULL" if task is None else "'" + task["id"] + "'"
        self.sql("INSERT INTO usage_intervals(id,owner_id,task_id,kind,started_at,ended_at,incomplete) "
                 f"VALUES('{uuid.uuid4()}',:owner,{task_id},'{kind}','{start}',"
                 f"'{start}'::timestamptz+interval '{seconds} seconds',{str(incomplete).lower()});")

    def artifact(self, task, size, duration, created, status="READY"):
        artifact_id = str(uuid.uuid4())
        seconds = "NULL" if duration is None else str(duration)
        self.sql("INSERT INTO artifacts(id,owner_id,task_id,name,mime_type,status,size_bytes,"
                 "complete,duration_seconds,relative_path,created_at) VALUES "
                 f"('{artifact_id}',:owner,'{task['id']}','Measured fixture','audio/mpeg',"
                 f"'{status}',{size},true,{seconds},'{artifact_id}','{created}');")

    def test_repeated_original_download_does_not_duplicate_media_usage(self):
        task = self.create("Repeated original download accounting")
        payload = io.BytesIO()
        with wave.open(payload, "wb") as recording:
            recording.setnchannels(1)
            recording.setsampwidth(2)
            recording.setframerate(8000)
            recording.writeframes(b"\0\0" * 80)
        original = payload.getvalue()
        artifact = str(uuid.uuid4())
        digest = hashlib.sha256(original).hexdigest()
        self.sql("INSERT INTO artifacts(id,owner_id,task_id,name,mime_type,status,size_bytes,"
                 "complete,sha256,relative_path) VALUES "
                 f"('{artifact}',:owner,'{task['id']}','Synthetic original','audio/wav','READY',"
                 f"{len(original)},true,'{digest}','{artifact}');")
        written = subprocess.run([
            "docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375", "exec", "-i",
            "helmglass-api-1", "tee", "/data/artifacts/" + artifact], input=original,
            capture_output=True, timeout=15)
        self.assertEqual(0, written.returncode)
        before = self.usage()
        self.assertEqual(len(original), before["usage"]["mediaBytes"])
        self.assertIsNone(before["usage"]["mediaSeconds"])
        self.assertTrue(before["usage"]["incomplete"])
        page = self.client.api("/api/tasks/" + task["id"] + "/artifacts")[1]
        self.assertEqual(1, page["total"])
        for _ in range(2):
            status, received, _ = self.client.request(self.client.base + page["items"][0]["downloadUrl"])
            self.assertEqual((200, original), (status, received))
        self.assertEqual(before, self.usage())
        self.assertEqual(page, self.client.api("/api/tasks/" + task["id"] + "/artifacts")[1])

    def usage(self, **query):
        status, report = self.client.api("/api/usage?" + urlencode(query))
        self.assertEqual(200, status, report)
        return report

    def admin_command(self, kind, **fields):
        path = "/api/admin/users/" + self.identity.id
        status, detail = self.admin.api(path)
        self.assertEqual(200, status, detail)
        return self.admin.api(path + "/commands", "POST", {
            "type": kind, "expectedVersion": detail["user"]["version"],
            "reason": "Disposable reporting contract", **fields})

    def test_lost_create_body_and_status_counters_use_the_entire_filtered_cohort(self):
        marker = "Counter cohort " + str(uuid.uuid4())
        body = {"title": marker, "goal": "Retry without consuming the original response body",
                "prepare": False}
        key = str(uuid.uuid4())
        csrf = next(cookie.value for cookie in self.client.cookies if cookie.name == "XSRF-TOKEN")
        request = Request(self.client.base + "/api/tasks", data=json.dumps(body).encode(), headers={
            "Content-Type": "application/json", "X-XSRF-TOKEN": csrf, "Idempotency-Key": key})
        # The response is deliberately closed before reading the created task or its ID.
        with self.client.http.open(request, timeout=25) as response:
            self.assertEqual(200, response.status)
        committed = self.client.api("/api/tasks?" + urlencode({"search": marker}))[1]
        self.assertEqual(1, committed["total"])
        status, repeated = self.client.api("/api/tasks", "POST", body, key)
        self.assertEqual(200, status, repeated)
        self.assertEqual(committed["items"][0]["id"], repeated["id"])
        self.assertEqual(1, self.client.api("/api/tasks?" + urlencode({"search": marker}))[1]["total"])

        states = ["DRAFT", "WAITING_CHATGPT", "QUEUED", "STARTING", "RUNNING", "WAITING_USER",
                  "PAUSING", "PAUSED", "STOPPING", "STOPPED", "SUCCEEDED", "PARTIAL", "NOT_ACHIEVED", "FAILED"]
        cohort = [repeated] + [self.create(marker + " " + state, prepare=False) for state in states[1:]]
        for task, state in zip(cohort, states):
            self.sql("UPDATE tasks SET status='" + state + "',site='example.com',source='WEB',"
                     "created_at='2026-07-02T00:00:00Z' WHERE owner_id=:owner AND id='" + task["id"] + "';")
        for field, value in (("site", "example.org"), ("source", "MCP"),
                             ("created_at", "2026-07-01T23:59:59Z"), ("created_at", "2026-07-03T00:00:00Z")):
            excluded = self.create(marker + " excluded " + field, prepare=False)
            self.sql("UPDATE tasks SET status='SUCCEEDED',site='example.com',source='WEB',"
                     "created_at='2026-07-02T00:00:00Z' WHERE owner_id=:owner AND id='" + excluded["id"] + "';"
                     "UPDATE tasks SET " + field + "='" + value + "' WHERE owner_id=:owner AND id='" + excluded["id"] + "';")
        self.create("Excluded search title", prepare=False)
        query = urlencode({"search": marker, "site": "example.com", "source": "WEB",
                           "from": "2026-07-02T00:00:00Z", "to": "2026-07-03T00:00:00Z", "pageSize": 10})
        summary = self.client.api("/api/tasks/summary?" + query)[1]
        self.assertEqual((14, 4, 1, 1), tuple(summary[key] for key in ("total", "active", "succeeded", "waitingForYou")))
        first = self.client.api("/api/tasks?" + query)[1]
        second = self.client.api("/api/tasks?" + query + "&page=2")[1]
        self.assertEqual((14, 10, 4), (first["total"], len(first["items"]), len(second["items"])))
        for selected, expected in (("STARTING,RUNNING,PAUSING,STOPPING", 4), ("SUCCEEDED", 1),
                                   ("WAITING_USER", 1), ("QUEUED,PAUSED,WAITING_CHATGPT", 3)):
            self.assertEqual(summary, self.client.api("/api/tasks/summary?" + query + "&status=" + selected + "&page=2")[1])
            self.assertEqual(expected, self.client.api("/api/tasks?" + query + "&status=" + selected)[1]["total"])

    def test_created_cohort_outcomes_accumulated_intervals_and_incomplete_media(self):
        tasks = [self.create("Outcome " + str(number))
                 for number in range(7)]
        for task, outcome in zip(tasks, ("SUCCEEDED", "PARTIAL", "NOT_ACHIEVED")):
            ended = self.command(task, "FINISH", outcome=outcome, text="Confirmed " + outcome)
            self.assertEqual(outcome, ended["status"])
            self.assertEqual(outcome, ended["outcome"])
        self.command(tasks[3], "STOP")
        self.command(tasks[6], "STOP")
        self.sql(f"UPDATE tasks SET site=NULL,start_url=NULL WHERE owner_id=:owner AND id='{tasks[3]['id']}';")
        draft = self.create("Excluded draft", prepare=False)
        old = self.create("Excluded earlier task")
        end = self.create("Excluded exclusive endpoint")
        dates = ["2026-07-01T19:59:59Z", "2026-07-01T20:00:00Z"] + ["2026-07-02T12:00:00Z"] * 5
        for task, created in zip(tasks, dates):
            self.sql(f"UPDATE tasks SET created_at='{created}' WHERE owner_id=:owner AND id='{task['id']}';")
        for task, created in ((draft, dates[0]), (old, "2026-06-30T19:59:59Z"), (end, "2026-07-02T20:00:00Z")):
            self.sql(f"UPDATE tasks SET created_at='{created}' WHERE owner_id=:owner AND id='{task['id']}';")
        self.sql(f"UPDATE tasks SET status='FAILED' WHERE owner_id=:owner AND id='{tasks[4]['id']}';"
                 "INSERT INTO operations(id,owner_id,task_id,type,arguments,status,mutating,instruction_revision) "
                 f"VALUES('{uuid.uuid4()}',:owner,'{tasks[6]['id']}','click','{{}}','UNKNOWN',true,1);")
        self.interval(tasks[0], "BROWSER", "2026-07-01T21:00:00Z", 120)
        self.interval(tasks[0], "EXECUTION", "2026-07-01T21:00:10Z", 30)
        self.interval(tasks[0], "MANUAL", "2026-07-01T21:01:00Z", 20)
        self.interval(tasks[1], "BROWSER", "2026-07-02T14:00:00Z", 60, True)
        self.interval(tasks[1], "EXECUTION", "2026-07-02T14:00:10Z", 10)
        self.interval(tasks[1], "MANUAL", "2026-07-02T14:00:30Z", 5)
        self.interval(tasks[3], "BROWSER", "2026-08-01T12:00:00Z", 40)
        self.interval(old, "BROWSER", "2026-07-01T12:00:00Z", 999)
        self.interval(None, "BROWSER", "2026-07-01T12:00:00Z", 888)
        self.artifact(tasks[0], 300, 12.5, "2026-08-01T00:00:00Z")
        self.artifact(tasks[1], 200, None, "2026-07-02T00:00:00Z")
        self.artifact(tasks[2], 111, 99, "2026-07-02T00:00:00Z", "TRANSFERRING")
        query = {"from": "2026-06-30T20:00:00Z", "to": "2026-07-02T20:00:00Z", "timezone": "Europe/Saratov"}
        report = self.usage(**query)
        self.assertEqual((7, 1, 5, .2), tuple(report[key] for key in
                         ("totalTasks", "successfulTasks", "completedTasks", "successRate")))
        self.assertEqual({"browserSeconds":220, "executionSeconds":40, "manualSeconds":25,
                          "mediaSeconds":12.5, "mediaBytes":500, "incomplete":True}, report["usage"])
        self.assertEqual([{"date":"2026-07-01","tasks":1,"browserSeconds":120},
                          {"date":"2026-07-02","tasks":6,"browserSeconds":100}], report["days"]["items"])
        sites = {item["site"]:item for item in report["sites"]["items"]}
        self.assertEqual((6,180,500,12.5), tuple(sites["example.com"][key] for key in
                         ("tasks","browserSeconds","mediaBytes","mediaSeconds")))
        self.assertEqual((1,40), (sites[None]["tasks"],sites[None]["browserSeconds"]))
        self.assertEqual(7, sum(item["tasks"] for item in report["statuses"]))
        self.assertEqual(report, self.usage(**query), "Reading a report must not charge usage again")
        self.assertIsNone(self.usage(**{"from":"2026-06-30T19:59:59Z","to":"2026-06-30T20:00:00Z"})["successRate"])
        self.assertEqual(0, self.usage(**{"from":"2026-01-01T00:00:00Z","to":"2026-01-02T00:00:00Z"})["totalTasks"])

    def test_admin_calendar_window_includes_existing_tasks_and_standalone_usage(self):
        recent = self.create("Recent calendar task")
        old = self.create("Older task with recent work")
        now = datetime.now(timezone.utc)
        start = (now + timedelta(hours=4)).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=6, hours=4)
        self.sql(f"UPDATE tasks SET created_at='{(start-timedelta(days=1)).isoformat()}' "
                 f"WHERE owner_id=:owner AND id='{old['id']}';")
        self.interval(recent,"BROWSER",(now-timedelta(hours=1)).isoformat(),120)
        self.interval(old,"BROWSER",(now-timedelta(hours=2)).isoformat(),30)
        self.interval(None,"BROWSER",(start-timedelta(seconds=60)).isoformat(),120)
        self.interval(None,"MANUAL",(now-timedelta(hours=3)).isoformat(),20)
        self.interval(None,"BROWSER",(start-timedelta(hours=1)).isoformat(),30)
        self.artifact(old,400,8,(now-timedelta(minutes=5)).isoformat())
        self.artifact(recent,100,2,(start-timedelta(seconds=1)).isoformat())
        status, detail = self.admin.api("/api/admin/users/"+self.identity.id+"?timezone=Europe%2FSaratov")
        self.assertEqual(200,status,detail)
        self.assertEqual(1,detail["usage"]["totalTasks"])
        self.assertEqual({"browserSeconds":210,"executionSeconds":0,"manualSeconds":20,
                          "mediaSeconds":8,"mediaBytes":400,"incomplete":False},detail["usage"]["usage"])
        report=self.usage()
        self.assertEqual(150,report["usage"]["browserSeconds"])
        self.assertEqual(0,report["usage"]["manualSeconds"])
        self.assertEqual(500,report["usage"]["mediaBytes"])

    def test_admin_limits_search_recent_fifty_and_stop_all_cutoff(self):
        endpoint = "/api/admin/users/" + self.identity.id
        status, detail = self.admin.api(endpoint)
        self.assertEqual(200,status)
        self.assertEqual("PLATFORM",detail["user"]["browserLimitMode"])
        self.assertIsNone(detail["user"]["browserLimit"])
        self.assertIsNone(detail["user"]["waitingLimit"])
        for fields in ({"browserLimitMode":"CUSTOM","browserLimit":0},
                       {"browserLimitMode":"CUSTOM","browserLimit":-1},
                       {"browserLimitMode":"CUSTOM","browserLimit":None},
                       {"browserLimitMode":"CUSTOM","browserLimit":1.5},
                       {"browserLimitMode":"CUSTOM","browserLimit":1,"waitingLimit":-1},
                       {"browserLimitMode":"UNKNOWN"}):
            self.assertEqual(400,self.admin_command("LIMITS",**fields)[0],fields)
        for reason in (None,"", " ", "a"*1001):
            self.assertEqual(400,self.admin_command("LIMITS",browserLimitMode="PLATFORM",reason=reason)[0])
        for mode, limit, waiting in (("CUSTOM",1,3),("UNLIMITED",None,None),("PLATFORM",None,None)):
            status, user = self.admin_command("LIMITS",browserLimitMode=mode,browserLimit=limit,waitingLimit=waiting)
            self.assertEqual(200,status,user)
            self.assertEqual((mode,limit,waiting),(user["browserLimitMode"],user["browserLimit"],user["waitingLimit"]))
        self.assertEqual(403,self.client.api(endpoint+"/commands","POST",{
            "type":"LIMITS","reason":"User must not set limits","browserLimitMode":"UNLIMITED"})[0])
        draft=self.create("Preserved draft",prepare=False)
        tasks=[self.create("Accepted task "+str(number)) for number in range(52)]
        statements=[]
        for number,task in enumerate([draft]+tasks):
            statements.append(f"UPDATE tasks SET created_at='2026-07-01'::timestamptz+interval '{number} seconds' "
                              f"WHERE owner_id=:owner AND id='{task['id']}';")
        self.sql("\n".join(statements))
        self.assertEqual("PAUSED",self.command(tasks[0],"PAUSE")["status"])
        status,detail=self.admin.api(endpoint)
        self.assertEqual(51,detail["user"]["waitingCount"])
        self.assertEqual(0,detail["user"]["browserCount"])
        self.assertIsNotNone(detail["user"]["lastAccessAt"])
        status,user=self.admin_command("LIMITS",browserLimitMode="CUSTOM",browserLimit=1,waitingLimit=1)
        self.assertEqual(200,status,user)
        self.assertEqual("WAITING_CHATGPT",self.command(tasks[0],"RESUME")["status"],
                         "Lowering a waiting limit must not reject accepted work returning from pause")
        status,refusal=self.client.api("/api/tasks","POST",{
            "title":"Denied new admission","goal":"The queue is full","startUrl":"https://example.com","prepare":True})
        self.assertEqual((409,"WAITING_LIMIT"),(status,refusal["code"]))
        for search in (self.identity.id,self.identity.username+"@example.com","Dev Contract"):
            status,found=self.admin.api("/api/admin/users?"+urlencode({"search":search,"status":"ACTIVE","flag":"waiting","pageSize":50}))
            self.assertEqual(200,status,found)
            self.assertIn(self.identity.id,[row["id"] for row in found["items"]])
        self.assertEqual(0,self.admin.api("/api/admin/users?"+urlencode({"search":self.identity.id,"status":"BLOCKED"}))[1]["total"])
        recent=[]
        for page in (1,2,3,4):
            status,detail=self.admin.api(endpoint+"?taskPage="+str(page)+"&taskPageSize=20")
            self.assertEqual(200,status,detail)
            self.assertEqual(50,detail["tasks"]["total"])
            self.assertEqual((20,20,10,0)[page-1],len(detail["tasks"]["items"]))
            recent.extend(row["id"] for row in detail["tasks"]["items"])
        self.assertEqual([task["id"] for task in reversed(tasks[-50:])],recent)
        status,_=self.admin_command("LIMITS",browserLimitMode="UNLIMITED",waitingLimit=None)
        self.assertEqual(200,status)
        stop_key=str(uuid.uuid4())
        status,stopping=self.admin.api(endpoint+"/commands","POST",{"type":"STOP_ALL"},stop_key)
        self.assertEqual(200,status,stopping)
        self.assertGreaterEqual(stopping["pendingOperations"],1)
        self.assertEqual((status,stopping),self.admin.api(endpoint+"/commands","POST",{"type":"STOP_ALL"},stop_key))
        future=self.create("Future accepted task survives cutoff")
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            status,detail=self.admin.api(endpoint)
            if detail["user"]["pendingOperations"]==0:
                break
            time.sleep(.2)
        self.assertEqual(0,detail["user"]["pendingOperations"])
        self.assertEqual("DRAFT",self.client.api("/api/tasks/"+draft["id"])[1]["status"])
        self.assertEqual("WAITING_CHATGPT",self.client.api("/api/tasks/"+future["id"])[1]["status"])
        stopped=self.client.api("/api/tasks?status=STOPPED&pageSize=50")[1]
        self.assertEqual(52,stopped["total"])
        status,audit=self.admin.api("/api/admin/audit?"+urlencode({"user":self.identity.id,"search":"STOP_ALL","status":"SUCCEEDED"}))
        self.assertEqual(200,status,audit)
        self.assertEqual(1,audit["total"])
        row=audit["items"][0]
        self.assertEqual(self.identity.id,row["target"])
        self.assertIsNone(row["reason"])
        self.assertEqual("ACTIVE",json.loads(row["before"])["status"])
        self.assertEqual("ACTIVE",json.loads(row["after"])["status"])
        self.assertEqual(self.admin.api("/api/me")[1]["id"],row["actor"])

    def test_invalid_node_command_is_a_validation_error(self):
        status,nodes=self.admin.api("/api/admin/nodes")
        self.assertEqual(200,status,nodes)
        self.assertTrue(nodes)
        node=nodes[0]
        status,error=self.admin.api("/api/admin/nodes/"+node["id"]+"/commands","POST",{
            "type":None,"reason":"Invalid node command must not change admission"})
        self.assertEqual(400,status,error)
        self.assertEqual("VALIDATION",error["code"])

    def test_pause_settles_dispatched_step_and_unknown_preserves_saved_results(self):
        self.client.login_mcp()
        error,presentation,_=self.client.tool("tasks.create",{
            "operationKey":str(uuid.uuid4()),"task":{
                "title":"Pause and saved result contract","goal":"Verify known outcomes before pausing",
                "startUrl":"https://example.com","outputFormat":"TABLE",
                "prepare":True,"requireConfirmation":False}})
        self.assertFalse(error,presentation)
        task=presentation["task"]
        task_id=task["id"]

        def current():
            status,value=self.client.api("/api/tasks/"+task_id)
            self.assertEqual(200,status,value)
            return value

        def execute(kind, arguments):
            task=current()
            operation=str(uuid.uuid4())
            action={"operationId":operation,"type":kind,"arguments":arguments,
                    "instructionRevision":task["instructionRevision"]}
            if task.get("browser"):
                action["controlEpoch"]=task["browser"]["controlEpoch"]
            error,receipt,_=self.client.tool("browser.execute",{"taskId":task_id,"action":action})
            self.assertFalse(error,receipt)
            return operation

        observed=execute("observe",{})
        self.assertEqual("SUCCEEDED",self.wait_operation(observed,self.client)["status"])
        browser=current()["browser"]["id"]
        screenshot=execute("screenshot",{})
        self.assertEqual("SUCCEEDED",self.wait_operation(screenshot,self.client)["status"])
        error,saved,_=self.client.tool("results.publish",{
            "taskId":task_id,"instructionRevision":task["instructionRevision"],
            "operationKey":str(uuid.uuid4()),"result":{
                "summary":"Preserved before uncertain action","limitations":[],"sources":[],
                "columns":[{"key":"value","label":"Saved value","type":"string"}]},
            "rows":[{"value":"immutable prior result"}]})
        self.assertFalse(error,saved)
        status,files=self.client.api("/api/tasks/"+task_id+"/artifacts")
        self.assertEqual(200,status,files)
        self.assertEqual(1,files["total"])
        artifact=files["items"][0]
        status,original,_=self.client.request(self.client.base+artifact["downloadUrl"])
        self.assertEqual(200,status)
        self.assertEqual(artifact["sha256"],hashlib.sha256(original).hexdigest())
        pending=execute("waitFor",{"selector":"[data-acceptance-never-visible]"})
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            error,receipt,_=self.client.tool("operations.get",{"operationId":pending})
            self.assertFalse(error,receipt)
            if receipt["status"]=="DISPATCHED":
                break
            time.sleep(.1)
        self.assertEqual("DISPATCHED",receipt["status"])
        self.assertEqual("RUNNING",current()["status"])
        queued=execute("observe",{})
        pausing=self.command(task,"PAUSE")
        self.assertEqual("PAUSING",pausing["status"])
        self.assertEqual(browser,pausing["browser"]["id"])
        self.assertEqual("CANCELLED",self.wait_operation(queued,self.client)["status"])
        self.assertEqual("FAILED",self.wait_operation(pending,self.client)["status"])
        paused=current()
        self.assertEqual("PAUSED",paused["status"])
        self.assertEqual((browser,"LIVE"),(paused["browser"]["id"],paused["browser"]["status"]))
        elapsed=paused["usage"]["executionSeconds"]
        time.sleep(.5)
        self.assertEqual(elapsed,current()["usage"]["executionSeconds"],"Paused time is not execution time")
        self.assertGreater(current()["usage"]["browserSeconds"],paused["usage"]["browserSeconds"])
        self.command(task,"RESUME")
        unknown=execute("click",{"selector":"[data-acceptance-never-visible]"})
        self.assertEqual("UNKNOWN",self.wait_operation(unknown,self.client)["status"])
        task=current()
        self.assertEqual("UNKNOWN_RESULT",task["request"]["type"])
        self.assertEqual("Preserved before uncertain action",task["result"]["summary"])
        self.assertEqual(1,task["result"]["artifactCount"])
        status,rows=self.client.api("/api/tasks/"+task_id+"/result/rows")
        self.assertEqual(200,status,rows)
        self.assertEqual({"value":"immutable prior result"},rows["items"][0]["cells"])
        status,download,_=self.client.request(self.client.base+artifact["downloadUrl"])
        self.assertEqual(200,status)
        self.assertEqual(original,download)
        self.assertEqual(404,self.admin.api("/api/tasks/"+task_id+"/result/rows")[0])
        self.assertEqual(404,self.admin.request(self.admin.base+artifact["downloadUrl"])[0])
        status,refusal=self.client.api("/api/tasks/"+task_id+"/commands","POST",{
            "type":"RESUME","expectedVersion":task["version"]})
        self.assertEqual((409,"UNKNOWN_RESULT"),(status,refusal["code"]))

    def test_platform_unlimited_lowered_limit_and_stop_all_standalone_browsers(self):
        self.client.login_mcp()
        connection_ids=[]
        for number in range(2):
            status,connection=self.client.api("/api/connections","POST",{
                "name":"Standalone capacity "+str(number),"site":"example.com","startUrl":"https://example.com"})
            self.assertEqual(200,status,connection)
            connection_ids.append(connection["id"])
            status,_=self.client.api("/api/connections/"+connection["id"]+"/login","POST",{
                "action":"START","viewerId":str(uuid.uuid4())})
            self.assertEqual(200,status)
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            standalone=[self.client.api("/api/connections/"+item)[1] for item in connection_ids]
            if all(item.get("browser") and item["browser"]["status"]=="LIVE" for item in standalone):
                break
            time.sleep(.3)
        self.assertTrue(all(item.get("browser") and item["browser"]["status"]=="LIVE" for item in standalone))
        standalone_browsers={item["browser"]["id"] for item in standalone}
        self.assertEqual(2,len(standalone_browsers))

        def admitted(title):
            transport=self.identity.client()
            transport.token=self.client.token
            error,state,_=transport.tool("tasks.create",{"operationKey":str(uuid.uuid4()),"task":{
                "title":title,"goal":"Verify browser capacity accounting","startUrl":"https://example.org",
                "prepare":True,"requireConfirmation":False}})
            self.assertFalse(error,state)
            task=state["task"]
            operation=str(uuid.uuid4())
            error,receipt,_=transport.tool("browser.execute",{"taskId":task["id"],"action":{
                "operationId":operation,"type":"observe","arguments":{},"instructionRevision":task["instructionRevision"]}})
            self.assertFalse(error,receipt)
            return transport,task,operation

        transport,task,operation=admitted("Platform limit holds a third browser")
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            status,waiting=self.client.api("/api/tasks/"+task["id"])
            if waiting.get("browser") and waiting["browser"]["status"]=="QUEUED":
                break
            time.sleep(.2)
        self.assertEqual("QUEUED",waiting["browser"]["status"])
        time.sleep(2)
        self.assertEqual("QUEUED",self.client.api("/api/tasks/"+task["id"])[1]["browser"]["status"])
        endpoint="/api/admin/users/"+self.identity.id
        self.assertEqual(2,self.admin.api(endpoint)[1]["user"]["browserCount"])
        status,_=self.admin_command("LIMITS",browserLimitMode="UNLIMITED")
        self.assertEqual(200,status)
        self.assertEqual("SUCCEEDED",self.wait_operation(operation,transport)["status"])
        self.assertEqual(3,self.admin.api(endpoint)[1]["user"]["browserCount"])
        status,_=self.admin_command("LIMITS",browserLimitMode="CUSTOM",browserLimit=1)
        self.assertEqual(200,status)
        _,queued,_=admitted("Lowered limit applies to new assignments")
        time.sleep(2)
        self.assertEqual("QUEUED",self.client.api("/api/tasks/"+queued["id"])[1]["browser"]["status"])
        self.assertEqual("LIVE",self.client.api("/api/tasks/"+task["id"])[1]["browser"]["status"])
        self.assertTrue(all(self.client.api("/api/connections/"+item)[1]["browser"]["status"]=="LIVE" for item in connection_ids))
        self.assertEqual(3,self.admin.api(endpoint)[1]["user"]["browserCount"])
        status,refusal=self.admin.api("/api/admin/browsers/"+next(iter(standalone_browsers))+"/stop","POST",{})
        self.assertEqual((409,"NO_TASK"),(status,refusal["code"]))
        nodes=self.admin.api("/api/admin/nodes")[1]
        listed=[browser for node in nodes for browser in node["browsers"] if browser["ownerId"]==self.identity.id]
        self.assertEqual(3,len(listed))
        self.assertEqual(2,sum(browser["taskId"] is None for browser in listed))
        self.assertTrue(all(set(browser)=={"id","taskId","ownerId","ownerName","status"} for browser in listed))
        draft=self.create("Stop all keeps draft",prepare=False)
        self.assertEqual(200,self.admin_command("STOP_ALL",reason=None)[0])
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            detail=self.admin.api(endpoint)[1]
            if detail["user"]["browserCount"]==0 and detail["user"]["pendingOperations"]==0:
                break
            time.sleep(.3)
        self.assertEqual((0,0),(detail["user"]["browserCount"],detail["user"]["pendingOperations"]))
        for stopped in (task,queued):
            self.assertEqual("STOPPED",self.client.api("/api/tasks/"+stopped["id"])[1]["status"])
        self.assertEqual("DRAFT",self.client.api("/api/tasks/"+draft["id"])[1]["status"])
        self.assertTrue(all(self.client.api("/api/connections/"+item)[1]["browser"] is None for item in connection_ids))
        future_transport,_,future_operation=admitted("Explicit future browser start remains available")
        self.assertEqual("SUCCEEDED",self.wait_operation(future_operation,future_transport)["status"])
        self.assertEqual(1,self.admin.api(endpoint)[1]["user"]["browserCount"])

    def test_paused_manual_control_can_return_without_resuming(self):
        self.client.login_mcp()
        task=self.create("Manual control preserves an explicit pause")
        error,_,_=self.client.tool("tasks.view",{"taskId":task["id"],"operationKey":str(uuid.uuid4())})
        self.assertFalse(error)
        operation=str(uuid.uuid4())
        error,receipt,_=self.client.tool("browser.execute",{"taskId":task["id"],"action":{
            "operationId":operation,"type":"observe","arguments":{},"instructionRevision":task["instructionRevision"]}})
        self.assertFalse(error,receipt)
        completed=self.wait_operation(operation,self.client)
        self.assertEqual("SUCCEEDED",completed["status"],completed)
        paused=self.command(task,"PAUSE")
        self.assertEqual("PAUSED",paused["status"])
        self.assertTrue({"RESUME","STOP","TAKE_CONTROL","BEGIN_LOGIN"}.issubset(paused["allowedCommands"]),
                        paused["allowedCommands"])
        browser=paused["browser"]["id"]
        self.create("Paused control draft remains outside waiting count",prepare=False)
        endpoint="/api/admin/users/"+self.identity.id
        self.assertEqual(0,self.admin.api(endpoint)[1]["user"]["waitingCount"])
        for reason in ("x","x"*1000):
            self.assertEqual(200,self.admin_command("LIMITS",browserLimitMode="CUSTOM",browserLimit=1,reason=reason)[0])
        viewer=str(uuid.uuid4())
        self.command(task,"TAKE_CONTROL",viewerId=viewer)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            current=self.client.api("/api/tasks/"+task["id"])[1]
            if current["browser"]["controlOwner"]=="USER":
                break
            time.sleep(.2)
        self.assertEqual("USER",current["browser"]["controlOwner"])
        self.assertIn("RETURN_CONTROL",current["allowedCommands"])
        self.assertEqual(1,self.admin.api(endpoint)[1]["user"]["waitingCount"])
        queued_client=self.identity.client()
        queued_client.token=self.client.token
        error,queued_state,_=queued_client.tool("tasks.create",{"operationKey":str(uuid.uuid4()),"task":{
            "title":"Queue contributes to waiting count","goal":"Verify waiting classes",
            "startUrl":"https://example.org","prepare":True}})
        self.assertFalse(error,queued_state)
        queued_task=queued_state["task"]
        error,receipt,_=queued_client.tool("browser.execute",{"taskId":queued_task["id"],"action":{
            "operationId":str(uuid.uuid4()),"type":"observe","arguments":{},"instructionRevision":queued_task["instructionRevision"]}})
        self.assertFalse(error,receipt)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            queued=self.client.api("/api/tasks/"+queued_task["id"])[1]
            if queued.get("browser") and queued["browser"]["status"]=="QUEUED":
                break
            time.sleep(.2)
        self.assertEqual("QUEUED",queued["browser"]["status"])
        self.assertEqual(2,self.admin.api(endpoint)[1]["user"]["waitingCount"])
        self.command(task,"RETURN_CONTROL",viewerId=viewer,resume=True)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            current=self.client.api("/api/tasks/"+task["id"])[1]
            if current["browser"]["controlOwner"]=="CHATGPT":
                break
            time.sleep(.2)
        self.assertEqual("PAUSED",current["status"])
        self.assertEqual(browser,current["browser"]["id"])
        self.assertEqual("LIVE",current["browser"]["status"])
        self.assertEqual(1,self.admin.api(endpoint)[1]["user"]["waitingCount"])
        error,refusal,_=self.client.tool("browser.execute",{"taskId":task["id"],"action":{
            "operationId":str(uuid.uuid4()),"type":"observe","arguments":{},
            "instructionRevision":current["instructionRevision"],"controlEpoch":current["browser"]["controlEpoch"]}})
        self.assertTrue(error)
        self.assertEqual("TASK_NOT_RUNNING",refusal["code"])
        resumed=self.command(task,"RESUME")
        self.assertEqual("WAITING_CHATGPT",resumed["status"])
        status,receipt=self.admin.api("/api/admin/browsers/"+browser+"/stop","POST",{})
        self.assertEqual(200,status,receipt)
        self.assertEqual(task["id"],receipt["taskId"])
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            current=self.client.api("/api/tasks/"+task["id"])[1]
            if current["status"]=="STOPPED":
                break
            time.sleep(.2)
        self.assertEqual("STOPPED",current["status"])

    def test_real_standalone_login_usage_is_only_in_administration(self):
        status,connection=self.client.api("/api/connections","POST",{
            "name":"Standalone usage recording","site":"example.com","startUrl":"https://example.com"})
        self.assertEqual(200,status,connection)
        viewer=str(uuid.uuid4())
        endpoint="/api/connections/"+connection["id"]
        self.assertEqual(200,self.client.api(endpoint+"/login","POST",{"action":"START","viewerId":viewer})[0])
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            current=self.client.api(endpoint)[1]
            if current.get("browser") and current["browser"]["status"]=="LIVE":
                break
            time.sleep(.2)
        self.assertEqual("LIVE",current["browser"]["status"])
        time.sleep(.5)
        user_report=self.usage()
        self.assertEqual(0,user_report["totalTasks"])
        self.assertEqual(0,user_report["usage"]["browserSeconds"])
        self.assertEqual(0,user_report["usage"]["manualSeconds"])
        detail=self.admin.api("/api/admin/users/"+self.identity.id+"?timezone=Europe%2FSaratov")[1]
        self.assertGreater(detail["usage"]["usage"]["browserSeconds"],0)
        self.assertGreater(detail["usage"]["usage"]["manualSeconds"],0)
        self.assertEqual(0,detail["usage"]["usage"]["executionSeconds"])
        self.assertEqual(200,self.client.api(endpoint+"/login","POST",{"action":"CLOSE","viewerId":viewer})[0])
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            if self.client.api(endpoint)[1]["browser"] is None:
                break
            time.sleep(.2)
        self.assertIsNone(self.client.api(endpoint)[1]["browser"])
        stopped=self.admin.api("/api/admin/users/"+self.identity.id)[1]["usage"]["usage"]
        time.sleep(.5)
        self.assertEqual(stopped,self.admin.api("/api/admin/users/"+self.identity.id)[1]["usage"]["usage"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
