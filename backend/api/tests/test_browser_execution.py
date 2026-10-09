"""Browser execution round trips, partial sequences and replay against deployed dev."""
import subprocess
from concurrent.futures import ThreadPoolExecutor
import time
import unittest
import uuid

import test_connection_contract as connections
import test_dev_contract as dev


class BrowserExecutionTest(unittest.TestCase):
    setUp = connections.ConnectionContractTest.setUp
    tearDown = connections.ConnectionContractTest.tearDown
    owner = connections.ConnectionContractTest.owner
    create = connections.ConnectionContractTest.create
    fixture_sql = dev.DevContractTest.fixture_sql
    wait_operation = dev.DevContractTest.wait_operation

    @classmethod
    def setUpClass(cls):
        dev.DevContractTest.setUpClass.__func__(cls)
        cls.docker = ['docker', '--host', 'tcp://' + cls.settings['DEV_HOST'] + ':2375']
        name = 'execution-' + uuid.uuid4().hex + '.html'
        cls.fixture_path = '/usr/share/nginx/html/' + name
        cls.fixture_url = cls.settings['PUBLIC_URL'].rstrip('/') + '/' + name
        cls.addClassCleanup(cls.remove_fixture)
        html = '''<!doctype html><title>Execution acceptance</title>
<input id="text"><input id="password" type="password">
<span id="message" role="textbox" contenteditable="true" aria-label="Message"
      style="display:block;min-height:24px"></span>
<button id="increment" onclick="counter++; render()">Increment</button>
<button id="render" onclick="render()">Read state</button>
<button id="delay" onclick="setTimeout(()=>document.querySelector('#delayed').hidden=false,10000)">Delay</button>
<span id="delayed" hidden>Ready</span><pre id="state"></pre>
<script>let counter=0; function render(){document.querySelector('#state').textContent=
JSON.stringify({counter,text:document.querySelector('#text').value})} render();</script>'''
        subprocess.run(cls.docker + ['exec', '-i', '-u', '0', 'helmglass-frontend-1',
            'sh', '-c', 'cat > ' + cls.fixture_path], input=html, text=True,
            capture_output=True, check=True, timeout=20)

    @classmethod
    def remove_fixture(cls):
        subprocess.run(cls.docker + ['exec', '-u', '0', 'helmglass-frontend-1',
            'rm', '-f', cls.fixture_path], check=True, capture_output=True, timeout=20)

    def ready(self):
        self.identity, primary = self.owner()
        self.client, task = self.create(primary, self.fixture_url)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            self.task = primary.api('/api/tasks/' + task['id'])[1]
            if self.task.get('browser') and self.task['browser']['status'] == 'LIVE':
                break
            time.sleep(.25)
        self.assertEqual('LIVE', self.task['browser']['status'])

    def action(self, kind, arguments=None, **fields):
        return {'operationId': str(uuid.uuid4()), 'type': kind, 'arguments': arguments or {},
                'instructionRevision': self.task['instructionRevision'],
                'controlEpoch': self.task['browser']['controlEpoch'], 'step': {
                    'operationKey': 'verify-execution', 'objectKey': self.task['id'],
                    'title': 'Проверить результат действий',
                    'completionCriterion': 'Счётчик и текст совпадают с заданным результатом'}, **fields}

    def execute(self, **fields):
        error, result, _ = self.client.tool('browser.execute', {'taskId': self.task['id'], **fields})
        self.assertFalse(error, result)
        return result

    def test_short_results_inline_step_and_sequence_replay(self):
        self.ready()
        observed = self.execute(action=self.action('observe'))
        self.assertEqual('SUCCEEDED', observed['status'], 'A short command returns its final receipt')
        commands = [self.action('fill', {'selector': '#text', 'text': 'synthetic-value'}),
                    self.action('click', {'selector': '#increment'}),
                    self.action('click', {'selector': '#render'})]
        started = time.monotonic()
        result = self.execute(actions=commands)
        elapsed = time.monotonic() - started
        self.assertTrue(result['complete'], result)
        self.assertEqual(['SUCCEEDED'] * 3, [item['status'] for item in result['operations']])
        for item in result['operations'][:-1]:
            self.assertNotIn('observation', item['result'])
        final = result['operations'][-1]['result']['observation']
        self.assertIn('"counter":1', final['text'])
        self.assertIn('"text":"synthetic-value"', final['text'])
        self.assertEqual(result, self.execute(actions=commands))
        self.assertIn('"counter":1', self.execute(action=self.action('observe'))['result']['text'])
        error, page, _ = self.client.tool('steps.list', {'taskId': self.task['id']})
        self.assertFalse(error, page)
        self.assertEqual(1, page['total'])
        self.assertEqual('RUNNING', page['items'][0]['status'], 'A click is not a business result')
        self.assertEqual(observed['stepId'], page['items'][0]['id'])
        conflict = {**commands[0], 'arguments': {'selector': '#text', 'text': 'different'}}
        error, refusal, _ = self.client.tool('browser.execute', {
            'taskId': self.task['id'], 'actions': [conflict, *commands[1:]]})
        self.assertTrue(error, refusal)
        self.assertEqual('IDEMPOTENCY_CONFLICT', refusal['code'])
        print(f'Three browser actions, final observation and ready receipts: {elapsed:.3f}s; one MCP call', flush=True)

    def test_media_reads_omit_redundant_dom_and_replay_preserves_observation(self):
        self.ready()
        observed = self.execute(action=self.action('observe'))['result']
        self.assertTrue(observed['elements'])
        for element in observed['elements']:
            self.assertTrue(all(value is not None and value != '' for value in element.values()), element)
        self.assertTrue(any(element.get('id') == 'increment' and element.get('text') == 'Increment'
                            for element in observed['elements']))
        action = self.action('listMedia')
        result = self.execute(action=action)
        self.assertEqual('SUCCEEDED', result['status'])
        self.assertNotIn('observation', result['result'])
        self.assertIn('media', result['result'])
        self.assertEqual(result, self.execute(action=action))
        batch = self.execute(actions=[self.action('listMedia')])
        self.assertNotIn('observation', batch['operations'][0]['result'])
        explicit = self.action('listMedia', observeAfter=True)
        with_snapshot = self.execute(action=explicit)
        self.assertIn('observation', with_snapshot['result'])
        # Omitted options reuse the durable choice, including receipts made under older defaults.
        without_option = {key: value for key, value in explicit.items() if key != 'observeAfter'}
        self.assertEqual(with_snapshot, self.execute(action=without_option))
        error, refusal, _ = self.client.tool('browser.execute', {'taskId': self.task['id'],
            'action': {**explicit, 'observeAfter': False}})
        self.assertTrue(error, refusal)
        self.assertEqual('IDEMPOTENCY_CONFLICT', refusal['code'])

    def test_editable_target_is_observed_and_missing_input_fails_before_effect(self):
        self.ready()
        observed = self.execute(action=self.action('observe'))['result']
        editable = next((element for element in observed['elements']
                         if element.get('id') == 'message'), None)
        self.assertIsNotNone(editable, 'The model must see the actual editable element and tag')
        self.assertEqual('span', editable['tag'])
        self.assertEqual('textbox', editable['role'])
        self.assertTrue(editable['contentEditable'])
        for kind, arguments in [('fill', {'selector': 'div[contenteditable="true"]', 'text': 'test'}),
                                ('press', {'selector': '#missing-input', 'key': 'Enter'})]:
            action = self.action(kind, arguments)
            started = time.monotonic()
            receipt = self.execute(action=action)
            self.assertEqual('FAILED', receipt['status'], 'Read-only preflight cannot change the site')
            self.assertLess(time.monotonic() - started, 3, 'A missing input must fail without a 20s wait')
            self.assertEqual(receipt, self.execute(action=action))
            owner, task_id = self.tasks[-1]
            status, current = owner.api('/api/tasks/' + task_id)
            self.assertEqual(200, status, current)
            self.assertIsNone(current['request'])
        valid = self.execute(action=self.action('fill', {'selector': '#message', 'text': 'verified draft'}))
        self.assertEqual('SUCCEEDED', valid['status'])
        self.assertIn('verified draft', valid['result']['observation']['text'])

    def test_sequence_stops_on_refusal_and_never_repeats_completed_effects(self):
        self.ready()
        commands = [self.action('click', {'selector': '#increment'}),
                    self.action('fill', {'selector': '#password', 'text': 'synthetic-only'}),
                    self.action('click', {'selector': '#increment'})]
        result = self.execute(actions=commands)
        self.assertFalse(result['complete'])
        self.assertEqual(['SUCCEEDED', 'FAILED'], [item['status'] for item in result['operations']])
        self.assertEqual(commands[1]['operationId'], result['nextOperationId'])
        self.assertEqual(result, self.execute(actions=commands))
        error, refusal, _ = self.client.tool('operations.get', {'operationId': commands[2]['operationId']})
        self.assertTrue(error, refusal)
        self.assertEqual('NOT_FOUND', refusal['code'])
        self.assertIn('"counter":1', self.execute(action=self.action('observe'))['result']['text'])

    def test_wait_budget_returns_pending_and_sequence_continues_with_same_ids(self):
        self.ready()
        commands = [self.action('click', {'selector': '#delay'}),
                    self.action('waitFor', {'selector': '#delayed'}),
                    self.action('click', {'selector': '#increment'})]
        started = time.monotonic()
        result = self.execute(actions=commands)
        elapsed = time.monotonic() - started
        self.assertFalse(result['complete'])
        self.assertLess(elapsed, 10, 'Waiting must return before the delayed page is ready')
        self.assertEqual(2, len(result['operations']), result)
        self.assertIn(result['operations'][-1]['status'], ('ACCEPTED', 'DISPATCHED'))
        self.assertEqual(commands[1]['operationId'], result['nextOperationId'])
        self.assertEqual('SUCCEEDED', self.wait_operation(commands[1]['operationId'], self.client)['status'])
        continued = self.execute(actions=commands)
        self.assertTrue(continued['complete'], continued)
        self.assertIn('"counter":1', continued['operations'][-1]['result']['observation']['text'])

    def test_rejected_command_rolls_back_inline_step(self):
        self.ready()
        invalid = self.action('captureAudio', {'sourceId': str(uuid.uuid4())})
        error, refusal, _ = self.client.tool('browser.execute', {'taskId': self.task['id'], 'action': invalid})
        self.assertTrue(error, refusal)
        self.assertEqual('VALIDATION', refusal['code'])
        error, page, _ = self.client.tool('steps.list', {'taskId': self.task['id']})
        self.assertFalse(error, page)
        self.assertEqual(0, page['total'])
        for fields in ({'action': None}, {'actions': [None]}):
            error, refusal, _ = self.client.tool('browser.execute', {'taskId': self.task['id'], **fields})
            self.assertTrue(error, refusal)
            self.assertIn('object expected', str(refusal), 'The MCP schema rejects null before execution')

    def test_concurrent_replay_waits_for_one_effect_and_one_step(self):
        self.ready()
        action = self.action('click', {'selector': '#increment'})
        with ThreadPoolExecutor(max_workers=2) as executor:
            replies = list(executor.map(lambda _: self.execute(action=action), range(2)))
        self.assertEqual(replies[0], replies[1])
        self.assertEqual('SUCCEEDED', replies[0]['status'])
        self.assertIn('"counter":1', replies[0]['result']['observation']['text'])
        self.assertEqual(1, self.client.tool('steps.list', {'taskId': self.task['id']})[1]['total'])

    def test_unknown_effect_blocks_sequence_continuation_and_replay(self):
        self.ready()
        commands = [self.action('click', {'selector': '#increment'}),
                    self.action('click', {'selector': '#missing-effect'}),
                    self.action('click', {'selector': '#increment'})]
        pending = self.execute(actions=commands)
        self.assertFalse(pending['complete'])
        self.assertEqual(2, len(pending['operations']), pending)
        self.assertEqual('UNKNOWN', self.wait_operation(commands[1]['operationId'], self.client)['status'])
        repeated = self.execute(actions=commands)
        self.assertFalse(repeated['complete'])
        self.assertEqual(['SUCCEEDED', 'UNKNOWN'], [item['status'] for item in repeated['operations']])
        error, refusal, _ = self.client.tool('browser.execute', {
            'taskId': self.task['id'], 'action': commands[2]})
        self.assertTrue(error, refusal)
        self.assertEqual('UNKNOWN_RESULT', refusal['code'])
        self.assertIn('"counter":1', self.execute(action=self.action('observe'))['result']['text'])

    def test_slow_browser_does_not_hold_another_tasks_short_command(self):
        self.ready()
        slow_client, slow_task, slow_owner = self.client, self.task, self.identity
        slow_action = self.action('waitFor', {'selector': '#never-ready'})
        self.ready()
        with ThreadPoolExecutor(max_workers=1) as executor:
            slow = executor.submit(slow_client.tool, 'browser.execute', {
                'taskId': slow_task['id'], 'action': slow_action})
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                status = self.fixture_sql(slow_owner, "SELECT status FROM operations WHERE owner_id=:owner "
                    "AND id='" + slow_action['operationId'] + "';")
                if status == 'DISPATCHED':
                    break
                time.sleep(.1)
            self.assertEqual('DISPATCHED', status)
            started = time.monotonic()
            quick = self.execute(action=self.action('observe'))
            elapsed = time.monotonic() - started
            self.assertEqual('SUCCEEDED', quick['status'],
                'An independent browser must not queue behind another browser waiting on its site')
            self.assertLess(elapsed, 5)
            self.assertFalse(slow.result()[0])
            # Another command in the slow task must stay queued until its own wait finishes.
            next_action = {**slow_action, 'operationId': str(uuid.uuid4()), 'type': 'observe', 'arguments': {}}
            error, queued, _ = slow_client.tool('browser.execute', {
                'taskId': slow_task['id'], 'action': next_action})
            self.assertFalse(error, queued)
            self.assertEqual('ACCEPTED', queued['status'])
            self.assertEqual('FAILED', self.wait_operation(slow_action['operationId'], slow_client)['status'])
            self.assertEqual('SUCCEEDED', self.wait_operation(next_action['operationId'], slow_client)['status'])
            print(f'Independent short command while another browser waits: {elapsed:.3f}s', flush=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
