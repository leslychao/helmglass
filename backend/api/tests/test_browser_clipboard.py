"""Real Chrome/noVNC clipboard against dev; creates only one disposable connection."""
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

from test_dev_contract import DevClient


class BrowserClipboardTest(unittest.TestCase):
    def test_real_clipboard_and_viewer_isolation(self):
        settings = dict(line.split('=', 1) for line in Path(
            os.environ.get('HELM_TEST_ENV', 'deploy/.env.dev')).read_text(encoding='utf-8').splitlines()
            if line and not line.startswith('#') and '=' in line)
        client = DevClient(settings, 'test', 'KEYCLOAK_TEST_PASSWORD')
        client.login_web()
        docker = ['docker', '--host', 'tcp://' + settings['DEV_HOST'] + ':2375']
        filename = 'clipboard-' + uuid.uuid4().hex + '.html'
        destination = '/usr/share/nginx/html/' + filename
        fixture = (Path(__file__).parent / 'fixtures' / 'clipboard.html').read_text(encoding='utf-8')
        subprocess.run(docker + ['exec', '-i', '-u', '0', 'helmglass-frontend-1', 'sh', '-c',
            'cat > ' + destination], input=fixture, text=True, capture_output=True, check=True, timeout=20)
        connection_id = None
        try:
            status, connection = client.api('/api/connections', 'POST', {
                'name': 'Disposable clipboard acceptance', 'startUrl': client.base + '/' + filename})
            self.assertEqual(status, 200)
            connection_id = connection['id']
            viewer, visit = str(uuid.uuid4()), str(uuid.uuid4())
            status, opened = client.api('/api/connections/' + connection_id + '/login', 'POST', {
                'action': 'START', 'viewerId': viewer, 'pageVisitId': visit})
            self.assertEqual(status, 200)
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                _, opened = client.api('/api/connections/' + connection_id)
                if opened.get('browser') and opened['browser']['status'] == 'LIVE':
                    break
                time.sleep(.5)
            else:
                self.fail('Clipboard test browser did not become LIVE')
            cookies = [{'name': cookie.name, 'value': cookie.value, 'domain': cookie.domain,
                'path': cookie.path, 'secure': cookie.secure, 'httpOnly': cookie.has_nonstandard_attr('HttpOnly')}
                for cookie in client.cookies]
            completed = subprocess.run(['node', str(Path(__file__).parent / 'clipboard-browser.mjs')],
                input=json.dumps({'base': client.base, 'connectionId': connection_id, 'viewerId': viewer,
                    'fixtureUrl': client.base + '/' + filename, 'cookies': cookies}),
                text=True, capture_output=True, timeout=240)
            print(completed.stdout, end='')
            self.assertEqual(completed.returncode, 0, completed.stderr)
        finally:
            if connection_id:
                client.api('/api/connections/' + connection_id + '/login', 'POST', {'action': 'CLOSE'})
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    _, current = client.api('/api/connections/' + connection_id)
                    if (current.get('browser') or {}).get('status') == 'CLOSED':
                        break
                    time.sleep(.5)
                client.api('/api/connections/' + connection_id, 'DELETE')
            subprocess.run(docker + ['exec', '-u', '0', 'helmglass-frontend-1', 'rm', '-f', destination],
                capture_output=True, check=True, timeout=20)


if __name__ == '__main__':
    unittest.main()
