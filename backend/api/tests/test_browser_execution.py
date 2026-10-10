"""Browser execution round trips, partial sequences and replay against deployed dev."""
import json
from pathlib import Path
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
        html = (Path(__file__).parent / 'fixtures' / 'browser-execution.html').read_text(encoding='utf-8')
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

    def observation(self):
        result = self.execute(action=self.action('observe'))
        if result['status'] in ('ACCEPTED', 'DISPATCHED'):
            result = self.wait_operation(result['id'], self.client)
        self.assertEqual('SUCCEEDED', result['status'], result)
        return result['result']

    def target(self, observation, name, role=None):
        matches = [entry['node'] for entry in observation['snapshot']
                   if isinstance(entry['node'], dict) and entry['node'].get('name') == name
                   and (role is None or entry['node']['role'] == role) and entry['node'].get('ref')]
        self.assertEqual(1, len(matches), (name, observation))
        return {'observationId': observation['observationId'], 'ref': matches[0]['ref']}

    def click(self, name):
        return self.execute(action=self.action('click', self.target(self.observation(), name)))

    def runtime_resources(self):
        browser_id = str(uuid.UUID(self.task['browser']['id']))
        script = r'''
import {readdir, readFile, stat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
let rssKiB;
for (const pid of await readdir('/proc')) {
  if (!/^\d+$/.test(pid)) continue;
  try {
    const command = (await readFile('/proc/'+pid+'/cmdline','utf8')).split('\0');
    if (command[1] !== '/app/dist/server.js') continue;
    rssKiB = Number((await readFile('/proc/'+pid+'/status','utf8')).match(/^VmRSS:\s+(\d+)/m)[1]);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const db = new DatabaseSync('/data/session.sqlite',{readOnly:true});
let leaked = false;
for (const row of db.prepare('SELECT result FROM operations LIMIT 100').all()) {
  if (/private-(password|code|card|hidden|service|url|query|fragment)/.test(row.result ?? '')) leaked = true;
}
db.close();
let files = 0;
try { for (const file of await readdir('/tmp/helm-mcp')) if ((await stat('/tmp/helm-mcp/'+file)).isFile()) files++; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log(JSON.stringify({rssKiB, leaked, files}));
'''
        result = subprocess.run(self.docker + ['exec', '-i', 'helm-browser-' + browser_id,
            'node', '--input-type=module'], input=script, text=True, capture_output=True, timeout=20)
        self.assertEqual(0, result.returncode, result.stderr)
        values = json.loads(result.stdout)
        self.assertGreater(values['rssKiB'], 0)
        self.assertFalse(values['leaked'], 'Receipts must never retain synthetic sensitive values')
        self.assertEqual(0, values['files'], 'MCP diagnostics must not write site data to files')
        return values

    def test_short_results_inline_step_and_sequence_replay(self):
        self.ready()
        observed = self.observation()
        commands = [self.action('fill', {**self.target(observed, 'Recipient'), 'text': 'synthetic-value'}),
                    self.action('click', self.target(observed, 'Increment')),
                    self.action('click', self.target(observed, 'Read state'))]
        started = time.monotonic()
        result = self.execute(actions=commands)
        self.assertTrue(result['complete'], result)
        self.assertEqual(['SUCCEEDED'] * 3, [item['status'] for item in result['operations']])
        for item in result['operations'][:-1]:
            self.assertNotIn('observation', item['result'])
        final = result['operations'][-1]['result']['observation']
        self.assertIn('"counter":1', str(final))
        self.assertIn('"text":"synthetic-value"', str(final))
        self.assertEqual(4, final['metrics']['snapshots'] - observed['metrics']['snapshots'],
                         'One bounded native preflight per action and one final observation')
        self.assertEqual(result, self.execute(actions=commands))
        self.assertIn('"counter":1', str(self.observation()))
        conflict = {**commands[0], 'arguments': {**commands[0]['arguments'], 'text': 'different'}}
        error, refusal, _ = self.client.tool('browser.execute', {
            'taskId': self.task['id'], 'actions': [conflict, *commands[1:]]})
        self.assertTrue(error, refusal)
        self.assertEqual('IDEMPOTENCY_CONFLICT', refusal['code'])
        print(f'Three actions + final snapshot: {time.monotonic()-started:.3f}s', flush=True)

    def test_media_reads_omit_redundant_dom_and_replay_preserves_observation(self):
        self.ready()
        self.assertTrue(self.observation()['snapshot'])
        action = self.action('listMedia')
        result = self.execute(action=action)
        self.assertEqual('SUCCEEDED', result['status'])
        self.assertNotIn('observation', result['result'])
        self.assertIn('media', result['result'])
        self.assertEqual(result, self.execute(action=action))
        explicit = self.action('listMedia', observeAfter=True)
        with_snapshot = self.execute(action=explicit)
        self.assertIn('observation', with_snapshot['result'])
        without_option = {key: value for key, value in explicit.items() if key != 'observeAfter'}
        self.assertEqual(with_snapshot, self.execute(action=without_option))
        error, refusal, _ = self.client.tool('browser.execute', {'taskId': self.task['id'],
            'action': {**explicit, 'observeAfter': False}})
        self.assertTrue(error, refusal)
        self.assertEqual('IDEMPOTENCY_CONFLICT', refusal['code'])

    def test_native_references_survive_media_reads_in_the_accepted_sequence(self):
        self.ready()
        observed = self.observation()
        commands = [self.action('listMedia'),
                    self.action('fill', {**self.target(observed, 'Recipient'), 'text': 'mixed sequence'}),
                    self.action('listMedia'),
                    self.action('click', self.target(observed, 'Read state'))]
        result = self.execute(actions=commands)
        self.assertTrue(result['complete'], result)
        self.assertEqual(['SUCCEEDED'] * 4, [item['status'] for item in result['operations']])
        final = result['operations'][-1]['result']['observation']
        self.assertIn('"text":"mixed sequence"', str(final))
        self.assertEqual(3, final['metrics']['snapshots'] - observed['metrics']['snapshots'])
        self.assertEqual(result, self.execute(actions=commands))

    def test_unissued_and_replaced_refs_fail_before_effect(self):
        self.ready()
        observed = self.observation()
        for kind, values in [('fill', {'text': 'test'}), ('press', {'key': 'Enter'})]:
            action = self.action(kind, {'observationId': observed['observationId'], 'ref': 'e999999', **values})
            receipt = self.execute(action=action)
            self.assertEqual('FAILED', receipt['status'])
            self.assertEqual(receipt, self.execute(action=action))
        changed = self.execute(actions=[self.action('click', self.target(observed, 'Replace target')),
                         self.action('click', self.target(observed, 'Increment'))])
        self.assertEqual(['SUCCEEDED', 'FAILED'], [item['status'] for item in changed['operations']])
        self.assertIn('"counter":0', str(self.observation()))
        filled = self.execute(action=self.action('fill', {**self.target(self.observation(), 'Message'), 'text': 'verified draft'}))
        self.assertEqual('SUCCEEDED', filled['status'])
        self.assertIn('verified draft', str(filled['result']['observation']))

    def test_native_form_states_and_sensitive_values(self):
        self.ready()
        observed = self.observation()
        nodes = [entry['node'] for entry in observed['snapshot'] if isinstance(entry['node'], dict)]
        by_name = {node.get('name'): node for node in nodes}
        self.assertEqual('combobox', by_name['City']['role'])
        self.assertTrue(by_name['Kazan']['selected'])
        self.assertTrue(by_name['Notifications']['checked'])
        self.assertFalse(by_name['Checked data'].get('checked', False))
        self.assertEqual('Existing comment', by_name['Comment']['text'])
        self.assertNotIn('private-', str(observed))
        self.assertEqual('https://example.com/path', by_name['Safe link']['url'])
        for name in ('Code', 'Number', 'One-time code', 'Card number'):
            refused = self.execute(action=self.action('fill', {
                **self.target(observed, name), 'text': 'synthetic-rejected-value'}))
            self.assertEqual('FAILED', refused['status'])
        changed = self.execute(actions=[
            self.action('fill', {**self.target(observed, 'Recipient'), 'text': 'Synthetic recipient'}),
            self.action('selectOption', {**self.target(observed, 'City'), 'values': ['Perm']}),
            self.action('check', {**self.target(observed, 'Notifications'), 'checked': False})])
        self.assertTrue(changed['complete'], changed)
        nodes = {entry['node'].get('name'): entry['node'] for entry in changed['operations'][-1]['result']['observation']['snapshot'] if isinstance(entry['node'], dict)}
        self.assertTrue(nodes['Perm']['selected'])
        self.assertFalse(nodes['Notifications'].get('checked', False))
        self.runtime_resources()

    def test_sequence_stops_on_private_refusal_and_never_repeats_completed_effects(self):
        self.ready()
        observed = self.observation()
        commands = [self.action('click', self.target(observed, 'Increment')),
                    self.action('fill', {**self.target(observed, 'OTP'), 'text': 'synthetic-only'}),
                    self.action('click', self.target(observed, 'Increment'))]
        result = self.execute(actions=commands)
        self.assertFalse(result['complete'])
        self.assertEqual(['SUCCEEDED', 'FAILED'], [item['status'] for item in result['operations']])
        self.assertEqual(result, self.execute(actions=commands))
        self.assertIn('"counter":1', str(self.observation()))

    def test_pagination_is_bounded_and_keeps_original_timestamp(self):
        self.ready()
        result = self.click('Large form')
        self.assertEqual('SUCCEEDED', result['status'])
        observed = result['result']['observation']
        self.assertFalse(observed['complete'])
        self.assertLessEqual(len(observed['snapshot']), 200)
        self.assertLessEqual(len(json.dumps(observed, ensure_ascii=False).encode()), 32768)
        continued = self.execute(action=self.action('observe', {'cursor': observed['cursor']}))['result']
        self.assertEqual(observed['observedAt'], continued['observedAt'])
        self.assertEqual(observed['metrics']['snapshots'], continued['metrics']['snapshots'])
        self.assertEqual(observed['observationId'], continued['observationId'])
        self.observation()
        expired = self.execute(action=self.action('observe', {'cursor': observed['cursor']}))
        self.assertEqual('FAILED', expired['status'])

    def test_capture_limits_do_not_change_successful_action_receipt(self):
        self.ready()
        self.observation()
        memory = [self.runtime_resources()['rssKiB']]
        for name in ('Huge text', 'Deep tree', 'Many frames', 'Unavailable frame'):
            with self.subTest(name=name):
                reset = self.execute(action=self.action('navigate', {'url': self.fixture_url}))
                if reset['status'] in ('ACCEPTED', 'DISPATCHED'):
                    reset = self.wait_operation(reset['id'], self.client)
                self.assertEqual('SUCCEEDED', reset['status'], reset)
                result = self.click(name)
                if result['status'] in ('ACCEPTED', 'DISPATCHED'):
                    result = self.wait_operation(result['id'], self.client)
                self.assertEqual('SUCCEEDED', result['status'], result)
                expected = ('OBSERVATION_UNAVAILABLE' if name == 'Unavailable frame'
                            else 'OBSERVATION_LIMIT_EXCEEDED')
                self.assertEqual(expected, result['result'].get('observationError'))
                self.assertNotIn('observation', result['result'])
                if name == 'Huge text':
                    refused = self.execute(action=self.action('observe'))
                    self.assertEqual('FAILED', refused['status'], refused)
                    self.assertEqual('OBSERVATION_LIMIT_EXCEEDED', refused['errorCode'])
                memory.append(self.runtime_resources()['rssKiB'])
        print('Node RSS before/after bounded rejections (KiB): ' + str(memory), flush=True)

    def test_iframe_conditional_fields_popup_and_navigation_revoke_refs(self):
        self.ready()
        observed = self.observation()
        frame_target = self.target(observed, 'Frame value')
        self.assertTrue(frame_target['ref'].startswith('f'))
        result = self.execute(action=self.action('fill', {**frame_target, 'text': 'frame answer'}))
        self.assertIn('frame answer', str(result['result']['observation']))
        result = self.click('Show conditional')
        target = self.target(result['result']['observation'], 'Conditional')
        self.assertEqual('SUCCEEDED', self.execute(action=self.action('fill', {**target, 'text': 'conditional answer'}))['status'])
        previous = self.observation()
        result = self.click('Popup')
        self.assertEqual(2, len(result['result']['observation']['tabs']))
        refused = self.execute(action=self.action('click', self.target(previous, 'Increment')))
        self.assertEqual('FAILED', refused['status'])
        previous = self.observation()
        self.execute(action=self.action('reload'))
        self.assertEqual('FAILED', self.execute(action=self.action('click', self.target(previous, 'Increment')))['status'])

    def test_wait_budget_continues_exact_sequence(self):
        self.ready()
        observed = self.observation()
        commands = [self.action('click', self.target(observed, 'Delay')),
                    self.action('waitFor', {**self.target(observed, 'Delayed target'), 'state': 'hidden'}),
                    self.action('click', self.target(observed, 'Increment'))]
        result = self.execute(actions=commands)
        self.assertFalse(result['complete'])
        self.assertIn(result['operations'][-1]['status'], ('ACCEPTED', 'DISPATCHED'))
        self.assertEqual('SUCCEEDED', self.wait_operation(commands[1]['operationId'], self.client)['status'])
        continued = self.execute(actions=commands)
        self.assertTrue(continued['complete'], continued)
        self.assertIn('"counter":1', str(continued['operations'][-1]['result']['observation']))

    def test_concurrent_duplicate_has_one_effect(self):
        self.ready()
        action = self.action('click', self.target(self.observation(), 'Increment'))
        with ThreadPoolExecutor(max_workers=2) as executor:
            replies = list(executor.map(lambda _: self.execute(action=action), range(2)))
        self.assertEqual(replies[0], replies[1])
        self.assertEqual('SUCCEEDED', replies[0]['status'])
        self.assertIn('"counter":1', str(replies[0]['result']['observation']))

    def test_unknown_after_possible_effect_is_not_replayed(self):
        self.ready()
        action = self.action('click', self.target(self.observation(), 'Slow effect'))
        result = self.execute(action=action)
        if result['status'] in ('ACCEPTED', 'DISPATCHED'):
            result = self.wait_operation(action['operationId'], self.client)
        self.assertEqual('UNKNOWN', result['status'], result)
        self.assertEqual(result, self.execute(action=action))
        self.assertIn('"counter":1', str(self.observation()))
        error, refusal, _ = self.client.tool('browser.execute', {'taskId': self.task['id'],
            'action': self.action('click', self.target(self.observation(), 'Increment'))})
        self.assertTrue(error, refusal)
        self.assertEqual('UNKNOWN_RESULT', refusal['code'])

    def test_rejected_command_rolls_back_inline_step(self):
        self.ready()
        invalid = self.action('captureAudio', {'sourceId': str(uuid.uuid4())})
        error, refusal, _ = self.client.tool('browser.execute', {'taskId': self.task['id'], 'action': invalid})
        self.assertTrue(error, refusal)
        self.assertEqual('VALIDATION', refusal['code'])
        error, page, _ = self.client.tool('steps.list', {'taskId': self.task['id']})
        self.assertFalse(error, page)
        self.assertEqual(0, page['total'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
