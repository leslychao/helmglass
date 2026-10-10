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
        target = model.browser_target(task['id'], 'Increment')
        error, receipt, _ = model.execute_in_scenario_step({'taskId': task['id'], 'action': {
            'operationId': operation, 'type': 'waitFor', 'arguments': {**target, 'state': 'hidden'},
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
