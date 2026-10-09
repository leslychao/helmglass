"""Deployed admission and connection contracts with disposable accounts."""
import json
import time
import unittest
from urllib.parse import urlencode
import uuid
import test_dev_contract as dev


class ConnectionContractTest(unittest.TestCase):
    setUpClass = classmethod(dev.DevContractTest.setUpClass.__func__)
    fixture_sql = dev.DevContractTest.fixture_sql
    wait_operation = dev.DevContractTest.wait_operation

    def setUp(self):
        self.identities = []
        self.tasks = []

    def owner(self):
        identity = dev.DisposableIdentity(self.settings, self.me["id"])
        self.identities.append(identity)
        client = identity.client()
        client.login_web()
        client.login_mcp()
        return identity, client

    def create(self, primary, url="https://example.com", preferred=None):
        client = dev.DevClient(primary.settings, primary.user, primary.password_key)
        client.token = primary.token
        error, state, _ = client.tool("tasks.create", {"operationKey":str(uuid.uuid4()),"task":{
            "title":"Disposable connection contract", "goal":"Verify account coordination", "startUrl":url,
            "prepare":True,"preferredConnectionIds":preferred or []}})
        self.assertFalse(error,state)
        task = state["task"]
        self.tasks.append((primary,task["id"]))
        return client,task

    def observe(self, client, task):
        operation = str(uuid.uuid4())
        action = {"operationId":operation,"type":"observe","arguments":{},"instructionRevision":task["instructionRevision"]}
        if task.get("browser"):
            action["controlEpoch"] = task["browser"]["controlEpoch"]
        error, receipt, _ = client.execute_in_scenario_step({"taskId":task["id"],"action":action})
        self.assertFalse(error,receipt)
        return operation

    def tearDown(self):
        for client,task_id in self.tasks:
            for attempt in range(5):
                status,task = client.api("/api/tasks/"+task_id)
                if status!=200 or task["status"] in ("STOPPED","STOPPING"):
                    break
                status,_=client.api("/api/tasks/"+task_id+"/commands","POST",{
                    "type":"STOP","expectedVersion":task["version"]})
                if status==200:
                    break
                self.assertEqual(409,status)
            else:
                self.fail("Could not stop disposable concurrent task")
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if all(client.api("/api/tasks/"+task_id)[1]["status"]=="STOPPED" for client,task_id in self.tasks):
                break
            time.sleep(.5)
        for identity in self.identities:
            path="/api/admin/users/"+identity.id
            _,detail=self.admin.api(path)
            self.assertEqual(200,self.admin.api(path+"/commands","POST",{
                "type":"REQUEST_DELETION","expectedVersion":detail["user"]["version"],
                "reason":"Remove disposable connection acceptance"})[0])
            self.fixture_sql(identity,"UPDATE accounts SET deletion_due_at=clock_timestamp() WHERE id=:owner;")
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if all(self.admin.api("/api/admin/users/"+identity.id)[1]["user"]["status"]=="DELETED" for identity in self.identities):
                return
            time.sleep(.5)
        self.fail("Disposable connection fixture cleanup was not confirmed")

    def test_admin_usage_never_contains_private_sites(self):
        identity,client=self.owner()
        sentinel="private-contract-"+uuid.uuid4().hex+".example.com"
        self.create(client,"https://"+sentinel)
        status,detail=self.admin.api("/api/admin/users/"+identity.id)
        self.assertEqual(200,status)
        self.assertNotIn(sentinel,json.dumps(detail))
        self.assertEqual({"totalTasks","successfulTasks","completedTasks","successRate","usage",
                          "commands","from","to","days"},set(detail["usage"]))
        for size in (10,20,50):
            status, page = self.admin.api("/api/admin/users/"+identity.id+"?taskPageSize="+str(size)+"&auditPageSize="+str(size))
            self.assertEqual(200,status)
            self.assertEqual(size,page["tasks"]["pageSize"])
            self.assertEqual(size,page["audit"]["pageSize"])
        self.assertEqual(400,self.admin.api("/api/admin/users/"+identity.id+"?taskPageSize=11")[0])

    def test_autocomplete_limits_exact_task_and_owner_scopes(self):
        _, primary = self.owner()
        _, other = self.owner()
        marker = "autocomplete-" + uuid.uuid4().hex[:12]
        created = []
        sites = []
        for index in range(4):
            site = str(index) + "." + marker + ".example.com"
            sites.append(site)
            status, task = primary.api("/api/tasks", "POST", {
                "title": marker + (" duplicate" if index < 2 else " " + str(index)),
                "goal": "Verify autocomplete filtering without starting a browser",
                "startUrl": "https://" + site, "outputFormat": "TEXT", "prepare": False})
            self.assertEqual(200, status, task)
            created.append(task)
            status, connection = primary.api("/api/connections", "POST", {
                "name": marker + " " + str(index), "startUrl": "https://" + site})
            self.assertEqual(200, status, connection)

        def get(client, path, **query):
            status, result = client.api(path + "?" + urlencode(query, doseq=True))
            self.assertEqual(200, status, result)
            return result

        for path in ("/api/tasks", "/api/tasks/sites", "/api/connections/sites"):
            page = get(primary, path, search=marker, suggestions="true", page=99, pageSize=50)
            self.assertEqual((4, 1, 3, 3),
                             (page["total"], page["page"], page["pageSize"], len(page["items"])))
            self.assertEqual(0, get(primary, path, search="missing-" + marker,
                                    suggestions="true")["total"])
            self.assertEqual(0, get(other, path, search=marker, suggestions="true")["total"])

        duplicates = get(primary, "/api/tasks", search=marker + " duplicate", suggestions="true")
        self.assertEqual(2, len(duplicates["items"]))
        self.assertEqual(2, len({task["id"] for task in duplicates["items"]}))
        self.assertEqual(1, len(get(primary, "/api/tasks", search=created[0]["id"],
                                   suggestions="true")["items"]))
        self.assertEqual(1, len(get(primary, "/api/tasks/sites", search=sites[0],
                                   suggestions="true")["items"]))
        self.assertEqual(1, len(get(primary, "/api/connections/sites", search=sites[0],
                                   suggestions="true")["items"]))

        for client, expected in ((primary, 1), (other, 0)):
            # The ID is authoritative even if a previously displayed title has changed.
            filters = {"taskId": created[0]["id"], "search": "old displayed title"}
            page = get(client, "/api/tasks", **filters)
            summary = get(client, "/api/tasks/summary", **filters)
            self.assertEqual(expected, page["total"])
            self.assertEqual(expected, summary["total"])
            if expected:
                self.assertEqual(created[0]["id"], page["items"][0]["id"])

        for path in ("/api/tasks", "/api/connections"):
            page = get(primary, path, site=sites[:3])
            self.assertEqual(3, page["total"])
            self.assertEqual(set(sites[:3]), {item["site"] for item in page["items"]})
        self.assertEqual(3, get(primary, "/api/tasks/summary", site=sites[:3])["total"])
        self.assertEqual(0, get(primary, "/api/tasks", taskId=created[0]["id"], site=sites[1])["total"])
        self.assertEqual(0, get(primary, "/api/tasks/summary", taskId=created[0]["id"], site=sites[1])["total"])
        self.assertEqual(400, primary.api("/api/tasks?taskId=invalid")[0])
        # Removing the UI search does not break existing callers of the connection API.
        self.assertEqual(1, get(primary, "/api/connections", search=marker + " 3")["total"])

    def test_admin_usage_counts_unique_commands_and_splits_calendar_intervals(self):
        identity, primary = self.owner()
        client, task = self.create(primary)
        operation = self.observe(client, task)
        self.assertEqual('SUCCEEDED', self.wait_operation(operation, client)['status'])
        action = {'operationId': operation, 'type': 'observe', 'arguments': {},
                  'instructionRevision': task['instructionRevision']}
        if task.get('browser'):
            action['controlEpoch'] = task['browser']['controlEpoch']
        error, _, _ = client.execute_in_scenario_step({'taskId': task['id'], 'action': action})
        self.assertFalse(error)
        self.fixture_sql(identity, """
INSERT INTO usage_intervals(id,owner_id,kind,started_at,ended_at,incomplete)
SELECT gen_random_uuid(),:owner,'BROWSER',
  (date_trunc('day',clock_timestamp() AT TIME ZONE 'Europe/Saratov')-interval '25 hours') AT TIME ZONE 'Europe/Saratov',
  (date_trunc('day',clock_timestamp() AT TIME ZONE 'Europe/Saratov')-interval '23 hours') AT TIME ZONE 'Europe/Saratov',true;
""")
        endpoint = '/api/admin/users/' + identity.id + '?timezone=Europe%2FSaratov&usagePageSize=10'
        status, detail = self.admin.api(endpoint)
        self.assertEqual(200, status)
        usage = detail['usage']
        self.assertEqual(1, usage['commands'], 'Repeated operation ID must not add a command')
        days = usage['days']['items']
        self.assertEqual(7, usage['days']['total'])
        self.assertEqual(7, len(days))
        self.assertEqual(1, sum(day['commands'] for day in days))
        self.assertEqual(usage['from'], days[0]['date'])
        self.assertEqual(usage['to'], days[-1]['date'])
        for day in days[-3:-1]:
            self.assertEqual(3600, day['browserSeconds'])
            self.assertTrue(day['incomplete'])
            self.assertEqual(0, day['commands'])
        for day in days[:-3]:
            self.assertEqual((0, 0, False),
                             (day['commands'], day['browserSeconds'], day['incomplete']))
        for day in days:
            self.assertEqual({'date','commands','browserSeconds','incomplete'}, set(day))
        self.assertNotIn('example.com', json.dumps(usage))
        self.assertEqual(usage['commands'], self.admin.api(endpoint)[1]['usage']['commands'])

    def await_connection(self, client, connection, predicate):
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            status,value=client.api("/api/connections/"+connection)
            self.assertEqual(200,status,value)
            if predicate(value):
                return value
            time.sleep(.3)
        self.fail("Connection transition was not confirmed")

    def saved_connection(self, client, suffix, close=True):
        status,value=client.api("/api/connections","POST",{
            "name":"Anonymous profile "+suffix,"site":"example.com","startUrl":"https://example.com"})
        self.assertEqual(200,status,value)
        connection=value["id"]
        viewer=str(uuid.uuid4())
        path="/api/connections/"+connection+"/login"
        self.assertEqual(200,client.api(path,"POST",{"action":"START","viewerId":viewer})[0])
        opened=self.await_connection(client,connection,lambda value:value.get("browser") and value["browser"]["status"]=="LIVE")
        self.assertTrue(opened["browser"]["privateMode"])
        self.assertEqual("USER",opened["browser"]["controlOwner"])
        status,receipt=client.api(path,"POST",{"action":"SAVE","viewerId":viewer,
            "accountLabel":"Anonymous "+suffix,"accountSubject":"anonymous-"+suffix})
        self.assertEqual(200,status,receipt)
        value=self.await_connection(client,connection,lambda value:value["status"]=="READY" and value["browser"]["controlOwner"]=="NONE")
        self.assertEqual(opened["browser"]["id"],value["browser"]["id"])
        if close:
            self.assertEqual(200,client.api(path,"POST",{"action":"CLOSE","viewerId":viewer})[0])
            self.await_connection(client,connection,lambda value:not value.get("browser"))
        return connection

    def test_single_live_saved_connection_is_adopted_by_the_task(self):
        _,primary=self.owner()
        connection=self.saved_connection(primary,"Adoption",close=False)
        standalone=primary.api("/api/connections/"+connection)[1]["browser"]
        self.assertEqual(("LIVE","NONE"),(standalone["status"],standalone["controlOwner"]))
        client,task=self.create(primary)
        self.assertEqual(standalone["id"],task["browser"]["id"])
        self.assertIsNone(task["request"])
        self.assertEqual("SUCCEEDED",self.wait_operation(self.observe(client,task),client)["status"])
        task=primary.api("/api/tasks/"+task["id"])[1]
        self.assertEqual(standalone["id"],task["browser"]["id"])
        self.assertEqual("CHATGPT",task["browser"]["controlOwner"])

    def test_confirmed_session_save_preserves_private_control(self):
        _, primary = self.owner()
        _, foreign = self.owner()
        status, connection = primary.api("/api/connections", "POST", {
            "name": "Confirmed private session fixture", "startUrl": "https://example.com"})
        self.assertEqual(200, status, connection)
        connection_id = connection["id"]
        viewer = str(uuid.uuid4())
        connection_login = "/api/connections/" + connection_id + "/login"
        self.assertEqual(200, primary.api(connection_login, "POST", {
            "action": "START", "viewerId": viewer})[0])
        connection = self.await_connection(primary, connection_id, lambda value:
            value.get("browser") and value["browser"]["status"] == "LIVE"
            and value["browser"]["controlOwner"] == "USER")
        browser = connection["browser"]
        browser_id = browser["id"]
        path = "/api/browser-sessions/" + browser_id + "/login"
        control = "/api/browser-sessions/" + browser_id + "/control"
        confirm = {"type": "CONFIRM_LOGIN", "viewerId": viewer,
                   "controlEpoch": browser["controlEpoch"]}
        save = {**confirm, "type": "SAVE_SESSION", "accountLabel": "Anonymous fixture",
                "accountSubject": "anonymous-confirmed-session"}
        try:
            self.assertFalse(browser["loginConfirmed"])
            self.assertEqual(connection_id, browser["connectionId"])
            self.assertIsNone(browser["taskId"])
            status, refusal = primary.api(path, "POST", save)
            self.assertEqual((409, "LOGIN_NOT_CONFIRMED"), (status, refusal.get("code")))
            self.assertEqual(404, foreign.api(path, "POST", confirm)[0])
            self.assertEqual(400, primary.api(path, "POST", {**confirm, "viewerId": None})[0])
            self.assertEqual(403, primary.api(path, "POST", {
                **confirm, "viewerId": str(uuid.uuid4())})[0])
            for epoch in (None, browser["controlEpoch"] - 1):
                status, refusal = primary.api(path, "POST", {**confirm, "controlEpoch": epoch})
                self.assertEqual((409, "CONTROL_CHANGED"), (status, refusal.get("code")))

            confirm_key = str(uuid.uuid4())
            status, confirmed = primary.api(path, "POST", confirm, key=confirm_key)
            self.assertEqual(200, status, confirmed)
            self.assertTrue(confirmed["loginConfirmed"])
            self.assertEqual(confirmed, primary.api(path, "POST", confirm, key=confirm_key)[1])
            self.assertTrue(primary.api("/api/connections/" + connection_id)[1]["browser"]["loginConfirmed"])
            self.assertEqual(400, primary.api(control, "POST", save)[0],
                             "A direct save command without a destination must not succeed without saving")

            # First save needs no manually entered label or external account identity.
            status, first_receipt = primary.api(path, "POST", {**confirm, "type": "SAVE_SESSION"})
            self.assertEqual(200, status, first_receipt)
            first_saved = self.await_connection(primary, connection_id, lambda value:
                value["status"] == "READY" and value["browser"]["controlOwner"] == "USER"
                and not value["browser"]["loginConfirmed"])
            self.assertIsNone(first_saved["accountLabel"])
            self.assertIsNone(first_saved["accountSubject"])
            self.assertEqual(browser_id, first_saved["browser"]["id"])
            confirm["controlEpoch"] = first_saved["browser"]["controlEpoch"]
            save["controlEpoch"] = confirm["controlEpoch"]
            self.assertEqual(200, primary.api(path, "POST", confirm)[0])

            save_key = str(uuid.uuid4())
            status, receipt = primary.api(path, "POST", save, key=save_key)
            self.assertEqual(200, status, receipt)
            self.assertEqual(receipt, primary.api(path, "POST", save, key=save_key)[1])
            saved = self.await_connection(primary, connection_id, lambda value:
                value["status"] == "READY" and value["browser"]["controlOwner"] == "USER"
                and not value["browser"]["loginConfirmed"])
            self.assertEqual((browser_id, "LIVE", True),
                             (saved["browser"]["id"], saved["browser"]["status"],
                              saved["browser"]["privateMode"]))
            self.assertGreater(saved["profileRevision"], 0)
            self.assertIsNotNone(saved["profileSavedAt"])
            self.assertIsNone(saved["profileSaveError"])
            self.assertEqual(200, primary.api("/api/browser-sessions/" + browser_id + "/ticket",
                "POST", {"role": "CONTROLLER", "viewerId": viewer})[0])
            self.assertEqual(receipt, primary.api(path, "POST", save, key=save_key)[1])
            replayed = primary.api("/api/connections/" + connection_id)[1]
            self.assertEqual(saved["profileRevision"], replayed["profileRevision"])
            self.assertFalse(replayed["browser"]["loginConfirmed"])

            # A new explicit confirmation makes another save possible; another account cannot replace it.
            confirm["controlEpoch"] = replayed["browser"]["controlEpoch"]
            self.assertEqual(200, primary.api(path, "POST", confirm)[0])
            status, refusal = primary.api(path, "POST", {
                **confirm, "type": "SAVE_SESSION", "accountLabel": "Different account",
                "accountSubject": "another-account"})
            self.assertEqual((409, "ACCOUNT_MISMATCH"), (status, refusal.get("code")))
            unchanged = primary.api("/api/connections/" + connection_id)[1]
            self.assertEqual(save["accountSubject"], unchanged["accountSubject"])
            self.assertEqual(saved["profileRevision"], unchanged["profileRevision"])
            self.assertTrue(unchanged["browser"]["loginConfirmed"])
            status, retry = primary.api(path, "POST", {**confirm, "type": "SAVE_SESSION"})
            self.assertEqual(200, status, retry)
            self.await_connection(primary, connection_id, lambda value:
                value["browser"]["controlOwner"] == "USER" and not value["browser"]["loginConfirmed"])
        finally:
            self.assertEqual(200, primary.api(connection_login, "POST", {
                "action": "CLOSE", "viewerId": viewer})[0])
            self.await_connection(primary, connection_id, lambda value: not value.get("browser"))

    def test_task_session_save_keeps_pause_request_and_browser(self):
        _, primary = self.owner()
        client, task = self.create(primary)
        self.assertEqual("SUCCEEDED", self.wait_operation(self.observe(client, task), client)["status"])
        task_path = "/api/tasks/" + task["id"]
        task = primary.api(task_path)[1]
        status, task = primary.api(task_path + "/commands", "POST", {
            "type": "PAUSE", "expectedVersion": task["version"]})
        self.assertEqual(200, status, task)
        viewer = str(uuid.uuid4())
        status, task = primary.api(task_path + "/commands", "POST", {
            "type": "BEGIN_LOGIN", "viewerId": viewer, "expectedVersion": task["version"]})
        self.assertEqual(200, status, task)

        def await_task(predicate):
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                status, value = primary.api(task_path)
                self.assertEqual(200, status, value)
                if predicate(value):
                    return value
                time.sleep(.3)
            self.fail("Task session transition was not confirmed")

        task = await_task(lambda value: value["browser"]["controlOwner"] == "USER")
        browser = task["browser"]
        browser_id = browser["id"]
        pending_request = task["request"]
        task_state = task["status"]
        path = "/api/browser-sessions/" + browser_id + "/login"
        command = {"type": "CONFIRM_LOGIN", "viewerId": viewer,
                   "controlEpoch": browser["controlEpoch"]}
        self.assertEqual(200, primary.api(path, "POST", command)[0])
        status, receipt = primary.api(path, "POST", {
            **command, "type": "SAVE_SESSION", "accountLabel": "Anonymous paused task",
            "accountSubject": "anonymous-paused-task"})
        self.assertEqual(200, status, receipt)
        saved = await_task(lambda value: value["browser"]["controlOwner"] == "USER"
                           and not value["browser"]["loginConfirmed"])
        self.assertEqual(task_state, saved["status"])
        self.assertEqual(pending_request, saved["request"])
        self.assertEqual((browser_id, "LIVE", True, task["id"]),
                         (saved["browser"]["id"], saved["browser"]["status"],
                          saved["browser"]["privateMode"], saved["browser"]["taskId"]))
        connection = primary.api("/api/connections/" + saved["browser"]["connectionId"])[1]
        self.assertEqual(browser_id, connection["browser"]["id"])
        self.assertEqual(task["id"], connection["browser"]["taskId"])
        status, receipt = primary.api(task_path + "/commands", "POST", {
            "type": "RETURN_CONTROL", "viewerId": viewer, "resume": True,
            "expectedVersion": saved["version"]})
        self.assertEqual(200, status, receipt)
        returned = await_task(lambda value: value["browser"]["controlOwner"] == "CHATGPT")
        self.assertEqual("PAUSED", returned["status"], "Saving must not clear the explicit task pause")
        self.assertEqual(browser_id, returned["browser"]["id"])

    def test_saved_credentials_are_owner_private_and_separate_from_cookies(self):
        _, client = self.owner()
        _, foreign = self.owner()
        status, connection = client.api('/api/connections', 'POST', {
            'name': 'Disposable credential boundary', 'site': 'example.com',
            'startUrl': 'https://example.com'})
        self.assertEqual(200, status)
        viewer = str(uuid.uuid4())
        login = '/api/connections/' + connection['id'] + '/login'
        self.assertEqual(200, client.api(login, 'POST', {'action': 'START', 'viewerId': viewer})[0])
        connection = self.await_connection(client, connection['id'], lambda value:
            value.get('browser') and value['browser']['status'] == 'LIVE'
            and value['browser']['controlOwner'] == 'USER')
        browser = connection['browser']['id']
        credentials = '/api/browser-sessions/' + browser + '/credentials'
        try:
            status, metadata = client.api(credentials + '?viewerId=' + viewer)
            self.assertEqual(200, status)
            self.assertFalse(metadata['available'])
            self.assertEqual(0, metadata['revision'])
            self.assertEqual('https://example.com', metadata['currentOrigin'])
            self.assertFalse(metadata['captureEnabled'])
            self.assertEqual('DISABLED', metadata['captureStatus'])
            self.assertIsNone(metadata['captureOrigin'])
            self.assertEqual(403, client.api(credentials + '?viewerId=' + str(uuid.uuid4()))[0])
            self.assertEqual(404, foreign.api(credentials + '?viewerId=' + viewer)[0])
            self.assertEqual(400, client.api(credentials, 'POST', {
                'viewerId': viewer, 'origin': 'https://example.com', 'username': 'synthetic-account',
                'password': 'synthetic-credential-value', 'expectedRevision': 0})[0])
            value = {'viewerId': viewer, 'enabled': True,
                'expectedCaptureRevision': metadata['captureRevision']}
            operation = str(uuid.uuid4())
            status, metadata = client.api(credentials, 'POST', value, operation)
            self.assertEqual(200, status)
            self.assertEqual(0, metadata['revision'])
            self.assertFalse(metadata['available'])
            self.assertTrue(metadata['captureEnabled'])
            self.assertEqual('ARMED', metadata['captureStatus'])
            self.assertEqual('https://example.com', metadata['captureOrigin'])
            self.assertNotIn('synthetic-credential-value', json.dumps(metadata))
            self.assertEqual(metadata, client.api(credentials, 'POST', value, operation)[1])
            self.assertEqual(409, client.api(credentials, 'POST', value)[0])
            _, unchanged = client.api('/api/connections/' + connection['id'])
            self.assertEqual(0, unchanged['profileRevision'], 'Consent must not save a password or cookies')
            status, disabled = client.api(credentials, 'POST', {'viewerId': viewer, 'enabled': False,
                'expectedCaptureRevision': metadata['captureRevision']})
            self.assertEqual(200, status)
            self.assertFalse(disabled['captureEnabled'])
            self.assertEqual('DISABLED', disabled['captureStatus'])
            self.assertIsNone(disabled['captureOrigin'])
            status, removed = client.api(credentials, 'DELETE', {'viewerId': viewer, 'expectedRevision': 0})
            self.assertEqual(200, status)
            self.assertFalse(removed['available'])
            self.assertEqual(1, removed['revision'])
        finally:
            self.assertEqual(200, client.api(login, 'POST', {'action': 'CLOSE', 'viewerId': viewer})[0])
            self.await_connection(client, connection['id'], lambda value: not value.get('browser'))

    def test_specific_switch_consent_and_account_choice_without_second_confirmation(self):
        _,primary=self.owner()
        first=self.saved_connection(primary,"A")
        second=self.saved_connection(primary,"B")
        client,task=self.create(primary,preferred=[first])
        self.assertEqual("SUCCEEDED",self.wait_operation(self.observe(client,task),client)["status"])
        _,task=primary.api("/api/tasks/"+task["id"])
        browser=task["browser"]["id"]
        error,presentation,_=client.tool("connections.select",{"taskId":task["id"],"connectionId":second,"confirmationPrompt":"Switch to the second account?",
            "instructionRevision":task["instructionRevision"],"operationKey":str(uuid.uuid4())})
        self.assertFalse(error,presentation)
        _,task=primary.api("/api/tasks/"+task["id"])
        self.assertEqual("CONFIRMATION",task["request"]["type"])
        operation=task["request"]["operationId"]
        self.assertEqual(browser,task["browser"]["id"])
        _,current=primary.api("/api/connections/"+first)
        self.assertEqual(browser,current["browser"]["id"])
        status,value=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":"CONFIRM","expectedVersion":task["version"],"requestId":task["request"]["id"],"requestVersion":task["request"]["version"]})
        self.assertEqual((409,"HOST_RESPONSE_REQUIRED"),(status,value["code"]))
        error,value,_=client.respond(task,{"proceed":True})
        self.assertFalse(error,value)
        self.assertEqual("SUCCEEDED",self.wait_operation(operation,client)["status"])
        _,current=primary.api("/api/connections/"+second)
        self.assertEqual(browser,current["browser"]["id"])
        error,result,_=client.tool("results.publish",{"taskId":task["id"],"instructionRevision":task["instructionRevision"],
            "operationKey":str(uuid.uuid4()),"result":{"summary":"Preserved after connection deletion","limitations":[],
            "columns":[{"key":"value","label":"Value","type":"string"}]},"rows":[{"value":"kept"}]})
        self.assertFalse(error,result)
        _,history=primary.api("/api/tasks/"+task["id"]+"/history")
        self.assertEqual(200,primary.api("/api/connections/"+second,"DELETE")[0])
        _,current=primary.api("/api/tasks/"+task["id"])
        self.assertEqual("ACCOUNT_CHOICE",current["request"]["type"])
        error,current,_=client.respond(current,{"connectionId":first})
        self.assertFalse(error,current)
        self.assertIsNone(current["request"], "A user's explicit account choice needs no second approval")
        response = current["lastResponse"]
        self.assertEqual(("CHOOSE_CONNECTION", first), (response["command"], response["connectionId"]))
        self.assertEqual(response, client.tool("tasks.get", {"taskId": task["id"]})[1]["lastResponse"])
        self.assertEqual(browser,current["browser"]["id"])
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            _,restored=primary.api("/api/connections/"+first)
            if restored.get("browser") and restored["browser"]["id"]==browser:
                break
            time.sleep(.2)
        self.assertEqual(browser,restored["browser"]["id"])
        self.assertEqual(200,primary.api("/api/connections/"+first,"DELETE")[0])
        _,current=primary.api("/api/tasks/"+task["id"])
        self.assertEqual("Preserved after connection deletion",current["result"]["summary"])
        self.assertEqual("ACCOUNT_CHOICE",current["request"]["type"])
        _,rows=primary.api("/api/tasks/"+task["id"]+"/result/rows")
        self.assertEqual("kept",rows["items"][0]["cells"]["value"])
        _,later_history=primary.api("/api/tasks/"+task["id"]+"/history")
        self.assertGreaterEqual(later_history["total"],history["total"])

    def test_explicit_login_required_waits_for_user_and_can_save_paused(self):
        _,primary=self.owner()
        _,connection=primary.api("/api/connections","POST",{
            "name":"Explicit login required","site":"example.com","startUrl":"https://example.com"})
        client,task=self.create(primary,preferred=[connection["id"]])
        self.assertEqual(400,primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":None,"expectedVersion":task["version"]})[0])
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            _,task=primary.api("/api/tasks/"+task["id"])
            if task.get("browser") and task["browser"]["status"]=="LIVE":
                break
            time.sleep(.3)
        self.assertEqual("LIVE",task["browser"]["status"])
        self.assertEqual("WAITING_USER",task["status"])
        self.assertEqual("LOGIN",task["request"]["type"])
        self.assertTrue(task["browser"]["privateMode"])
        self.assertEqual("NONE",task["browser"]["controlOwner"])
        status,task=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":"PAUSE","expectedVersion":task["version"]})
        self.assertEqual(200,status,task)
        viewer=str(uuid.uuid4())
        for command in ({"type":"BEGIN_LOGIN"},{"type":"FINISH_LOGIN","saveConnection":True,
                "connectionId":connection["id"],"accountLabel":"Verified anonymous", "accountSubject":"anonymous-login"}):
            status,task=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
                **command,"viewerId":viewer,"expectedVersion":task["version"]})
            self.assertEqual(200,status,task)
            deadline=time.monotonic()+60
            while time.monotonic()<deadline:
                _,task=primary.api("/api/tasks/"+task["id"])
                if task["browser"]["controlOwner"]!="TRANSFERRING":
                    break
                time.sleep(.3)
        self.assertEqual("PAUSED",task["status"])
        self.assertFalse(task["browser"]["privateMode"])
        self.assertIsNone(task["request"])
        _,saved=primary.api("/api/connections/"+connection["id"])
        self.assertEqual("READY",saved["status"])
        self.assertEqual(task["browser"]["id"],saved["browser"]["id"])

    def test_login_preserves_pending_question_and_restores_its_wait_reason(self):
        _, primary = self.owner()
        client, task = self.create(primary)
        self.assertEqual("SUCCEEDED", self.wait_operation(self.observe(client, task), client)["status"])
        error, task, _ = client.tool("tasks.ask", {
            "taskId": task["id"], "instructionRevision": task["instructionRevision"],
            "operationKey": str(uuid.uuid4()), "prompt": "Which public page should be inspected?"})
        self.assertFalse(error, task)
        pending = task["request"]
        self.assertEqual("QUESTION", pending["type"])
        browser_id = task["browser"]["id"]
        viewer = str(uuid.uuid4())
        for command in ({"type": "BEGIN_LOGIN"}, {"type": "FINISH_LOGIN", "saveConnection": True,
                "accountLabel": "Anonymous fixture", "accountSubject": "anonymous-question"}):
            status, task = primary.api("/api/tasks/" + task["id"] + "/commands", "POST", {
                **command, "viewerId": viewer, "expectedVersion": task["version"]})
            self.assertEqual(200, status, task)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                status, task = primary.api("/api/tasks/" + task["id"])
                self.assertEqual(200, status, task)
                if task["browser"]["controlOwner"] != "TRANSFERRING":
                    break
                time.sleep(.3)
            self.assertNotEqual("TRANSFERRING", task["browser"]["controlOwner"])
            self.assertEqual(pending, task["request"])
        self.assertEqual(("WAITING_USER", "QUESTION"), (task["status"], task["waitReason"]))
        self.assertFalse(task["browser"]["privateMode"])
        self.assertEqual(browser_id, task["browser"]["id"])
        error, task, _ = client.respond(task, {"answer": "Inspect example.com"})
        self.assertFalse(error, task)
        self.assertIsNone(task["request"])
        self.assertEqual("WAITING_CHATGPT", task["status"])
        self.assertEqual(browser_id, task["browser"]["id"])
        self.assertEqual("SUCCEEDED", self.wait_operation(self.observe(client, task), client)["status"])

    def test_account_choice_is_bounded_and_validates_persisted_scope(self):
        identity,primary=self.owner()
        _,foreign=self.owner()
        candidates=[]
        for index in range(12):
            status,value=primary.api("/api/connections","POST",{
                "name":"Choice "+str(index).zfill(2),"site":"example.com","startUrl":"https://example.com"})
            self.assertEqual(200,status)
            candidates.append(value["id"])
        # Scope and list fixture only: paused tasks never import these credential-free records.
        self.fixture_sql(identity,"UPDATE connections SET status='READY' WHERE owner_id=:owner;")
        _,login_required=primary.api("/api/connections","POST",{
            "name":"Needs login","site":"example.com","startUrl":"https://example.com"})
        _,wrong_site=primary.api("/api/connections","POST",{
            "name":"Other site","site":"other.example.com","startUrl":"https://other.example.com"})
        _,foreign_connection=foreign.api("/api/connections","POST",{
            "name":"Foreign","site":"example.com","startUrl":"https://example.com"})
        status,page=primary.api("/api/connections?site=example.com&status=READY&pageSize=10&page=2")
        self.assertEqual(200,status)
        self.assertEqual(12,page["total"])
        self.assertEqual(2,len(page["items"]))
        _,found=primary.api("/api/connections?site=example.com&status=READY&search=Choice%2011")
        self.assertEqual([candidates[-1]],[item["id"] for item in found["items"]])
        client,task=self.create(primary)
        _,task=primary.api("/api/tasks/"+task["id"])
        self.assertEqual("ACCOUNT_CHOICE",task["request"]["type"])
        self.assertEqual(set(candidates),{option["id"] for option in task["request"]["options"]})
        status,task=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":"PAUSE","expectedVersion":task["version"]})
        self.assertEqual(200,status)
        choice={"type":"CHOOSE_CONNECTION","expectedVersion":task["version"],
            "requestId":task["request"]["id"],"requestVersion":task["request"]["version"]}
        for selected in (login_required["id"],wrong_site["id"],foreign_connection["id"]):
            error,refusal,_=client.respond(task,{"connectionId":selected})
            self.assertTrue(error,refusal)
        error,task,_=client.tool("tasks.command",{"taskId":task["id"],"operationKey":str(uuid.uuid4()),"command":{
            "type":"AMEND","expectedVersion":task["version"],"goal":"Updated account choice scope",
            "startUrl":"https://example.com"}})
        self.assertFalse(error,task)
        error,refusal,_=client.tool("tasks.respond",{"taskId":task["id"],"operationKey":str(uuid.uuid4()),
            "requestId":choice["requestId"],"requestVersion":choice["requestVersion"]})
        self.assertTrue(error)
        self.assertEqual("STALE_REQUEST",refusal["code"])
        client,preferred=self.create(primary,preferred=candidates[:2])
        _,preferred=primary.api("/api/tasks/"+preferred["id"])
        self.assertEqual(set(candidates[:2]),{option["id"] for option in preferred["request"]["options"]})
        status,preferred=primary.api("/api/tasks/"+preferred["id"]+"/commands","POST",{
            "type":"PAUSE","expectedVersion":preferred["version"]})
        self.assertEqual(200,status)
        self.assertTrue(client.respond(preferred,{"connectionId":candidates[2]})[0])
        error,selected,_=client.respond(preferred,{"connectionId":candidates[0]})
        self.assertFalse(error,selected)
        self.assertIsNone(selected["request"])
        self.assertEqual("PAUSED",selected["status"])
        self.assertIsNone(selected["browser"])

    def test_multiple_accounts_require_choice_even_after_success_and_busy_lease_resumes(self):
        identity, primary = self.owner()
        self.fixture_sql(identity,
            "UPDATE accounts SET browser_limit_mode='CUSTOM',browser_limit=1 WHERE id=:owner;")
        first = self.saved_connection(primary, "Latest-success A")
        second = self.saved_connection(primary, "Later-save B")
        explicit, task = self.create(primary, preferred=[first])
        first_operation = self.observe(explicit, task)
        self.assertEqual("SUCCEEDED", self.wait_operation(first_operation, explicit)["status"])
        current = primary.api("/api/tasks/" + task["id"])[1]
        self.assertEqual(current["browser"]["id"], primary.api("/api/connections/" + first)[1]["browser"]["id"])

        def finish(task_id, transport=None, operation_id=None):
            if operation_id:
                transport.complete_scenario_step(task_id, operation_id)
            current = primary.api("/api/tasks/" + task_id)[1]
            status, receipt = primary.api("/api/tasks/" + task_id + "/commands", "POST", {
                "type": "FINISH", "expectedVersion": current["version"],
                "outcome": "SUCCEEDED", "text": "Public account fixture completed"})
            self.assertEqual(200, status, receipt)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                current = primary.api("/api/tasks/" + task_id)[1]
                if current["status"] == "SUCCEEDED" and (not current.get("browser") or current["browser"]["status"] == "CLOSED"):
                    return
                time.sleep(.2)
            self.fail("Owned task did not release its browser: " + current["status"] + "/"
                      + (current.get("browser") or {}).get("status", "NONE"))

        _, unallocated = self.create(primary, preferred=[second])
        self.assertEqual("QUEUED", unallocated["browser"]["status"])
        finish(unallocated["id"])
        finish(task["id"], explicit, first_operation)
        automatic, selected = self.create(primary)
        self.assertEqual("ACCOUNT_CHOICE",selected["request"]["type"])
        self.assertIsNone(selected["browser"])
        error,selected,_=automatic.respond(selected,{"connectionId":first})
        self.assertFalse(error,selected)
        selected_operation = self.observe(automatic, selected)
        self.assertEqual("SUCCEEDED", self.wait_operation(selected_operation, automatic)["status"])
        active = primary.api("/api/tasks/" + selected["id"])[1]
        used = primary.api("/api/connections/" + first)[1]
        self.assertIsNotNone(used.get("browser"),
                             "The explicitly chosen account must be used")
        self.assertEqual(active["browser"]["id"], used["browser"]["id"])
        self.assertIsNone(primary.api("/api/connections/" + second)[1].get("browser"))

        waiting, pending = self.create(primary, preferred=[first])
        operation = self.observe(waiting, pending)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            queued = primary.api("/api/tasks/" + pending["id"])[1]
            if queued["waitReason"] == "CONNECTION_BUSY":
                break
            time.sleep(.2)
        self.assertEqual(("QUEUED", "CONNECTION_BUSY", None),
                         (queued["status"], queued["waitReason"], queued["browser"]))
        self.assertEqual("ACCEPTED", waiting.tool("operations.get", {"operationId": operation})[1]["status"])
        finish(selected["id"], automatic, selected_operation)
        self.assertEqual("SUCCEEDED", self.wait_operation(operation, waiting)["status"])
        resumed = primary.api("/api/tasks/" + pending["id"])[1]
        self.assertEqual("LIVE", resumed["browser"]["status"])
        self.assertNotEqual(active["browser"]["id"], resumed["browser"]["id"])
        self.assertEqual(resumed["browser"]["id"], primary.api("/api/connections/" + first)[1]["browser"]["id"])
        self.assertIsNone(primary.api("/api/connections/" + second)[1].get("browser"))
        finish(pending["id"], waiting, operation)
        unused, preferred = self.create(primary, preferred=[first])
        finish(preferred["id"])
        self.assertEqual(200, primary.api("/api/connections/" + first, "DELETE")[0])
        # Both a previously selected account and an unused preference can disappear after completion.
        # Neither may silently select B or fail with an opaque NOT_FOUND after explicit resume.
        for transport, stopped in ((waiting, pending), (unused, preferred)):
            value = primary.api("/api/tasks/" + stopped["id"])[1]
            status, value = primary.api("/api/tasks/" + stopped["id"] + "/commands", "POST", {
                "type": "RESUME", "expectedVersion": value["version"], "confirmBrowserLoss": True})
            self.assertEqual(200, status, value)
            operation = self.observe(transport, value)
            value = primary.api("/api/tasks/" + stopped["id"])[1]
            self.assertEqual("ACCOUNT_CHOICE", value["request"]["type"])
            self.assertEqual("WAITING_USER", value["status"])
            self.assertEqual("ACCEPTED", transport.tool("operations.get", {"operationId": operation})[1]["status"])
            self.assertIsNone(primary.api("/api/connections/" + second)[1].get("browser"))
            error, chosen, _ = transport.respond(value,{"connectionId":second})
            self.assertFalse(error, chosen)
            self.assertEqual("SUCCEEDED", self.wait_operation(operation, transport)["status"])
            finish(stopped["id"])

    def test_busy_connection_does_not_block_other_owner(self):
        identity,primary=self.owner()
        _,other=self.owner()
        client,task=self.create(primary)
        lease_client,lease_task=self.create(primary)
        for current,current_task in ((client,task),(lease_client,lease_task)):
            self.assertEqual("SUCCEEDED",self.wait_operation(self.observe(current,current_task),current)["status"])
        _,task=primary.api("/api/tasks/"+task["id"])
        _,lease_task=primary.api("/api/tasks/"+lease_task["id"])
        status,connection=primary.api("/api/connections","POST",{
            "name":"Busy queue fixture","site":"example.com","startUrl":"https://example.com"})
        self.assertEqual(200,status)
        operation=str(uuid.uuid4())
        # A committed approved switch is the admission input. The connection is intentionally
        # leased, so this operation must never dispatch or require a saved credential fixture.
        self.fixture_sql(identity,"UPDATE browser_sessions SET connection_id='"+connection["id"]+"' WHERE owner_id=:owner AND id='"+lease_task["browser"]["id"]+"'; "
            +"INSERT INTO operations(id,owner_id,task_id,type,arguments,status,mutating,instruction_revision,control_epoch) VALUES ('"+operation+"',:owner,'"+task["id"]+"','applyConnection','{\"connectionId\":\""+connection["id"]+"\"}','ACCEPTED',true,"+str(task["instructionRevision"])+","+str(task["browser"]["controlEpoch"])+");")
        other_client,other_task=self.create(other)
        other_operation=self.observe(other_client,other_task)
        deadline=time.monotonic()+20
        receipt={}
        while time.monotonic()<deadline:
            error,receipt,_=other_client.tool("operations.get",{"operationId":other_operation})
            self.assertFalse(error,receipt)
            if receipt["status"]=="SUCCEEDED":
                break
            time.sleep(.3)
        self.assertEqual("SUCCEEDED",receipt.get("status"),"A leased connection must not starve another runnable owner")
        error,blocked,_=client.tool("operations.get",{"operationId":operation})
        self.assertFalse(error)
        self.assertEqual("ACCEPTED",blocked["status"])


if __name__=="__main__":
    unittest.main(verbosity=2)
