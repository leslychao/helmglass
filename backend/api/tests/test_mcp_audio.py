"""Real CPU audio analysis contracts on deployed dev."""
from concurrent.futures import ThreadPoolExecutor
from array import array
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid
import wave
from test_dev_contract import DevClient

class AudioAnalysisTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings = dict(line.split('=', 1) for line in Path(os.environ.get('HELM_TEST_ENV', 'deploy/.env.dev')).read_text().splitlines() if line and not line.startswith('#') and '=' in line)
        cls.client = DevClient(cls.settings, 'test', 'KEYCLOAK_TEST_PASSWORD')
        cls.owner = cls.client.login_web()['id']
        cls.client.login_mcp()
        cls.docker = ['docker', '--host', 'tcp://' + cls.settings['DEV_HOST'] + ':2375']

    @classmethod
    def tearDownClass(cls):
        cls.client.close_mcp()

    def sql(self, statement):
        result = subprocess.run(self.docker + ['exec', '-i', 'helmglass-postgres-1', 'psql', '-U', 'postgres', '-d', 'helmglass', '-At', '-v', 'ON_ERROR_STOP=1'], input=statement, text=True, capture_output=True, timeout=30)
        self.assertEqual(0, result.returncode, result.stderr)
        return result.stdout.strip()

    def fixture(self, path, name):
        # Dedicated draft and random artifact ID: never mutate user originals.
        status, task = self.client.api('/api/tasks', 'POST', {'title': 'Audio regression: ' + name, 'goal': 'Verify local processing of a test fixture.', 'startUrl': 'https://example.com', 'outputFormat': 'TEXT', 'prepare': False})
        self.assertIn(status, (200, 201), task)
        artifact = str(uuid.uuid4())
        task_id, owner = str(uuid.UUID(task['id'])), str(uuid.UUID(self.owner))
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        subprocess.run(self.docker + ['cp', str(path), 'helmglass-api-1:/data/artifacts/' + artifact], check=True, capture_output=True, timeout=30)
        self.sql(f"INSERT INTO artifacts(id,owner_id,task_id,name,mime_type,status,size_bytes,sha256,complete,relative_path) VALUES ('{artifact}','{owner}','{task_id}','fixture.wav','audio/wav','READY',{path.stat().st_size},'{digest}',true,'{artifact}');")
        return artifact, task_id, digest

    def tool(self, name, arguments, client=None):
        failed, data, raw = (client or self.client).tool(name, arguments)
        self.assertFalse(failed, data)
        self.assertTrue(all(item['type'] == 'text' for item in raw['content']))
        self.assertLessEqual(len(json.dumps(data, ensure_ascii=False).encode()), 65536)
        return data

    def wait(self, analysis):
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            try:
                page = self.tool('audio.get', {'analysisId': analysis})
            except AssertionError as error:
                if 'returned HTTP 502' not in str(error) and 'returned HTTP 503' not in str(error):
                    raise
                time.sleep(2)
                continue
            if page['status'] in ('SUCCEEDED', 'PARTIAL', 'FAILED'):
                return page
            time.sleep(1)
        self.fail('Analysis did not reach a terminal state')

    def action(self, task_id, kind, arguments):
        task = self.client.api('/api/tasks/' + task_id)[1]
        action = {'operationId': str(uuid.uuid4()), 'type': kind, 'arguments': arguments,
                  'instructionRevision': task['instructionRevision']}
        if task.get('browser'):
            action['controlEpoch'] = task['browser']['controlEpoch']
        failed, data, _ = self.client.execute_browser({'taskId': task_id, 'action': action})
        self.assertFalse(failed, data)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            receipt = self.tool('operations.get', {'operationId': action['operationId']})
            if receipt['status'] in ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'):
                self.assertEqual('SUCCEEDED', receipt['status'], receipt)
                return receipt
            time.sleep(.5)
        self.fail('Browser action timeout')

    def test_short_transcript_returns_inline_and_pending_wait_is_bounded(self):
        path = Path('.work/audio-corpus/fleurs-10669014641440041936.wav')
        self.assertTrue(path.is_file(), 'Prepare the existing audio corpus before this dev acceptance')
        artifact, _, _ = self.fixture(path, 'inline transcript')
        started = time.monotonic()
        page = self.tool('audio.analyze', {'artifactId': artifact, 'mode': 'transcript'})
        elapsed = time.monotonic() - started
        self.assertEqual('SUCCEEDED', page['status'], page)
        self.assertTrue(page['sectionComplete'])
        self.assertFalse(page['hasMore'])
        self.assertIsNone(page['nextCursor'])
        self.assertGreater(len(' '.join(item['text'] for item in page['items']).split()), 10)
        self.assertLess(elapsed, 8)
        self.assertEqual(1, page['metrics']['asrCalls'])
        repeat = self.tool('audio.analyze', {'artifactId': artifact, 'mode': 'transcript'})
        self.assertEqual(page, repeat)
        print(f'Short audio: transcript and ready receipt in one MCP call, {elapsed:.3f}s', flush=True)

        delayed_artifact, _, digest = self.fixture(path, 'queued transcript')
        delayed_id = str(uuid.uuid4())
        self.sql(f"""INSERT INTO audio_analyses
            (id,owner_id,artifact_id,source_sha256,processing_version,metadata,
             requested_mode,status,next_attempt_at)
            SELECT '{delayed_id}',owner_id,'{delayed_artifact}','{digest}',processing_version,
              metadata,'transcript','QUEUED',now()+interval '1 day'
            FROM audio_analyses WHERE id='{page['analysisId']}';""")
        try:
            started = time.monotonic()
            pending = self.tool('audio.analyze', {'artifactId': delayed_artifact, 'mode': 'transcript'})
            elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 49)
            self.assertLess(elapsed, 55)
            self.assertEqual(delayed_id, pending['analysisId'])
            self.assertEqual('QUEUED', pending['status'])
            self.assertFalse(pending['sectionComplete'])
            self.assertEqual([], pending['items'])
        finally:
            self.sql(f"UPDATE audio_analyses SET next_attempt_at=now() WHERE id='{delayed_id}';")
        finished = self.wait(delayed_id)
        self.assertEqual('SUCCEEDED', finished['status'], finished)
        self.assertEqual(1, finished['metrics']['asrCalls'])

    def test_pending_summary_read_waits_for_full_completion(self):
        path = Path('.work/audio-corpus/fleurs-10669014641440041936.wav')
        artifact, _, _ = self.fixture(path, 'summary readiness metadata')
        reference = self.tool('audio.analyze', {'artifactId': artifact, 'mode': 'full'})
        self.assertEqual('SUCCEEDED', reference['status'], reference)
        queued_artifact, _, digest = self.fixture(path, 'queued sound summary')
        queued_id = str(uuid.uuid4())
        self.sql(f"""INSERT INTO audio_analyses
            (id,owner_id,artifact_id,source_sha256,processing_version,metadata,
             requested_mode,status,next_attempt_at)
            SELECT '{queued_id}',owner_id,'{queued_artifact}','{digest}',processing_version,
              metadata,'full','QUEUED',now()+interval '1 day'
            FROM audio_analyses WHERE id='{reference['analysisId']}';""")
        self.sql(f"""INSERT INTO audio_analysis_items
            (analysis_id,section,start_seconds,end_seconds,payload)
            SELECT '{queued_id}',section,start_seconds,end_seconds,payload
            FROM audio_analysis_items WHERE analysis_id='{reference['analysisId']}'
              AND section='acoustics' ORDER BY id;
            UPDATE audio_analyses SET acoustics_complete=true WHERE id='{queued_id}';""")
        ready_started = time.monotonic()
        acoustic_page = self.tool('audio.get', {
            'analysisId': queued_id, 'section': 'acoustics', 'limit': 1})
        self.assertEqual('QUEUED', acoustic_page['status'])
        self.assertTrue(acoustic_page['sectionComplete'])
        self.assertEqual(1, len(acoustic_page['items']))
        self.assertLess(time.monotonic() - ready_started, 2)
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.tool, 'audio.get', {
                'analysisId': queued_id, 'section': 'summary'})
            try:
                time.sleep(3)
                self.assertFalse(pending.done(), 'An unfinished summary read should await its signal')
            finally:
                self.sql(f"UPDATE audio_analyses SET next_attempt_at=now() WHERE id='{queued_id}';")
            summary = pending.result(timeout=60)
        self.assertEqual('SUCCEEDED', summary['status'], summary)
        self.assertTrue(summary['sectionComplete'])
        self.assertTrue(summary['soundSummary']['acousticsComplete'])
        self.assertTrue(summary['soundSummary']['emotionsComplete'])
        self.assertLess(time.monotonic() - started, 15)
        print('One summary read returned on full completion, without status polling', flush=True)

    def test_loudness_levels_and_timeline_through_mcp(self):
        # Analytic RMS/peak references for a sine, including both silence edges.
        # Eighteen seconds crosses the processor's bounded decoding blocks.
        directory = Path('.work/audio-fixtures')
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / ('levels-' + str(uuid.uuid4()) + '.wav')
        try:
            with wave.open(str(path), 'wb') as output:
                output.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                for amplitude, seconds in ((0, 2), (.1, 4), (.5, 4), (.025, 4), (0, 4)):
                    second = array('h', (round(32768 * amplitude * math.sin(2 * math.pi * 200 * n / 16000))
                                         for n in range(16000)))
                    for _ in range(seconds):
                        output.writeframes(second.tobytes())
            artifact, _, _ = self.fixture(path, 'known loudness levels')
        finally:
            path.unlink(missing_ok=True)
        job = self.tool('audio.analyze', {'artifactId': artifact, 'mode': 'full'})
        self.assertIn('soundSummary', job)
        self.assertEqual('SUCCEEDED', job['status'], job)
        self.assertTrue(job['soundSummary']['acousticsComplete'])
        self.assertTrue(job['soundSummary']['emotionsComplete'])
        state = self.wait(job['analysisId'])
        self.assertTrue(state['acousticsComplete'], state)
        self.assertEqual(18, state['durationSeconds'])
        summary = self.tool('audio.get', {'analysisId': job['analysisId'], 'section': 'summary'})
        self.assertTrue(summary['sectionComplete'])
        self.assertFalse(summary['hasMore'])
        sound = summary['soundSummary']
        self.assertTrue(sound['acousticsComplete'])
        self.assertTrue(sound['emotionsComplete'])
        acoustics = sound['acoustics']
        self.assertEqual(360, acoustics['loudnessSamples'])
        self.assertEqual(1800, acoustics['pitchSamples'])
        self.assertEqual(18, acoustics['coveredSeconds'])
        self.assertEqual(6, acoustics['digitalSilenceSeconds'])
        self.assertAlmostEqual(-6.0206, acoustics['peakDbfs'], delta=.02)
        self.assertAlmostEqual(10 * math.log10((.1**2 + .5**2 + .025**2) * 2 / 18),
                               acoustics['rmsDbfs'], delta=.02)
        self.assertTrue(sound['emotions']['sectionComplete'])
        if job['status'] == 'SUCCEEDED':
            self.assertEqual(sound, job['soundSummary'])
        interval = self.tool('audio.get', {'analysisId': job['analysisId'],
            'section': 'acoustics', 'from': 6, 'to': 6.1})
        self.assertFalse(interval['hasMore'])
        self.assertTrue(all(item['start'] >= 6 and item['end'] <= 6.1
                            for item in interval['items']))
        self.assertGreater(len(interval['items']), 0)
        print('Full sound summary includes all 18 seconds; targeted samples share the same result',
              flush=True)
        cursor = None
        loudness = []
        while True:
            arguments = {'analysisId': job['analysisId'], 'section': 'acoustics', 'limit': 100}
            if cursor:
                arguments['cursor'] = cursor
            page = self.tool('audio.get', arguments)
            self.assertTrue(page['sectionComplete'])
            loudness.extend(item for item in page['items'] if item['kind'] == 'loudness')
            if not page['hasMore']:
                break
            self.assertNotEqual(cursor, page['nextCursor'])
            cursor = page['nextCursor']
        self.assertEqual(360, len(loudness))
        for index, item in enumerate(loudness):
            self.assertAlmostEqual(index / 20, item['start'])
            self.assertAlmostEqual((index + 1) / 20, item['end'])
            if index < 40 or index >= 280:
                self.assertTrue(item['digitalSilence'])
                self.assertIsNone(item['rmsDbfs'])
                self.assertIsNone(item['peakDbfs'])
            else:
                # Independently calculated: 20 log10(A), RMS is 3.0103 dB lower.
                if index < 120:
                    rms, peak = -23.0103, -20
                elif index < 200:
                    rms, peak = -9.0309, -6.0206
                else:
                    rms, peak = -35.0515, -32.0412
                self.assertFalse(item['digitalSilence'])
                self.assertAlmostEqual(rms, item['rmsDbfs'], delta=.02)
                self.assertAlmostEqual(peak, item['peakDbfs'], delta=.02)

    def test_browser_capture_transcript_upgrade_and_other_chat(self):
        failed, presentation, _ = self.client.tool('tasks.create', {
            'operationKey': str(uuid.uuid4()), 'task': {'title': 'Local audio browser regression',
                'goal': 'Obtain text through local Helm processing.', 'prepare': True,
                'startUrl': 'https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/example.wav'}})
        self.assertFalse(failed, presentation)
        self.assertIn('audio', presentation)
        task_id = presentation['task']['id']
        try:
            listing = self.action(task_id, 'listMedia', {})
            media = listing['result']['media'][0]
            captured = self.action(task_id, 'captureAudio', {'sourceId': media['id'],
                'sourceRef': 'local-audio-regression', 'sourceContext': {
                    'assignmentId': 'audio-regression', 'instruction': 'Historical source data.',
                    'questions': ['What is said in the recording?']},
                'name': 'gigaam-example.wav'})
            artifact = captured['result']['artifact']
            self.assertNotIn('observation', captured['result'])
            self.assertNotIn('sourceUrl', artifact)
            self.assertNotIn('downloadUrl', artifact)
            listing = self.tool('artifacts.list', {'taskId': task_id})
            self.assertNotIn('sourceUrl', listing['items'][0])
            first = self.tool('audio.analyze', {'artifactId': artifact['id'], 'mode': 'transcript'})
            page = self.wait(first['analysisId'])
            self.assertEqual('SUCCEEDED', page['status'], page)
            self.assertGreater(page['tempo']['recognizedWords'], 15)
            calls = page['metrics']['asrCalls']
            saved_context = page['instructionContext']
            other = DevClient(self.settings, 'test', 'KEYCLOAK_TEST_PASSWORD')
            other.token = self.client.token
            before = self.client.api('/api/tasks/' + task_id)[1]
            try:
                upgraded = self.tool('audio.analyze', {'artifactId': artifact['id'], 'mode': 'full'}, other)
                self.assertEqual(first['analysisId'], upgraded['analysisId'])
                page = self.wait(first['analysisId'])
                self.assertEqual('SUCCEEDED', page['status'], page)
                self.assertEqual(calls, page['metrics']['asrCalls'])
                self.assertEqual(saved_context, page['instructionContext'])
                unscoped = other.rpc('tools/call', {'name':'audio.get', 'arguments': {
                    'analysisId': first['analysisId'], 'callId': str(uuid.uuid4()),
                    'stepTitle': 'Прочитать сохранённый анализ аудио'}})
                self.assertFalse(unscoped.get('isError',False))
                self.assertTrue(all(x['type']=='text' for x in unscoped['content']))
                self.assertEqual(before['version'], self.client.api('/api/tasks/' + task_id)[1]['version'])
                after_browser = self.client.api('/api/tasks/' + task_id)[1]['browser']
                # Worker heartbeat revisions can advance independently of analysis.
                for field in ('id', 'status', 'controlOwner', 'controlEpoch', 'privateMode', 'idleCloseAt'):
                    self.assertEqual(before['browser'][field], after_browser[field])
            finally:
                other.close_mcp()
            status, raw, _ = self.client.request(self.client.base + '/api/artifacts/' + artifact['id'] + '/download')
            self.assertEqual(200,status)
            self.assertEqual(artifact['sha256'],hashlib.sha256(raw).hexdigest())
            original_browser = self.client.api('/api/tasks/' + task_id)[1]['browser']['id']
            for command, expected in [('CLOSE_BROWSER', 'CLOSED'), ('OPEN_BROWSER', 'LIVE')]:
                current = self.client.api('/api/tasks/' + task_id)[1]
                status, reply = self.client.api('/api/tasks/' + task_id + '/commands', 'POST',
                    {'type': command, 'expectedVersion': current['version']})
                self.assertEqual(200, status, reply)
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    current = self.client.api('/api/tasks/' + task_id)[1]
                    if current['browser']['status'] == expected:
                        break
                    time.sleep(.2)
                self.assertEqual(expected, current['browser']['status'])
                status, saved, _ = self.client.request(
                    self.client.base + '/api/artifacts/' + artifact['id'] + '/download')
                self.assertEqual(200, status)
                self.assertEqual(artifact['sha256'], hashlib.sha256(saved).hexdigest())
                self.assertEqual('SUCCEEDED', self.tool('audio.get', {'analysisId': first['analysisId']})['status'])
            self.assertNotEqual(original_browser, current['browser']['id'])
        finally:
            task = self.client.api('/api/tasks/' + task_id)[1]
            status, _ = self.client.api('/api/tasks/' + task_id + '/commands', 'POST',
                {'type':'STOP','expectedVersion':task['version']})
            self.assertEqual(200,status)

    def test_silence_corruption_and_access(self):
        directory = Path('.work/audio-fixtures')
        directory.mkdir(parents=True, exist_ok=True)
        silence = directory / 'silence.wav'
        with wave.open(str(silence), 'wb') as output:
            output.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            output.writeframes(bytes(3 * 16000 * 2))
        artifact, task, digest = self.fixture(silence, 'silence')
        before = self.client.api('/api/tasks/' + task)[1]
        first = self.tool('audio.analyze', {'artifactId': artifact, 'mode': 'transcript'})
        analysis = first['analysisId']
        with ThreadPoolExecutor(max_workers=4) as executor:
            def start(_):
                peer = DevClient(self.settings, 'test', 'KEYCLOAK_TEST_PASSWORD')
                peer.token = self.client.token
                try:
                    return self.tool('audio.analyze', {'artifactId': artifact, 'mode': 'transcript'}, peer)
                finally:
                    peer.close_mcp()
            repeats = list(executor.map(start, range(4)))
        self.assertEqual({analysis}, {item['analysisId'] for item in repeats})
        page = self.wait(analysis)
        self.assertEqual('SUCCEEDED', page['status'], page)
        self.assertTrue(page['sectionComplete'])
        self.assertEqual([], page['items'])
        self.assertEqual('NO_SPEECH_DETECTED', page['tempo']['reason'])
        self.assertEqual(0, page['metrics']['asrCalls'])
        self.assertEqual(digest, page['sourceSha256'])
        upgraded = self.tool('audio.analyze', {'artifactId': artifact, 'mode': 'full'})
        self.assertEqual(analysis, upgraded['analysisId'])
        page = self.wait(analysis)
        self.assertEqual('SUCCEEDED', page['status'], page)
        self.assertEqual(0, page['metrics']['asrCalls'])
        silence_summary = self.tool('audio.get', {'analysisId': analysis, 'section': 'summary'})
        self.assertIsNone(silence_summary['soundSummary']['acoustics']['rmsDbfs'])
        self.assertEqual(3, silence_summary['soundSummary']['acoustics']['digitalSilenceSeconds'])
        acoustics = self.tool('audio.get', {'analysisId': analysis, 'section': 'acoustics', 'limit': 20})
        self.assertTrue(acoustics['hasMore'])
        self.assertTrue(acoustics['sectionComplete'])
        self.assertTrue(all(item['digitalSilence'] for item in acoustics['items'] if item['kind']=='loudness'))
        self.assertTrue(all(item['f0Hz'] is None for item in acoustics['items'] if item['kind']=='pitch'))
        second = self.tool('audio.get', {'analysisId': analysis, 'section': 'acoustics', 'cursor': acoustics['nextCursor'], 'limit': 20})
        self.assertGreater(second['items'][0]['start'], acoustics['items'][-1]['start'])
        stranger = DevClient(self.settings, 'admin', 'KEYCLOAK_APP_ADMIN_PASSWORD')
        stranger.login_web()
        stranger.login_mcp()
        try:
            for name, args in [('audio.analyze', {'artifactId': artifact, 'mode': 'full'}),
                               ('audio.get', {'analysisId': analysis}),
                               ('audio.get', {'analysisId': analysis, 'section': 'summary'})]:
                failed, refusal, raw = stranger.tool(name, args)
                self.assertTrue(failed)
                self.assertEqual('NOT_FOUND', refusal['code'])
                self.assertTrue(all(item['type'] == 'text' for item in raw['content']))
        finally:
            stranger.close_mcp()
        self.assertEqual(before['version'], self.client.api('/api/tasks/' + task)[1]['version'])
        invalid = directory / 'corrupt.wav'
        invalid.write_bytes(b'not an audio container')
        broken, _, _ = self.fixture(invalid, 'corrupt')
        job = self.tool('audio.analyze', {'artifactId': broken, 'mode': 'full'})
        result = self.wait(job['analysisId'])
        self.assertEqual('FAILED', result['status'], result)
        self.assertEqual('DECODE_FAILED', result['errorCode'])
        self.assertFalse(result['sectionComplete'])

        truncated = directory / 'truncated.wav'
        truncated.write_bytes(silence.read_bytes()[:-1001])
        artifact, _, _ = self.fixture(truncated, 'truncated')
        job = self.tool('audio.analyze', {'artifactId': artifact, 'mode': 'full'})
        result = self.wait(job['analysisId'])
        self.assertIn(result['status'], ('FAILED', 'PARTIAL'), result)
        self.assertEqual('DECODE_FAILED', result['errorCode'])

        # Recover an explicitly failed emotion checkpoint, with other stages intact.
        partial, _, _ = self.fixture(silence, 'stage failure checkpoint')
        partial_id = str(uuid.uuid4())
        self.sql(f"""INSERT INTO audio_analyses
            (id,owner_id,artifact_id,source_sha256,processing_version,metadata,
             requested_mode,status,checkpoint,next_attempt_at)
            SELECT '{partial_id}',owner_id,'{partial}',source_sha256,processing_version,metadata,
              'full','QUEUED','{{"errors":{{"emotions":"EMOTION_FAILED"}}}}',now()+interval '1 day'
            FROM audio_analyses WHERE id='{analysis}';""")
        pending = self.tool('audio.get', {'analysisId': partial_id, 'section': 'emotions'})
        self.assertFalse(pending['hasMore'])
        self.assertFalse(pending['sectionComplete'])
        self.sql(f"UPDATE audio_analyses SET next_attempt_at=now() WHERE id='{partial_id}';")
        result = self.wait(partial_id)
        self.assertEqual('PARTIAL', result['status'])
        self.assertTrue(result['transcriptComplete'])
        self.assertTrue(result['acousticsComplete'])
        self.assertFalse(result['emotionsComplete'])
        self.assertEqual('FAILED', result['stages']['emotions'])
        self.assertEqual('EMOTION_FAILED', result['stageErrors']['emotions'])
        partial_summary = self.tool('audio.get', {'analysisId': partial_id, 'section': 'summary'})
        self.assertFalse(partial_summary['sectionComplete'])
        self.assertTrue(partial_summary['soundSummary']['acousticsComplete'])
        self.assertFalse(partial_summary['soundSummary']['emotions']['sectionComplete'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
