"""Artifact publication and recovery against the deployed application and its real storage."""
import hashlib
from concurrent.futures import ThreadPoolExecutor
import json
import time
import unittest
import uuid

import test_lost_archive as archive


class SharedArtifactTest(unittest.TestCase):
    setUpClass = classmethod(archive.LostArchiveTest.setUpClass.__func__)
    setUp = archive.LostArchiveTest.setUp
    tearDown = archive.LostArchiveTest.tearDown
    fixture_sql = archive.LostArchiveTest.fixture_sql
    purge_identity = archive.LostArchiveTest.purge_identity
    wait_operation = archive.LostArchiveTest.wait_operation
    command = archive.LostArchiveTest.command
    admin_command = archive.LostArchiveTest.admin_command
    docker = archive.LostArchiveTest.docker
    worker = archive.LostArchiveTest.worker
    current = archive.LostArchiveTest.current
    wait_task = archive.LostArchiveTest.wait_task
    execute = archive.LostArchiveTest.execute
    archive_failure = archive.LostArchiveTest.archive_failure

    def test_symlink_source_is_preserved_until_administrator_repairs_it(self):
        self.archive_failure('SOURCE_SYMLINK')

    def test_unreadable_source_is_preserved_until_administrator_repairs_it(self):
        self.archive_failure('SOURCE_ACCESS')

    def test_incomplete_source_is_not_published_or_deleted(self):
        self.archive_failure('SOURCE_INCOMPLETE')

    def test_concurrent_duplicate_publishes_one_artifact(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool('tasks.create', {
            'operationKey': str(uuid.uuid4()), 'task': {
                'title': 'Concurrent artifact publication', 'goal': 'Publish one screenshot',
                'startUrl': self.client.browser_fixture_url(), 'prepare': True}})
        self.assertFalse(error, presentation)
        task = presentation['task']
        try:
            self.execute(task, 'observe', {})
            current = self.current(task)
            action = {'operationId': str(uuid.uuid4()), 'type': 'screenshot', 'arguments': {},
                'instructionRevision': current['instructionRevision'],
                'controlEpoch': current['browser']['controlEpoch']}
            with ThreadPoolExecutor(max_workers=2) as executor:
                replies = list(executor.map(lambda _: self.client.execute_browser({
                    'taskId': task['id'], 'action': action}), range(2)))
            for error, result, _ in replies:
                self.assertFalse(error, result)
                self.assertEqual(action['operationId'], result.get('operationId', result.get('id')))
            receipt = self.wait_operation(action['operationId'], self.client)
            self.assertEqual('SUCCEEDED', receipt['status'])
            source = self.worker('/sessions/' + current['browser']['id'] + '/artifacts')['value']['artifacts'][0]
            artifact = source['id']
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                status, page = self.client.api('/api/tasks/' + task['id'] + '/artifacts')
                self.assertEqual(200, status)
                value = next((item for item in page['items'] if item['id'] == artifact), None)
                if value and value['status'] == 'READY':
                    break
                time.sleep(.2)
            self.assertIsNotNone(value)
            self.assertEqual('READY', value['status'])
            self.assertEqual('1', self.fixture_sql(self.identity,
                "SELECT count(*) FROM artifacts WHERE owner_id=:owner AND task_id='" + task['id'] + "';"))
            self.assertEqual(1, len(self.worker('/sessions/' + current['browser']['id']
                + '/artifacts')['value']['artifacts']))
            status, content, _ = self.client.request(self.client.base + '/api/artifacts/' + artifact + '/download')
            self.assertEqual(200, status)
            self.assertEqual(value['sha256'], hashlib.sha256(content).hexdigest())
        finally:
            self.command(task, 'STOP')
            self.wait_task(task, lambda value: value['status'] == 'STOPPED')

    def test_partial_cleanup_recovers_without_requiring_deleted_records(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool('tasks.create', {
            'operationKey': str(uuid.uuid4()), 'task': {
                'title': 'Partial session cleanup', 'goal': 'Keep published results when temporary cleanup fails',
                'startUrl': 'https://example.com', 'prepare': True}})
        self.assertFalse(error, presentation)
        task = presentation['task']
        session = None
        complete = False
        try:
            self.execute(task, 'observe', {})
            session = self.current(task)['browser']['id']
            self.execute(task, 'screenshot', {})
            source = self.worker('/sessions/' + session + '/artifacts')['value']['artifacts'][0]
            artifact = source['id']
            self.assertEqual('READY', self.fixture_sql(self.identity,
                "SELECT status FROM artifacts WHERE owner_id=:owner AND id='" + artifact + "';"))
            before = self.docker('exec', 'helmglass-api-1', 'stat', '--format', '%d:%i',
                '/data/artifacts/' + artifact)
            temporary = '/artifacts/sessions/' + session + '/.cleanup-fixture'
            script = ("import fs from 'node:fs';const p=" + json.dumps(temporary)
                + ";fs.mkdirSync(p,{mode:0o700});fs.writeFileSync(p+'/temporary','cleanup fixture');fs.chmodSync(p,0o000);")
            self.docker('exec', '--user', '1000', '-i', 'helmglass-browser-node-1',
                'node', '--input-type=module', script=script)
            self.command(task, 'STOP')
            failed = self.wait_task(task, lambda value: value['browser']['cleanupState'] == 'FAILED')
            self.assertEqual('CLEANUP_FAILED', failed['browser']['cleanupError'])
            self.assertEqual('CLOSED', failed['browser']['status'])
            status, saved, _ = self.client.request(self.client.base + '/api/artifacts/' + artifact + '/download')
            self.assertEqual(200, status)
            self.assertEqual(source['sha256'], hashlib.sha256(saved).hexdigest())
            self.assertEqual(200, self.worker('/sessions/' + session + '/artifacts')['status'],
                'Acknowledged records must not be required after partially deleting temporary data')
            script = "import fs from 'node:fs';fs.chmodSync(" + json.dumps(temporary) + ",0o700);"
            self.docker('exec', '--user', '1000', '-i', 'helmglass-browser-node-1',
                'node', '--input-type=module', script=script)
            self.assertEqual(200, self.admin.api('/api/admin/browsers/' + session + '/retry-cleanup', 'POST', {})[0])
            self.wait_task(task, lambda value: value['browser']['cleanupState'] == 'COMPLETE')
            complete = True
            self.assertEqual(before, self.docker('exec', 'helmglass-api-1', 'stat', '--format', '%d:%i',
                '/data/artifacts/' + artifact))
        finally:
            if session and not complete:
                # Restore only this fault fixture; published data is never modified.
                temporary = '/artifacts/sessions/' + session + '/.cleanup-fixture'
                script = "import fs from 'node:fs';const p=" + json.dumps(temporary) + ";if(fs.existsSync(p))fs.chmodSync(p,0o700);"
                self.docker('exec', '--user', '1000', '-i', 'helmglass-browser-node-1',
                    'node', '--input-type=module', script=script)
                current = self.current(task)
                if current['browser']['status'] != 'CLOSED':
                    self.command(task, 'STOP')

    def test_publication_preserves_inode_and_recovers_after_database_commit_loss(self):
        self.client.login_mcp()
        error, presentation, _ = self.client.tool('tasks.create', {
            'operationKey': str(uuid.uuid4()), 'task': {
                'title': 'Shared artifact publication', 'goal': 'Verify file publication without copying',
                'startUrl': self.client.browser_fixture_url(), 'prepare': True}})
        self.assertFalse(error, presentation)
        task = presentation['task']
        session = None
        constraint = None
        try:
            self.execute(task, 'observe', {})
            session = self.current(task)['browser']['id']
            scope = " WHERE owner_id=:owner AND id='" + str(uuid.UUID(session)) + "';"
            self.fixture_sql(self.identity, 'UPDATE browser_sessions SET artifact_cursor=9007199254740991' + scope)
            self.execute(task, 'click', self.client.browser_target(
                task['id'], 'Download a completed result after this action returns'))
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                page = self.worker('/sessions/' + session + '/artifacts')['value']
                if page['artifacts']:
                    source = page['artifacts'][0]
                    break
                time.sleep(.2)
            else:
                self.fail('A completed download was not committed')
            artifact = str(uuid.UUID(source['id']))
            container = 'helm-browser-' + session
            before = self.docker('exec', container, 'stat', '--format', '%d:%i', '/data/artifacts/' + artifact)
            inspected = json.loads(self.docker('inspect', container))[0]
            constraint = 'artifact_ready_fixture_' + uuid.UUID(artifact).hex
            self.fixture_sql(self.identity, 'ALTER TABLE artifacts ADD CONSTRAINT ' + constraint
                + " CHECK (id<>'" + artifact + "' OR status<>'READY') NOT VALID;")
            self.fixture_sql(self.identity, 'UPDATE browser_sessions SET artifact_cursor=0' + scope)
            self.command(task, 'STOP')
            self.wait_task(task, lambda value: value['browser']['cleanupState'] == 'FAILED')
            state = self.fixture_sql(self.identity,
                "SELECT status FROM artifacts WHERE owner_id=:owner AND id='" + artifact + "';")
            self.assertEqual('UPLOADING', state, 'A failed commit must not report READY')
            after = self.docker('exec', 'helmglass-api-1', 'stat', '--format', '%d:%i', '/data/artifacts/' + artifact)
            self.assertEqual(before, after, 'Publication must rename the same inode')
            mounted = inspected['HostConfig']['Mounts']
            self.assertEqual(1, len(mounted), 'Only this session directory may be exposed')
            self.assertEqual('/data', mounted[0]['Target'])
            self.assertEqual('sessions/' + session, mounted[0]['VolumeOptions']['Subpath'])
            self.assertTrue(mounted[0]['VolumeOptions']['NoCopy'])
            self.assertEqual('0640', self.docker('exec', 'helmglass-api-1', 'stat', '--format', '%04a', '/data/artifacts/' + artifact))
            self.assertEqual('', self.docker('volume', 'ls', '--filter', 'name=' + container + '-data', '--format', '{{.Name}}'))
            status, _, _ = self.client.request(self.client.base + '/api/artifacts/' + artifact + '/download')
            self.assertEqual(409, status)
            # The inode is published but READY could not commit. Restart both owners, then retry.
            self.assertEqual('0', self.fixture_sql(self.identity,
                "SELECT count(*) FROM browser_sessions WHERE status NOT IN ('CLOSED','QUEUED');"),
                'Restart recovery requires a stand without another running browser')
            self.docker('restart', '--time', '1', 'helmglass-api-1', 'helmglass-browser-node-1')
            self.fixture_sql(self.identity, 'ALTER TABLE artifacts DROP CONSTRAINT ' + constraint + ';')
            constraint = None
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                status, _ = self.admin.api('/api/admin/browsers/' + session + '/retry-cleanup', 'POST', {})
                if status == 200:
                    break
                time.sleep(.4)
            self.assertEqual(200, status)
            self.wait_task(task, lambda value: value['browser']['cleanupState'] == 'COMPLETE')
            self.assertEqual('READY', self.fixture_sql(self.identity,
                "SELECT status FROM artifacts WHERE owner_id=:owner AND id='" + artifact + "';"))
            status, content, _ = self.client.request(self.client.base + '/api/artifacts/' + artifact + '/download')
            self.assertEqual(200, status)
            self.assertEqual(source['sha256'], hashlib.sha256(content).hexdigest())
            self.assertEqual(before, self.docker('exec', 'helmglass-api-1', 'stat', '--format', '%d:%i', '/data/artifacts/' + artifact))
            script = "import fs from 'node:fs';console.log(fs.existsSync('/artifacts/sessions/" + session + "'));"
            self.assertEqual('false', self.docker('exec', '-i', 'helmglass-browser-node-1',
                'node', '--input-type=module', script=script), 'Only temporary session data is removed')
            if self.current(task)['status'] != 'STOPPED':
                self.command(task, 'STOP')
            self.wait_task(task, lambda value: value['status'] == 'STOPPED'
                           and value['browser']['cleanupState'] == 'COMPLETE')
            status, closed_content, _ = self.client.request(self.client.base + '/api/artifacts/' + artifact + '/download')
            self.assertEqual((200, content), (status, closed_content))
        finally:
            if constraint:
                self.fixture_sql(self.identity, 'ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS ' + constraint + ';')
            if session:
                self.fixture_sql(self.identity, "UPDATE browser_sessions SET artifact_cursor=0 WHERE owner_id=:owner AND id='" + str(uuid.UUID(session)) + "';")
            if self.current(task)['status'] != 'STOPPED':
                self.command(task, 'STOP')
            if session and self.current(task)['browser']['cleanupState'] == 'FAILED':
                self.admin.api('/api/admin/browsers/' + session + '/retry-cleanup', 'POST', {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
