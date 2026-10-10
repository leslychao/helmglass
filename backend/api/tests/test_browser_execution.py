"""Browser execution round trips, partial sequences and replay against deployed dev."""
import json
from array import array
import io
import math
from pathlib import Path
import subprocess
from concurrent.futures import ThreadPoolExecutor
import time
import unittest
import uuid
import wave

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
        cls.audio_fixture_path = cls.fixture_path.removesuffix('.html') + '.wav'
        cls.write_audio_fixture(.1)
        html = html.replace('AUDIO_FIXTURE_URL', cls.audio_fixture_path.rsplit('/', 1)[1])
        subprocess.run(cls.docker + ['exec', '-i', '-u', '0', 'helmglass-frontend-1',
            'sh', '-c', 'cat > ' + cls.fixture_path], input=html, text=True,
            capture_output=True, check=True, timeout=20)

    @classmethod
    def remove_fixture(cls):
        subprocess.run(cls.docker + ['exec', '-u', '0', 'helmglass-frontend-1',
            'rm', '-f', cls.fixture_path, cls.audio_fixture_path],
            check=True, capture_output=True, timeout=20)

    @classmethod
    def write_audio_fixture(cls, amplitude):
        output = io.BytesIO()
        with wave.open(output, 'wb') as audio:
            audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            audio.writeframes(array('h', (round(amplitude * 32767 * math.sin(
                2 * math.pi * 220 * sample / 16000)) for sample in range(16000))).tobytes())
        subprocess.run(cls.docker + ['exec', '-i', '-u', '0', 'helmglass-frontend-1',
            'sh', '-c', 'cat > ' + cls.audio_fixture_path], input=output.getvalue(),
            capture_output=True, check=True, timeout=20)

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
                'controlEpoch': self.task['browser']['controlEpoch'], **fields}

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
import {readdir, readFile} from 'node:fs/promises';
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
console.log(JSON.stringify({rssKiB, leaked}));
'''
        result = subprocess.run(self.docker + ['exec', '-i', 'helm-browser-' + browser_id,
            'node', '--input-type=module'], input=script, text=True, capture_output=True, timeout=20)
        self.assertEqual(0, result.returncode, result.stderr)
        values = json.loads(result.stdout)
        self.assertGreater(values['rssKiB'], 0)
        self.assertFalse(values['leaked'], 'Receipts must never retain synthetic sensitive values')
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
        self.assertEqual(1, final['metrics']['snapshots'] - observed['metrics']['snapshots'],
                         'Native actions retain references until the final observation')
        self.assertEqual(result, self.execute(actions=commands))
        self.assertIn('"counter":1', str(self.observation()))
        conflict = {**commands[0], 'arguments': {**commands[0]['arguments'], 'text': 'different'}}
        error, refusal, _ = self.client.tool('browser.execute', {
            'taskId': self.task['id'], 'actions': [conflict, *commands[1:]]})
        self.assertTrue(error, refusal)
        self.assertEqual('IDEMPOTENCY_CONFLICT', refusal['code'])
        print(f'Sequence, replay and conflict checks: {time.monotonic()-started:.3f}s', flush=True)

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

    def test_whole_known_form_is_one_batch_with_one_final_observation(self):
        self.ready()
        observed = self.observation()
        commands = [self.action('fill', {**self.target(observed, 'Batch field ' + str(index)),
                    'text': 'value-' + str(index)}) for index in range(1, 11)]
        result = self.execute(actions=commands)
        self.assertTrue(result['complete'], result)
        self.assertEqual(['SUCCEEDED'] * 10, [item['status'] for item in result['operations']])
        self.assertTrue(all('observation' not in item['result']
                            for item in result['operations'][:-1]))
        final = result['operations'][-1]['result']['observation']
        self.assertEqual(1, final['metrics']['snapshots'] - observed['metrics']['snapshots'])
        for index in range(1, 11):
            self.assertIn('value-' + str(index), str(final))
        self.assertEqual(result, self.execute(actions=commands))
        oversized = self.action('fill', {**self.target(final, 'Batch field 1'),
                                        'text': '\U0001f642' * 17_000})
        error, refusal, _ = self.client.tool('browser.execute', {
            'taskId': self.task['id'], 'action': oversized})
        self.assertTrue(error, refusal)
        self.assertEqual('VALIDATION', refusal['code'])
        print('Ten form fields: one MCP call and one final observation', flush=True)

    def test_screenshot_inside_a_batch_delivers_the_image_inline(self):
        self.ready()
        error, result, receipt = self.client.tool('browser.execute', {
            'taskId': self.task['id'], 'actions': [self.action('screenshot')]})
        self.assertFalse(error, result)
        self.assertTrue(result['complete'], result)
        self.assertEqual('READY', result['operations'][0]['result']['imageDelivery'])
        self.assertEqual(1, sum(item['type'] == 'image' for item in receipt['content']))
        print('A batch screenshot delivered its target and image in one MCP call', flush=True)

    def test_audio_reuse_checks_bytes_instruction_context_and_processing_version(self):
        self.ready()
        inventory = self.execute(action=self.action('listMedia'))['result']
        source_id = next(item['sourceId'] for item in inventory['sources']
                         if item['label'] == 'Original audio')
        source = next(item for item in inventory['media'] if item['id'] == source_id)
        context = {'assignmentId': 'audio-reuse-fixture', 'instruction': 'Compare the whole audio.',
                   'questions': ['How loud is this recording?']}

        def capture(label, source_context):
            return self.execute(action=self.action('captureAudio', {
                'sourceId': source['id'], 'sourceRef': label,
                'sourceContext': source_context}))['result']

        first = capture('first display', context)
        second = capture('second display', dict(reversed(list(context.items()))))
        self.assertEqual(first['artifact']['id'], second['artifact']['id'])
        self.assertEqual('second display', second['sourceRef'])
        error, analysis, _ = self.client.tool('audio.analyze', {
            'artifactId': first['artifact']['id'], 'mode': 'full'})
        self.assertFalse(error, analysis)
        self.assertEqual('SUCCEEDED', analysis['status'], analysis)
        error, reused, _ = self.client.tool('audio.analyze', {
            'artifactId': second['artifact']['id'], 'mode': 'full'})
        self.assertFalse(error, reused)
        self.assertEqual(analysis['analysisId'], reused['analysisId'])
        self.assertEqual(analysis['processingVersion'], reused['processingVersion'])
        changed_context = capture('different question', {**context,
            'questions': ['What is its pitch?']})
        self.assertNotEqual(first['artifact']['id'], changed_context['artifact']['id'])
        self.write_audio_fixture(.3)
        changed_bytes = capture('updated HTTP source', context)
        self.assertNotEqual(first['artifact']['id'], changed_bytes['artifact']['id'])
        self.assertNotEqual(first['artifact']['sha256'], changed_bytes['artifact']['sha256'])
        print('Same bytes/context reuse the saved original and analysis; changed inputs do not', flush=True)

    def test_iframe_audio_plays_fully_without_images_or_coordinate_clicks(self):
        self.ready()
        observed = self.observation()
        self.assertFalse(any(isinstance(entry['node'], dict)
            and entry['node']['role'] == 'button' and 'play' in entry['node'].get('name', '').lower()
            for entry in observed['snapshot']))
        inventory = self.execute(action=self.action('listMedia'))['result']
        source_id = next(item['sourceId'] for item in inventory['sources']
                         if item['label'] == 'Iframe audio')
        action = self.action('playMedia', {'sourceId': source_id})
        started = time.monotonic()
        error, completed, receipt = self.client.tool('browser.execute', {
            'taskId': self.task['id'], 'action': action})
        self.assertFalse(error, completed)
        self.assertEqual('SUCCEEDED', completed['status'], completed)
        playback = completed['result']['playback']
        self.assertTrue(playback['ended'])
        self.assertTrue(playback['fullyPlayed'])
        self.assertEqual(1, playback['duration'])
        self.assertEqual(1, playback['currentTime'])
        self.assertGreaterEqual(time.monotonic() - started, .9)
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(all(item['type'] == 'text' for item in receipt['content']))
        self.assertEqual(completed, self.execute(action=action))
        final = self.observation()
        self.assertIn('Listened fully:1', str(final))
        self.assertIn('Original fully:0', str(final))
        self.assertEqual(1, final['metrics']['snapshots'] - observed['metrics']['snapshots'])
        refused = self.execute(action=self.action('playMedia', {'sourceId': str(uuid.uuid4())}))
        self.assertEqual('FAILED', refused['status'], refused)
        print('Iframe audio reached its real end in one text-only MCP call; replay had no second effect', flush=True)

    def test_explicit_time_wait_returns_the_final_result_in_one_call(self):
        self.ready()
        started = time.monotonic()
        result = self.execute(action=self.action('waitFor', {'time': 9}))
        self.assertEqual('SUCCEEDED', result['status'], result)
        self.assertIn('observation', result['result'])
        self.assertGreaterEqual(time.monotonic() - started, 9)
        self.assertLess(time.monotonic() - started, 18)
        print('Nine-second wait returned its final observation in one MCP call', flush=True)

    def test_operation_read_waits_for_the_pending_result(self):
        self.ready()
        action = self.action('waitFor', {'time': 10})
        with ThreadPoolExecutor(max_workers=1) as executor:
            execution = executor.submit(self.execute, action=action)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                status = self.fixture_sql(self.identity,
                    "SELECT status FROM operations WHERE owner_id=:owner AND id='"
                    + action['operationId'] + "'").strip()
                if status == 'DISPATCHED':
                    break
                time.sleep(.1)
            self.assertEqual('DISPATCHED', status)
            started = time.monotonic()
            error, completed, _ = self.client.tool('operations.get', {
                'operationId': action['operationId']})
            self.assertEqual(completed, execution.result(timeout=15))
        self.assertFalse(error, completed)
        self.assertEqual('SUCCEEDED', completed['status'], completed)
        self.assertIn('observation', completed['result'])
        self.assertGreater(time.monotonic() - started, 1)
        self.assertLess(time.monotonic() - started, 12)
        ready_started = time.monotonic()
        self.assertEqual(completed, self.client.tool('operations.get', {
            'operationId': action['operationId']})[1])
        self.assertLess(time.monotonic() - ready_started, 2)
        print('One operation read waited for completion; a ready receipt returned immediately', flush=True)

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
        self.assertEqual(1, final['metrics']['snapshots'] - observed['metrics']['snapshots'])
        self.assertEqual(result, self.execute(actions=commands))

    def test_unissued_and_replaced_refs_fail_before_effect(self):
        self.ready()
        observed = self.observation()
        for kind, values in [('fill', {'text': 'test'})]:
            action = self.action(kind, {'observationId': observed['observationId'], 'ref': 'e999999', **values})
            receipt = self.execute(action=action)
            self.assertEqual('FAILED', receipt['status'])
            self.assertEqual(receipt, self.execute(action=action))
        commands = [self.action('click', self.target(observed, 'Replace target')),
                    self.action('click', self.target(observed, 'Increment'))]
        changed = self.execute(actions=commands)
        if changed['operations'][-1]['status'] in ('ACCEPTED', 'DISPATCHED'):
            self.wait_operation(commands[-1]['operationId'], self.client)
            changed = self.execute(actions=commands)
        self.assertEqual(['SUCCEEDED', 'FAILED'], [item['status'] for item in changed['operations']])
        self.assertIn('"counter":0', str(self.observation()))
        filled = self.execute(action=self.action('fill', {**self.target(self.observation(), 'Message'), 'text': 'verified draft'}))
        self.assertEqual('SUCCEEDED', filled['status'])
        read = self.click('Read state')
        self.assertIn('verified draft', str(read['result']['observation']))

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

    def test_keyboard_focus_scroll_and_native_screenshot(self):
        self.ready()
        self.assertEqual('SUCCEEDED', self.click('Focus recipient')['status'])
        for key in ('a', 'b'):
            self.assertEqual('SUCCEEDED', self.execute(action=self.action('press', {'key': key}))['status'])
        self.assertIn('"text":"ab"', str(self.click('Read state')['result']['observation']))
        self.assertEqual('SUCCEEDED', self.click('Focus private code')['status'])
        refused = self.execute(action=self.action('press', {'key': 'c'}))
        self.assertEqual('FAILED', refused['status'])
        self.assertEqual('SUCCEEDED', self.execute(action=self.action('scroll', {'y': 500}))['status'])
        shot = self.action('screenshot')
        started = time.monotonic()
        error, result, receipt = self.client.tool('browser.execute', {
            'taskId': self.task['id'], 'action': shot})
        screenshot_elapsed = time.monotonic() - started
        self.assertFalse(error, result)
        self.assertEqual('SUCCEEDED', result['status'], result)
        self.assertTrue(any(item['type'] == 'image' for item in receipt['content']),
                        'A ready screenshot must be delivered in the original MCP call')
        self.assertEqual('READY', result['result']['imageDelivery'])
        target = result['result']['screenshotTarget']
        self.assertEqual(shot['operationId'], target['screenshotId'])
        self.assertGreater(target['width'], 0)
        self.assertGreater(target['height'], 0)
        image = next(item for item in receipt['content'] if item['type'] == 'image')
        self.assertEqual('image/png', image['mimeType'])
        self.assertTrue(image['data'])
        self.assertNotIn('/tmp/helm-mcp', str(result))
        repeated = self.execute(action=shot)
        self.assertEqual('SUCCEEDED', repeated['status'])
        self.assertEqual(shot['operationId'], repeated.get('id', repeated.get('operationId')))
        self.assertEqual(target, repeated['result']['screenshotTarget'])
        self.fixture_sql(self.identity, "UPDATE artifacts SET status='UPLOADING' "
            "WHERE owner_id=:owner AND operation_id='" + shot['operationId'] + "';")
        try:
            started = time.monotonic()
            error, pending, pending_receipt = self.client.tool('operations.get', {
                'operationId': shot['operationId']})
            self.assertFalse(error, pending)
            self.assertLess(time.monotonic() - started, 10, 'Delivery exceeded its response budget')
            self.assertEqual('PENDING', pending['result']['imageDelivery'])
            self.assertFalse(any(item['type'] == 'image' for item in pending_receipt['content']))
        finally:
            self.fixture_sql(self.identity, "UPDATE artifacts SET status='READY' "
                "WHERE owner_id=:owner AND operation_id='" + shot['operationId'] + "';")
        error, delivered, delivered_receipt = self.client.tool('operations.get', {
            'operationId': shot['operationId']})
        self.assertFalse(error, delivered)
        self.assertEqual('READY', delivered['result']['imageDelivery'])
        self.assertEqual(target, delivered['result']['screenshotTarget'])
        self.assertEqual(image, next(item for item in delivered_receipt['content']
                                    if item['type'] == 'image'))
        script = "import {existsSync} from 'node:fs'; console.log(existsSync('/tmp/helm-mcp/screenshot-" + shot['operationId'] + ".png'));"
        checked = subprocess.run(self.docker + ['exec', '-i', 'helm-browser-' + self.task['browser']['id'],
            'node', '--input-type=module'], input=script, text=True, capture_output=True, check=True, timeout=20)
        self.assertEqual('false', checked.stdout.strip())
        print(f'Screenshot returned inline in {screenshot_elapsed:.3f}s; bounded pending delivery '
              'and recovery used the same operation and image', flush=True)

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
        previous = self.observation()
        previous_tail = self.target(previous, 'Save delayed')
        result = self.click('Large form')
        self.assertEqual('SUCCEEDED', result['status'])
        observed = result['result']['observation']
        self.assertFalse(observed['complete'])
        self.assertLessEqual(len(observed['snapshot']), 200)
        self.assertLessEqual(len(json.dumps(observed, ensure_ascii=False).encode()), 32768)
        unissued = self.execute(action=self.action('click', {
            **previous_tail, 'observationId': observed['observationId']}))
        self.assertEqual('FAILED', unissued['status'])
        self.assertEqual('OBSERVATION_REFERENCE_NOT_ISSUED', unissued['errorCode'])
        continued = self.execute(action=self.action('observe', {'cursor': observed['cursor']}))['result']
        self.assertEqual(observed['observedAt'], continued['observedAt'])
        self.assertEqual(observed['metrics']['snapshots'], continued['metrics']['snapshots'])
        self.assertEqual(observed['observationId'], continued['observationId'])
        self.observation()
        expired = self.execute(action=self.action('observe', {'cursor': observed['cursor']}))
        self.assertEqual('FAILED', expired['status'])
        self.assertEqual('OBSERVATION_CURSOR_EXPIRED', expired['errorCode'])

    def test_capture_limits_do_not_change_successful_action_receipt(self):
        self.ready()
        self.observation()
        memory = [self.runtime_resources()['rssKiB']]
        for name in ('Huge text',):
            with self.subTest(name=name):
                reset = self.execute(action=self.action('navigate', {'url': self.fixture_url}))
                if reset['status'] in ('ACCEPTED', 'DISPATCHED'):
                    reset = self.wait_operation(reset['id'], self.client)
                self.assertEqual('SUCCEEDED', reset['status'], reset)
                result = self.click(name)
                if result['status'] in ('ACCEPTED', 'DISPATCHED'):
                    result = self.wait_operation(result['id'], self.client)
                self.assertEqual('SUCCEEDED', result['status'], result)
                self.assertEqual('OBSERVATION_LIMIT_EXCEEDED', result['result'].get('observationError'))
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
        self.execute(action=self.action('navigate', {'url': self.fixture_url}))
        self.assertEqual('FAILED', self.execute(action=self.action('click', self.target(previous, 'Increment')))['status'])

    def test_delayed_sequence_finishes_in_one_call_without_repeating_effects(self):
        self.ready()
        observed = self.observation()
        commands = [self.action('click', self.target(observed, 'Delay')),
                    self.action('waitFor', {'textGone': 'Delayed target'}),
                    self.action('click', self.target(observed, 'Increment'))]
        result = self.execute(actions=commands)
        self.assertTrue(result['complete'], result)
        self.assertEqual(['SUCCEEDED'] * 3, [item['status'] for item in result['operations']])
        self.assertIn('"counter":1', str(result['operations'][-1]['result']['observation']))
        self.assertEqual(result, self.execute(actions=commands))

    def test_transport_deadline_continues_the_exact_sequence(self):
        self.ready()
        observed = self.observation()
        commands = [self.action('click', self.target(observed, 'Increment')),
                    self.action('waitFor', {'time': 30}),
                    self.action('waitFor', {'time': 25}),
                    self.action('click', self.target(observed, 'Read state'))]
        result = self.execute(actions=commands)
        self.assertFalse(result['complete'], result)
        self.assertEqual(commands[2]['operationId'], result['nextOperationId'])
        self.assertEqual(['SUCCEEDED', 'SUCCEEDED', 'DISPATCHED'],
                         [item['status'] for item in result['operations']])
        self.assertEqual('SUCCEEDED', self.client.tool('operations.get', {
            'operationId': commands[2]['operationId']})[1]['status'])
        continued = self.execute(actions=commands)
        self.assertTrue(continued['complete'], continued)
        self.assertIn('"counter":1', str(continued['operations'][-1]['result']['observation']))
        self.assertEqual(continued, self.execute(actions=commands))

    def test_native_text_wait_and_scoped_observation_replay_without_second_effect(self):
        self.ready()
        observed = self.observation()
        commands = [self.action('click', self.target(observed, 'Save delayed')),
                    self.action('waitFor', {'text': 'Saved 1'})]
        result = self.execute(actions=commands)
        self.assertTrue(result['complete'], result)
        self.assertEqual(['SUCCEEDED', 'SUCCEEDED'], [item['status'] for item in result['operations']])
        final = result['operations'][-1]['result']['observation']
        self.assertEqual('page', final['scope']['type'])
        self.assertIn('Saved 1', str(final['snapshot']))
        self.assertIn('Recipient', str(final['snapshot']))
        self.assertEqual(observed['metrics']['fullSnapshots'] + 1, final['metrics']['fullSnapshots'])
        self.assertEqual(result, self.execute(actions=commands))
        # A later retry cannot change the accepted sequence identity.
        error, conflict, _ = self.client.tool('browser.execute', {'taskId': self.task['id'], 'action': commands[0]})
        self.assertTrue(error, conflict)
        self.assertEqual('IDEMPOTENCY_CONFLICT', conflict['code'])
        observed = self.observation()
        scoped = [self.action('click', self.target(observed, 'Read state')),
                  self.action('observe', self.target(observed, 'Async result'))]
        final_batch = self.execute(actions=scoped)
        self.assertTrue(final_batch['complete'], final_batch)
        region = final_batch['operations'][-1]['result']
        self.assertEqual('region', region['scope']['type'])
        self.assertIn('Saved 1', str(region['snapshot']))
        self.assertLess(len(json.dumps(region)), len(json.dumps(observed)))
        print(json.dumps({'pageObservationBytes': len(json.dumps(observed, ensure_ascii=False, separators=(',', ':')).encode()),
                          'regionObservationBytes': len(json.dumps(region, ensure_ascii=False, separators=(',', ':')).encode()),
                          'regionMetrics': region['metrics']}))

    def test_text_wait_timeout_preserves_success_and_rejects_invalid_combinations(self):
        self.ready()
        observed = self.observation()
        for kind, arguments in [
            ('observe', {**self.target(observed, 'Async result'), 'cursor': 'conflict'}),
            ('press', {**self.target(observed, 'Recipient'), 'key': 'Enter'}),
            ('waitFor', {'text': 'x' * 1001}), ('waitFor', {})]:
            error, refusal, _ = self.client.tool('browser.execute', {'taskId': self.task['id'],
                'action': self.action(kind, arguments)})
            self.assertTrue(error, refusal)
            self.assertEqual('VALIDATION', refusal['code'])
        for arguments in ({'state': 'visible', 'text': 'Saved'}, {'time': 31}, {'time': 0}):
            refusal = self.client.rpc('tools/call', {'name': 'browser.execute', 'arguments': {
                'callId': str(uuid.uuid4()), 'stepTitle': 'Дождаться появления результата задания',
                'taskId': self.task['id'], 'action': self.action('waitFor', arguments)}})
            self.assertTrue(refusal['isError'], refusal)
        missing_arguments = self.action('observe')
        missing_arguments['arguments'] = None
        # Null is rejected by the published object schema before Helm's handler.
        refusal = self.client.rpc('tools/call', {'name': 'browser.execute', 'arguments': {
            'callId': str(uuid.uuid4()), 'stepTitle': 'Прочитать страницу тестового задания',
            'taskId': self.task['id'], 'actions': [missing_arguments]}})
        self.assertTrue(refusal['isError'], refusal)
        self.assertIn('/actions/0/arguments', refusal['content'][0]['text'])
        commands = [self.action('click', self.target(observed, 'Save delayed')),
                    self.action('waitFor', {'text': 'Never appears'})]
        pending = self.execute(actions=commands)
        self.assertFalse(pending['complete'])
        self.assertEqual('SUCCEEDED', pending['operations'][0]['status'])
        failed = self.wait_operation(commands[1]['operationId'], self.client)
        self.assertEqual('FAILED', failed['status'], failed)
        replay = self.execute(actions=commands)
        self.assertEqual(['SUCCEEDED', 'FAILED'], [item['status'] for item in replay['operations']])
        self.assertIn('Saved 1', str(self.observation()['snapshot']))

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
        initial = self.execute(action=self.action('observe'))
        self.assertEqual('SUCCEEDED', initial['status'])
        action = self.action('click', self.target(initial['result'],
            'Slow effect'))
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

        primary = self.tasks[0][0]
        path = '/api/tasks/' + self.task['id']
        before = primary.api(path)[1]
        history = primary.api(path + '/history')[1]
        # Make this disposable receipt eligible for two normal recovery sweeps.
        self.fixture_sql(self.identity,
            "UPDATE operations SET dispatched_at=clock_timestamp()-interval '1 minute' "
            "WHERE owner_id=:owner AND id='" + action['operationId'] + "';")
        time.sleep(12)
        after = primary.api(path)[1]
        for field in ('status', 'version', 'updatedAt', 'request'):
            self.assertEqual(before[field], after[field], field)
        self.assertEqual(before['browser']['idleCloseAt'], after['browser']['idleCloseAt'])
        self.assertEqual(history, primary.api(path + '/history')[1])

        observed = self.execute(action=self.action('observe'))
        self.assertEqual('SUCCEEDED', observed['status'])
        self.assertIn('"counter":1', str(observed['result']))
        pending = before['request']
        verification = {'outcome': 'SUCCEEDED',
            'evidence': 'Observed counter=1 after the uncertain click.',
            'observationOperationId': observed['id']}
        arguments = {'taskId': self.task['id'], 'requestId': pending['id'],
            'requestVersion': pending['version'], 'operationKey': str(uuid.uuid4()),
            'verification': verification}
        self.client.close_mcp()
        self.client.mcp_capabilities = {}
        for invalid in (None, [], 'invalid', {**verification, 'extra': True},
                        {**verification, 'evidence': None}, {'outcome': 'SUCCEEDED'}):
            error, refusal, _ = self.client.tool('tasks.respond', {**arguments,
                'operationKey': str(uuid.uuid4()), 'verification': invalid})
            self.assertTrue(error, refusal)
            self.assertEqual(pending, primary.api(path)[1]['request'])
        for invalid in (str(uuid.uuid4()), initial['id'], action['operationId']):
            error, refusal, _ = self.client.tool('tasks.respond', {**arguments,
                'operationKey': str(uuid.uuid4()),
                'verification': {**verification, 'observationOperationId': invalid}})
            self.assertTrue(error, refusal)
            self.assertEqual('VALIDATION', refusal['code'])
        error, refusal, _ = self.client.tool('tasks.respond', {**arguments,
            'requestVersion': pending['version'] + 1})
        self.assertTrue(error, refusal)
        self.assertEqual('STALE_REQUEST', refusal['code'])
        wrong_chat = primary.tool('tasks.respond', arguments)
        self.assertTrue(wrong_chat[0], wrong_chat[1])

        # Simulate a lost resolve reply after its intent and worker receipt were persisted.
        payload = json.dumps(verification).replace("'", "''")
        self.fixture_sql(self.identity,
            "UPDATE task_requests SET verification='" + payload + "'::jsonb,"
            "elicitation_operation_key='" + arguments['operationKey'] + "',"
            "elicitation_attempt_id=NULL,elicitation_deadline=NULL WHERE owner_id=:owner AND id='"
            + pending['id'] + "'; UPDATE operations SET next_check_at=clock_timestamp()"
            " WHERE owner_id=:owner AND id='" + action['operationId'] + "';")
        script = """
const input = %s;
const response = await fetch('http://127.0.0.1:8080/commands/' + input.id + '/resolve', {
  method: 'POST', headers: {'content-type': 'application/json', 'x-worker-token': process.env.SESSION_TOKEN},
  body: JSON.stringify({outcome: input.outcome, evidence: input.evidence})});
if (response.status !== 200) throw new Error('Resolve status ' + response.status);
""" % json.dumps({'id': action['operationId'], **verification})
        reply = subprocess.run(self.docker + ['exec', '-i',
            'helm-browser-' + self.task['browser']['id'], 'node', '--input-type=module'],
            input=script, text=True, capture_output=True, timeout=20)
        self.assertEqual(0, reply.returncode, reply.stderr)
        time.sleep(12)
        self.assertEqual(pending, primary.api(path)[1]['request'])
        self.assertEqual('UNKNOWN', self.client.tool('operations.get',
            {'operationId': action['operationId']})[1]['status'])
        for changed in ({**verification, 'outcome': 'FAILED'},
                        {**verification, 'evidence': 'A contradictory retry'},
                        {**verification, 'observationOperationId': initial['id']}):
            error, refusal, _ = self.client.tool('tasks.respond', {**arguments,
                'verification': changed})
            self.assertTrue(error, refusal)
            self.assertEqual('IDEMPOTENCY_CONFLICT', refusal['code'])
        error, refusal, _ = self.client.tool('tasks.respond', {**arguments,
            'operationKey': str(uuid.uuid4()),
            'verification': {**verification, 'outcome': 'FAILED'}})
        self.assertTrue(error, refusal)
        self.assertEqual('IDEMPOTENCY_CONFLICT', refusal['code'])
        error, resolved, _ = self.client.tool('tasks.respond', arguments)
        self.assertFalse(error, resolved)
        self.assertEqual('WAITING_CHATGPT', resolved['status'])
        self.assertIsNone(resolved['request'])
        self.assertEqual('ACCEPTED', resolved['continuation']['status'],
                         'Verification continues the current chat turn without another message')
        error, receipt, _ = self.client.tool('operations.get', {'operationId': action['operationId']})
        self.assertFalse(error, receipt)
        self.assertEqual('SUCCEEDED', receipt['status'])
        self.assertEqual(observed['id'], receipt['result']['observationOperationId'])
        self.assertEqual(resolved, self.client.tool('tasks.respond', arguments)[1])
        error, refusal, _ = self.client.tool('tasks.respond', {**arguments,
            'verification': {**verification, 'outcome': 'FAILED'}})
        self.assertTrue(error, refusal)
        self.assertEqual('IDEMPOTENCY_CONFLICT', refusal['code'])
        self.assertEqual('MCP_VERIFICATION', self.fixture_sql(self.identity,
            "SELECT answer_source FROM task_requests WHERE owner_id=:owner AND id='" + pending['id'] + "';"))

    def test_unconfirmed_effect_allows_autonomous_progress_without_replay(self):
        self.ready()
        original = self.action('click', self.target(self.observation(), 'Slow effect'))
        uncertain = self.execute(action=original)
        if uncertain['status'] in ('ACCEPTED', 'DISPATCHED'):
            uncertain = self.wait_operation(original['operationId'], self.client)
        self.assertEqual('UNKNOWN', uncertain['status'])
        primary = self.tasks[0][0]
        path = '/api/tasks/' + self.task['id']
        pending = primary.api(path)[1]
        self.assertEqual(('WAITING_CHATGPT', 'UNKNOWN_RESULT'),
            (pending['status'], pending['waitReason']))
        self.assertIn('TAKE_CONTROL', pending['allowedCommands'])
        self.assertIn('BEGIN_LOGIN', pending['allowedCommands'])
        self.assertEqual('PENDING', self.fixture_sql(self.identity,
            "SELECT continuation_status FROM mcp_chats WHERE owner_id=:owner AND task_id='"
            + self.task['id'] + "';"))
        tab = self.observation()['tabs'][0]['id']
        for kind, arguments in (('selectTab', {'tabId': tab}), ('scroll', {'y': 100})):
            receipt = self.execute(action=self.action(kind, arguments))
            if receipt['status'] in ('ACCEPTED', 'DISPATCHED'):
                receipt = self.wait_operation(receipt['id'], self.client)
            self.assertEqual('SUCCEEDED', receipt['status'], receipt)
        observed = self.execute(action=self.action('observe'))
        if observed['status'] in ('ACCEPTED', 'DISPATCHED'):
            observed = self.wait_operation(observed['id'], self.client)
        self.assertEqual('SUCCEEDED', observed['status'])
        self.client.close_mcp()
        self.client.mcp_capabilities = {}
        arguments = {'taskId': self.task['id'], 'requestId': pending['request']['id'],
            'requestVersion': pending['request']['version'], 'operationKey': str(uuid.uuid4()),
            'verification': {'outcome': 'UNCONFIRMED',
                'evidence': 'Counter=1 is visible, but handler completion is unconfirmed. '
                    'Proceed with the independent next increment without repeating the old click.',
                'observationOperationId': observed['id']}}
        error, resumed, _ = self.client.tool('tasks.respond', arguments)
        self.assertFalse(error, resumed)
        self.assertEqual('WAITING_CHATGPT', resumed['status'])
        self.assertIsNone(resumed['request'])
        self.assertEqual('ACCEPTED', resumed['continuation']['status'],
                         'Verification continues the current chat turn without another message')
        error, shown, _ = self.client.tool('tasks.view', {
            'taskId': self.task['id'], 'operationKey': str(uuid.uuid4())})
        self.assertFalse(error, shown)
        self.assertEqual('ACCEPTED', shown['continuationStatus'])
        binding = {'taskId': self.task['id'], 'generation': shown['generation'],
                   'continuationId': shown['continuationId']}
        self.assertFalse(self.client.tool('widget.claim', binding)[1]['claimed'],
                         'The widget must not start another turn after model verification')
        receipt = self.client.tool('operations.get', {'operationId': original['operationId']})[1]
        self.assertEqual(('UNCONFIRMED', 'RESULT_UNCONFIRMED'),
            (receipt['status'], receipt['errorCode']))
        self.assertEqual(observed['id'], receipt['result']['observationOperationId'])
        self.assertEqual(receipt, self.execute(action=original))
        self.assertEqual(resumed, self.client.tool('tasks.respond', arguments)[1])
        self.assertEqual('ACCEPTED', primary.api(path)[1]['continuation']['status'])
        self.assertEqual('SUCCEEDED', self.click('Increment')['status'])
        self.assertIn('"counter":2', str(self.observation()))
        error, conflict, _ = self.client.tool('tasks.respond', {**arguments,
            'verification': {**arguments['verification'], 'outcome': 'SUCCEEDED'}})
        self.assertTrue(error)
        self.assertEqual('IDEMPOTENCY_CONFLICT', conflict['code'])
        self.assertEqual('MCP_VERIFICATION|PROCEED', self.fixture_sql(self.identity,
            "SELECT answer_source || '|' || answer_command FROM task_requests WHERE owner_id=:owner"
            " AND id='" + pending['request']['id'] + "';"))
        current = primary.api(path)[1]
        error, finished, _ = self.client.tool('tasks.command', {
            'taskId': self.task['id'], 'operationKey': str(uuid.uuid4()), 'command': {
                'type': 'FINISH', 'expectedVersion': current['version'], 'outcome': 'SUCCEEDED',
                'text': 'Reached counter=2. The earlier click remains unconfirmed in history.'}})
        self.assertFalse(error, finished)
        self.assertEqual('SUCCEEDED', finished['status'])

    def test_native_click_timeout_requires_verification(self):
        self.ready()
        action = self.action('click', self.target(self.observation(), 'Covered target'))
        result = self.execute(action=action)
        if result['status'] in ('ACCEPTED', 'DISPATCHED'):
            result = self.wait_operation(action['operationId'], self.client)
        self.assertEqual('UNKNOWN', result['status'], result)
        self.assertEqual('UNKNOWN_RESULT', result['errorCode'])
        self.assertEqual(result, self.execute(action=action))
        task = self.tasks[0][0].api('/api/tasks/' + self.task['id'])[1]
        self.assertEqual('UNKNOWN_RESULT', task['request']['type'])
        self.assertIn('"counter":0', str(self.observation()))

    def test_dialog_early_response_stops_execution_and_preserves_receipt(self):
        self.ready()
        action = self.action('click', self.target(self.observation(), 'Dialog before effect'))
        result = self.execute(action=action)
        if result['status'] in ('ACCEPTED', 'DISPATCHED'):
            result = self.wait_operation(action['operationId'], self.client)
        self.assertEqual('UNKNOWN', result['status'], result)
        self.assertEqual(result, self.execute(action=action))
        primary = self.tasks[0][0]
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            task = primary.api('/api/tasks/' + self.task['id'])[1]
            if task['browser']['status'] in ('LOST', 'CLOSED'):
                break
            time.sleep(.25)
        self.assertIn(task['browser']['status'], ('LOST', 'CLOSED'))
        running = subprocess.run(self.docker + ['ps', '--filter',
            'name=^/helm-browser-' + self.task['browser']['id'] + '$', '--format', '{{.ID}}'],
            text=True, capture_output=True, check=True, timeout=20)
        self.assertEqual('', running.stdout.strip(), 'No native callback can run after the stopped session is released')
        error, saved, _ = self.client.tool('operations.get', {'operationId': action['operationId']})
        self.assertFalse(error, saved)
        self.assertEqual(result['id'], saved['id'])
        self.assertEqual('UNKNOWN', saved['status'])

    def test_verification_after_stop_does_not_resume_the_task(self):
        self.ready()
        action = self.action('click', self.target(self.observation(), 'Slow effect'))
        result = self.execute(action=action)
        if result['status'] in ('ACCEPTED', 'DISPATCHED'):
            result = self.wait_operation(action['operationId'], self.client)
        self.assertEqual('UNKNOWN', result['status'], result)
        observed = self.execute(action=self.action('observe'))
        if observed['status'] in ('ACCEPTED', 'DISPATCHED'):
            observed = self.wait_operation(observed['id'], self.client)
        self.assertEqual('SUCCEEDED', observed['status'])
        self.assertIn('"counter":1', str(observed['result']))
        primary = self.tasks[0][0]
        path = '/api/tasks/' + self.task['id']
        task = primary.api(path)[1]
        status, stopped = primary.api(path + '/commands', 'POST',
            {'type': 'STOP', 'expectedVersion': task['version']})
        self.assertEqual(200, status, stopped)
        until = time.monotonic() + 45
        while time.monotonic() < until:
            stopped = primary.api(path)[1]
            if stopped['status'] == 'STOPPED':
                break
            time.sleep(.2)
        self.assertEqual('STOPPED', stopped['status'])
        pending = stopped['request']
        self.client.close_mcp()
        self.client.mcp_capabilities = {}
        error, verified, _ = self.client.tool('tasks.respond', {
            'taskId': self.task['id'], 'requestId': pending['id'],
            'requestVersion': pending['version'], 'operationKey': str(uuid.uuid4()),
            'verification': {'outcome': 'SUCCEEDED',
                'evidence': 'Observed counter=1 before stopping; this only verifies the prior effect.',
                'observationOperationId': observed['id']}})
        self.assertFalse(error, verified)
        self.assertEqual(('STOPPED', 'CLOSED'), (verified['status'], verified['browser']['status']))
        self.assertIsNone(verified['request'])
        self.assertEqual('SUCCEEDED', self.client.tool('operations.get',
            {'operationId': action['operationId']})[1]['status'])

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
