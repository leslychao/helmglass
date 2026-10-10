"""Idle public WSS and broken-link recovery against dev, with a disposable browser."""
import json
import subprocess
import time
import unittest
import uuid

import test_dev_contract as dev
from test_viewer_revocation import ViewerSocket


VIEWER = r'''
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const url = new URL(input.ticket.url, input.publicUrl);
const endpoint = new URL('/' + url.searchParams.get('path'), input.publicUrl);
endpoint.protocol = 'wss:';
const started = Date.now();
let phase = 0, buffer = Buffer.alloc(0), pings = 0, ready = false, finished = false;
let dataAfterInit = 0, emptyClipboardMessages = 0;
const viewer = new WebSocket(endpoint, { origin: input.publicUrl,
  autoPong: input.mode !== 'unresponsive', handshakeTimeout: 10_000 });
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => fail(new Error('Viewer check timed out')), input.duration + 15_000);
  let observed;
  function fail(error) { if (finished) return; finished = true; clearTimeout(timeout); clearTimeout(observed); viewer.terminate(); reject(error); }
  function done() {
    if (finished) return;
    finished = true; clearTimeout(timeout); clearTimeout(observed); viewer.terminate();
    resolve({ mode: input.mode, pings, ready, elapsedMs: Date.now() - started, dataAfterInit, emptyClipboardMessages });
  }
  viewer.on('ping', () => {
    pings++;
    if (pings % 3 === 0) console.log(JSON.stringify({ progress: true, pings, elapsedMs: Date.now() - started }));
  });
  viewer.on('error', fail);
  viewer.on('close', () => {
    if (finished) return;
    if (input.mode === 'unresponsive' && ready && pings > 0) done();
    else fail(new Error(`Idle viewer closed after ${Date.now() - started} ms; pings=${pings}; ready=${ready}`));
  });
  viewer.on('message', raw => {
    try {
      if (ready) {
        // An empty ServerCutText after ServerInit is not a framebuffer update.
        if (raw.length === 8 && raw[0] === 3 && raw.readUInt32BE(4) === 0) emptyClipboardMessages++;
        else dataAfterInit += raw.length;
        return;
      }
      assert.ok(buffer.length + raw.length <= 65536, 'Bound the RFB handshake');
      buffer = Buffer.concat([buffer, raw]);
      while (!ready) {
        if (phase === 0) {
          if (buffer.length < 12) return;
          assert.equal(buffer.subarray(0, 12).toString(), 'RFB 003.008\n');
          buffer = buffer.subarray(12); viewer.send('RFB 003.008\n'); phase++;
        } else if (phase === 1) {
          if (buffer.length < 1 || buffer.length < 1 + buffer[0]) return;
          const count = buffer[0]; assert.ok(buffer.subarray(1, 1 + count).includes(1));
          buffer = buffer.subarray(1 + count); viewer.send(Buffer.from([1])); phase++;
        } else if (phase === 2) {
          if (buffer.length < 4) return;
          assert.equal(buffer.readUInt32BE(), 0);
          buffer = buffer.subarray(4); viewer.send(Buffer.from([1])); phase++;
        } else {
          if (buffer.length < 24) return;
          const size = 24 + buffer.readUInt32BE(20); assert.ok(size <= 65536);
          if (buffer.length < size) return;
          ready = true; buffer = Buffer.alloc(0);
          // Complete RFB initialization but request no frames: only native heartbeat can keep this idle route alive.
          if (input.mode !== 'unresponsive') observed = setTimeout(() => {
            try { assert.equal(viewer.readyState, WebSocket.OPEN); assert.ok(pings >= Math.floor(input.duration / 20_000)); done(); }
            catch (error) { fail(error); }
          }, input.duration);
        }
      }
    } catch (error) { fail(error); }
  });
});
console.log(JSON.stringify(result));
'''


