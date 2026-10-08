"""Atomic in-cabinet profile updates against deployed dev using a disposable account."""
import io
import json
import os
from pathlib import Path
import random
import subprocess
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor

from PIL import Image
import test_dev_contract as dev


class AccountConsoleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings = dict(line.split('=', 1) for line in Path(
            os.environ.get('HELM_TEST_ENV', 'deploy/.env.dev')).read_text(encoding='utf-8').splitlines()
            if line and not line.startswith('#') and '=' in line)
        cls.admin = dev.DevClient(cls.settings, 'admin', 'KEYCLOAK_APP_ADMIN_PASSWORD')
        cls.admin.login_web()
        cls.template = dev.DevClient(cls.settings, 'test', 'KEYCLOAK_TEST_PASSWORD').login_web()['id']

    purge_identity = dev.DevContractTest.purge_identity
    fixture_sql = dev.DevContractTest.fixture_sql

    def upload(self, client, name, version, content=None, mime='image/png', key=None, extra=None):
        boundary = 'helm-profile-' + uuid.uuid4().hex
        fields = {'name': name, 'expectedVersion': str(version), **(extra or {})}
        parts = [b'--' + boundary.encode() + b'\r\nContent-Disposition: form-data; name="'
                 + field.encode() + b'"\r\n\r\n' + value.encode() + b'\r\n'
                 for field, value in fields.items()]
        if content is not None:
            parts.append(b'--' + boundary.encode()
                + b'\r\nContent-Disposition: form-data; name="avatar"; filename="photo.bin"\r\nContent-Type: '
                + mime.encode() + b'\r\n\r\n' + content + b'\r\n')
        parts.append(b'--' + boundary.encode() + b'--\r\n')
        csrf = next((cookie.value for cookie in client.cookies if cookie.name == 'XSRF-TOKEN'), '')
        status, raw, _ = client.request(client.base + '/api/me', 'POST', b''.join(parts), {
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
            'X-XSRF-TOKEN': csrf, 'Idempotency-Key': key or str(uuid.uuid4())})
        return status, json.loads(raw) if raw.startswith(b'{') else {}

    @staticmethod
    def picture(format, size=(12, 9)):
        output = io.BytesIO()
        Image.new('RGB', size, (41, 89, 161)).save(output, format=format)
        return output.getvalue()

    def test_profile_name_avatar_atomic_validation_replay_and_purge(self):
        identity = dev.DisposableIdentity(self.settings, self.template)
        client = identity.client()
        profile = client.login_web()
        directory = '/data/artifacts/profiles/' + str(uuid.UUID(identity.id))
        purged = False
        try:
            self.assertNotIn('accountManagementUrl', profile)
            self.assertIsNone(profile['avatarUrl'])
            self.assertEqual(404, client.request(client.base + '/api/me/avatar')[0])
            key = str(uuid.uuid4())
            initial = profile
            status, profile = self.upload(client, '  Новое имя пользователя  ', initial['version'], key=key)
            self.assertEqual(200, status, profile)
            self.assertEqual('Новое имя пользователя', profile['name'])
            self.assertEqual(initial['email'], profile['email'])
            self.assertEqual(initial['version'] + 1, profile['version'])
            self.assertEqual((200, profile), self.upload(client, '  Новое имя пользователя  ', initial['version'], key=key))
            self.assertEqual(409, self.upload(client, 'Different', initial['version'], key=key)[0])
            self.assertEqual(400, self.upload(client, ' ', profile['version'])[0])
            self.assertEqual(400, self.upload(client, 'Changed email', profile['version'], extra={'email': 'foreign@example.com'})[0])
            client = identity.client()
            self.assertEqual(profile, client.login_web(), 'A fresh identity token must not overwrite the local display name')
            self.assertEqual(profile['name'], self.admin.api('/api/admin/users/' + identity.id)[1]['user']['name'])

            for format, mime in [('PNG', 'image/png'), ('JPEG', 'image/jpeg'), ('WEBP', 'image/webp')]:
                content = self.picture(format)
                previous = profile
                key = str(uuid.uuid4())
                status, profile = self.upload(client, 'Profile ' + format, previous['version'], content, mime, key)
                self.assertEqual(200, status, profile)
                self.assertEqual(previous['version'] + 1, profile['version'])
                self.assertEqual((200, profile), self.upload(client, 'Profile ' + format, previous['version'], content, mime, key))
                status, downloaded, headers = client.request(client.base + profile['avatarUrl'])
                self.assertEqual(200, status)
                self.assertEqual(content, downloaded)
                self.assertEqual(mime, headers['Content-Type'])
                self.assertEqual('nosniff', headers['X-Content-Type-Options'])
                self.assertIn('no-store', headers['Cache-Control'])
                self.assertEqual(404, self.admin.request(self.admin.base + profile['avatarUrl'])[0])
                if previous['avatarUrl']:
                    self.assertEqual(404, client.request(client.base + previous['avatarUrl'])[0])
                self.assertEqual(409, self.upload(client, 'Stale upload', previous['version'], content, mime)[0])
                self.assertEqual(profile, client.api('/api/me')[1])

            # A valid >4 MiB original proves the public proxy also admits the promised size range.
            large = io.BytesIO()
            Image.frombytes('RGB', (1280, 1280), random.Random(19).randbytes(1280 * 1280 * 3)).save(large, 'PNG')
            content = large.getvalue()
            self.assertGreater(len(content), 4 * 1024 * 1024)
            self.assertLessEqual(len(content), 5 * 1024 * 1024)
            status, profile = self.upload(client, 'Large original', profile['version'], content)
            self.assertEqual(200, status, profile)
            self.assertEqual(content, client.request(client.base + profile['avatarUrl'])[1])

            invalid = [(b'<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/png', 400),
                       (self.picture('PNG'), 'image/jpeg', 400),
                       (b'\x89PNG\r\n\x1a\ninvalid', 'image/png', 400),
                       (b'x' * (5 * 1024 * 1024 + 1), 'image/png', 413),
                       (self.picture('PNG', (5000, 4000)), 'image/png', 400)]
            for content, mime, expected in invalid:
                status, error = self.upload(client, 'Must not be committed', profile['version'], content, mime)
                self.assertEqual(expected, status, error)
                self.assertEqual(profile, client.api('/api/me')[1])
            current_url = profile['avatarUrl']
            with ThreadPoolExecutor(max_workers=2) as executor:
                replies = list(executor.map(lambda name: self.upload(client, name, profile['version']),
                                            ['Concurrent One', 'Concurrent Two']))
            self.assertEqual([200, 409], sorted(status for status, _ in replies))
            profile = client.api('/api/me')[1]
            self.assertEqual(current_url, profile['avatarUrl'], 'Saving only the name must preserve the photo')
            self.assertEqual(profile, identity.client().login_web())
            self.assertEqual('1', self.fixture_sql(identity,
                'SELECT count(*) FROM account_avatars WHERE owner_id=:owner;'))
            self.assertNotEqual('0', self.fixture_sql(identity,
                "SELECT count(*) FROM user_events WHERE owner_id=:owner AND resource='account';"))

            # The existing account cleanup cycle removes retired/orphan files under the owner lock.
            deadline = time.monotonic() + 95
            while time.monotonic() < deadline:
                result = subprocess.run(['docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
                    'exec', 'helmglass-api-1', 'find', directory, '-maxdepth', '1', '-type', 'f', '-printf', '%f\n'],
                    capture_output=True, text=True, timeout=20)
                self.assertEqual(0, result.returncode, 'The owned profile directory could not be inspected')
                names = result.stdout.splitlines()
                if names == [current_url.split('=')[1]]:
                    break
                time.sleep(.5)
            else:
                self.fail('Retired profile image files were not removed by the account cleanup cycle')

            self.purge_identity(identity)
            purged = True
            result = subprocess.run(['docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
                'exec', 'helmglass-api-1', 'test', '!', '-e', directory], capture_output=True, timeout=20)
            self.assertEqual(0, result.returncode, 'Purged account retained a profile image directory')
            self.assertEqual(404, identity.admin('/users/' + identity.id)[0])
            self.assertIn(client.request(client.base + current_url)[0], (401, 403))
        finally:
            if not purged:
                self.purge_identity(identity)


if __name__ == '__main__':
    unittest.main(verbosity=2)
