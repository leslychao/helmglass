"""Application data survives an operator-run ordinary dev deployment.

This check never deploys or restarts infrastructure. It prints READY after closing
its browser and retains the fixture credentials only in process memory.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
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

    def browser_action(self, task, kind, arguments=None):
        status, current = self.client.api('/api/tasks/' + task['id'])
        self.assertEqual(200, status)
        operation = str(uuid.uuid4())
        error, receipt, _ = self.client.execute_browser({'taskId': task['id'], 'action': {
            'operationId': operation, 'type': kind, 'arguments': arguments or {},
            'instructionRevision': current['instructionRevision'],
            'controlEpoch': current['browser']['controlEpoch']}})
        self.assertFalse(error, receipt)
        receipt = self.wait_operation(operation, self.client)
        self.assertEqual('SUCCEEDED', receipt['status'], receipt)
        return receipt['result']

    def login_control(self, task, kind, viewer):
        self.command(task, kind, viewerId=viewer, accountLabel='Synthetic persisted account',
                     accountSubject='helm-credential-test')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status, current = self.client.api('/api/tasks/' + task['id'])
            self.assertEqual(200, status)
            if current['browser']['controlOwner'] != 'TRANSFERRING':
                self.assertIsNone(current['browser']['profileSaveError'])
                self.assertEqual(kind == 'BEGIN_LOGIN', current['browser']['privateMode'])
                return current
            time.sleep(.2)
        self.fail('Protected control transition was not acknowledged')

    def test_saved_application_data_survives_ordinary_deployment(self):
        self.assertEqual("1",os.environ.get("HELM_TEST_WAIT_DEPLOY"),
                         "This check requires an explicitly coordinated ordinary dev deployment")
        self.client.login_mcp()
        fixtures = Path(__file__).resolve().parents[2] / 'browser-session' / 'test' / 'fixtures'
        profile_url = 'https://httpbin.org/base64/' + base64.urlsafe_b64encode(
            (fixtures / 'profile-lifetime.html').read_bytes()).decode()
        credential_url = 'https://httpbin.org/base64/' + base64.urlsafe_b64encode(
            (fixtures / 'credentials.html').read_bytes()).decode()
        creation={"operationKey":str(uuid.uuid4()),"task":{
            "title":"Disposable deployment persistence","goal":"Keep original persisted application data",
            "startUrl":profile_url,"prepare":True,"outputFormat":"TABLE"}}
        error,state,_=self.client.tool("tasks.create",creation)
        self.assertFalse(error,state)
        task=state["task"]
        task_id=task["id"]
        self.browser_action(task, 'click', self.client.browser_target(task['id'], 'Use account A'))
        operation=str(uuid.uuid4())
        error,receipt,_=self.client.execute_browser({"taskId":task_id,"action":{
            "operationId":operation,"type":"screenshot","arguments":{},"instructionRevision":task["instructionRevision"],
            "controlEpoch":task["browser"]["controlEpoch"]}})
        self.assertFalse(error,receipt)
        receipt=self.wait_operation(operation,self.client)
        self.assertEqual("SUCCEEDED",receipt["status"],receipt)
        viewer = str(uuid.uuid4())
        task = self.login_control(task, 'BEGIN_LOGIN', viewer)
        task = self.login_control(task, 'FINISH_LOGIN', viewer)
        error,result,_=self.client.tool("results.publish",{
            "taskId":task_id,"instructionRevision":task["instructionRevision"],"operationKey":str(uuid.uuid4()),
            "result":{"summary":"Persisted original result","limitations":[],
                      "sources":[{"title":"Synthetic profile fixture","url":profile_url}],
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
        status, connections = self.client.api('/api/connections')
        self.assertEqual(200, status)
        self.assertEqual(1, connections['total'])
        connection = connections['items'][0]
        self.assertGreater(connection['profileRevision'], 0)
        # This fixture covers already-saved credential persistence. Native private form
        # capture has its own browser regression; there is no public password-write API.
        seeded = subprocess.run([
            'docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
            'exec', '-i', 'helmglass-browser-node-1', 'node', '--input-type=module', '-e',
            "import {DatabaseSync} from 'node:sqlite';import {CredentialStore} from './dist/credentials.js';"
            "let data='';for await(const chunk of process.stdin)data+=chunk;const {owner,id}=JSON.parse(data);"
            "const db=new DatabaseSync((process.env.DATA_DIR??'/data')+'/node.sqlite');"
            "try{new CredentialStore(db,Buffer.from(process.env.PROFILE_ENCRYPTION_KEY,'base64'))"
            ".write(id,owner,'persistence-fixture-seed',0,{origin:'https://httpbin.org',"
            "username:'helm-credential-test',password:'synthetic-not-a-secret'});}finally{db.close()}"],
            input=json.dumps({'owner': self.identity.id, 'id': connection['id']}),
            text=True, capture_output=True, timeout=15)
        self.assertEqual(0, seeded.returncode, 'Owned encrypted persistence fixture failed')
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
        print("READY persistence fixture " + self.identity.id + "; browser CLOSED; encrypted profile and credentials saved; waiting for ordinary deployment",flush=True)
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
        error, state, _ = self.client.tool('tasks.create', {'operationKey': str(uuid.uuid4()), 'task': {
            'title': 'Restore synthetic login after deployment', 'goal': 'Verify saved profile and optional credentials',
            'startUrl': profile_url, 'preferredConnectionIds': [connection['id']], 'prepare': True}})
        self.assertFalse(error, state)
        restored = state['task']
        self.assertNotEqual(task['browser']['id'], restored['browser']['id'])
        self.browser_action(restored, 'click', self.client.browser_target(restored['id'], 'Read state'))
        observed = self.browser_action(restored, 'observe')
        self.assertIn('"account":"a"', observed['text'])
        self.assertIn('"localAccount":"a"', observed['text'])
        self.browser_action(restored, 'navigate', {'url': credential_url})
        restored = self.login_control(restored, 'BEGIN_LOGIN', viewer)
        status, credential = self.client.api('/api/browser-sessions/' + restored['browser']['id']
            + '/credentials?viewerId=' + viewer)
        self.assertEqual(200, status)
        self.assertTrue(credential['available'])
        self.assertEqual(1, credential['revision'])
        restored = self.login_control(restored, 'FINISH_LOGIN', viewer)
        self.browser_action(restored, 'click', self.client.browser_target(restored['id'], 'Check synthetic credentials'))
        self.assertIn('Expected synthetic credentials', self.browser_action(restored, 'observe')['text'])
        self.command(restored, 'STOP')
        print("PASS persisted application data, encrypted cookies/localStorage and automatic protected credential fill in a new Chromium",flush=True)


if __name__=="__main__":
    unittest.main(verbosity=2)
