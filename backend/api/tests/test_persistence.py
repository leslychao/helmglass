"""Application data survives an operator-run ordinary dev deployment.

This check never deploys or restarts infrastructure. It prints READY after closing
its browser and retains the fixture credentials only in process memory.
"""

import hashlib
import os
import subprocess
import time
import unittest
import uuid

import test_usage_admin as usage


class ApplicationPersistenceTest(unittest.TestCase):
    setUpClass = classmethod(usage.UsageAdministrationTest.setUpClass.__func__)
    setUp = usage.UsageAdministrationTest.setUp
    tearDown = usage.UsageAdministrationTest.tearDown
    fixture_sql = usage.UsageAdministrationTest.fixture_sql
    purge_identity = usage.UsageAdministrationTest.purge_identity
    wait_operation = usage.UsageAdministrationTest.wait_operation
    admin_command = usage.UsageAdministrationTest.admin_command
    command = usage.UsageAdministrationTest.command

    def started_at(self):
        result = subprocess.run([
            "docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
            "inspect", "helmglass-api-1", "--format", "{{.State.StartedAt}}"],
            text=True, capture_output=True, timeout=15)
        return result.stdout.strip() if result.returncode == 0 else None

    def test_saved_application_data_survives_ordinary_deployment(self):
        self.assertEqual("1",os.environ.get("HELM_TEST_WAIT_DEPLOY"),
                         "This check requires an explicitly coordinated ordinary dev deployment")
        self.client.login_mcp()
        creation={"operationKey":str(uuid.uuid4()),"task":{
            "title":"Disposable deployment persistence","goal":"Keep original persisted application data",
            "startUrl":"https://example.com","prepare":True,"requireConfirmation":False,"outputFormat":"TABLE"}}
        error,state,_=self.client.tool("tasks.create",creation)
        self.assertFalse(error,state)
        task=state["task"]
        task_id=task["id"]
        operation=str(uuid.uuid4())
        error,receipt,_=self.client.tool("browser.execute",{"taskId":task_id,"action":{
            "operationId":operation,"type":"screenshot","arguments":{},"instructionRevision":task["instructionRevision"]}})
        self.assertFalse(error,receipt)
        receipt=self.wait_operation(operation,self.client)
        self.assertEqual("SUCCEEDED",receipt["status"],receipt)
        error,result,_=self.client.tool("results.publish",{
            "taskId":task_id,"instructionRevision":task["instructionRevision"],"operationKey":str(uuid.uuid4()),
            "result":{"summary":"Persisted original result","limitations":[],
                      "sources":[{"title":"Public starting page","url":"https://example.com"}],
                      "columns":[{"key":"answer","label":"Answer","type":"string"}]},
            "rows":[{"answer":"Preserved across deployment"}]})
        self.assertFalse(error,result)
        self.command(task,"FINISH",outcome="SUCCEEDED",text="Persisted complete result")
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            current=self.client.api("/api/tasks/"+task_id)[1]
            if current["browser"]["status"]=="CLOSED":
                break
            time.sleep(.2)
        self.assertEqual("CLOSED",current["browser"]["status"])
        # Retain both deployed receipt generations during this compatible schema correction.
        self.fixture_sql(self.identity,
            "UPDATE idempotency_records SET response=response #- '{task,pauseRequested}' "
            "WHERE owner_id=:owner AND key='" + creation["operationKey"] + "';")
        draft_key = str(uuid.uuid4())
        draft_body = {"title":"Persisted WEB draft receipt","prepare":False}
        status,draft = self.client.api("/api/tasks","POST",draft_body,draft_key)
        self.assertEqual(200,status,draft)
        view_key = str(uuid.uuid4())
        view_body = {"taskId":task_id,"operationKey":view_key}
        error,view,_ = self.client.tool("tasks.view",view_body)
        self.assertFalse(error,view)
        status,connection=self.client.api("/api/connections","POST",{
            "name":"Persisted connection metadata","site":"example.org","startUrl":"https://example.org"})
        self.assertEqual(200,status,connection)
        self.assertEqual(200,self.admin_command("LIMITS",browserLimitMode="CUSTOM",browserLimit=2,waitingLimit=7)[0])
        resources=["/api/tasks/"+task_id,"/api/tasks/"+task_id+"/history",
                   "/api/tasks/"+task_id+"/result/rows","/api/tasks/"+task_id+"/artifacts",
                   "/api/connections/"+connection["id"],"/api/notifications","/api/usage"]
        before={path:self.client.api(path)[1] for path in resources}
        audit_path="/api/admin/audit?user="+self.identity.id
        audit=self.admin.api(audit_path)[1]
        files=before["/api/tasks/"+task_id+"/artifacts"]
        self.assertEqual(1,files["total"])
        artifact=files["items"][0]
        status,original,_=self.client.request(self.client.base+artifact["downloadUrl"])
        self.assertEqual(200,status)
        self.assertEqual(artifact["sha256"],hashlib.sha256(original).hexdigest())
        started=self.started_at()
        self.assertIsNotNone(started)
        print("READY persistence fixture " + self.identity.id + "; browser CLOSED; waiting for ordinary deployment",flush=True)
        deadline=time.monotonic()+420
        while time.monotonic()<deadline:
            restarted=self.started_at()
            if restarted is not None and restarted!=started:
                try:
                    if self.client.api("/api/me")[0]==200:
                        break
                except OSError:
                    pass
            time.sleep(2)
        else:
            self.fail("An ordinary deployment with ready API was not observed within the agreed window")
        for path,expected in before.items():
            status,actual=self.client.api(path)
            self.assertEqual(200,status,path)
            if path=="/api/tasks/"+task_id:
                # New readonly presentation fields are allowed across a compatible release.
                expected={key:value for key,value in expected.items() if key!="pauseRequested"}
                actual={key:actual[key] for key in expected}
            self.assertEqual(expected,actual,path)
        self.assertEqual(audit,self.admin.api(audit_path)[1])
        status,persisted,_=self.client.request(self.client.base+artifact["downloadUrl"])
        self.assertEqual(200,status)
        self.assertEqual(original,persisted)
        self.assertEqual(200,self.client.refresh_mcp(),"Use the normal independent refresh grant after a long deployment")
        error,duplicate,_=self.client.tool("tasks.create",creation)
        self.assertFalse(error,duplicate)
        self.assertEqual(task_id,duplicate["task"]["id"])
        self.assertEqual(2,self.client.api("/api/tasks")[1]["total"])
        status,persisted_draft = self.client.api("/api/tasks","POST",draft_body,draft_key)
        self.assertEqual(200,status,persisted_draft)
        self.assertEqual({key:value for key,value in draft.items() if key!="pauseRequested"},persisted_draft)
        error,persisted_view,_ = self.client.tool("tasks.view",view_body)
        self.assertFalse(error,persisted_view)
        self.assertEqual(view["task"]["id"],persisted_view["task"]["id"])
        error,persisted_receipt,_=self.client.tool("operations.get",{"operationId":operation})
        self.assertFalse(error,persisted_receipt)
        self.assertEqual(receipt,persisted_receipt)
        print("PASS persisted task, results, history, original file, connection, notifications, usage, audit, idempotency and receipt",flush=True)


if __name__=="__main__":
    unittest.main(verbosity=2)
