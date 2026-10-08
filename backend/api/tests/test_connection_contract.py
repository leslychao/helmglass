"""Deployed admission and connection contracts with disposable accounts."""
import json
import time
import unittest
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
            "prepare":True,"requireConfirmation":False,"preferredConnectionIds":preferred or []}})
        self.assertFalse(error,state)
        task = state["task"]
        self.tasks.append((primary,task["id"]))
        return client,task

    def observe(self, client, task):
        operation = str(uuid.uuid4())
        action = {"operationId":operation,"type":"observe","arguments":{},"instructionRevision":task["instructionRevision"]}
        if task.get("browser"):
            action["controlEpoch"] = task["browser"]["controlEpoch"]
        error, receipt, _ = client.tool("browser.execute",{"taskId":task["id"],"action":action})
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
        self.assertEqual({"totalTasks","successfulTasks","completedTasks","successRate","usage"},set(detail["usage"]))
        for size in (10,20,50):
            status, page = self.admin.api("/api/admin/users/"+identity.id+"?taskPageSize="+str(size)+"&auditPageSize="+str(size))
            self.assertEqual(200,status)
            self.assertEqual(size,page["tasks"]["pageSize"])
            self.assertEqual(size,page["audit"]["pageSize"])
        self.assertEqual(400,self.admin.api("/api/admin/users/"+identity.id+"?taskPageSize=11")[0])

    def await_connection(self, client, connection, predicate):
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            status,value=client.api("/api/connections/"+connection)
            self.assertEqual(200,status,value)
            if predicate(value):
                return value
            time.sleep(.3)
        self.fail("Connection transition was not confirmed")

    def saved_connection(self, client, suffix):
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
        self.assertEqual(200,client.api(path,"POST",{"action":"CLOSE","viewerId":viewer})[0])
        self.await_connection(client,connection,lambda value:not value.get("browser"))
        return connection

    def test_saved_profiles_switch_requires_consent_and_delete_preserves_results(self):
        _,primary=self.owner()
        first=self.saved_connection(primary,"A")
        second=self.saved_connection(primary,"B")
        client,task=self.create(primary,preferred=[first])
        self.assertEqual("SUCCEEDED",self.wait_operation(self.observe(client,task),client)["status"])
        _,task=primary.api("/api/tasks/"+task["id"])
        browser=task["browser"]["id"]
        error,presentation,_=client.tool("connections.select",{"taskId":task["id"],"connectionId":second,
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
        self.assertEqual(200,status,value)
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
        status,current=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":"CHOOSE_CONNECTION","expectedVersion":current["version"],"connectionId":first,
            "requestId":current["request"]["id"],"requestVersion":current["request"]["version"]})
        self.assertEqual(200,status,current)
        self.assertEqual("CONFIRMATION",current["request"]["type"])
        self.assertEqual(browser,current["browser"]["id"])
        operation=current["request"]["operationId"]
        status,current=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":"CONFIRM","expectedVersion":current["version"],"requestId":current["request"]["id"],
            "requestVersion":current["request"]["version"]})
        self.assertEqual(200,status,current)
        self.assertEqual("SUCCEEDED",self.wait_operation(operation,client)["status"])
        _,restored=primary.api("/api/connections/"+first)
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
        self.observe(client,task)
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
        viewer=str(uuid.uuid4())
        for command in ({"type":"BEGIN_LOGIN"},{"type":"FINISH_LOGIN","saveConnection":True,
                "connectionId":connection["id"],"accountLabel":"Verified anonymous", "accountSubject":"anonymous-login",
                "resume":False}):
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
        self.observe(client,task)
        _,task=primary.api("/api/tasks/"+task["id"])
        self.assertEqual("ACCOUNT_CHOICE",task["request"]["type"])
        self.assertEqual([],task["request"]["options"])
        status,task=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":"PAUSE","expectedVersion":task["version"]})
        self.assertEqual(200,status)
        choice={"type":"CHOOSE_CONNECTION","expectedVersion":task["version"],
            "requestId":task["request"]["id"],"requestVersion":task["request"]["version"]}
        for selected,expected in ((login_required["id"],400),(wrong_site["id"],400),(foreign_connection["id"],404)):
            self.assertEqual(expected,primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
                **choice,"connectionId":selected})[0])
        status,task=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":"AMEND","expectedVersion":task["version"],"goal":"Updated account choice scope",
            "startUrl":"https://example.com"})
        self.assertEqual(200,status)
        self.assertEqual(409,primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            **choice,"expectedVersion":task["version"],"connectionId":candidates[0]})[0])
        client,preferred=self.create(primary,preferred=candidates[:2])
        self.observe(client,preferred)
        _,preferred=primary.api("/api/tasks/"+preferred["id"])
        self.assertEqual(set(candidates[:2]),{option["id"] for option in preferred["request"]["options"]})
        status,preferred=primary.api("/api/tasks/"+preferred["id"]+"/commands","POST",{
            "type":"PAUSE","expectedVersion":preferred["version"]})
        self.assertEqual(200,status)
        choice={"type":"CHOOSE_CONNECTION","expectedVersion":preferred["version"],
            "requestId":preferred["request"]["id"],"requestVersion":preferred["request"]["version"]}
        self.assertEqual(400,primary.api("/api/tasks/"+preferred["id"]+"/commands","POST",{
            **choice,"connectionId":candidates[2]})[0])
        status,selected=primary.api("/api/tasks/"+preferred["id"]+"/commands","POST",{
            **choice,"connectionId":candidates[0]})
        self.assertEqual(200,status,selected)
        self.assertIsNone(selected["request"])
        self.assertEqual("PAUSED",selected["status"])
        self.assertIsNone(selected["browser"])

    def test_latest_successful_account_is_reused_and_busy_lease_resumes(self):
        _, primary = self.owner()
        first = self.saved_connection(primary, "Latest-success A")
        second = self.saved_connection(primary, "Later-save B")
        explicit, task = self.create(primary, preferred=[first])
        self.assertEqual("SUCCEEDED", self.wait_operation(self.observe(explicit, task), explicit)["status"])
        current = primary.api("/api/tasks/" + task["id"])[1]
        self.assertEqual(current["browser"]["id"], primary.api("/api/connections/" + first)[1]["browser"]["id"])

        def stop(task_id):
            current = primary.api("/api/tasks/" + task_id)[1]
            status, receipt = primary.api("/api/tasks/" + task_id + "/commands", "POST", {
                "type": "STOP", "expectedVersion": current["version"]})
            self.assertEqual(200, status, receipt)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                current = primary.api("/api/tasks/" + task_id)[1]
                if current["status"] == "STOPPED":
                    return
                time.sleep(.2)
            self.fail("Owned task did not stop and release its browser")

        stop(task["id"])
        automatic, selected = self.create(primary)
        self.assertEqual("SUCCEEDED", self.wait_operation(self.observe(automatic, selected), automatic)["status"])
        active = primary.api("/api/tasks/" + selected["id"])[1]
        used = primary.api("/api/connections/" + first)[1]
        self.assertIsNotNone(used.get("browser"),
                             "Latest successful use of A must take precedence over the later saved B")
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
        stop(selected["id"])
        self.assertEqual("SUCCEEDED", self.wait_operation(operation, waiting)["status"])
        resumed = primary.api("/api/tasks/" + pending["id"])[1]
        self.assertEqual("LIVE", resumed["browser"]["status"])
        self.assertNotEqual(active["browser"]["id"], resumed["browser"]["id"])
        self.assertEqual(resumed["browser"]["id"], primary.api("/api/connections/" + first)[1]["browser"]["id"])
        self.assertIsNone(primary.api("/api/connections/" + second)[1].get("browser"))
        stop(pending["id"])
        unused, preferred = self.create(primary, preferred=[first])
        stop(preferred["id"])
        self.assertEqual(200, primary.api("/api/connections/" + first, "DELETE")[0])
        # Both a previously selected account and an unused preference can disappear while stopped.
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
            status, chosen = primary.api("/api/tasks/" + stopped["id"] + "/commands", "POST", {
                "type": "CHOOSE_CONNECTION", "expectedVersion": value["version"],
                "requestId": value["request"]["id"], "requestVersion": value["request"]["version"],
                "connectionId": second})
            self.assertEqual(200, status, chosen)
            self.assertEqual("SUCCEEDED", self.wait_operation(operation, transport)["status"])
            stop(stopped["id"])

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
