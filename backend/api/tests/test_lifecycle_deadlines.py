"""Bounded execution and real idle clocks against dev, using disposable browser owners."""
import hashlib
import json
import subprocess
import threading
import time
import unittest
import uuid
from datetime import datetime
from pathlib import Path
from urllib.request import Request

from test_browser_idle import BrowserIdleTest


class LifecycleDeadlinesTest(unittest.TestCase):
    setUpClass = classmethod(BrowserIdleTest.setUpClass.__func__)
    setUp = BrowserIdleTest.setUp
    tearDown = BrowserIdleTest.tearDown
    owner = BrowserIdleTest.owner
    create = BrowserIdleTest.create
    fixture_sql = BrowserIdleTest.fixture_sql
    page = BrowserIdleTest.page
    ready = BrowserIdleTest.ready
    take = BrowserIdleTest.take
    command = BrowserIdleTest.command

    def wait_task(self, client, task_id, predicate):
        until = time.monotonic() + 90
        while time.monotonic() < until:
            status, value = client.api('/api/tasks/' + task_id)
            self.assertEqual(200, status)
            if predicate(value):
                return value
            time.sleep(.3)
        self.fail('Lifecycle did not settle: ' + str((value['status'], value['browser']['status'])))

    def docker(self, *arguments, script=None):
        result = subprocess.run(['docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
                                 *arguments], input=script, text=True, capture_output=True, timeout=35)
        self.assertEqual(0, result.returncode, 'Scoped browser fault operation failed')
        return result.stdout.strip()

    def freeze_runtime(self, browser):
        session = str(uuid.UUID(browser['id']))
        container = 'helm-browser-' + session
        self.assertEqual(session, json.loads(self.docker('inspect', container))[0]['Config']['Labels']['helmglass.session'])
        script = r"""import fs from 'node:fs';const pids=[];
for(const name of fs.readdirSync('/proc')){
  if(!/^\d+$/.test(name))continue;
  try{const a=fs.readFileSync(`/proc/${name}/cmdline`,'utf8').split('\0');
    if((a[0]==='node'||a[0]?.endsWith('/node'))&&a[1]?.endsWith('/server.js'))pids.push(Number(name));
  }catch{}
}
if(pids.length!==1)throw Error('Expected one owned runtime');
process.kill(pids[0],'SIGSTOP');console.log(pids[0]);"""
        pid = int(self.docker('exec', '-u', '1000', '-i', container, 'node', '--input-type=module', script=script))

        def unfreeze_if_live():
            rows = json.loads(self.docker('inspect', container)) if self.docker(
                'ps', '-a', '--filter', 'name=^/' + container + '$', '--format', '{{.ID}}') else []
            if rows and rows[0]['State']['Running']:
                self.docker('exec', '-u', '1000', container, 'node', '-e',
                            "try{process.kill(" + str(pid) + ",'SIGCONT')}catch(e){if(e.code!=='ESRCH')throw e}")
        self.addCleanup(unfreeze_if_live)
        return unfreeze_if_live

    def test_node_start_deadline_stops_a_frozen_initialization(self):
        identity, client = self.owner()
        model, task = self.create(client, client.browser_fixture_url())
        session = str(uuid.UUID(task['browser']['id']))
        container = 'helm-browser-' + session
        until = time.monotonic() + 30
        while time.monotonic() < until:
            if self.docker('ps', '--filter', 'name=^/' + container + '$', '--format', '{{.ID}}'):
                break
            time.sleep(.1)
        self.freeze_runtime(task['browser'])
        current = client.api('/api/tasks/' + task['id'])[1]
        self.assertIn(current['browser']['status'], ('QUEUED', 'STARTING'),
                      'Fault fixture must intercept initialization before LIVE')
        script = """import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/node.sqlite');
const row=db.prepare('SELECT document FROM sessions WHERE id=?').get(%s);
const session=JSON.parse(row.document);
if(session.ownerId!==%s||!session.initializing)throw Error('Only the owned initializing fixture is allowed');
const remaining=Date.parse(session.startDeadlineAt)-Date.now();
if(remaining<300000||remaining>360000)throw Error('Expected persisted six-minute startup deadline');
session.startDeadlineAt=new Date(Date.now()+2000).toISOString();session.deadlineCheckAt=0;
db.prepare('UPDATE sessions SET document=? WHERE id=?').run(JSON.stringify(session),session.id);
""" % (json.dumps(session), json.dumps(identity.id))
        self.docker('exec', '-i', 'helmglass-browser-node-1', 'node', '--input-type=module', script=script)
        closed = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertNotIn(closed['status'], ('RUNNING', 'STARTING', 'QUEUED'))
        self.assertEqual('0', self.fixture_sql(identity,
            "SELECT count(*) FROM browser_sessions WHERE owner_id=:owner AND status NOT IN ('CLOSED','QUEUED');"))
        # A late failure of the original startup request must not restore occupied status.
        until = time.monotonic() + 42
        while time.monotonic() < until:
            current = client.api('/api/tasks/' + task['id'])[1]
            self.assertEqual('CLOSED', current['browser']['status'])
            time.sleep(1)

    def test_replayed_control_keeps_original_deadline_and_joins_pending_transfer(self):
        identity, client, model, task = self.ready()
        browser = task['browser']
        resume = self.freeze_runtime(browser)
        viewer = str(uuid.uuid4())
        status, accepted = client.api('/api/browser-sessions/' + browser['id'] + '/control', 'POST', {
            'type': 'TAKE', 'viewerId': viewer, 'controlEpoch': browser['controlEpoch']})
        self.assertEqual(200, status, accepted)
        epoch = accepted['controlEpoch']
        script = """import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/node.sqlite');
const id=%s,owner=%s,epoch=%s;
const read=()=>{const s=JSON.parse(db.prepare('SELECT document FROM sessions WHERE id=?').get(id).document);
  if(s.ownerId!==owner)throw Error('Wrong fixture owner');return s;};
const until=Date.now()+10000;
while(read().pendingOperation?.id!==`control:${epoch}`){
  if(Date.now()>until)throw Error('Control was not dispatched');
  await new Promise(r=>setTimeout(r,50));
}
const before=read().pendingOperation.deadlineAt;
const repeat=fetch(`http://127.0.0.1:8090/sessions/${id}/control`,{method:'POST',
  headers:{'X-Worker-Token':process.env.WORKER_TOKEN,'Content-Type':'application/json'},
  body:JSON.stringify({controlEpoch:epoch,owner:'USER',privateMode:false,controllerId:%s,
    deadlineAt:new Date(Date.parse(before)+60000).toISOString()})});
await new Promise(r=>setTimeout(r,300));
console.log(JSON.stringify({before,after:read().pendingOperation?.deadlineAt}));
const result=await repeat;console.log(JSON.stringify({status:result.status}));await result.body?.cancel();
""" % (json.dumps(browser['id']), json.dumps(identity.id), epoch, json.dumps(viewer))
        process = subprocess.Popen(['docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
            'exec', '-i', 'helmglass-browser-node-1', 'node', '--input-type=module'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write(script)
            process.stdin.close()
            timing = json.loads(process.stdout.readline())
            resume()
            response = json.loads(process.stdout.readline())
            self.assertEqual(0, process.wait(timeout=40))
            self.assertEqual(timing['before'], timing['after'], 'Replay must retain the original deadline')
            self.assertEqual(200, response['status'], 'The identical pending transfer must share its result')
            current = self.wait_task(client, task['id'], lambda value:
                value['browser']['controlOwner'] == 'USER' or value['browser']['status'] == 'CLOSED')
            self.assertEqual(('LIVE', 'USER', epoch), (current['browser']['status'],
                current['browser']['controlOwner'], current['browser']['controlEpoch']))
            completed_script = """import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';import {once} from 'node:events';import {WebSocket} from 'ws';
const db=new DatabaseSync('/data/node.sqlite'),id=%s,owner=%s,viewer=%s,epoch=%s;
const session=JSON.parse(db.prepare('SELECT document FROM sessions WHERE id=?').get(id).document);
if(session.ownerId!==owner)throw Error('Wrong fixture owner');
const base=`http://127.0.0.1:8090/sessions/${id}`;
const headers={'X-Worker-Token':process.env.WORKER_TOKEN,'Content-Type':'application/json'};
const ticket=randomBytes(32).toString('base64url');
const grant=await fetch(base+'/ticket',{method:'POST',headers,body:JSON.stringify({ticket,
 viewerId:viewer,role:'CONTROLLER',expiresAt:new Date(Date.now()+60000).toISOString(),
 access:{channel:'WEB',grantId:'disposable-control-replay'}})});
if(grant.status!==200)throw Error('Viewer ticket denied');await grant.body?.cancel();
const socket=new WebSocket(base.replace('http:','ws:')+'/view?ticket='+ticket,
 {headers:{Origin:new URL(process.env.PUBLIC_URL).origin}});
let disconnected=false;socket.on('close',()=>disconnected=true);
try{
 await once(socket,'message',{signal:AbortSignal.timeout(5000)});
 const send=async body=>{const r=await fetch(base+'/control',{method:'POST',headers,body:JSON.stringify(body)});
  await r.body?.cancel();return r.status;};
 const policy={controlEpoch:epoch,owner:'USER',privateMode:false,controllerId:viewer};
 const replay=await send({...policy,deadlineAt:new Date(0).toISOString()});
 const conflict=await send({...policy,controllerId:'another-controller'});
 const stale=await send({...policy,controlEpoch:epoch-1});
 await new Promise(r=>setTimeout(r,200));
 console.log(JSON.stringify({replay,conflict,stale,disconnected}));
}finally{socket.terminate();}
""" % (json.dumps(browser['id']), json.dumps(identity.id), json.dumps(viewer), epoch)
            checked = json.loads(self.docker('exec', '-i', 'helmglass-browser-node-1',
                'node', '--input-type=module', script=completed_script))
            self.assertEqual({'replay': 200, 'conflict': 409, 'stale': 409, 'disconnected': False}, checked)
        finally:
            resume()
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()

    def test_expired_control_candidate_does_not_close_a_completed_transfer(self):
        identity, client, model, task = self.ready()
        session = str(uuid.UUID(task['browser']['id']))
        owner = str(uuid.UUID(identity.id))
        self.fixture_sql(identity, 'SELECT 1;')
        process = subprocess.Popen(['docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
            'exec', '-i', 'helmglass-postgres-1', 'psql', '-U', 'postgres', '-d', 'helmglass',
            '-Atq', '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write("SET idle_in_transaction_session_timeout='20s';BEGIN;"
                + "SELECT pg_backend_pid() FROM accounts WHERE id='" + owner + "' FOR UPDATE;\n")
            process.stdin.flush()
            locker = int(process.stdout.readline())
            self.fixture_sql(identity, "UPDATE browser_sessions SET pending_control='{}',"
                "control_owner='TRANSFERRING',control_deadline_at=clock_timestamp()-interval '1 second',"
                "control_next_check_at=clock_timestamp()+interval '6 minutes' "
                "WHERE owner_id=:owner AND id='" + session + "';")
            until = time.monotonic() + 12
            while time.monotonic() < until:
                waiting = int(self.fixture_sql(identity,
                    "WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE "
                    + str(locker) + "=ANY(pg_blocking_pids(pid)) UNION "
                    "SELECT a.pid FROM pg_stat_activity a JOIN blocked b "
                    "ON b.pid=ANY(pg_blocking_pids(a.pid))) SELECT count(*) FROM blocked;"))
                if waiting >= 2:
                    break
                time.sleep(.2)
            self.assertGreaterEqual(waiting, 2, 'Expiry and reconciliation must wait for the fixture owner')
            process.stdin.write("UPDATE browser_sessions SET pending_control=NULL,control_owner='CHATGPT',"
                "control_deadline_at=NULL,control_epoch=control_epoch+1 WHERE owner_id='" + owner
                + "' AND id='" + session + "';COMMIT;\n")
            process.stdin.close()
            self.assertEqual(0, process.wait(timeout=5))
            until = time.monotonic() + 6
            while time.monotonic() < until:
                current = client.api('/api/tasks/' + task['id'])[1]
                self.assertEqual('LIVE', current['browser']['status'])
                self.assertEqual('CHATGPT', current['browser']['controlOwner'])
                self.assertNotEqual('PAUSED', current['status'])
                time.sleep(.3)
        finally:
            if not process.stdin.closed:
                process.stdin.close()
            if process.poll() is None:
                process.wait(timeout=25)
            process.stdout.close()
            process.stderr.close()

    def test_late_control_failure_does_not_change_a_closed_browser(self):
        identity, client, model, task = self.ready()
        browser = task['browser']
        session, owner = str(uuid.UUID(browser['id'])), str(uuid.UUID(identity.id))
        self.freeze_runtime(browser)
        status, accepted = client.api('/api/browser-sessions/' + session + '/control', 'POST', {
            'type': 'TAKE', 'viewerId': str(uuid.uuid4()), 'controlEpoch': browser['controlEpoch']})
        self.assertEqual(200, status, accepted)
        script = """import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/node.sqlite'),id=%s,owner=%s,epoch=%s;
const until=Date.now()+10000;
while(true){const s=JSON.parse(db.prepare('SELECT document FROM sessions WHERE id=?').get(id).document);
 if(s.ownerId!==owner)throw Error('Wrong fixture owner');
 if(s.pendingOperation?.id===`control:${epoch}`)break;
 if(Date.now()>until)throw Error('Control was not dispatched');
 await new Promise(r=>setTimeout(r,50));}
""" % (json.dumps(session), json.dumps(owner), accepted['controlEpoch'])
        self.docker('exec', '-i', 'helmglass-browser-node-1', 'node', '--input-type=module', script=script)
        process = subprocess.Popen(['docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
            'exec', '-i', 'helmglass-postgres-1', 'psql', '-U', 'postgres', '-d', 'helmglass',
            '-Atq', '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write("SET idle_in_transaction_session_timeout='50s';BEGIN;"
                + "SELECT pg_backend_pid() FROM accounts WHERE id='" + owner + "' FOR UPDATE;\n")
            process.stdin.flush()
            self.assertGreater(int(process.stdout.readline()), 0)
            self.docker('stop', '--time', '1', 'helm-browser-' + session)
            # Reproduce confirmed physical closure winning the owner lock before the late reply.
            process.stdin.write("UPDATE browser_sessions SET status='CLOSED',closed_at=now(),"
                "control_owner='NONE',pending_control=NULL,control_deadline_at=NULL,idle_close_at=NULL "
                "WHERE owner_id='" + owner + "' AND id='" + session + "';"
                "UPDATE tasks SET status='PAUSED',paused_explicitly=true WHERE owner_id='" + owner
                + "' AND id='" + str(uuid.UUID(task['id'])) + "';SELECT 1;\n")
            process.stdin.flush()
            self.assertEqual('1', process.stdout.readline().strip())
            until = time.monotonic() + 35
            while time.monotonic() < until:
                if 'Control delivery failed for session ' + session in self.docker(
                        'logs', '--since', '60s', 'helmglass-api-1'):
                    break
                time.sleep(.3)
            else:
                self.fail('The dispatched control must return its late failure')
            process.stdin.write('COMMIT;\n')
            process.stdin.close()
            self.assertEqual(0, process.wait(timeout=5))
            until = time.monotonic() + 6
            while time.monotonic() < until:
                current = client.api('/api/tasks/' + task['id'])[1]
                self.assertEqual(('CLOSED', 'NONE'), (current['browser']['status'],
                    current['browser']['controlOwner']))
                self.assertEqual('0', self.fixture_sql(identity,
                    "SELECT count(*) FROM task_history WHERE owner_id=:owner AND task_id='"
                    + str(uuid.UUID(task['id'])) + "' AND type='BROWSER_FAILURE';"),
                    'A settled control must not add another failure after physical closure')
                time.sleep(.3)
        finally:
            if not process.stdin.closed:
                process.stdin.close()
            if process.poll() is None:
                process.wait(timeout=55)
            process.stdout.close()
            process.stderr.close()

    def test_control_retry_after_node_restart_keeps_the_original_intent(self):
        identity, client, model, task = self.ready()
        self.assertEqual('1', self.fixture_sql(identity,
            "SELECT count(*) FROM browser_sessions WHERE status NOT IN ('CLOSED','QUEUED');"))
        browser = task['browser']
        resume = self.freeze_runtime(browser)
        status, accepted = client.api('/api/browser-sessions/' + browser['id'] + '/control', 'POST', {
            'type': 'TAKE', 'viewerId': str(uuid.uuid4()), 'controlEpoch': browser['controlEpoch']})
        self.assertEqual(200, status, accepted)
        script = """import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/node.sqlite'),id=%s,owner=%s,epoch=%s;
const until=Date.now()+10000;
while(true){const s=JSON.parse(db.prepare('SELECT document FROM sessions WHERE id=?').get(id).document);
 if(s.ownerId!==owner)throw Error('Wrong fixture owner');
 if(s.pendingOperation?.id===`control:${epoch}`){console.log(s.pendingOperation.deadlineAt);break;}
 if(Date.now()>until)throw Error('Control was not dispatched');
 await new Promise(r=>setTimeout(r,50));}
""" % (json.dumps(browser['id']), json.dumps(identity.id), accepted['controlEpoch'])
        before = self.docker('exec', '-i', 'helmglass-browser-node-1', 'node', '--input-type=module', script=script)
        try:
            self.docker('restart', '--time', '1', 'helmglass-browser-node-1')
            after = self.docker('exec', '-i', 'helmglass-browser-node-1', 'node', '--input-type=module', script=script)
            self.assertEqual(before, after, 'Restart and retry must not create another deadline')
        finally:
            resume()
        current = self.wait_task(client, task['id'], lambda value:
            value['browser']['controlOwner'] == 'USER' or value['browser']['status'] == 'CLOSED')
        self.assertEqual(('LIVE', 'USER', accepted['controlEpoch']), (current['browser']['status'],
            current['browser']['controlOwner'], current['browser']['controlEpoch']))

    def test_unavailable_session_registry_is_not_a_missing_receipt(self):
        identity, client, model, task = self.ready()
        session = str(uuid.UUID(task['browser']['id']))
        scope = " WHERE owner_id=:owner AND id='" + session + "';"
        self.fixture_sql(identity,
            "UPDATE browser_sessions SET next_check_at=clock_timestamp()+interval '7 minutes'" + scope)
        script = """import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
const db=new DatabaseSync('/data/node.sqlite'),id=%s,owner=%s;
const row=db.prepare('SELECT document FROM sessions WHERE id=?').get(id);
const session=JSON.parse(row.document);
if(session.ownerId!==owner)throw Error('Wrong fixture owner');
const closed=await fetch('http://127.0.0.1:8090/sessions/'+id,{method:'DELETE',
 headers:{'X-Worker-Token':process.env.WORKER_TOKEN},signal:AbortSignal.timeout(15000)});
const stopped=await closed.json();
if(closed.status!==200||!stopped.runtimeStoppedAt)throw Error('Execution was not stopped');
const original=JSON.parse(db.prepare('SELECT document FROM sessions WHERE id=?').get(id).document);
const get=async route=>{const r=await fetch('http://127.0.0.1:8090/sessions/'+id+'/'+route,
 {headers:{'X-Worker-Token':process.env.WORKER_TOKEN},signal:AbortSignal.timeout(15000)});
 await r.body?.cancel();return r.status;};
const receiptRoute='commands/'+%s;
let receipt,manifest;
try{
 const registry='/artifacts/sessions/'+id+'/session.sqlite';
 fs.renameSync(registry,registry+'.fixture');
 receipt=await get(receiptRoute);manifest=await get('artifacts');
}finally{
 const registry='/artifacts/sessions/'+id+'/session.sqlite';
 fs.renameSync(registry+'.fixture',registry);
}
console.log(JSON.stringify({receipt,manifest,restoredReceipt:await get(receiptRoute),
 restoredManifest:await get('artifacts')}));
""" % (json.dumps(session), json.dumps(identity.id), json.dumps(str(uuid.uuid4())))
        try:
            checked = json.loads(self.docker('exec', '-i', 'helmglass-browser-node-1',
                'node', '--input-type=module', script=script))
            self.assertEqual({'receipt': 502, 'manifest': 502,
                'restoredReceipt': 404, 'restoredManifest': 200}, checked,
                'An unavailable registry cannot prove a receipt or artifact is absent')
            self.assertEqual('directory', self.docker('exec', 'helmglass-browser-node-1', 'stat',
                '--format', '%F', '/artifacts/sessions/' + session))
        finally:
            self.fixture_sql(identity,
                "UPDATE browser_sessions SET next_check_at=clock_timestamp()" + scope)

    def test_hung_control_stops_execution_at_persisted_deadline(self):
        identity, client, model, task = self.ready()
        browser = task['browser']
        self.freeze_runtime(browser)
        started = time.monotonic()
        status, accepted = client.api('/api/browser-sessions/' + browser['id'] + '/control', 'POST', {
            'type': 'TAKE', 'viewerId': str(uuid.uuid4()), 'controlEpoch': browser['controlEpoch']})
        self.assertEqual(200, status, accepted)
        self.assertLess(time.monotonic() - started, 5, 'Accepting intent must not wait for runtime I/O')
        closed = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertEqual('PAUSED', closed['status'])
        self.assertLess(time.monotonic() - started, 70)
        self.assertEqual('', self.docker('ps', '--filter', 'name=^/helm-browser-' + browser['id'] + '$', '--format', '{{.ID}}'))
        self.assertEqual('0', self.fixture_sql(identity,
            "SELECT count(*) FROM browser_sessions WHERE owner_id=:owner AND status NOT IN ('CLOSED','QUEUED');"))

    def test_hung_read_is_failed_and_late_completion_does_not_resume_stopped_task(self):
        identity, client, model, task = self.ready()
        operation = str(uuid.uuid4())
        error, receipt, _ = model.execute_browser({'taskId': task['id'], 'action': {
            'operationId': operation, 'type': 'waitFor', 'arguments': {'textGone': 'Increment'},
            'instructionRevision': task['instructionRevision']}})
        self.assertFalse(error, receipt)
        self.wait_task(client, task['id'], lambda value: value['status'] == 'RUNNING')
        self.freeze_runtime(task['browser'])
        self.fixture_sql(identity, "UPDATE operations SET deadline_at=clock_timestamp()-interval '1 second' "
            "WHERE owner_id=:owner AND id='" + operation + "';")
        self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertEqual('FAILED', model.tool('operations.get', {'operationId': operation})[1]['status'])
        self.command(client, task['id'], 'STOP')
        stopped = self.wait_task(client, task['id'], lambda value: value['status'] == 'STOPPED')
        self.assertNotIn('RESUME', stopped['allowedCommands'])
        self.assertEqual('1', self.fixture_sql(identity, "SELECT count(*) FROM operations WHERE owner_id=:owner AND id='" + operation + "';"))

    def test_hung_profile_save_keeps_unconfirmed_login_and_stops_execution(self):
        identity, client, model, task = self.ready()
        task, viewer, visit = self.take(client, task, private=True)
        status, connection = client.api('/api/connections', 'POST', {
            'name': 'Unconfirmed deadline fixture', 'startUrl': task['startUrl']})
        self.assertEqual(200, status, connection)
        browser = task['browser']
        self.freeze_runtime(browser)
        started = time.monotonic()
        status, accepted = client.api('/api/browser-sessions/' + browser['id'] + '/control', 'POST', {
            'type': 'FINISH_LOGIN', 'viewerId': viewer, 'controlEpoch': browser['controlEpoch'],
            'saveConnection': True, 'connectionId': connection['id'], 'resume': False})
        self.assertEqual(200, status, accepted)
        self.assertLess(time.monotonic() - started, 5)
        scope = " WHERE owner_id=:owner AND id='" + browser['id'] + "'"
        remaining = float(self.fixture_sql(identity,
            'SELECT extract(epoch FROM control_deadline_at-clock_timestamp()) FROM browser_sessions' + scope))
        self.assertGreater(remaining, 340)
        self.assertLessEqual(remaining, 360)
        self.fixture_sql(identity,
            "UPDATE browser_sessions SET control_deadline_at=clock_timestamp()-interval '1 second'" + scope)
        closed = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertNotIn(closed['status'], ('RUNNING', 'STARTING'))
        saved = client.api('/api/connections/' + connection['id'])[1]
        self.assertEqual(0, saved['profileRevision'])
        self.assertIsNone(saved['profileSavedAt'])
        self.assertEqual('', self.docker('ps', '--filter', 'name=^/helm-browser-' + browser['id'] + '$', '--format', '{{.ID}}'))

    def test_saved_audio_processing_does_not_reopen_closed_browser(self):
        identity, client, model, task = self.ready()
        source = Path(__file__).resolve().parents[3] / '.work/audio-corpus/fleurs-10669014641440041936.wav'
        self.assertTrue(source.is_file(), 'The existing public audio acceptance corpus is required')
        self.assertLess(source.stat().st_size, 1_048_576)
        with source.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        artifact = str(uuid.uuid4())
        self.docker('cp', str(source), 'helmglass-api-1:/data/artifacts/' + artifact)
        self.fixture_sql(identity,
            "INSERT INTO artifacts(id,owner_id,task_id,name,mime_type,status,size_bytes,sha256,complete,relative_path) "
            "VALUES ('" + artifact + "',:owner,'" + task['id'] + "','Public audio fixture','audio/wav','READY',"
            + str(source.stat().st_size) + ",'" + digest + "',true,'" + artifact + "');")
        self.command(client, task['id'], 'CLOSE_BROWSER')
        closed = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        error, analysis, _ = model.tool('audio.analyze', {'artifactId': artifact, 'mode': 'transcript'})
        self.assertFalse(error, analysis)
        until = time.monotonic() + 90
        while analysis['status'] in ('QUEUED', 'RUNNING') and time.monotonic() < until:
            time.sleep(.5)
            error, analysis, _ = model.tool('audio.get', {'analysisId': analysis['analysisId']})
            self.assertFalse(error, analysis)
        self.assertEqual('SUCCEEDED', analysis['status'])
        self.assertTrue(analysis['sectionComplete'])
        current = client.api('/api/tasks/' + task['id'])[1]
        self.assertEqual(('PAUSED', closed['browser']['id'], 'CLOSED'),
                         (current['status'], current['browser']['id'], current['browser']['status']))

    def test_unavailable_docker_retains_slot_and_close_survives_node_restart(self):
        identity, client, model, task = self.ready()
        session = str(uuid.UUID(task['browser']['id']))
        # This deliberate infrastructure outage is allowed only in an otherwise empty dev node.
        self.assertEqual('1', self.fixture_sql(identity,
            "SELECT count(*) FROM browser_sessions WHERE status NOT IN ('CLOSED','QUEUED');"))
        proxy = 'helmglass-docker-proxy-1'
        original = json.loads(self.docker('inspect', proxy))[0]
        self.assertEqual('docker-proxy', original['Config']['Labels']['com.docker.compose.service'])
        self.assertTrue(original['State']['Running'])
        try:
            self.docker('stop', '--time', '2', proxy)
            self.command(client, task['id'], 'STOP')
            time.sleep(12)
            current = client.api('/api/tasks/' + task['id'])[1]
            self.assertEqual('STOPPING', current['status'])
            self.assertNotEqual('CLOSED', current['browser']['status'])
            self.assertEqual('1', self.fixture_sql(identity,
                "SELECT count(*) FROM browser_sessions WHERE owner_id=:owner AND status NOT IN ('CLOSED','QUEUED');"))
            self.assertTrue(json.loads(self.docker('inspect', '--format', '{{json .State.Running}}',
                                                'helm-browser-' + session)))
            self.docker('restart', '--time', '2', 'helmglass-browser-node-1')
        finally:
            self.docker('start', proxy)
        stopped = self.wait_task(client, task['id'], lambda value: value['status'] == 'STOPPED')
        self.assertEqual('CLOSED', stopped['browser']['status'])
        self.assertEqual('0', self.fixture_sql(identity,
            "SELECT count(*) FROM browser_sessions WHERE owner_id=:owner AND status NOT IN ('CLOSED','QUEUED');"))

    def test_real_five_minute_wait_ignores_status_reads(self):
        identity, client, model, task = self.ready()
        first = task['browser']
        start = time.monotonic()
        print('Real idle acceptance: five-minute wait started for task ' + task['id'], flush=True)
        self.assertEqual(300, first['idleTimeoutSeconds'])
        self.assertAlmostEqual(60, datetime.fromisoformat(first['idleCloseAt']).timestamp()
            - datetime.fromisoformat(first['idleWarningAt']).timestamp(), delta=.01)
        while time.time() < datetime.fromisoformat(first['idleCloseAt']).timestamp():
            self.assertFalse(model.tool('tasks.get', {'taskId': task['id']})[0])
            current = client.api('/api/tasks/' + task['id'])[1]['browser']
            self.assertEqual(first['idleCloseAt'], current['idleCloseAt'])
            time.sleep(10)
        self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertGreater(time.monotonic() - start, 285)
        print('Real idle acceptance: five-minute closure confirmed', flush=True)

    def test_real_fifteen_minute_manual_idle_with_passive_sse(self):
        identity, client, model, task = self.ready()
        task, viewer, visit = self.take(client, task)
        manual = task['browser']
        print('Real idle acceptance: fifteen-minute passive manual view started', flush=True)
        self.assertEqual(900, manual['idleTimeoutSeconds'])
        self.assertAlmostEqual(300, datetime.fromisoformat(manual['idleCloseAt']).timestamp()
            - datetime.fromisoformat(manual['idleWarningAt']).timestamp(), delta=.01)
        stop = threading.Event()
        failures = []
        def read_events():
            try:
                # The web token expires during this long check. Reconnect on clean EOF,
                # using the refreshed cookie jar, as the cabinet's LiveEvents does.
                for attempt in range(8):
                    if stop.is_set():
                        return
                    with client.http.open(Request(client.base + '/api/events?browserVisit=' + visit), timeout=35) as stream:
                        while not stop.is_set() and stream.readline():
                            pass
                failures.append('Too many event-stream renewals')
            except (OSError, ValueError):
                if not stop.is_set():
                    failures.append('Passive events stream could not reconnect')
        reader = threading.Thread(target=read_events, daemon=True)
        reader.start()
        try:
            while time.time() < datetime.fromisoformat(manual['idleCloseAt']).timestamp():
                current = client.api('/api/tasks/' + task['id'])[1]['browser']
                self.assertEqual(manual['idleCloseAt'], current['idleCloseAt'])
                self.assertEqual('USER', current['controlOwner'])
                self.assertFalse(failures, failures)
                time.sleep(10)
            closed = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
            self.assertEqual('IDLE_TIMEOUT', closed['browser']['closeReason'])
            print('Real idle acceptance: fifteen-minute manual closure confirmed', flush=True)
        finally:
            stop.set()


if __name__ == '__main__':
    unittest.main(verbosity=2)
