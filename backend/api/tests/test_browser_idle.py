"""Browser lifecycle acceptance against dev with disposable, owner-scoped fixtures."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from pathlib import Path
import subprocess
import time
import unittest
import uuid

import test_browser_pages as pages


class BrowserIdleTest(unittest.TestCase):
    setUpClass = classmethod(pages.BrowserPagesTest.setUpClass.__func__)
    setUp = pages.BrowserPagesTest.setUp
    tearDown = pages.BrowserPagesTest.tearDown
    owner = pages.BrowserPagesTest.owner
    create = pages.BrowserPagesTest.create
    fixture_sql = pages.BrowserPagesTest.fixture_sql
    page = pages.BrowserPagesTest.page

    def wait_task(self, client, task_id, predicate):
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            status, task = client.api('/api/tasks/' + task_id)
            self.assertEqual(200, status)
            if predicate(task):
                return task
            time.sleep(.25)
        browser = task.get('browser') or {}
        history = client.api('/api/tasks/' + task_id + '/history')[1].get('items', [])[:4]
        self.fail('Expected browser lifecycle transition was not confirmed: '
            + str((task['status'], task['waitReason'], browser.get('status'), browser.get('closeReason')))
            + '; latest history: ' + str([(event.get('type'), event.get('detail')) for event in history]))

    def ready(self):
        identity, client = self.owner()
        model, task = self.create(client, client.browser_fixture_url())
        task = self.wait_task(client, task['id'], lambda value:
            value['browser'] and value['browser']['status'] == 'LIVE')
        return identity, client, model, task

    def command(self, client, task_id, kind):
        task = client.api('/api/tasks/' + task_id)[1]
        status, result = client.api('/api/tasks/' + task_id + '/commands', 'POST', {
            'type': kind, 'expectedVersion': task['version']})
        self.assertEqual(200, status, result.get('code'))
        return result

    def take(self, client, task, private=False):
        viewer, visit = str(uuid.uuid4()), str(uuid.uuid4())
        browser = task['browser']
        status, result = client.api('/api/browser-sessions/' + browser['id'] + '/control', 'POST', {
            'type': 'BEGIN_LOGIN' if private else 'TAKE', 'viewerId': viewer,
            'controlEpoch': browser['controlEpoch']})
        self.assertEqual(200, status, result.get('code'))
        task = self.wait_task(client, task['id'], lambda value: value['browser']['controlOwner'] == 'USER')
        self.assertEqual(200, self.page(client, task['browser'], visit, 'PUT', viewer)[0])
        return task, viewer, visit

    def expire_browser(self, identity, browser):
        self.fixture_sql(identity, "UPDATE browser_sessions SET idle_close_at=clock_timestamp()-interval '1 second' "
            "WHERE owner_id=:owner AND id='" + str(uuid.UUID(browser['id'])) + "';")

    def test_unknown_after_close_allows_verification_without_replaying_change(self):
        identity, client, model, task = self.ready()
        model.close_mcp()
        instructions = model.rpc('initialize', {'protocolVersion': '2025-11-25',
            'capabilities': model.mcp_capabilities, 'clientInfo': {'name': 'helm-idle-regression',
                'version': '1'}})['instructions']
        self.assertIn('observationOperationId', instructions,
            'Initialize must explain model verification independently of human consent')
        operation = str(uuid.uuid4())
        error, value, _ = model.execute_in_scenario_step({
            'taskId': task['id'], 'action': {
                'operationId': operation, 'type': 'click',
                'arguments': model.browser_target(task['id'], 'Slow effect', uncertain=True),
                'instructionRevision': task['instructionRevision']}})
        self.assertFalse(error, value)
        unknown = self.wait_task(client, task['id'], lambda value:
            value['request'] and value['request']['type'] == 'UNKNOWN_RESULT')
        request = unknown['request']
        self.assertEqual('WAITING_CHATGPT', unknown['status'])
        self.fixture_sql(identity, "UPDATE tasks SET status='WAITING_USER' WHERE owner_id=:owner "
            "AND id='" + task['id'] + "';")
        recovered = self.wait_task(client, task['id'], lambda value: value['status'] == 'WAITING_CHATGPT')
        self.assertEqual(request, recovered['request'])
        self.expire_browser(identity, recovered['browser'])
        idle = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertEqual(('WAITING_CHATGPT', request), (idle['status'], idle['request']))
        self.assertEqual('PENDING', self.fixture_sql(identity,
            "SELECT continuation_status FROM mcp_chats WHERE owner_id=:owner AND task_id='"
            + task['id'] + "';"))
        error, observed, _ = model.execute_in_scenario_step({'taskId': task['id'], 'action': {
            'operationId': str(uuid.uuid4()), 'type': 'observe', 'arguments': {},
            'instructionRevision': task['instructionRevision']}})
        self.assertFalse(error, observed)
        if observed['status'] in ('ACCEPTED', 'DISPATCHED'):
            until = time.monotonic() + 45
            while time.monotonic() < until:
                observed = model.tool('operations.get', {'operationId': observed['id']})[1]
                if observed['status'] not in ('ACCEPTED', 'DISPATCHED'):
                    break
                time.sleep(.2)
        self.assertEqual('SUCCEEDED', observed['status'])
        reopened = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'LIVE')
        self.assertNotEqual(idle['browser']['id'], reopened['browser']['id'])
        self.assertEqual(request, reopened['request'])
        controlled, viewer, visit = self.take(client, reopened)
        self.assertEqual(request, controlled['request'])
        status, response = client.api('/api/browser-sessions/' + controlled['browser']['id'] + '/control',
            'POST', {'type': 'RETURN', 'viewerId': viewer, 'resume': True,
                'controlEpoch': controlled['browser']['controlEpoch']})
        self.assertEqual(200, status, response)
        returned = self.wait_task(client, task['id'], lambda value:
            value['browser']['controlOwner'] == 'CHATGPT')
        self.assertEqual(('WAITING_CHATGPT', request), (returned['status'], returned['request']))
        self.page(client, returned['browser'], visit, 'DELETE')
        capabilities = model.mcp_capabilities
        model.close_mcp()
        model.mcp_capabilities = {}
        try:
            error, refusal, _ = model.tool('tasks.respond', {
                'taskId': task['id'], 'requestId': request['id'],
                'requestVersion': request['version'], 'operationKey': str(uuid.uuid4())})
            self.assertTrue(error)
            self.assertEqual('VERIFICATION_REQUIRED', refusal['code'])
            self.assertEqual(request, client.api('/api/tasks/' + task['id'])[1]['request'])
        finally:
            model.close_mcp()
            model.mcp_capabilities = capabilities
        for mode in ('OPEN_BROWSER', 'RESUME'):
            self.command(client, task['id'], 'CLOSE_BROWSER')
            closed = self.wait_task(client, task['id'], lambda value:
                value['browser']['status'] == 'CLOSED')
            self.assertEqual(('PAUSED', request), (closed['status'], closed['request']))
            self.assertIn(mode, closed['allowedCommands'],
                'Unknown effects must not prevent opening a browser for read-only verification')
            read = {'operationId': str(uuid.uuid4()), 'type': 'observe', 'arguments': {},
                    'instructionRevision': closed['instructionRevision']}
            error, refusal, _ = model.execute_in_scenario_step({
                'taskId': task['id'], 'action': dict(read)})
            self.assertTrue(error)
            self.assertEqual('TASK_NOT_RUNNING', refusal['code'])
            if mode == 'OPEN_BROWSER':
                ui = subprocess.run([
                    'docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
                    'run', '--rm', '-i', '--network', 'bridge', '--user', 'node',
                    '--security-opt', 'seccomp=' + str(Path(__file__).resolve().parents[2]
                        / 'browser-node' / 'seccomp-profile.json'), '--entrypoint', 'node',
                    'helmglass-browser-session:current', '--input-type=module', '-'],
                    input='''
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const input=%s;
const browser=await chromium.launch({headless:true,chromiumSandbox:true});
try {
 const page=await browser.newPage();page.setDefaultTimeout(30000);
 await page.goto(input.base+'/oauth2/start?rd='+encodeURIComponent('/tasks/'+input.task));
 await page.locator('#username').fill(input.username);
 await page.locator('#password').fill(input.password);
 await page.locator('#kc-login').click();
 await page.getByText('Для проверки требуется возобновить браузер.',{exact:false}).waitFor();
 const open=page.getByRole('region',{name:'Браузер',exact:true})
  .getByRole('button',{name:'Возобновить браузер',exact:true});
 assert.equal(await open.isEnabled(),true);
 await open.click();
 await open.waitFor({state:'hidden'});
 assert.equal(await page.getByRole('dialog').count(),0);
} finally {await browser.close();}
''' % json.dumps({'base': client.base, 'username': identity.username,
                         'password': identity.password, 'task': task['id']}),
                    capture_output=True, text=True, encoding='utf-8', timeout=120)
                self.assertEqual(0, ui.returncode, ui.stderr.replace(identity.password, '[redacted]'))
                opened = self.wait_task(client, task['id'], lambda value:
                    value['browser']['status'] == 'LIVE' and value['status'] == 'WAITING_CHATGPT')
            else:
                command = {'type': mode, 'expectedVersion': closed['version']}
                error, opened, _ = model.tool('tasks.command', {'taskId': task['id'],
                    'operationKey': str(uuid.uuid4()), 'command': command})
                self.assertFalse(error, opened)
                self.assertIn('OPEN_BROWSER', opened['allowedCommands'],
                    'Accepted continuation must retain explicit browser recovery while UNKNOWN waits')
                self.assertEqual('CLOSED', opened['browser']['status'])
                error, opened, _ = model.tool('tasks.command', {'taskId': task['id'],
                    'operationKey': str(uuid.uuid4()), 'command': {
                        'type': 'RESUME', 'expectedVersion': opened['version']}})
                self.assertFalse(error,
                    'Repeated continuation must permit reading for verification: ' + str(opened))
                self.assertIn('RESUME', opened['allowedCommands'])
            self.assertEqual(request, opened['request'])
            read_id = str(uuid.uuid4())
            error, accepted, _ = model.execute_in_scenario_step({
                'taskId': task['id'], 'action': {**read, 'operationId': read_id}})
            self.assertFalse(error, accepted)
            until = time.monotonic() + 45
            while time.monotonic() < until:
                verified = model.tool('operations.get', {'operationId': read_id})[1]
                if verified['status'] not in ('ACCEPTED', 'DISPATCHED'):
                    break
                time.sleep(.2)
            self.assertEqual('SUCCEEDED', verified['status'])
            current = client.api('/api/tasks/' + task['id'])[1]
            self.assertNotEqual(closed['browser']['id'], current['browser']['id'])
            self.assertEqual(('WAITING_CHATGPT', 'UNKNOWN_RESULT', request),
                (current['status'], current['waitReason'], current['request']))
            error, refusal, _ = model.execute_in_scenario_step({
                'taskId': task['id'], 'action': {**read, 'operationId': str(uuid.uuid4()),
                    'type': 'click', 'arguments': {}}})
            self.assertTrue(error)
            self.assertEqual('UNKNOWN_RESULT', refusal['code'])
            self.assertEqual('UNKNOWN', model.tool('operations.get',
                {'operationId': operation})[1]['status'])
        current = client.api('/api/tasks/' + task['id'])[1]
        error, login, _ = model.tool('tasks.command', {'taskId': task['id'],
            'operationKey': str(uuid.uuid4()), 'command': {
                'type': 'REQUIRE_LOGIN', 'expectedVersion': current['version']}})
        self.assertFalse(error, login)
        protected = self.wait_task(client, task['id'], lambda value:
            value['browser']['privateMode'] and value['browser']['controlOwner'] != 'TRANSFERRING')
        self.assertEqual(('WAITING_USER', 'LOGIN', request),
            (protected['status'], protected['waitReason'], protected['request']))
        error, refused, _ = model.tool('browser.execute', {'taskId': task['id'], 'action': {
            'operationId': str(uuid.uuid4()), 'stepId': verified['stepId'], 'type': 'observe',
            'arguments': {}, 'instructionRevision': protected['instructionRevision'],
            'controlEpoch': protected['browser']['controlEpoch']}})
        self.assertTrue(error)
        self.assertEqual('CONTROL_NOT_OWNED', refused['code'])
        controlled, viewer, visit = self.take(client, protected, private=True)
        status, response = client.api('/api/browser-sessions/' + controlled['browser']['id'] + '/control',
            'POST', {'type': 'RETURN', 'viewerId': viewer, 'resume': True,
                'controlEpoch': controlled['browser']['controlEpoch']})
        self.assertEqual(200, status, response)
        retained = self.wait_task(client, task['id'], lambda value:
            value['browser']['controlOwner'] != 'TRANSFERRING')
        self.assertEqual(('WAITING_USER', 'LOGIN', True, request),
            (retained['status'], retained['waitReason'], retained['browser']['privateMode'], retained['request']))
        self.page(client, retained['browser'], visit, 'DELETE')
        self.command(client, task['id'], 'STOP')
        stopped = self.wait_task(client, task['id'], lambda value: value['status'] == 'STOPPED')
        self.assertEqual(request, stopped['request'])
        self.assertNotIn('RESUME', stopped['allowedCommands'])
        self.assertNotIn('OPEN_BROWSER', stopped['allowedCommands'])

    def test_reopen_continues_same_task_and_preserves_independent_pause(self):
        identity, client, model, task = self.ready()
        original = task['browser']['id']
        self.command(client, task['id'], 'CLOSE_BROWSER')
        closed = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertEqual('PAUSED', closed['status'])
        self.command(client, task['id'], 'OPEN_BROWSER')
        reopened = self.wait_task(client, task['id'], lambda value:
            value['browser']['status'] == 'LIVE' and value['status'] == 'WAITING_CHATGPT')
        self.assertNotEqual(original, reopened['browser']['id'])
        self.assertEqual(task['instructionRevision'], reopened['instructionRevision'])
        self.assertEqual(task['stepCount'], reopened['stepCount'])
        # A separate pre-existing pause must survive a subsequent close/open cycle.
        self.fixture_sql(identity, "UPDATE tasks SET status='PAUSED',paused_explicitly=true "
            "WHERE owner_id=:owner AND id='" + str(uuid.UUID(task['id'])) + "';")
        self.command(client, task['id'], 'CLOSE_BROWSER')
        self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.command(client, task['id'], 'OPEN_BROWSER')
        retained = self.wait_task(client, task['id'], lambda value:
            value['browser']['status'] == 'LIVE' and value['waitReason'] != 'BROWSER_OPEN_REQUESTED')
        self.assertEqual('PAUSED', retained['status'])

    def test_deliberate_leave_continues_but_expired_controller_waits(self):
        identity, client, model, task = self.ready()
        task, viewer, visit = self.take(client, task)
        browser = task['browser']
        self.assertEqual(200, self.page(client, browser, visit, 'DELETE')[0])
        resumed = self.wait_task(client, task['id'], lambda value: value['status'] == 'WAITING_CHATGPT')
        self.assertEqual(browser['id'], resumed['browser']['id'])
        task, viewer, visit = self.take(client, resumed)
        self.fixture_sql(identity, "UPDATE browser_page_visits SET expires_at=clock_timestamp() "
            "WHERE id='" + str(uuid.UUID(visit)) + "' AND session_id IN "
            "(SELECT id FROM browser_sessions WHERE owner_id=:owner);")
        paused = self.wait_task(client, task['id'], lambda value: value['status'] == 'PAUSED')
        self.assertEqual('LIVE', paused['browser']['status'])
        self.assertEqual(200, self.page(client, browser, visit, 'DELETE')[0])
        self.assertEqual('PAUSED', client.api('/api/tasks/' + task['id'])[1]['status'])

    def test_idle_extension_is_owned_idempotent_and_widget_reads_do_not_extend(self):
        identity, client, model, task = self.ready()
        task = self.wait_task(client, task['id'], lambda value: value['browser']['idleCloseAt'] is not None)
        browser = task['browser']
        _, foreign = self.owner()
        path = '/api/browser-sessions/' + browser['id'] + '/keep-open'
        self.assertEqual(404, foreign.api(path, 'POST', {})[0])
        key = str(uuid.uuid4())
        status, extended = client.api(path, 'POST', {}, key)
        self.assertEqual(200, status)
        self.assertGreater(datetime.fromisoformat(extended['idleCloseAt']), datetime.fromisoformat(browser['idleCloseAt']))
        self.assertEqual(extended, client.api(path, 'POST', {}, key)[1])
        error, shown, _ = model.tool('tasks.view', {'taskId': task['id'], 'operationKey': str(uuid.uuid4())})
        self.assertFalse(error, shown)
        binding = {'taskId': task['id'], 'generation': shown['generation']}
        before = client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt']
        for _ in range(3):
            self.assertFalse(model.tool('widget.state', binding)[0])
        self.assertEqual(before, client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt'])
        error, kept, _ = model.tool('widget.keep-open', {**binding, 'browserId': browser['id'], 'operationKey': str(uuid.uuid4())})
        self.assertFalse(error, kept)
        self.assertEqual('WAITING_CHATGPT', kept['task']['status'])
        self.expire_browser(identity, browser)
        closed = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertEqual(('PAUSED', 'IDLE_TIMEOUT'), (closed['status'], closed['browser']['closeReason']))
        self.assertEqual(409, client.api(path, 'POST', {})[0])

    def test_manual_deadline_and_incomplete_login_stays_private(self):
        identity, client, model, task = self.ready()
        task, viewer, visit = self.take(client, task, private=True)
        protected = task
        self.assertEqual(900, protected['browser']['idleTimeoutSeconds'])
        self.assertGreater(datetime.fromisoformat(protected['browser']['idleCloseAt']).timestamp(), time.time() + 850)
        self.assertGreater(datetime.fromisoformat(protected['browser']['idleWarningAt']).timestamp(), time.time() + 550)
        self.assertEqual(('LIVE', 'USER'), (protected['browser']['status'], protected['browser']['controlOwner']))
        self.assertEqual(200, self.page(client, task['browser'], visit, 'DELETE')[0])
        released = self.wait_task(client, task['id'], lambda value: value['browser']['controlOwner'] != 'USER'
            and value['browser']['controlOwner'] != 'TRANSFERRING')
        self.assertTrue(released['browser']['privateMode'])
        self.assertEqual(('WAITING_USER', 'LOGIN'), (released['status'], released['waitReason']))
        self.command(client, task['id'], 'CLOSE_BROWSER')
        self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.command(client, task['id'], 'OPEN_BROWSER')
        reopened = self.wait_task(client, task['id'], lambda value:
            value['browser']['status'] == 'LIVE' and value['waitReason'] != 'BROWSER_OPEN_REQUESTED')
        self.assertTrue(reopened['browser']['privateMode'])
        self.assertEqual(('WAITING_USER', 'LOGIN'), (reopened['status'], reopened['waitReason']))

    def test_manual_activity_requires_current_controller_and_never_replays(self):
        identity, client, model, task = self.ready()
        task, viewer, visit = self.take(client, task)
        browser = task['browser']
        path = '/api/browser-sessions/' + browser['id'] + '/pages/' + visit + '/activity'
        before = browser['idleCloseAt']
        payload = {'controlEpoch': browser['controlEpoch'], 'sequence': 1}
        _, foreign = self.owner()
        self.assertEqual(404, foreign.api(path, 'POST', payload)[0])
        self.assertEqual(409, client.api(path, 'POST', {**payload, 'controlEpoch': browser['controlEpoch'] - 1})[0])
        observer_visit = str(uuid.uuid4())
        self.assertEqual(200, self.page(client, browser, observer_visit, 'PUT', str(uuid.uuid4()))[0])
        observer_path = path.replace(visit, observer_visit)
        self.assertEqual(403, client.api(observer_path, 'POST', payload)[0])
        self.assertEqual(before, client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt'])
        self.assertEqual(200, client.api(path, 'POST', payload)[0])
        renewed = client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt']
        self.assertGreater(renewed, before)
        self.assertEqual(200, client.api(path, 'POST', payload)[0])
        self.assertEqual(200, self.page(client, browser, visit, 'PUT', viewer)[0])
        self.assertEqual(renewed, client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt'])
        self.expire_browser(identity, browser)
        closed = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertEqual('PAUSED', closed['status'])
        self.assertEqual('IDLE_TIMEOUT', closed['browser']['closeReason'])
        self.assertEqual(409, client.api(path, 'POST', {**payload, 'sequence': 2})[0])

    def test_model_status_and_rejected_requests_do_not_extend_idle(self):
        identity, client, model, task = self.ready()
        browser = task['browser']
        self.assertEqual(300, browser['idleTimeoutSeconds'])
        before = browser['idleCloseAt']
        for _ in range(3):
            self.assertFalse(model.tool('tasks.get', {'taskId': task['id']})[0])
            client.api('/api/tasks/' + task['id'])
        self.assertEqual(before, client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt'])
        self.expire_browser(identity, browser)
        self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')

    def test_concurrent_explicit_leaves_create_one_continuation(self):
        identity, client, model, task = self.ready()
        error, shown, _ = model.tool('tasks.view', {'taskId': task['id'], 'operationKey': str(uuid.uuid4())})
        self.assertFalse(error, shown)
        task, viewer, visit = self.take(client, task)
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: self.page(client, task['browser'], visit, 'DELETE')[0], range(2)))
        self.assertEqual([200, 200], outcomes)
        self.wait_task(client, task['id'], lambda value: value['status'] == 'WAITING_CHATGPT')
        binding = {'taskId': task['id'], 'generation': shown['generation']}
        first = model.tool('widget.state', binding)[1]
        self.assertEqual('PENDING', first['continuationStatus'])
        self.assertEqual(200, self.page(client, task['browser'], visit, 'DELETE')[0])
        self.assertEqual(first['continuationId'], model.tool('widget.state', binding)[1]['continuationId'])
        attempt = {**binding, 'continuationId': first['continuationId']}
        self.assertTrue(model.tool('widget.claim', attempt)[1]['claimed'])
        self.fixture_sql(identity, "UPDATE mcp_chats SET continuation_claimed_at=clock_timestamp()-interval '61 seconds' WHERE owner_id=:owner;")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if model.tool('widget.state', binding)[1]['continuationStatus'] == 'UNAVAILABLE':
                break
            time.sleep(.5)
        self.assertEqual('UNAVAILABLE', model.tool('widget.state', binding)[1]['continuationStatus'])
        self.assertFalse(model.tool('widget.claim', attempt)[1]['claimed'])

    def test_dispatched_operation_blocks_idle_close_and_resets_deadline(self):
        identity, client, model, task = self.ready()
        operation = str(uuid.uuid4())
        error, receipt, _ = model.execute_in_scenario_step({'taskId': task['id'], 'action': {
            'operationId': operation, 'type': 'waitFor',
            'arguments': {**model.browser_target(task['id'], 'Increment'), 'state': 'hidden'},
            'instructionRevision': task['instructionRevision']}})
        self.assertFalse(error, receipt)
        self.wait_task(client, task['id'], lambda value: value['status'] == 'RUNNING')
        self.expire_browser(identity, task['browser'])
        protected = self.wait_task(client, task['id'], lambda value: value['browser']['idleCloseAt'] is None)
        self.assertEqual('LIVE', protected['browser']['status'])
        settled = self.wait_task(client, task['id'], lambda value:
            value['status'] != 'RUNNING' and value['browser']['idleCloseAt'] is not None)
        self.assertEqual('LIVE', settled['browser']['status'])
        self.assertGreater(datetime.fromisoformat(settled['browser']['idleCloseAt']).timestamp(), time.time() + 250)
        rows = self.fixture_sql(identity, "SELECT count(*) FROM operations WHERE owner_id=:owner "
            "AND id='" + operation + "';")
        self.assertEqual('1', rows)

    def test_stop_wins_over_pending_return_and_refuses_resume(self):
        _, client, model, task = self.ready()
        task, viewer, visit = self.take(client, task)
        status, response = client.api('/api/browser-sessions/' + task['browser']['id'] + '/control',
            'POST', {'type': 'RETURN', 'viewerId': viewer, 'resume': True,
                     'controlEpoch': task['browser']['controlEpoch']})
        self.assertEqual(200, status, response.get('code'))
        for _ in range(5):
            current = client.api('/api/tasks/' + task['id'])[1]
            status, result = client.api('/api/tasks/' + task['id'] + '/commands', 'POST', {
                'type': 'STOP', 'expectedVersion': current['version']})
            if status == 200:
                break
            self.assertEqual('STALE_VERSION', result.get('code'))
        self.assertEqual(200, status)
        stopped = self.wait_task(client, task['id'], lambda value: value['status'] == 'STOPPED')
        self.assertEqual('CLOSED', stopped['browser']['status'])
        self.assertNotIn('OPEN_BROWSER', stopped['allowedCommands'])
        self.assertEqual(409, client.api('/api/tasks/' + task['id'] + '/commands', 'POST', {
            'type': 'OPEN_BROWSER', 'expectedVersion': stopped['version']})[0])
        self.assertEqual('STOPPED', client.api('/api/tasks/' + task['id'])[1]['status'])

    def test_instruction_change_preserves_manual_control_and_waits_for_return(self):
        _, client, model, task = self.ready()
        error, shown, _ = model.tool('tasks.view', {
            'taskId': task['id'], 'operationKey': str(uuid.uuid4())})
        self.assertFalse(error, shown)
        task, viewer, visit = self.take(client, task)
        for _ in range(5):
            task = client.api('/api/tasks/' + task['id'])[1]
            error, amended, _ = model.tool('tasks.command', {
                'taskId': task['id'], 'operationKey': str(uuid.uuid4()), 'command': {
                    'type': 'AMEND', 'expectedVersion': task['version'], 'title': task['title'],
                    'goal': 'Read the public page after returning manual control',
                    'startUrl': 'https://example.com'}})
            if not error:
                break
            self.assertEqual('STALE_VERSION', amended.get('code'))
        self.assertFalse(error, amended)
        self.assertEqual(('WAITING_USER', 'MANUAL_CONTROL', 'USER'), (
            amended['status'], amended['waitReason'], amended['browser']['controlOwner']))
        binding = {'taskId': task['id'], 'generation': shown['generation']}
        self.assertNotEqual('PENDING', model.tool('widget.state', binding)[1]['continuationStatus'])
        self.assertEqual(200, self.page(client, amended['browser'], visit, 'DELETE')[0])
        self.wait_task(client, task['id'], lambda value: value['status'] == 'WAITING_CHATGPT')
        pending = model.tool('widget.state', binding)[1]
        self.assertEqual('PENDING', pending['continuationStatus'])
        self.assertTrue(model.tool('widget.claim', {
            **binding, 'continuationId': pending['continuationId']})[1]['claimed'])

    def test_pending_decision_survives_control_return_and_browser_replacement(self):
        for kind in ('QUESTION', 'CONFIRMATION'):
            with self.subTest(kind=kind):
                _, client, model, task = self.ready()
                operation = str(uuid.uuid4())
                if kind == 'QUESTION':
                    error, result, _ = model.tool('tasks.ask', {
                        'taskId': task['id'], 'instructionRevision': task['instructionRevision'],
                        'operationKey': operation, 'prompt': 'Choose before continuing'})
                else:
                    error, result, _ = model.execute_in_scenario_step({
                        'taskId': task['id'], 'action': {'operationId': operation,
                            'type': 'newTab', 'arguments': {'url': 'https://example.com'},
                            'confirmationPrompt': 'Open an additional public tab?',
                            'instructionRevision': task['instructionRevision']}})
                self.assertFalse(error, result)
                requested = client.api('/api/tasks/' + task['id'])[1]['request']
                task, viewer, visit = self.take(client, task)
                self.assertEqual(200, self.page(client, task['browser'], visit, 'DELETE')[0])
                returned = self.wait_task(client, task['id'], lambda value:
                    value['waitReason'] == kind and value['browser']['controlOwner'] == 'CHATGPT')
                self.assertEqual(requested, returned['request'])
                self.command(client, task['id'], 'CLOSE_BROWSER')
                self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
                self.command(client, task['id'], 'OPEN_BROWSER')
                reopened = self.wait_task(client, task['id'], lambda value:
                    value['browser']['status'] == 'LIVE' and value['waitReason'] == kind)
                self.assertEqual(('WAITING_USER', requested), (reopened['status'], reopened['request']))
                response = {'answer': 'Do not open another tab'} if kind == 'QUESTION' else {'proceed': False}
                error, answered, _ = model.respond(reopened, response)
                self.assertFalse(error, answered)
                self.assertIsNone(answered['request'])
                if kind == 'CONFIRMATION':
                    self.assertEqual('CANCELLED', model.tool('operations.get', {'operationId': operation})[1]['status'])
                self.command(client, task['id'], 'STOP')
                self.wait_task(client, task['id'], lambda value: value['status'] == 'STOPPED')

    def test_native_answer_after_closure_preserves_question_and_never_replays_old_confirmation(self):
        for kind in ('QUESTION', 'CONFIRMATION'):
            with self.subTest(kind=kind):
                _, client, model, task = self.ready()
                operation = str(uuid.uuid4())
                if kind == 'QUESTION':
                    error, _, _ = model.tool('tasks.ask', {'taskId': task['id'],
                        'instructionRevision': task['instructionRevision'], 'operationKey': operation,
                        'prompt': 'Choose before continuing after closure'})
                else:
                    target = model.browser_target(task['id'], 'Increment')
                    error, _, _ = model.execute_in_scenario_step({'taskId': task['id'], 'action': {
                        'operationId': operation, 'type': 'click', 'arguments': target,
                        'confirmationPrompt': 'Increment the synthetic counter once?',
                        'instructionRevision': task['instructionRevision']}})
                self.assertFalse(error)
                pending = client.api('/api/tasks/' + task['id'])[1]['request']

                def close_before_answer(form):
                    self.command(client, task['id'], 'CLOSE_BROWSER')
                    self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
                    return {'action': 'accept', 'content': {'answer': 'Keep my answer'}
                        if kind == 'QUESTION' else {'proceed': True}}

                model.elicitation_handler = close_before_answer
                try:
                    error, answered, _ = model.tool('tasks.respond', {'taskId': task['id'],
                        'requestId': pending['id'], 'requestVersion': pending['version'],
                        'operationKey': str(uuid.uuid4())})
                finally:
                    model.elicitation_handler = None
                self.assertFalse(error, answered)
                self.assertIsNone(answered['request'])
                self.assertEqual(('PAUSED', 'CLOSED'), (answered['status'], answered['browser']['status']))
                if kind == 'QUESTION':
                    self.assertEqual('Keep my answer', answered['lastResponse']['text'])
                else:
                    self.command(client, task['id'], 'OPEN_BROWSER')
                    self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'LIVE')
                    until = time.monotonic() + 10
                    while time.monotonic() < until:
                        receipt = model.tool('operations.get', {'operationId': operation})[1]
                        if receipt['status'] == 'CANCELLED':
                            break
                        time.sleep(.2)
                    self.assertEqual(('CANCELLED', 'STALE_BROWSER'), (receipt['status'], receipt['errorCode']))


if __name__ == '__main__':
    unittest.main()
