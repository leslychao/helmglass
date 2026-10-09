"""Connection-page lifetime against dev, using only disposable owners and browsers."""
import time
import unittest
import uuid
from urllib.request import Request

import test_dev_contract as dev
import test_connection_contract as connections


class BrowserPagesTest(unittest.TestCase):
    setUpClass = classmethod(dev.DevContractTest.setUpClass.__func__)
    setUp = connections.ConnectionContractTest.setUp
    tearDown = connections.ConnectionContractTest.tearDown
    owner = connections.ConnectionContractTest.owner
    create = connections.ConnectionContractTest.create
    saved_connection = connections.ConnectionContractTest.saved_connection
    await_connection = connections.ConnectionContractTest.await_connection
    fixture_sql = dev.DevContractTest.fixture_sql

    def start(self, client, wait_live=True):
        status, connection = client.api('/api/connections', 'POST', {
            'name': 'Page lifetime acceptance', 'startUrl': 'https://example.com'})
        self.assertEqual(200, status, connection)
        viewer, visit = str(uuid.uuid4()), str(uuid.uuid4())
        status, opened = client.api('/api/connections/' + connection['id'] + '/login', 'POST', {
            'action': 'START', 'viewerId': viewer, 'pageVisitId': visit})
        self.assertEqual(200, status, opened)
        if wait_live:
            opened = self.await_connection(client, connection['id'], lambda value:
                value['browser'] and value['browser']['status'] == 'LIVE')
        return opened, viewer, visit

    def page(self, client, browser, visit, method, viewer=None):
        path = '/api/browser-sessions/' + browser['id'] + '/pages/' + visit
        return client.api(path, method, {'viewerId': viewer} if viewer else {})

    def test_last_page_closes_standalone_and_other_owner_cannot_touch_it(self):
        _, client = self.owner()
        _, foreign = self.owner()
        connection, viewer, visit = self.start(client)
        browser = connection['browser']
        second = str(uuid.uuid4())
        self.assertEqual(404, self.page(foreign, browser, visit, 'DELETE')[0])
        self.assertEqual(404, self.page(foreign, browser, second, 'PUT', viewer)[0])
        self.assertEqual(200, self.page(client, browser, second, 'PUT', viewer)[0])
        self.assertEqual(200, self.page(client, browser, visit, 'DELETE')[0])
        self.assertEqual('LIVE', client.api('/api/connections/' + connection['id'])[1]['browser']['status'])
        self.assertEqual(200, self.page(client, browser, second, 'DELETE')[0])
        self.await_connection(client, connection['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertEqual(200, self.page(client, browser, second, 'DELETE')[0])
        # Closing a page must not prevent reconnecting the cabinet's shared event stream.
        with client.http.open(Request(client.base + '/api/events?browserVisit=' + second), timeout=10) as stream:
            self.assertEqual(200, stream.status)
            self.assertTrue(stream.readline())
        next_connection, _, next_visit = self.start(client)
        self.assertEqual(200, self.page(client, next_connection['browser'], next_visit, 'DELETE')[0])

    def test_expired_visit_closes_browser_but_reloaded_page_protects_it(self):
        identity, client = self.owner()
        connection, viewer, visit = self.start(client)
        browser = connection['browser']
        second = str(uuid.uuid4())
        self.assertEqual(200, self.page(client, browser, second, 'PUT', viewer)[0])

        def expire(visit_id):
            self.fixture_sql(identity, "UPDATE browser_page_visits SET expires_at=clock_timestamp() "
                "WHERE id='" + str(uuid.UUID(visit_id)) + "' AND session_id IN "
                "(SELECT id FROM browser_sessions WHERE owner_id=:owner);")
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                rows = self.fixture_sql(identity, "SELECT count(*) FROM browser_page_visits WHERE id='"
                    + str(uuid.UUID(visit_id)) + "';")
                if rows == '0':
                    return
                time.sleep(.5)
            self.fail('Expired page was not reaped')

        expire(visit)
        self.assertEqual('LIVE', client.api('/api/connections/' + connection['id'])[1]['browser']['status'])
        expire(second)
        self.await_connection(client, connection['id'], lambda value: value['browser']['status'] == 'CLOSED')

    def test_task_browser_survives_and_stale_page_cannot_release_new_controller(self):
        _, client = self.owner()
        connection = self.saved_connection(client, 'Task page lifetime', close=False)
        _, task = self.create(client)
        browser = task['browser']
        self.assertEqual(connection, browser['connectionId'])
        control_path = '/api/browser-sessions/' + browser['id'] + '/control'
        old_viewer, new_viewer = str(uuid.uuid4()), str(uuid.uuid4())
        old_visit, new_visit = str(uuid.uuid4()), str(uuid.uuid4())
        for viewer, visit in ((old_viewer, old_visit), (new_viewer, new_visit)):
            browser = self.await_connection(client, connection, lambda value:
                value['browser']['status'] == 'LIVE'
                and value['browser']['controlOwner'] != 'TRANSFERRING')['browser']
            status, browser = client.api(control_path, 'POST', {
                'type': 'BEGIN_LOGIN', 'viewerId': viewer, 'controlEpoch': browser['controlEpoch']})
            self.assertEqual(200, status, browser)
            browser = self.await_connection(client, connection, lambda value:
                value['browser']['controlOwner'] == 'USER')['browser']
            self.assertEqual(200, self.page(client, browser, visit, 'PUT', viewer)[0])
        self.assertEqual(200, self.page(client, browser, old_visit, 'DELETE')[0])
        current = client.api('/api/tasks/' + task['id'])[1]
        self.assertEqual(('LIVE', 'USER', browser['controlEpoch']), (
            current['browser']['status'], current['browser']['controlOwner'], current['browser']['controlEpoch']))
        pending_request = current['request']
        last_response = current['lastResponse']
        step_count = current['stepCount']
        self.assertEqual(200, self.page(client, browser, new_visit, 'DELETE')[0])
        self.await_connection(client, connection, lambda value:
            value['browser']['controlOwner'] == 'CHATGPT')
        current = client.api('/api/tasks/' + task['id'])[1]
        self.assertEqual(('LIVE', 'CHATGPT', 'WAITING_USER'), (
            current['browser']['status'], current['browser']['controlOwner'], current['status']))
        self.assertTrue(current['browser']['privateMode'])
        self.assertEqual('LOGIN', current['waitReason'])
        self.assertEqual(pending_request, current['request'])
        self.assertEqual(last_response, current['lastResponse'])
        self.assertEqual(step_count, current['stepCount'])
        self.assertEqual(200, client.api('/api/connections/' + connection, 'DELETE')[0])
        current = client.api('/api/tasks/' + task['id'])[1]
        self.assertEqual(('LIVE', 'WAITING_USER', browser['id']), (
            current['browser']['status'], current['status'], current['browser']['id']))
        self.assertEqual('ACCOUNT_CHOICE', current['request']['type'])
        self.assertEqual(last_response, current['lastResponse'])

    def test_authenticated_sse_keeps_background_page_alive_without_client_heartbeat(self):
        _, client = self.owner()
        connection, _, visit = self.start(client, wait_live=False)
        with client.http.open(Request(client.base + '/api/events?browserVisit=' + visit), timeout=30) as stream:
            self.await_connection(client, connection['id'], lambda value:
                value['browser']['status'] == 'LIVE')
            started = time.monotonic()
            while time.monotonic() - started < 65:
                self.assertTrue(stream.readline(), 'Authenticated page stream ended unexpectedly')
            self.assertEqual('LIVE', client.api('/api/connections/' + connection['id'])[1]['browser']['status'])
        self.assertEqual(200, self.page(client, connection['browser'], visit, 'DELETE')[0])
        self.await_connection(client, connection['id'], lambda value: value['browser']['status'] == 'CLOSED')


if __name__ == '__main__':
    unittest.main()