class ViewerHeartbeatTest(unittest.TestCase):
    setUpClass = classmethod(dev.DevContractTest.setUpClass.__func__)
    fixture_sql = dev.DevContractTest.fixture_sql

    def test_full_viewer_capacity_rejects_ticket_and_allows_replacement_and_recovery(self):
        identity = dev.DisposableIdentity(self.settings, self.me['id'])
        self.addCleanup(dev.DevContractTest.purge_identity, self, identity)
        client = identity.client()
        client.login_web()
        client.login_mcp()
        error, created, _ = client.tool('tasks.create', {'operationKey': str(uuid.uuid4()), 'task': {
            'title': 'Viewer capacity acceptance', 'goal': 'Verify viewer admission and recovery',
            'startUrl': 'https://example.com', 'prepare': True}})
        self.assertFalse(error, created)
        task_id = created['task']['id']

        def task():
            status, value = client.api('/api/tasks/' + task_id)
            self.assertEqual(200, status)
            return value

        sockets = []
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                current = task()
                if current.get('browser', {}).get('status') == 'LIVE':
                    break
                time.sleep(.2)
            self.assertEqual('LIVE', current['browser']['status'])
            browser_id = current['browser']['id']
            viewer_ids = [str(uuid.uuid4()) for _ in range(3)]

            def ticket(viewer_id):
                return client.api('/api/browser-sessions/' + browser_id + '/ticket', 'POST',
                    {'role': 'VIEWER', 'viewerId': viewer_id})

            for viewer_id in viewer_ids[:2]:
                status, value = ticket(viewer_id)
                self.assertEqual(200, status, value)
                sockets.append(ViewerSocket(client.base, value))
                self.assertEqual(101, sockets[-1].status)
            status, denied = ticket(viewer_ids[2])
            self.assertEqual(409, status, 'A full viewer group must reject ticket issuance')
            self.assertEqual('VIEWER_LIMIT_REACHED', denied['code'])

            status, replacement = ticket(viewer_ids[0])
            self.assertEqual(200, status, replacement)
            sockets.append(ViewerSocket(client.base, replacement))
            self.assertEqual(101, sockets[-1].status)
            self.assertTrue(sockets[0].closed(5), 'Replacement releases the previous transport')
            self.assertEqual(409, ticket(viewer_ids[2])[0], 'Replacement occupies only one slot')

            sockets[1].close()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                status, recovered = ticket(viewer_ids[2])
                if status == 200:
                    break
                self.assertEqual(409, status)
                time.sleep(.1)
            self.assertEqual(200, status, recovered)
            sockets.append(ViewerSocket(client.base, recovered))
            self.assertEqual(101, sockets[-1].status)
            self.assertEqual(browser_id, task()['browser']['id'])
            self.assertEqual('LIVE', task()['browser']['status'])
        finally:
            for viewer in sockets:
                viewer.close()
            current = task()
            self.assertEqual(200, client.api('/api/tasks/' + task_id + '/commands', 'POST', {
                'type': 'STOP', 'expectedVersion': current['version']})[0])

    def test_idle_public_view_and_missing_pong_recover_without_replacing_browser(self):
        identity = dev.DisposableIdentity(self.settings, self.me['id'])
        self.addCleanup(dev.DevContractTest.purge_identity, self, identity)
        client = identity.client()
        client.login_web()
        client.login_mcp()
        error, created, _ = client.tool('tasks.create', {'operationKey': str(uuid.uuid4()), 'task': {
            'title': 'Viewer heartbeat acceptance', 'goal': 'Verify idle stream and reconnect',
            'startUrl': 'https://example.com', 'prepare': True}})
        self.assertFalse(error, created)
        task_id = created['task']['id']

        def task():
            status, value = client.api('/api/tasks/' + task_id)
            self.assertEqual(200, status)
            return value

        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                current = task()
                if current.get('browser', {}).get('status') == 'LIVE':
                    break
                time.sleep(.2)
            self.assertEqual('LIVE', current['browser']['status'])
            browser = current['browser']
            viewer_id = str(uuid.uuid4())
            for mode, duration in [('unresponsive', 35_000), ('reconnected', 21_000), ('idle', 240_000)]:
                # Each transport observation stays inside the task's five-minute idle lifetime.
                self.assertEqual(200, client.api('/api/browser-sessions/' + browser['id'] + '/keep-open',
                    'POST', {})[0])
                status, ticket = client.api('/api/browser-sessions/' + browser['id'] + '/ticket',
                    'POST', {'role': 'VIEWER', 'viewerId': viewer_id})
                self.assertEqual(200, status, ticket)
                script = 'const input = ' + json.dumps({'ticket': ticket, 'publicUrl': client.base,
                    'mode': mode, 'duration': duration}) + ';\n' + VIEWER
                result = subprocess.run(['docker', '-H', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
                    'exec', '-i', 'helmglass-browser-node-1', 'node', '--input-type=module', '-'],
                    input=script, text=True, capture_output=True, timeout=duration / 1000 + 25)
                self.assertEqual(0, result.returncode, result.stderr)
                self.assertTrue(result.stdout.strip(), 'The diagnostic channel ended without a viewer result')
                observed = json.loads(result.stdout.strip().splitlines()[-1])
                print('Viewer transport:', json.dumps(observed), flush=True)
                self.assertTrue(observed['ready'])
                self.assertEqual(0, observed['dataAfterInit'], 'The idle test must not rely on changing frames')
                self.assertLessEqual(observed['emptyClipboardMessages'], 1,
                    'Repeated clipboard traffic must not keep the idle test alive')
                current = task()
                self.assertEqual(browser['id'], current['browser']['id'])
                self.assertEqual(browser['controlEpoch'], current['browser']['controlEpoch'])
                self.assertEqual('LIVE', current['browser']['status'])
        finally:
            current = task()
            self.assertEqual(200, client.api('/api/tasks/' + task_id + '/commands', 'POST', {
                'type': 'STOP', 'expectedVersion': current['version']})[0])
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and task()['status'] != 'STOPPED':
                time.sleep(.2)
            self.assertEqual('STOPPED', task()['status'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
