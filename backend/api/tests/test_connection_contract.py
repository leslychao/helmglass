"""Deployed admission and connection contracts with disposable accounts."""
import base64
import json
from pathlib import Path
import time
import unittest
from urllib.parse import urlencode
import uuid
import test_dev_contract as dev


class ConnectionContractTest(unittest.TestCase):
    setUpClass = classmethod(dev.DevContractTest.setUpClass.__func__)
    fixture_sql = dev.DevContractTest.fixture_sql
    wait_operation = dev.DevContractTest.wait_operation

    def setUp(self):
        self.identities = []
        self.tasks = []

    def owner(self):
        identity = dev.DisposableIdentity(self.settings, self.me["id"])
        self.identities.append(identity)
        client = identity.client()
        client.login_web()
        client.login_mcp()
        return identity, client

    def create(self, primary, url="https://example.com", preferred=None):
        client = dev.DevClient(primary.settings, primary.user, primary.password_key)
        client.token = primary.token
        error, state, _ = client.tool("tasks.create", {"operationKey":str(uuid.uuid4()),"task":{
            "title":"Disposable connection contract", "goal":"Verify account coordination", "startUrl":url,
            "prepare":True,"preferredConnectionIds":preferred or []}})
        self.assertFalse(error,state)
        task = state["task"]
        self.tasks.append((primary,task["id"]))
        return client,task

    def observe(self, client, task):
        deadline = time.monotonic() + 40
        while True:
            error, task, _ = client.tool('tasks.get', {'taskId': task['id']})
            self.assertFalse(error, task)
            if not task.get('browser') or task['browser']['controlOwner'] != 'TRANSFERRING':
                break
            self.assertLess(time.monotonic(), deadline, 'Control adoption did not settle')
            time.sleep(.2)
        operation = str(uuid.uuid4())
        action = {"operationId":operation,"type":"observe","arguments":{},"instructionRevision":task["instructionRevision"]}
        if task.get("browser"):
            action["controlEpoch"] = task["browser"]["controlEpoch"]
        error, receipt, _ = client.execute_browser({"taskId":task["id"],"action":action})
        self.assertFalse(error,receipt)
        return operation

    def tearDown(self):
        for client,task_id in self.tasks:
            for attempt in range(5):
                status,task = client.api("/api/tasks/"+task_id)
                if status!=200 or task["status"] in ("STOPPED","STOPPING"):
                    break
                status,_=client.api("/api/tasks/"+task_id+"/commands","POST",{
                    "type":"STOP","expectedVersion":task["version"]})
                if status==200:
                    break
                self.assertEqual(409,status)
            else:
                self.fail("Could not stop disposable concurrent task")
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if all(client.api("/api/tasks/"+task_id)[1]["status"]=="STOPPED" for client,task_id in self.tasks):
                break
            time.sleep(.5)
        for identity in self.identities:
            path="/api/admin/users/"+identity.id
            _,detail=self.admin.api(path)
            self.assertEqual(200,self.admin.api(path+"/commands","POST",{
                "type":"REQUEST_DELETION","expectedVersion":detail["user"]["version"],
                "reason":"Remove disposable connection acceptance"})[0])
            self.fixture_sql(identity,"UPDATE accounts SET deletion_due_at=clock_timestamp() WHERE id=:owner;")
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if all(self.admin.api("/api/admin/users/"+identity.id)[1]["user"]["status"]=="DELETED" for identity in self.identities):
                return
            time.sleep(.5)
        self.fail("Disposable connection fixture cleanup was not confirmed")

    def test_admin_usage_never_contains_private_sites(self):
        identity,client=self.owner()
        sentinel="private-contract-"+uuid.uuid4().hex+".example.com"
        self.create(client,"https://"+sentinel)
        status,detail=self.admin.api("/api/admin/users/"+identity.id)
        self.assertEqual(200,status)
        self.assertNotIn(sentinel,json.dumps(detail))
        self.assertEqual({"totalTasks","successfulTasks","completedTasks","successRate","usage",
                          "commands","from","to","days"},set(detail["usage"]))
        for size in (10,20,50):
            status, page = self.admin.api("/api/admin/users/"+identity.id+"?taskPageSize="+str(size)+"&auditPageSize="+str(size))
            self.assertEqual(200,status)
            self.assertEqual(size,page["tasks"]["pageSize"])
            self.assertEqual(size,page["audit"]["pageSize"])
        self.assertEqual(400,self.admin.api("/api/admin/users/"+identity.id+"?taskPageSize=11")[0])

    def test_autocomplete_limits_exact_task_and_owner_scopes(self):
        _, primary = self.owner()
        _, other = self.owner()
        marker = "autocomplete-" + uuid.uuid4().hex[:12]
        created = []
        sites = []
        for index in range(4):
            site = str(index) + "." + marker + ".example.com"
            sites.append(site)
            status, task = primary.api("/api/tasks", "POST", {
                "title": marker + (" duplicate" if index < 2 else " " + str(index)),
                "goal": "Verify autocomplete filtering without starting a browser",
                "startUrl": "https://" + site, "outputFormat": "TEXT", "prepare": False})
            self.assertEqual(200, status, task)
            created.append(task)
            status, connection = primary.api("/api/connections", "POST", {
                "name": marker + " " + str(index), "startUrl": "https://" + site})
            self.assertEqual(200, status, connection)

        def get(client, path, **query):
            status, result = client.api(path + "?" + urlencode(query, doseq=True))
            self.assertEqual(200, status, result)
            return result

        for path in ("/api/tasks", "/api/tasks/sites", "/api/connections/sites"):
            page = get(primary, path, search=marker, suggestions="true", page=99, pageSize=50)
            self.assertEqual((4, 1, 3, 3),
                             (page["total"], page["page"], page["pageSize"], len(page["items"])))
            self.assertEqual(0, get(primary, path, search="missing-" + marker,
                                    suggestions="true")["total"])
            self.assertEqual(0, get(other, path, search=marker, suggestions="true")["total"])

        duplicates = get(primary, "/api/tasks", search=marker + " duplicate", suggestions="true")
        self.assertEqual(2, len(duplicates["items"]))
        self.assertEqual(2, len({task["id"] for task in duplicates["items"]}))
        self.assertEqual(1, len(get(primary, "/api/tasks", search=created[0]["id"],
                                   suggestions="true")["items"]))
        self.assertEqual(1, len(get(primary, "/api/tasks/sites", search=sites[0],
                                   suggestions="true")["items"]))
        self.assertEqual(1, len(get(primary, "/api/connections/sites", search=sites[0],
                                   suggestions="true")["items"]))

        for client, expected in ((primary, 1), (other, 0)):
            # The ID is authoritative even if a previously displayed title has changed.
            filters = {"taskId": created[0]["id"], "search": "old displayed title"}
            page = get(client, "/api/tasks", **filters)
            summary = get(client, "/api/tasks/summary", **filters)
            self.assertEqual(expected, page["total"])
            self.assertEqual(expected, summary["total"])
            if expected:
                self.assertEqual(created[0]["id"], page["items"][0]["id"])

        for path in ("/api/tasks", "/api/connections"):
            page = get(primary, path, site=sites[:3])
            self.assertEqual(3, page["total"])
            self.assertEqual(set(sites[:3]), {item["site"] for item in page["items"]})
        self.assertEqual(3, get(primary, "/api/tasks/summary", site=sites[:3])["total"])
        self.assertEqual(0, get(primary, "/api/tasks", taskId=created[0]["id"], site=sites[1])["total"])
        self.assertEqual(0, get(primary, "/api/tasks/summary", taskId=created[0]["id"], site=sites[1])["total"])
        self.assertEqual(400, primary.api("/api/tasks?taskId=invalid")[0])
        # Removing the UI search does not break existing callers of the connection API.
        self.assertEqual(1, get(primary, "/api/connections", search=marker + " 3")["total"])

    def test_admin_usage_counts_unique_commands_and_splits_calendar_intervals(self):
        identity, primary = self.owner()
        client, task = self.create(primary)
        operation = self.observe(client, task)
        self.assertEqual('SUCCEEDED', self.wait_operation(operation, client)['status'])
        action = {'operationId': operation, 'type': 'observe', 'arguments': {},
                  'instructionRevision': task['instructionRevision']}
        if task.get('browser'):
            action['controlEpoch'] = task['browser']['controlEpoch']
        error, _, _ = client.execute_browser({'taskId': task['id'], 'action': action})
        self.assertFalse(error)
        self.fixture_sql(identity, """
INSERT INTO usage_intervals(id,owner_id,kind,started_at,ended_at,incomplete)
SELECT gen_random_uuid(),:owner,'BROWSER',
  (date_trunc('day',clock_timestamp() AT TIME ZONE 'Europe/Saratov')-interval '25 hours') AT TIME ZONE 'Europe/Saratov',
  (date_trunc('day',clock_timestamp() AT TIME ZONE 'Europe/Saratov')-interval '23 hours') AT TIME ZONE 'Europe/Saratov',true;
""")
        endpoint = '/api/admin/users/' + identity.id + '?timezone=Europe%2FSaratov&usagePageSize=10'
        status, detail = self.admin.api(endpoint)
        self.assertEqual(200, status)
        usage = detail['usage']
        self.assertEqual(1, usage['commands'], 'Repeated operation ID must not add a command')
        days = usage['days']['items']
        self.assertEqual(7, usage['days']['total'])
        self.assertEqual(7, len(days))
        self.assertEqual(1, sum(day['commands'] for day in days))
        self.assertEqual(usage['from'], days[0]['date'])
        self.assertEqual(usage['to'], days[-1]['date'])
        for day in days[-3:-1]:
            self.assertEqual(3600, day['browserSeconds'])
            self.assertTrue(day['incomplete'])
            self.assertEqual(0, day['commands'])
        for day in days[:-3]:
            self.assertEqual((0, 0, False),
                             (day['commands'], day['browserSeconds'], day['incomplete']))
        for day in days:
            self.assertEqual({'date','commands','browserSeconds','incomplete'}, set(day))
        self.assertNotIn('example.com', json.dumps(usage))
        self.assertEqual(usage['commands'], self.admin.api(endpoint)[1]['usage']['commands'])

    def await_connection(self, client, connection, predicate):
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            status,value=client.api("/api/connections/"+connection)
            self.assertEqual(200,status,value)
            if predicate(value):
                return value
            time.sleep(.3)
        self.fail("Connection transition was not confirmed")

    def test_deleting_connection_cancels_unacknowledged_control_transfer(self):
        identity, client = self.owner()
        status, connection = client.api('/api/connections', 'POST', {
            'name': 'Delete unacknowledged control fixture', 'startUrl': 'https://example.com'})
        self.assertEqual(200, status, connection)
        path = '/api/connections/' + connection['id']
        viewer = str(uuid.uuid4())
        self.assertEqual(200, client.api(path + '/login', 'POST', {
            'action': 'START', 'viewerId': viewer})[0])
        opened = self.await_connection(client, connection['id'], lambda value:
            value.get('browser') and value['browser']['status'] == 'LIVE'
            and value['browser']['controlOwner'] == 'USER')
        browser = opened['browser']
        # A stale durable intent is refused by the real worker and cannot finish on its own.
        intent = json.dumps({'input': {'type': 'BEGIN_LOGIN', 'viewerId': viewer,
                                      'saveConnection': False}, 'keepPrivate': False})
        self.fixture_sql(identity, "UPDATE browser_sessions SET control_owner='TRANSFERRING',"
            "control_epoch=0,pending_control='" + intent + "'::jsonb WHERE owner_id=:owner AND id='"
            + str(uuid.UUID(browser['id'])) + "';")
        try:
            self.assertEqual(404, self.user.api(path, 'DELETE')[0])
            key = str(uuid.uuid4())
            status, receipt = client.api(path, 'DELETE', key=key)
            self.assertEqual(200, status, receipt)
            self.assertEqual(receipt, client.api(path, 'DELETE', key=key)[1])
            self.assertEqual(404, client.api(path)[0])
            self.assertEqual('t', self.fixture_sql(identity,
                "SELECT close_requested AND pending_control IS NULL FROM browser_sessions "
                "WHERE owner_id=:owner AND id='" + str(uuid.UUID(browser['id'])) + "';"))
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                state = self.fixture_sql(identity,
                    "SELECT b.status||':'||c.status FROM browser_sessions b JOIN connections c "
                    "ON c.id=b.connection_id WHERE b.owner_id=:owner AND b.id='"
                    + str(uuid.UUID(browser['id'])) + "';")
                if state == 'CLOSED:DELETED':
                    break
                time.sleep(.5)
            self.assertEqual('CLOSED:DELETED', state)
        finally:
            # Restore only a failed test's still-visible fixture so normal cleanup can finish.
            if client.api(path)[0] == 200:
                self.fixture_sql(identity, "UPDATE browser_sessions SET control_owner='USER',"
                    "pending_control=NULL,control_epoch=" + str(browser['controlEpoch'])
                    + " WHERE owner_id=:owner AND id='" + str(uuid.UUID(browser['id'])) + "';")
                self.assertEqual(200, client.api(path, 'DELETE')[0])

    def test_deleting_connection_releases_standalone_browser_capacity(self):
        identity, primary = self.owner()
        endpoint = "/api/admin/users/" + identity.id
        _, detail = self.admin.api(endpoint)
        self.assertEqual(200, self.admin.api(endpoint + "/commands", "POST", {
            "type": "LIMITS", "expectedVersion": detail["user"]["version"],
            "reason": "Verify connection deletion releases its browser",
            "browserLimitMode": "CUSTOM", "browserLimit": 1, "waitingLimit": None})[0])

        def open_connection(name, expected):
            status, connection = primary.api("/api/connections", "POST", {
                "name": name, "startUrl": "https://example.com"})
            self.assertEqual(200, status, connection)
            self.assertEqual(200, primary.api(
                "/api/connections/" + connection["id"] + "/login", "POST", {
                    "action": "START", "viewerId": str(uuid.uuid4())})[0])
            return self.await_connection(primary, connection["id"], lambda value:
                value.get("browser") and value["browser"]["status"] == expected)

        def await_closed(browser):
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                state = self.fixture_sql(identity,
                    "SELECT status FROM browser_sessions WHERE owner_id=:owner AND id='"
                    + str(uuid.UUID(browser["id"])) + "';")
                if state == "CLOSED":
                    return
                time.sleep(.5)
            self.fail("Deleted connection still occupies a browser: " + state)

        active = open_connection("Deleted live browser", "LIVE")
        waiting = open_connection("Waiting for released browser slot", "QUEUED")
        cancelled = open_connection("Deleted queued browser", "QUEUED")
        self.assertEqual(404, self.user.api(
            "/api/connections/" + active["id"], "DELETE")[0])
        self.assertEqual(200, primary.api(
            "/api/connections/" + cancelled["id"], "DELETE")[0])
        await_closed(cancelled["browser"])
        self.assertEqual(200, primary.api(
            "/api/connections/" + active["id"], "DELETE")[0])
        await_closed(active["browser"])
        admitted = self.await_connection(primary, waiting["id"], lambda value:
            value.get("browser") and value["browser"]["status"] == "LIVE")
        self.assertEqual(waiting["browser"]["id"], admitted["browser"]["id"])
        self.assertEqual(200, primary.api(
            "/api/connections/" + waiting["id"], "DELETE")[0])
        await_closed(admitted["browser"])

        for connection in (active, waiting, cancelled):
            self.assertEqual(404, primary.api("/api/connections/" + connection["id"])[0])
            result = dev.subprocess.run([
                "docker", "--host", "tcp://" + self.settings["DEV_HOST"] + ":2375",
                "ps", "-aq", "--filter", "name=helm-browser-" + connection["browser"]["id"]],
                capture_output=True, text=True, timeout=20)
            self.assertEqual(0, result.returncode)
            self.assertEqual("", result.stdout.strip(), "Browser containers must actually be removed")

    def saved_connection(self, client, suffix, close=True, url="https://example.com"):
        status,value=client.api("/api/connections","POST",{
            "name":"Anonymous profile "+suffix,"startUrl":url})
        self.assertEqual(200,status,value)
        connection=value["id"]
        viewer=str(uuid.uuid4())
        path="/api/connections/"+connection+"/login"
        self.assertEqual(200,client.api(path,"POST",{"action":"START","viewerId":viewer})[0])
        opened=self.await_connection(client,connection,lambda value:value.get("browser") and value["browser"]["status"]=="LIVE")
        self.assertTrue(opened["browser"]["privateMode"])
        self.assertEqual("USER",opened["browser"]["controlOwner"])
        status,receipt=client.api(path,"POST",{"action":"SAVE","viewerId":viewer,
            "accountLabel":"Anonymous "+suffix,"accountSubject":"anonymous-"+suffix})
        self.assertEqual(200,status,receipt)
        value=self.await_connection(client,connection,lambda value:value["status"]=="READY" and value["browser"]["controlOwner"]=="NONE")
        self.assertEqual(opened["browser"]["id"],value["browser"]["id"])
        if close:
            self.assertEqual(200,client.api(path,"POST",{"action":"CLOSE","viewerId":viewer})[0])
            self.await_connection(client,connection,lambda value: value["browser"]["status"] == "CLOSED")
        return connection

    def test_single_live_saved_connection_is_adopted_by_the_task(self):
        _,primary=self.owner()
        connection=self.saved_connection(primary,"Adoption",close=False)
        standalone=primary.api("/api/connections/"+connection)[1]["browser"]
        self.assertEqual(("LIVE","NONE"),(standalone["status"],standalone["controlOwner"]))
        client,task=self.create(primary)
        self.assertEqual(standalone["id"],task["browser"]["id"])
        self.assertIsNone(task["request"])
        self.assertEqual("SUCCEEDED",self.wait_operation(self.observe(client,task),client)["status"])
        task=primary.api("/api/tasks/"+task["id"])[1]
        self.assertEqual(standalone["id"],task["browser"]["id"])
        self.assertEqual("CHATGPT",task["browser"]["controlOwner"])

    def test_subdomain_account_choice_respects_site_boundaries(self):
        identity, primary = self.owner()
        _, foreign = self.owner()
        cases = [
            ('region-one.com', 'login.region-one.ru', 'docs.region-one.ru', 'region-one.net'),
            ('region-two.ru', 'login.region-two.com', 'docs.region-two.com', 'other.ru'),
            ('uk.ru', 'login.uk.ru', 'docs.uk.ru', 'uk.com'),
            ('yang.yandex-team.ru', 'passport.yandex-team.ru', 'wiki.yandex-team.ru',
             'yandex-team.ru.evil.com'),
            ('app.example.co.uk', 'login.example.co.uk', 'docs.example.co.uk', 'other.co.uk'),
            ('alice.github.io', 'login.alice.github.io', 'docs.alice.github.io', 'bob.github.io'),
            ('amazonaws.com', 'www.amazonaws.com', 'docs.amazonaws.com', 'bucket.s3.amazonaws.com'),
            ('alice.internal', 'alice.internal', 'alice.internal', 'docs.alice.internal'),
            ('127.0.0.1', '127.0.0.1', '127.0.0.1', '127.0.0.2'),
        ]
        for first_host, second_host, target_host, unrelated_host in cases:
            with self.subTest(target=target_host):
                candidates = []
                hosts = [first_host, second_host, unrelated_host]
                if target_host == 'docs.amazonaws.com':
                    hosts.extend('bucket-' + str(index) + '.s3.amazonaws.com' for index in range(50))
                for index, host in enumerate(hosts):
                    status, connection = primary.api('/api/connections', 'POST', {
                        'name': ('Z candidate ' if index < 2 else 'A unrelated ') + str(index),
                        'startUrl': 'https://' + host})
                    self.assertEqual(200, status, connection)
                    candidates.append(connection['id'])
                created_ids = ','.join("'" + str(uuid.UUID(value)) + "'" for value in candidates)
                self.fixture_sql(identity, "UPDATE connections SET status='READY' WHERE owner_id=:owner"
                    + " AND id IN (" + created_ids + ");")
                status, foreign_connection = foreign.api('/api/connections', 'POST', {
                    'name': 'Foreign site boundary', 'startUrl': 'https://' + target_host})
                self.assertEqual(200, status, foreign_connection)
                client, task = self.create(primary, 'https://' + target_host)
                self.assertIsNotNone(task['request'], task)
                self.assertEqual('ACCOUNT_CHOICE', task['request']['type'])
                self.assertEqual(set(candidates[:2]),
                    {option['id'] for option in task['request']['options']})
                for refused in (candidates[2], foreign_connection['id']):
                    error, receipt, _ = client.respond(task, {'connectionId': refused})
                    self.assertTrue(error, receipt)
                preferred_client, preferred = self.create(primary, 'https://' + target_host,
                                                          preferred=candidates[:2])
                self.assertEqual('ACCOUNT_CHOICE', preferred['request']['type'])
                self.assertEqual(set(candidates[:2]),
                    {option['id'] for option in preferred['request']['options']})
                self.assertTrue(preferred_client.respond(preferred,
                    {'connectionId': candidates[2]})[0])

                # Requests without saved choices rebuild the same site boundary in the host form.
                self.fixture_sql(identity, "UPDATE task_requests SET options='[]'::jsonb"
                    + " WHERE owner_id=:owner AND id='"
                    + str(uuid.UUID(task['request']['id'])) + "' AND status='PENDING';")
                forms = []
                client.elicitation_handler = lambda form: forms.append(form) or {'action': 'decline'}
                try:
                    error, receipt, _ = client.tool('tasks.respond', {
                        'taskId': task['id'], 'requestId': task['request']['id'],
                        'requestVersion': task['request']['version'],
                        'operationKey': str(uuid.uuid4())})
                finally:
                    client.elicitation_handler = None
                self.assertTrue(error, receipt)
                self.assertEqual(1, len(forms), receipt)
                offered = forms[0]['requestedSchema']['properties']['connectionId']['oneOf']
                self.assertEqual(set(candidates[:2]), {option['const'] for option in offered})

    def test_subdomains_reuse_saved_accounts_and_keep_switch_destination(self):
        _, primary = self.owner()
        target = 'https://www.example.com/'
        first = self.saved_connection(primary, 'Subdomain A')
        automatic_client, automatic = self.create(primary, target)
        self.assertEqual(first, automatic['browser']['connectionId'])
        self.assertIsNone(automatic['request'])
        observation = self.wait_operation(self.observe(automatic_client, automatic), automatic_client)
        self.assertEqual('SUCCEEDED', observation['status'], observation)
        current = primary.api('/api/tasks/' + automatic['id'])[1]
        self.assertEqual(target, current['browser']['currentUrl'])
        self.assertEqual(200, primary.api('/api/tasks/' + current['id'] + '/commands', 'POST', {
            'type': 'STOP', 'expectedVersion': current['version']})[0])
        self.await_connection(primary, first, lambda value: value['browser']['status'] == 'CLOSED')

        second = self.saved_connection(primary, 'Subdomain B')
        client, task = self.create(primary, target, preferred=[first])
        self.assertEqual(first, task['browser']['connectionId'])
        self.assertEqual('SUCCEEDED', self.wait_operation(self.observe(client, task), client)['status'])
        task = primary.api('/api/tasks/' + task['id'])[1]
        browser_id = task['browser']['id']
        error, receipt, _ = client.tool('connections.select', {
            'taskId': task['id'], 'connectionId': second,
            'instructionRevision': task['instructionRevision'], 'operationKey': str(uuid.uuid4())})
        self.assertFalse(error, receipt)
        error, operations, _ = client.tool('operations.list', {'taskId': task['id']})
        self.assertFalse(error, operations)
        switches = [item for item in operations['items'] if item['type'] == 'applyConnection']
        self.assertEqual(1, len(switches))
        switched = self.wait_operation(switches[0]['id'], client)
        self.assertEqual('SUCCEEDED', switched['status'], switched)
        current = primary.api('/api/tasks/' + task['id'])[1]
        self.assertEqual((browser_id, second, target),
            (current['browser']['id'], current['browser']['connectionId'],
             current['browser']['currentUrl']))
        self.assertIsNone(current['request'])
        self.assertEqual('SUCCEEDED', self.wait_operation(self.observe(client, current), client)['status'])

    def test_com_ru_alias_preserves_saved_profile_and_switch_destination(self):
        identity, primary = self.owner()
        target = 'https://example.com/'

        def saved_ru_entry(label):
            connection = self.saved_connection(primary, label, url=target)
            # Model a .ru entry whose login reached .com. Keep the actual saved origins.
            self.fixture_sql(identity,
                "UPDATE connections SET site='example.ru',start_url='https://example.ru/' "
                "WHERE owner_id=:owner AND id='" + str(uuid.UUID(connection)) + "';")
            return connection

        first = saved_ru_entry('Alias A')
        automatic_client, automatic = self.create(primary, target)
        self.assertIsNone(automatic['request'])
        self.assertEqual(first, automatic['browser']['connectionId'])
        self.assertEqual('SUCCEEDED',
            self.wait_operation(self.observe(automatic_client, automatic), automatic_client)['status'])
        current = primary.api('/api/tasks/' + automatic['id'])[1]
        self.assertEqual(target, current['browser']['currentUrl'])
        self.assertEqual('example.com', current['site'])
        self.assertEqual('example.ru', primary.api('/api/connections/' + first)[1]['site'])
        self.assertEqual('["https://example.com"]', self.fixture_sql(identity,
            "SELECT authorized_origins::text FROM connections WHERE owner_id=:owner AND id='"
            + str(uuid.UUID(first)) + "';"))
        self.assertEqual(200, primary.api('/api/tasks/' + current['id'] + '/commands', 'POST', {
            'type': 'STOP', 'expectedVersion': current['version']})[0])
        self.await_connection(primary, first, lambda value: value['browser']['status'] == 'CLOSED')

        second = saved_ru_entry('Alias B')
        client, task = self.create(primary, target, preferred=[first])
        self.assertEqual(first, task['browser']['connectionId'])
        self.assertEqual('SUCCEEDED', self.wait_operation(self.observe(client, task), client)['status'])
        task = primary.api('/api/tasks/' + task['id'])[1]
        browser_id = task['browser']['id']
        error, receipt, _ = client.tool('connections.select', {
            'taskId': task['id'], 'connectionId': second,
            'instructionRevision': task['instructionRevision'], 'operationKey': str(uuid.uuid4())})
        self.assertFalse(error, receipt)
        error, operations, _ = client.tool('operations.list', {'taskId': task['id']})
        self.assertFalse(error, operations)
        switches = [item for item in operations['items'] if item['type'] == 'applyConnection']
        self.assertEqual(1, len(switches))
        self.assertEqual('SUCCEEDED', self.wait_operation(switches[0]['id'], client)['status'])
        current = primary.api('/api/tasks/' + task['id'])[1]
        self.assertEqual((browser_id, second, target),
            (current['browser']['id'], current['browser']['connectionId'],
             current['browser']['currentUrl']))
        self.assertIsNone(current['request'])
        self.assertEqual('SUCCEEDED', self.wait_operation(self.observe(client, current), client)['status'])

    def test_profile_is_saved_on_close_and_restored_with_updated_site_data(self):
        identity, primary = self.owner()
        fixture = Path(__file__).resolve().parents[2] / 'browser-session/test/fixtures/profile-lifetime.html'
        url = 'https://httpbin.org/base64/' + base64.urlsafe_b64encode(fixture.read_bytes()).decode()
        connection = self.saved_connection(primary, 'Save before close', close=False, url=url)
        client, task = self.create(primary, url=url)
        browser = task['browser']
        path = '/api/connections/' + connection
        original = primary.api(path)[1]['cookieCheck']
        for _ in range(3):
            receipt = self.wait_operation(self.observe(client, task), client)
            self.assertEqual('SUCCEEDED', receipt['status'])
            self.assertEqual(original, primary.api(path)[1]['cookieCheck'],
                'Reading the page must not export the complete saved profile')

        def click(transport, current, name):
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                current = primary.api('/api/tasks/' + current['id'])[1]
                if current.get('browser') and current['browser']['status'] == 'LIVE':
                    break
                time.sleep(.2)
            self.assertEqual('LIVE', current['browser']['status'])
            operation = str(uuid.uuid4())
            error, receipt, _ = transport.execute_browser({'taskId': current['id'], 'action': {
                'operationId': operation, 'type': 'click', 'arguments': transport.browser_target(current['id'], name),
                'instructionRevision': current['instructionRevision'],
                'controlEpoch': current['browser']['controlEpoch']}})
            self.assertFalse(error, receipt)
            self.assertEqual('SUCCEEDED', self.wait_operation(operation, transport)['status'])

        click(client, task, 'Use account B')
        # Exceed the former checkpoint interval while the same browser remains open.
        deadline = time.monotonic() + 66
        while time.monotonic() < deadline:
            self.assertEqual(original, primary.api(path)[1]['cookieCheck'],
                'An open browser must not periodically export its profile')
            time.sleep(2)

        current = primary.api('/api/tasks/' + task['id'])[1]
        self.assertEqual(200, primary.api('/api/tasks/' + task['id'] + '/commands', 'POST', {
            'type': 'STOP', 'expectedVersion': current['version']})[0])
        closed = self.await_connection(primary, connection,
            lambda value: value['browser']['status'] == 'CLOSED')
        self.assertNotEqual(original, closed['cookieCheck'])
        self.assertIsNone(closed['profileSaveError'])
        self.assertGreaterEqual(closed['cookieCheck']['usableCount'], 2)
        self.assertEqual('t', self.fixture_sql(identity,
            "SELECT close_profile_attempted FROM browser_sessions WHERE owner_id=:owner AND id='"
            + str(uuid.UUID(browser['id'])) + "';"))

        restored_client, restored = self.create(primary, url=url, preferred=[connection])
        click(restored_client, restored, 'Read state')
        observed = self.wait_operation(self.observe(restored_client, restored), restored_client)
        self.assertEqual('SUCCEEDED', observed['status'])
        self.assertNotEqual(browser['id'], primary.api('/api/tasks/' + restored['id'])[1]['browser']['id'])
        self.assertIn('"account":"b"', str(observed['result']))
        self.assertIn('"localAccount":"b"', str(observed['result']))

    def test_failed_final_save_closes_browser_keeps_previous_profile_and_warns(self):
        identity, primary = self.owner()
        connection = self.saved_connection(primary, 'Failed final save', close=False)
        client, task = self.create(primary)
        self.assertEqual('SUCCEEDED', self.wait_operation(self.observe(client, task), client)['status'])
        path = '/api/connections/' + connection
        original = primary.api(path)[1]
        browser_id = original['browser']['id']
        # Reject this disposable profile at the real worker; no shared service is stopped.
        self.fixture_sql(identity, "UPDATE connections SET authorized_origins='[\"about:blank\"]' "
            "WHERE owner_id=:owner AND id='" + str(uuid.UUID(connection)) + "';")
        try:
            started = time.monotonic()
            current = primary.api('/api/tasks/' + task['id'])[1]
            self.assertEqual(200, primary.api('/api/tasks/' + task['id'] + '/commands', 'POST', {
                'type': 'STOP', 'expectedVersion': current['version']})[0])
            failed = self.await_connection(primary, connection,
                lambda value: value['browser']['status'] == 'CLOSED')
            self.assertLess(time.monotonic() - started, 45)
            self.assertIsNotNone(failed['profileSaveError'])
            self.assertEqual(original['cookieCheck'], failed['cookieCheck'])
            self.assertEqual(original['profileRevision'], failed['profileRevision'])
        finally:
            self.fixture_sql(identity, "UPDATE connections SET authorized_origins='[\"https://example.com\"]' "
                "WHERE owner_id=:owner AND id='" + str(uuid.UUID(connection)) + "';")

        self.assertEqual('t', self.fixture_sql(identity,
            "SELECT close_profile_attempted FROM browser_sessions WHERE owner_id=:owner AND id='"
            + str(uuid.UUID(browser_id)) + "';"))
        removed = dev.subprocess.run([
            'docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
            'ps', '-q', '--filter', 'name=helm-browser-' + browser_id],
            capture_output=True, text=True, timeout=20)
        self.assertEqual((0, ''), (removed.returncode, removed.stdout.strip()))
        self.assertEqual(404, self.user.api(path)[0])
        replay = dev.subprocess.run([
            'docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
            'exec', '-i', 'helmglass-browser-node-1', 'node', '--input-type=module', '-'],
            input='''
            const headers = {'X-Worker-Token': process.env.WORKER_TOKEN,
                             'Content-Type': 'application/json'};
            const id = %s;
            const response = await fetch('http://127.0.0.1:8090/sessions/' + id, {headers});
            if (!response.ok) throw new Error('Fixture browser receipt unavailable');
            const state = await response.json();
            delete state.profileSaveError;
            const replay = await fetch('http://api:8080/internal/worker/sessions/' + id + '/events',
                {method: 'POST', headers, body: JSON.stringify(state)});
            if (!replay.ok) throw new Error('Fixture event rejected');
            ''' % json.dumps(browser_id), text=True, capture_output=True, timeout=30)
        self.assertEqual(0, replay.returncode, replay.stderr)
        self.assertEqual(failed['profileSaveError'], primary.api(path)[1]['profileSaveError'],
                         'An older saved profile must not clear the latest failed-save warning')
        # Verify the actual closed-browser warning through normal console authentication.
        ui = dev.subprocess.run([
            'docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
            'run', '--rm', '-i', '--network', 'bridge', '--user', 'node',
            '--security-opt', 'seccomp=' + str(Path(__file__).resolve().parents[2] / 'browser-node' / 'seccomp-profile.json'),
            '--entrypoint', 'node', 'helmglass-browser-session:current', '--input-type=module', '-'],
            input='''
            import assert from 'node:assert/strict';
            import { chromium } from 'playwright';
            const input = %s;
            const browser = await chromium.launch({headless: true, chromiumSandbox: true});
            try {
              const page = await browser.newPage();
              page.setDefaultTimeout(30000);
              await page.goto(input.base + '/oauth2/start?rd=' + encodeURIComponent('/tasks/' + input.task));
              await page.locator('#username').fill(input.username);
              await page.locator('#password').fill(input.password);
              await page.locator('#kc-login').click();
              const warning = page.getByRole('alert').filter({hasText: 'Браузер закрыт. Последние изменения сессии не удалось сохранить.'});
              await warning.waitFor({state: 'visible'});
              assert.match(await warning.innerText(), /прежняя сохранённая версия/);
              assert.equal(await page.getByRole('button', {name: 'Повторить сохранение и закрыть'}).count(), 0);
            } finally { await browser.close(); }
            ''' % json.dumps({'base': primary.base, 'username': identity.username,
                              'password': identity.password, 'task': task['id']}),
            capture_output=True, text=True, encoding='utf-8', timeout=120)
        self.assertEqual(0, ui.returncode,
                         ui.stderr.replace(identity.password, '[redacted]'))
        self.assertEqual(original['cookieCheck'], primary.api(path)[1]['cookieCheck'])

    def test_finish_login_saves_and_releases_control_in_one_command(self):
        _, primary = self.owner()
        _, foreign = self.owner()
        status, connection = primary.api('/api/connections', 'POST', {
            'name': 'Single action login fixture', 'startUrl': 'https://example.com'})
        self.assertEqual(200, status, connection)
        connection_id = connection['id']
        connection_login = '/api/connections/' + connection_id + '/login'
        viewer = str(uuid.uuid4())
        self.assertEqual(200, primary.api(connection_login, 'POST', {
            'action': 'START', 'viewerId': viewer})[0])
        try:
            opened = self.await_connection(primary, connection_id, lambda value:
                value.get('browser') and value['browser']['status'] == 'LIVE'
                and value['browser']['controlOwner'] == 'USER')
            browser = opened['browser']
            path = '/api/browser-sessions/' + browser['id'] + '/login'
            finish = {'type': 'FINISH_LOGIN', 'viewerId': viewer,
                      'controlEpoch': browser['controlEpoch'],
                      'accountSubject': 'anonymous-single-action'}
            self.assertFalse(browser['loginConfirmed'])
            self.assertEqual(404, foreign.api(path, 'POST', finish)[0])
            self.assertEqual(403, primary.api(path, 'POST', {
                **finish, 'viewerId': str(uuid.uuid4())})[0])
            for epoch in (None, browser['controlEpoch'] - 1):
                status, refusal = primary.api(path, 'POST', {**finish, 'controlEpoch': epoch})
                self.assertEqual((409, 'CONTROL_CHANGED'), (status, refusal.get('code')))
            key = str(uuid.uuid4())
            status, receipt = primary.api(path, 'POST', finish, key=key)
            self.assertEqual(200, status, receipt)
            saved = self.await_connection(primary, connection_id, lambda value:
                value['status'] == 'READY' and value['browser']['controlOwner'] == 'NONE')
            self.assertEqual((browser['id'], 'LIVE', False, False),
                (saved['browser']['id'], saved['browser']['status'],
                 saved['browser']['privateMode'], saved['browser']['loginConfirmed']))
            self.assertGreater(saved['profileRevision'], 0)
            self.assertIsNotNone(saved['profileSavedAt'])
            self.assertEqual(0, saved['cookieCheck']['usableCount'])
            self.assertIsNotNone(saved['cookieCheck']['checkedAt'])
            self.assertEqual(receipt, primary.api(path, 'POST', finish, key=key)[1])
            self.assertEqual(saved['profileRevision'], primary.api(
                '/api/connections/' + connection_id)[1]['profileRevision'])
            self.assertEqual(saved['cookieCheck'], primary.api(
                '/api/connections/' + connection_id)[1]['cookieCheck'])

            # A rejected save must leave private control and the previous session available.
            self.assertEqual(200, primary.api('/api/browser-sessions/' + browser['id'] + '/control',
                'POST', {'type': 'BEGIN_LOGIN', 'viewerId': viewer,
                         'controlEpoch': saved['browser']['controlEpoch']})[0])
            controlled = self.await_connection(primary, connection_id, lambda value:
                value['browser']['controlOwner'] == 'USER')
            finish['controlEpoch'] = controlled['browser']['controlEpoch']
            status, refusal = primary.api(path, 'POST', {
                **finish, 'accountSubject': 'another-account'})
            self.assertEqual((409, 'ACCOUNT_MISMATCH'), (status, refusal.get('code')))
            unchanged = primary.api('/api/connections/' + connection_id)[1]
            self.assertEqual(('USER', True, saved['profileRevision']),
                (unchanged['browser']['controlOwner'], unchanged['browser']['privateMode'],
                 unchanged['profileRevision']))
            del finish['accountSubject']
            self.assertEqual(200, primary.api(path, 'POST', finish)[0])
            retried = self.await_connection(primary, connection_id, lambda value:
                value['browser']['controlOwner'] == 'NONE')
            # Identical profile bytes retain their revision in the canonical store.
            self.assertEqual(saved['profileRevision'], retried['profileRevision'])
            self.assertGreater(retried['cookieCheck']['checkedAt'], saved['cookieCheck']['checkedAt'])
            replay = dev.subprocess.run([
                'docker', '--host', 'tcp://' + self.settings['DEV_HOST'] + ':2375',
                'exec', '-i', 'helmglass-browser-node-1', 'node', '--input-type=module', '-'],
                input='''
                const headers = {'X-Worker-Token': process.env.WORKER_TOKEN,
                                 'Content-Type': 'application/json'};
                const id = %s;
                const response = await fetch('http://127.0.0.1:8090/sessions/' + id, {headers});
                if (!response.ok) throw new Error('Fixture browser unavailable');
                const state = await response.json();
                state.cookieCheck = %s;
                const replay = await fetch('http://api:8080/internal/worker/sessions/' + id + '/events',
                    {method: 'POST', headers, body: JSON.stringify(state)});
                if (!replay.ok) throw new Error('Stale fixture event rejected');
                ''' % (json.dumps(browser['id']), json.dumps(saved['cookieCheck'])),
                text=True, capture_output=True, timeout=30)
            self.assertEqual(0, replay.returncode, replay.stderr)
            self.assertEqual(retried['cookieCheck'], primary.api(
                '/api/connections/' + connection_id)[1]['cookieCheck'],
                'A delayed worker snapshot must not roll back the latest cookie check')
            self.assertIsNone(retried['profileSaveError'])
            self.assertFalse(retried['browser']['privateMode'])
            self.assertEqual(saved['accountSubject'], retried['accountSubject'])
        finally:
            self.assertEqual(200, primary.api(connection_login, 'POST', {
                'action': 'CLOSE', 'viewerId': viewer})[0])
            self.await_connection(primary, connection_id, lambda value:
                value['browser']['status'] == 'CLOSED')

    def test_saved_connection_reopens_in_protected_control_with_its_saved_profile(self):
        _, primary = self.owner()
        status, connection = primary.api('/api/connections', 'POST', {
            'name': 'Saved session reopening fixture', 'startUrl': 'https://example.com'})
        self.assertEqual(200, status, connection)
        connection_id = connection['id']
        login = '/api/connections/' + connection_id + '/login'
        viewer = str(uuid.uuid4())
        self.assertEqual(0, connection['taskCount'])
        status, draft = primary.api('/api/tasks', 'POST', {
            'title': 'Connection details fixture', 'goal': 'Verify the connection task count',
            'startUrl': 'https://example.com', 'preferredConnectionIds': [connection_id]})
        self.assertEqual(200, status, draft)
        self.tasks.append((primary, draft['id']))
        self.assertEqual(1, primary.api('/api/connections/' + connection_id)[1]['taskCount'])

        def open_browser():
            self.assertEqual(200, primary.api(login, 'POST', {'action': 'START', 'viewerId': viewer})[0])
            return self.await_connection(primary, connection_id, lambda value:
                value['browser']['status'] == 'LIVE' and value['browser']['controlOwner'] == 'USER')

        def close_browser():
            self.assertEqual(200, primary.api(login, 'POST', {'action': 'CLOSE', 'viewerId': viewer})[0])
            self.await_connection(primary, connection_id, lambda value: value['browser']['status'] == 'CLOSED')

        try:
            opened = open_browser()
            self.assertTrue(opened['browser']['privateMode'])
            browser = opened['browser']
            self.assertEqual(200, primary.api('/api/browser-sessions/' + browser['id'] + '/login', 'POST', {
                'type': 'FINISH_LOGIN', 'viewerId': viewer, 'controlEpoch': browser['controlEpoch']})[0])
            saved = self.await_connection(primary, connection_id, lambda value:
                value['status'] == 'READY' and value['browser']['controlOwner'] == 'NONE')
            self.assertFalse(saved['browser']['privateMode'])
            close_browser()
            reopened = open_browser()
            self.assertNotEqual(browser['id'], reopened['browser']['id'])
            self.assertEqual(saved['profileRevision'], reopened['profileRevision'])
            self.assertTrue(reopened['browser']['privateMode'],
                            'Opening a connection always grants protected control')
            self.assertGreater(reopened['cookieCheck']['checkedAt'], saved['cookieCheck']['checkedAt'],
                               'The standalone browser saves its latest profile before closing')
            browser = reopened['browser']
            self.assertEqual(200, primary.api('/api/browser-sessions/' + browser['id'] + '/login', 'POST', {
                'type': 'FINISH_LOGIN', 'viewerId': viewer, 'controlEpoch': browser['controlEpoch']})[0])
            finished = self.await_connection(primary, connection_id, lambda value:
                value['browser']['controlOwner'] == 'NONE')
            self.assertEqual(browser['id'], finished['browser']['id'])
            self.assertEqual(saved['profileRevision'], finished['profileRevision'])
        finally:
            close_browser()

    def test_confirmed_session_save_preserves_private_control(self):
        _, primary = self.owner()
        _, foreign = self.owner()
        status, connection = primary.api("/api/connections", "POST", {
            "name": "Confirmed private session fixture", "startUrl": "https://example.com"})
        self.assertEqual(200, status, connection)
        connection_id = connection["id"]
        viewer = str(uuid.uuid4())
        connection_login = "/api/connections/" + connection_id + "/login"
        self.assertEqual(200, primary.api(connection_login, "POST", {
            "action": "START", "viewerId": viewer})[0])
        connection = self.await_connection(primary, connection_id, lambda value:
            value.get("browser") and value["browser"]["status"] == "LIVE"
            and value["browser"]["controlOwner"] == "USER")
        browser = connection["browser"]
        browser_id = browser["id"]
        path = "/api/browser-sessions/" + browser_id + "/login"
        control = "/api/browser-sessions/" + browser_id + "/control"
        confirm = {"type": "CONFIRM_LOGIN", "viewerId": viewer,
                   "controlEpoch": browser["controlEpoch"]}
        save = {**confirm, "type": "SAVE_SESSION", "accountLabel": "Anonymous fixture",
                "accountSubject": "anonymous-confirmed-session"}
        try:
            self.assertFalse(browser["loginConfirmed"])
            self.assertEqual(connection_id, browser["connectionId"])
            self.assertIsNone(browser["taskId"])
            status, refusal = primary.api(path, "POST", save)
            self.assertEqual((409, "LOGIN_NOT_CONFIRMED"), (status, refusal.get("code")))
            self.assertEqual(404, foreign.api(path, "POST", confirm)[0])
            self.assertEqual(400, primary.api(path, "POST", {**confirm, "viewerId": None})[0])
            self.assertEqual(403, primary.api(path, "POST", {
                **confirm, "viewerId": str(uuid.uuid4())})[0])
            for epoch in (None, browser["controlEpoch"] - 1):
                status, refusal = primary.api(path, "POST", {**confirm, "controlEpoch": epoch})
                self.assertEqual((409, "CONTROL_CHANGED"), (status, refusal.get("code")))

            confirm_key = str(uuid.uuid4())
            status, confirmed = primary.api(path, "POST", confirm, key=confirm_key)
            self.assertEqual(200, status, confirmed)
            self.assertTrue(confirmed["loginConfirmed"])
            self.assertEqual(confirmed, primary.api(path, "POST", confirm, key=confirm_key)[1])
            self.assertTrue(primary.api("/api/connections/" + connection_id)[1]["browser"]["loginConfirmed"])
            self.assertEqual(400, primary.api(control, "POST", save)[0],
                             "A direct save command without a destination must not succeed without saving")

            # First save needs no manually entered label or external account identity.
            status, first_receipt = primary.api(path, "POST", {**confirm, "type": "SAVE_SESSION"})
            self.assertEqual(200, status, first_receipt)
            first_saved = self.await_connection(primary, connection_id, lambda value:
                value["status"] == "READY" and value["browser"]["controlOwner"] == "USER"
                and not value["browser"]["loginConfirmed"])
            self.assertIsNone(first_saved["accountLabel"])
            self.assertIsNone(first_saved["accountSubject"])
            self.assertEqual(browser_id, first_saved["browser"]["id"])
            confirm["controlEpoch"] = first_saved["browser"]["controlEpoch"]
            save["controlEpoch"] = confirm["controlEpoch"]
            self.assertEqual(200, primary.api(path, "POST", confirm)[0])

            save_key = str(uuid.uuid4())
            status, receipt = primary.api(path, "POST", save, key=save_key)
            self.assertEqual(200, status, receipt)
            self.assertEqual(receipt, primary.api(path, "POST", save, key=save_key)[1])
            saved = self.await_connection(primary, connection_id, lambda value:
                value["status"] == "READY" and value["browser"]["controlOwner"] == "USER"
                and not value["browser"]["loginConfirmed"])
            self.assertEqual((browser_id, "LIVE", True),
                             (saved["browser"]["id"], saved["browser"]["status"],
                              saved["browser"]["privateMode"]))
            self.assertGreater(saved["profileRevision"], 0)
            self.assertIsNotNone(saved["profileSavedAt"])
            self.assertIsNone(saved["profileSaveError"])
            self.assertEqual(200, primary.api("/api/browser-sessions/" + browser_id + "/ticket",
                "POST", {"role": "CONTROLLER", "viewerId": viewer})[0])
            self.assertEqual(receipt, primary.api(path, "POST", save, key=save_key)[1])
            replayed = primary.api("/api/connections/" + connection_id)[1]
            self.assertEqual(saved["profileRevision"], replayed["profileRevision"])
            self.assertFalse(replayed["browser"]["loginConfirmed"])

            # A new explicit confirmation makes another save possible; another account cannot replace it.
            confirm["controlEpoch"] = replayed["browser"]["controlEpoch"]
            self.assertEqual(200, primary.api(path, "POST", confirm)[0])
            status, refusal = primary.api(path, "POST", {
                **confirm, "type": "SAVE_SESSION", "accountLabel": "Different account",
                "accountSubject": "another-account"})
            self.assertEqual((409, "ACCOUNT_MISMATCH"), (status, refusal.get("code")))
            unchanged = primary.api("/api/connections/" + connection_id)[1]
            self.assertEqual(save["accountSubject"], unchanged["accountSubject"])
            self.assertEqual(saved["profileRevision"], unchanged["profileRevision"])
            self.assertTrue(unchanged["browser"]["loginConfirmed"])
            status, retry = primary.api(path, "POST", {**confirm, "type": "SAVE_SESSION"})
            self.assertEqual(200, status, retry)
            self.await_connection(primary, connection_id, lambda value:
                value["browser"]["controlOwner"] == "USER" and not value["browser"]["loginConfirmed"])
        finally:
            self.assertEqual(200, primary.api(connection_login, "POST", {
                "action": "CLOSE", "viewerId": viewer})[0])
            self.await_connection(primary, connection_id, lambda value: value["browser"]["status"] == "CLOSED")

    def test_task_session_save_keeps_pause_request_and_browser(self):
        _, primary = self.owner()
        client, task = self.create(primary)
        self.assertEqual("SUCCEEDED", self.wait_operation(self.observe(client, task), client)["status"])
        task_path = "/api/tasks/" + task["id"]
        task = primary.return_control_without_continuing(task["id"])
        viewer = str(uuid.uuid4())
        status, task = primary.api(task_path + "/commands", "POST", {
            "type": "BEGIN_LOGIN", "viewerId": viewer, "expectedVersion": task["version"]})
        self.assertEqual(200, status, task)

        def await_task(predicate):
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                status, value = primary.api(task_path)
                self.assertEqual(200, status, value)
                if predicate(value):
                    return value
                time.sleep(.3)
            self.fail("Task session transition was not confirmed")

        task = await_task(lambda value: value["browser"]["controlOwner"] == "USER")
        browser = task["browser"]
        browser_id = browser["id"]
        self.assertIsNotNone(browser['connectionId'], 'Login must open through its canonical connection')
        status, login_connection = primary.api('/api/connections/' + browser['connectionId'])
        self.assertEqual(200, status, login_connection)
        self.assertEqual((browser_id, task['id']),
                         (login_connection['browser']['id'], login_connection['browser']['taskId']))
        pending_request = task["request"]
        task_state = task["status"]
        path = "/api/browser-sessions/" + browser_id + "/login"
        command = {"type": "CONFIRM_LOGIN", "viewerId": viewer,
                   "controlEpoch": browser["controlEpoch"]}
        self.assertEqual(200, primary.api(path, "POST", command)[0])
        status, receipt = primary.api(path, "POST", {
            **command, "type": "SAVE_SESSION", "accountLabel": "Anonymous paused task",
            "accountSubject": "anonymous-paused-task"})
        self.assertEqual(200, status, receipt)
        saved = await_task(lambda value: value["browser"]["controlOwner"] == "USER"
                           and not value["browser"]["loginConfirmed"])
        self.assertEqual(task_state, saved["status"])
        self.assertEqual(pending_request, saved["request"])
        self.assertEqual((browser_id, "LIVE", True, task["id"]),
                         (saved["browser"]["id"], saved["browser"]["status"],
                          saved["browser"]["privateMode"], saved["browser"]["taskId"]))
        connection = primary.api("/api/connections/" + saved["browser"]["connectionId"])[1]
        self.assertEqual(browser_id, connection["browser"]["id"])
        self.assertEqual(task["id"], connection["browser"]["taskId"])
        status, receipt = primary.api(task_path + "/commands", "POST", {
            "type": "RETURN_CONTROL", "viewerId": viewer, "resume": True,
            "expectedVersion": saved["version"]})
        self.assertEqual(200, status, receipt)
        returned = await_task(lambda value: value["browser"]["controlOwner"] == "CHATGPT")
        self.assertEqual("PAUSED", returned["status"], "Saving must not clear the explicit task pause")
        self.assertEqual(browser_id, returned["browser"]["id"])

    def test_optional_login_save_and_browser_close_reopen_keep_task_paused(self):
        _, primary = self.owner()
        _, foreign = self.owner()
        for save_session in (False, True):
            with self.subTest(save_session=save_session):
                status, connection = primary.api('/api/connections', 'POST', {
                    'name': 'V16 optional session save', 'startUrl': 'https://example.com'})
                self.assertEqual(200, status)
                _, task = self.create(primary, preferred=[connection['id']])
                path = '/api/tasks/' + task['id']
                viewer = str(uuid.uuid4())

                def wait(predicate):
                    deadline = time.monotonic() + 60
                    while time.monotonic() < deadline:
                        status, value = primary.api(path)
                        self.assertEqual(200, status)
                        if predicate(value):
                            return value
                        time.sleep(.3)
                    self.fail('Browser lifecycle transition was not confirmed')

                def command(kind, **extra):
                    _, current = primary.api(path)
                    status, value = primary.api(path + '/commands', 'POST', {
                        'type': kind, 'expectedVersion': current['version'], **extra})
                    self.assertEqual(200, status, value)
                    return value

                task = wait(lambda value: value.get('browser') and value['browser']['status'] == 'LIVE')
                browser_id = task['browser']['id']
                self.assertIsNotNone(task['browser']['startedAt'])
                self.assertIsNone(task['browser']['closedAt'])
                request_id = task['request']['id']
                command('BEGIN_LOGIN', viewerId=viewer)
                wait(lambda value: value['browser']['controlOwner'] == 'USER')
                command('RETURN_CONTROL', viewerId=viewer, resume=True)
                unconfirmed = wait(lambda value: value['browser']['controlOwner'] == 'CHATGPT')
                self.assertEqual('WAITING_USER', unconfirmed['status'])
                self.assertEqual(request_id, unconfirmed['request']['id'])
                primary.return_control_without_continuing(task['id'])
                command('BEGIN_LOGIN', viewerId=viewer)
                controlled = wait(lambda value: value['browser']['controlOwner'] == 'USER')
                login = '/api/browser-sessions/' + browser_id + '/login'
                intent = {'type': 'CONFIRM_LOGIN', 'viewerId': viewer,
                          'controlEpoch': controlled['browser']['controlEpoch']}
                if save_session:
                    self.assertEqual(200, primary.api(login, 'POST', {**intent, 'type': 'FINISH_LOGIN'})[0])
                else:
                    self.assertEqual(200, primary.api(login, 'POST', intent)[0])
                    command('RETURN_CONTROL', viewerId=viewer, resume=True)
                returned = wait(lambda value: value['browser']['controlOwner'] == 'CHATGPT')
                self.assertEqual('PAUSED', returned['status'])
                self.assertIsNone(returned['request'])
                self.assertEqual(not save_session, returned['browser']['loginConfirmed'])
                self.assertEqual(browser_id, returned['browser']['id'])
                self.assertEqual(404, foreign.api(path + '/commands', 'POST', {
                    'type': 'CLOSE_BROWSER', 'expectedVersion': returned['version']})[0])
                self.assertEqual(409, primary.api(path + '/commands', 'POST', {
                    'type': 'CLOSE_BROWSER', 'expectedVersion': returned['version'] - 1})[0])
                command('CLOSE_BROWSER')
                closed = wait(lambda value: value['browser']['status'] == 'CLOSED')
                self.assertEqual('PAUSED', closed['status'])
                self.assertEqual(returned['stepCount'], closed['stepCount'])
                self.assertEqual(returned['browser']['startedAt'], closed['browser']['startedAt'])
                self.assertIsNotNone(closed['browser']['closedAt'])
                detail = primary.api('/api/connections/' + connection['id'])[1]
                self.assertEqual(closed['browser']['closedAt'], detail['browser']['closedAt'])
                key = str(uuid.uuid4())
                opening = {'type': 'OPEN_BROWSER', 'expectedVersion': closed['version']}
                status, receipt = primary.api(path + '/commands', 'POST', opening, key=key)
                self.assertEqual(200, status, receipt)
                self.assertEqual(receipt, primary.api(path + '/commands', 'POST', opening, key=key)[1])
                reopened = wait(lambda value: value['browser']['status'] == 'LIVE')
                self.assertNotEqual(browser_id, reopened['browser']['id'])
                self.assertEqual('PAUSED', reopened['status'])
                self.assertIsNone(reopened['browser']['closedAt'])
                self.assertEqual(closed['stepCount'], reopened['stepCount'])
                command('CLOSE_BROWSER')
                wait(lambda value: value['browser']['status'] == 'CLOSED')

    def test_saved_credentials_are_owner_private_and_separate_from_cookies(self):
        _, client = self.owner()
        _, foreign = self.owner()
        status, connection = client.api('/api/connections', 'POST', {
            'name': 'Disposable credential boundary', 'site': 'example.com',
            'startUrl': 'https://example.com'})
        self.assertEqual(200, status)
        viewer = str(uuid.uuid4())
        login = '/api/connections/' + connection['id'] + '/login'
        self.assertEqual(200, client.api(login, 'POST', {'action': 'START', 'viewerId': viewer})[0])
        connection = self.await_connection(client, connection['id'], lambda value:
            value.get('browser') and value['browser']['status'] == 'LIVE'
            and value['browser']['controlOwner'] == 'USER')
        browser = connection['browser']['id']
        credentials = '/api/browser-sessions/' + browser + '/credentials'
        try:
            status, metadata = client.api(credentials + '?viewerId=' + viewer)
            self.assertEqual(200, status)
            self.assertFalse(metadata['available'])
            self.assertEqual(0, metadata['revision'])
            self.assertEqual('https://example.com', metadata['currentOrigin'])
            self.assertFalse(metadata['captureEnabled'])
            self.assertEqual('DISABLED', metadata['captureStatus'])
            self.assertIsNone(metadata['captureOrigin'])
            self.assertEqual(403, client.api(credentials + '?viewerId=' + str(uuid.uuid4()))[0])
            self.assertEqual(404, foreign.api(credentials + '?viewerId=' + viewer)[0])
            self.assertEqual(400, client.api(credentials, 'POST', {
                'viewerId': viewer, 'origin': 'https://example.com', 'username': 'synthetic-account',
                'password': 'synthetic-credential-value', 'expectedRevision': 0})[0])
            value = {'viewerId': viewer, 'enabled': True,
                'expectedCaptureRevision': metadata['captureRevision']}
            operation = str(uuid.uuid4())
            status, metadata = client.api(credentials, 'POST', value, operation)
            self.assertEqual(200, status)
            self.assertEqual(0, metadata['revision'])
            self.assertFalse(metadata['available'])
            self.assertTrue(metadata['captureEnabled'])
            self.assertEqual('ARMED', metadata['captureStatus'])
            self.assertEqual('https://example.com', metadata['captureOrigin'])
            self.assertNotIn('synthetic-credential-value', json.dumps(metadata))
            self.assertEqual(metadata, client.api(credentials, 'POST', value, operation)[1])
            self.assertEqual(409, client.api(credentials, 'POST', value)[0])
            _, unchanged = client.api('/api/connections/' + connection['id'])
            self.assertEqual(0, unchanged['profileRevision'], 'Consent must not save a password or cookies')
            status, disabled = client.api(credentials, 'POST', {'viewerId': viewer, 'enabled': False,
                'expectedCaptureRevision': metadata['captureRevision']})
            self.assertEqual(200, status)
            self.assertFalse(disabled['captureEnabled'])
            self.assertEqual('DISABLED', disabled['captureStatus'])
            self.assertIsNone(disabled['captureOrigin'])
            status, removed = client.api(credentials, 'DELETE', {'viewerId': viewer, 'expectedRevision': 0})
            self.assertEqual(200, status)
            self.assertFalse(removed['available'])
            self.assertEqual(1, removed['revision'])
        finally:
            self.assertEqual(200, client.api(login, 'POST', {'action': 'CLOSE', 'viewerId': viewer})[0])
            self.await_connection(client, connection['id'], lambda value: value['browser']['status'] == 'CLOSED')

    def test_specific_switch_consent_and_account_choice_without_second_confirmation(self):
        _,primary=self.owner()
        first=self.saved_connection(primary,"A")
        second=self.saved_connection(primary,"B")
        client,task=self.create(primary,preferred=[first])
        self.assertEqual("SUCCEEDED",self.wait_operation(self.observe(client,task),client)["status"])
        _,task=primary.api("/api/tasks/"+task["id"])
        browser=task["browser"]["id"]
        error,presentation,_=client.tool("connections.select",{"taskId":task["id"],"connectionId":second,"confirmationPrompt":"Switch to the second account?",
            "instructionRevision":task["instructionRevision"],"operationKey":str(uuid.uuid4())})
        self.assertFalse(error,presentation)
        _,task=primary.api("/api/tasks/"+task["id"])
        self.assertEqual("CONFIRMATION",task["request"]["type"])
        operation=task["request"]["operationId"]
        self.assertEqual(browser,task["browser"]["id"])
        _,current=primary.api("/api/connections/"+first)
        self.assertEqual(browser,current["browser"]["id"])
        previous_check = current['cookieCheck']
        status,value=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":"CONFIRM","expectedVersion":task["version"],"requestId":task["request"]["id"],"requestVersion":task["request"]["version"]})
        self.assertEqual((409,"HOST_RESPONSE_REQUIRED"),(status,value["code"]))
        error,value,_=client.respond(task,{"proceed":True})
        self.assertFalse(error,value)
        switched = self.wait_operation(operation, client)
        self.assertEqual("SUCCEEDED", switched["status"], switched)
        self.assertNotEqual(previous_check, primary.api('/api/connections/' + first)[1]['cookieCheck'],
                            'Replacing a browser context must first save its current connection')
        _,current=primary.api("/api/connections/"+second)
        self.assertEqual(browser,current["browser"]["id"])
        error,result,_=client.tool("results.publish",{"taskId":task["id"],"instructionRevision":task["instructionRevision"],
            "operationKey":str(uuid.uuid4()),"result":{"summary":"Preserved after connection deletion","limitations":[],
            "columns":[{"key":"value","label":"Value","type":"string"}]},"rows":[{"value":"kept"}]})
        self.assertFalse(error,result)
        _,history=primary.api("/api/tasks/"+task["id"]+"/history")
        self.assertEqual(200,primary.api("/api/connections/"+second,"DELETE")[0])
        _,current=primary.api("/api/tasks/"+task["id"])
        self.assertEqual("ACCOUNT_CHOICE",current["request"]["type"])
        error,current,_=client.respond(current,{"connectionId":first})
        self.assertFalse(error,current)
        self.assertIsNone(current["request"], "A user's explicit account choice needs no second approval")
        response = current["lastResponse"]
        self.assertEqual(("CHOOSE_CONNECTION", first), (response["command"], response["connectionId"]))
        self.assertEqual(response, client.tool("tasks.get", {"taskId": task["id"]})[1]["lastResponse"])
        self.assertEqual(browser,current["browser"]["id"])
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            _,restored=primary.api("/api/connections/"+first)
            if restored.get("browser") and restored["browser"]["id"]==browser:
                break
            time.sleep(.2)
        self.assertEqual(browser,restored["browser"]["id"])
        self.assertEqual(200,primary.api("/api/connections/"+first,"DELETE")[0])
        _,current=primary.api("/api/tasks/"+task["id"])
        self.assertEqual("Preserved after connection deletion",current["result"]["summary"])
        self.assertEqual("ACCOUNT_CHOICE",current["request"]["type"])
        _,rows=primary.api("/api/tasks/"+task["id"]+"/result/rows")
        self.assertEqual("kept",rows["items"][0]["cells"]["value"])
        _,later_history=primary.api("/api/tasks/"+task["id"]+"/history")
        self.assertGreaterEqual(later_history["total"],history["total"])

    def test_explicit_login_required_waits_for_user_and_can_save_paused(self):
        _,primary=self.owner()
        _,connection=primary.api("/api/connections","POST",{
            "name":"Explicit login required","site":"example.com","startUrl":"https://example.com"})
        client,task=self.create(primary,preferred=[connection["id"]])
        self.assertEqual(400,primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
            "type":None,"expectedVersion":task["version"]})[0])
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            _,task=primary.api("/api/tasks/"+task["id"])
            if task.get("browser") and task["browser"]["status"]=="LIVE":
                break
            time.sleep(.3)
        self.assertEqual("LIVE",task["browser"]["status"])
        self.assertEqual("WAITING_USER",task["status"])
        self.assertEqual("LOGIN",task["request"]["type"])
        self.assertTrue(task["browser"]["privateMode"])
        self.assertEqual("NONE",task["browser"]["controlOwner"])
        task=primary.return_control_without_continuing(task["id"])
        viewer=str(uuid.uuid4())
        for command in ({"type":"BEGIN_LOGIN"},{"type":"FINISH_LOGIN","saveConnection":True,
                "connectionId":connection["id"],"accountLabel":"Verified anonymous", "accountSubject":"anonymous-login"}):
            status,task=primary.api("/api/tasks/"+task["id"]+"/commands","POST",{
                **command,"viewerId":viewer,"expectedVersion":task["version"]})
            self.assertEqual(200,status,task)
            deadline=time.monotonic()+60
            while time.monotonic()<deadline:
                _,task=primary.api("/api/tasks/"+task["id"])
                if task["browser"]["controlOwner"]!="TRANSFERRING":
                    break
                time.sleep(.3)
        self.assertEqual("PAUSED",task["status"])
        self.assertFalse(task["browser"]["privateMode"])
        self.assertIsNone(task["request"])
        _,saved=primary.api("/api/connections/"+connection["id"])
        self.assertEqual("READY",saved["status"])
        self.assertEqual(task["browser"]["id"],saved["browser"]["id"])

    def test_login_preserves_pending_question_and_restores_its_wait_reason(self):
        _, primary = self.owner()
        client, task = self.create(primary)
        self.assertEqual("SUCCEEDED", self.wait_operation(self.observe(client, task), client)["status"])
        error, task, _ = client.tool("tasks.ask", {
            "taskId": task["id"], "instructionRevision": task["instructionRevision"],
            "operationKey": str(uuid.uuid4()), "prompt": "Which public page should be inspected?"})
        self.assertFalse(error, task)
        pending = task["request"]
        self.assertEqual("QUESTION", pending["type"])
        browser_id = task["browser"]["id"]
        viewer = str(uuid.uuid4())
        for command in ({"type": "BEGIN_LOGIN"}, {"type": "FINISH_LOGIN", "saveConnection": True,
                "accountLabel": "Anonymous fixture", "accountSubject": "anonymous-question"}):
            status, task = primary.api("/api/tasks/" + task["id"] + "/commands", "POST", {
                **command, "viewerId": viewer, "expectedVersion": task["version"]})
            self.assertEqual(200, status, task)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                status, task = primary.api("/api/tasks/" + task["id"])
                self.assertEqual(200, status, task)
                if task["browser"]["controlOwner"] != "TRANSFERRING":
                    break
                time.sleep(.3)
            self.assertNotEqual("TRANSFERRING", task["browser"]["controlOwner"])
            self.assertEqual(pending, task["request"])
        self.assertEqual(("WAITING_USER", "QUESTION"), (task["status"], task["waitReason"]))
        self.assertFalse(task["browser"]["privateMode"])
        self.assertEqual(browser_id, task["browser"]["id"])
        error, task, _ = client.respond(task, {"answer": "Inspect example.com"})
        self.assertFalse(error, task)
        self.assertIsNone(task["request"])
        self.assertEqual("WAITING_CHATGPT", task["status"])
        self.assertEqual(browser_id, task["browser"]["id"])
        self.assertEqual("SUCCEEDED", self.wait_operation(self.observe(client, task), client)["status"])

    def test_account_choice_is_bounded_and_validates_persisted_scope(self):
        identity,primary=self.owner()
        _,foreign=self.owner()
        first=self.saved_connection(primary,"Choice 00")
        current=primary.api("/api/connections/"+first)[1]
        status,_=primary.api("/api/connections/"+first,"PATCH",{
            "name":"Choice 00","expectedVersion":current["version"]})
        self.assertEqual(200,status)
        candidates=[first]
        for index in range(1,12):
            status,value=primary.api("/api/connections","POST",{
                "name":"Choice "+str(index).zfill(2),"site":"example.com","startUrl":"https://example.com"})
            self.assertEqual(200,status)
            candidates.append(value["id"])
        # Only the first candidate can be selected successfully; its profile was saved through login.
        created_ids = ','.join("'" + str(uuid.UUID(value)) + "'" for value in candidates)
        self.fixture_sql(identity, "UPDATE connections SET status='READY' WHERE owner_id=:owner"
            + " AND id IN (" + created_ids + ");")
        _,login_required=primary.api("/api/connections","POST",{
            "name":"Needs login","site":"example.com","startUrl":"https://example.com"})
        _,wrong_site=primary.api("/api/connections","POST",{
            "name":"Other site","site":"other.example.org","startUrl":"https://other.example.org"})
        _,foreign_connection=foreign.api("/api/connections","POST",{
            "name":"Foreign","site":"example.com","startUrl":"https://example.com"})
        status,page=primary.api("/api/connections?site=example.com&status=READY&pageSize=10&page=2")
        self.assertEqual(200,status)
        self.assertEqual(12,page["total"])
        self.assertEqual(2,len(page["items"]))
        _,found=primary.api("/api/connections?site=example.com&status=READY&search=Choice%2011")
        self.assertEqual([candidates[-1]],[item["id"] for item in found["items"]])
        client,task=self.create(primary)
        _,task=primary.api("/api/tasks/"+task["id"])
        self.assertEqual("ACCOUNT_CHOICE",task["request"]["type"])
        self.assertEqual(set(candidates),{option["id"] for option in task["request"]["options"]})
        choice={"type":"CHOOSE_CONNECTION","expectedVersion":task["version"],
            "requestId":task["request"]["id"],"requestVersion":task["request"]["version"]}
        for selected in (login_required["id"],wrong_site["id"],foreign_connection["id"]):
            error,refusal,_=client.respond(task,{"connectionId":selected})
            self.assertTrue(error,refusal)
        error,task,_=client.tool("tasks.command",{"taskId":task["id"],"operationKey":str(uuid.uuid4()),"command":{
            "type":"AMEND","expectedVersion":task["version"],"goal":"Updated account choice scope",
            "startUrl":"https://example.com"}})
        self.assertFalse(error,task)
        error,refusal,_=client.tool("tasks.respond",{"taskId":task["id"],"operationKey":str(uuid.uuid4()),
            "requestId":choice["requestId"],"requestVersion":choice["requestVersion"]})
        self.assertTrue(error)
        self.assertEqual("STALE_REQUEST",refusal["code"])
        client,preferred=self.create(primary,preferred=candidates[:2])
        _,preferred=primary.api("/api/tasks/"+preferred["id"])
        self.assertEqual(set(candidates[:2]),{option["id"] for option in preferred["request"]["options"]})
        self.assertTrue(client.respond(preferred,{"connectionId":candidates[2]})[0])
        error,selected,_=client.respond(preferred,{"connectionId":candidates[0]})
        self.assertFalse(error,selected)
        self.assertIsNone(selected["request"])
        self.assertEqual("SUCCEEDED",self.wait_operation(self.observe(client,selected),client)["status"])
        selected=primary.api("/api/tasks/"+selected["id"])[1]
        self.assertEqual("WAITING_CHATGPT",selected["status"])

    def test_multiple_accounts_require_choice_even_after_success_and_busy_lease_resumes(self):
        identity, primary = self.owner()
        self.fixture_sql(identity,
            "UPDATE accounts SET browser_limit_mode='CUSTOM',browser_limit=1 WHERE id=:owner;")
        first = self.saved_connection(primary, "Latest-success A")
        second = self.saved_connection(primary, "Later-save B")
        explicit, task = self.create(primary, preferred=[first])
        first_operation = self.observe(explicit, task)
        self.assertEqual("SUCCEEDED", self.wait_operation(first_operation, explicit)["status"])
        current = primary.api("/api/tasks/" + task["id"])[1]
        self.assertEqual(current["browser"]["id"], primary.api("/api/connections/" + first)[1]["browser"]["id"])

        def finish(task_id, transport=None, operation_id=None):
            current = primary.api("/api/tasks/" + task_id)[1]
            status, receipt = primary.api("/api/tasks/" + task_id + "/commands", "POST", {
                "type": "FINISH", "expectedVersion": current["version"],
                "outcome": "SUCCEEDED", "text": "Public account fixture completed"})
            self.assertEqual(200, status, receipt)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                current = primary.api("/api/tasks/" + task_id)[1]
                if current["status"] == "SUCCEEDED" and (not current.get("browser") or current["browser"]["status"] == "CLOSED"):
                    return
                time.sleep(.2)
            self.fail("Owned task did not release its browser: " + current["status"] + "/"
                      + (current.get("browser") or {}).get("status", "NONE"))

        _, unallocated = self.create(primary, preferred=[second])
        self.assertEqual("QUEUED", unallocated["browser"]["status"])
        finish(unallocated["id"])
        finish(task["id"], explicit, first_operation)
        automatic, selected = self.create(primary)
        self.assertEqual("ACCOUNT_CHOICE",selected["request"]["type"])
        self.assertIsNone(selected["browser"])
        error,selected,_=automatic.respond(selected,{"connectionId":first})
        self.assertFalse(error,selected)
        selected_operation = self.observe(automatic, selected)
        self.assertEqual("SUCCEEDED", self.wait_operation(selected_operation, automatic)["status"])
        active = primary.api("/api/tasks/" + selected["id"])[1]
        used = primary.api("/api/connections/" + first)[1]
        self.assertIsNotNone(used.get("browser"),
                             "The explicitly chosen account must be used")
        self.assertEqual(active["browser"]["id"], used["browser"]["id"])
        self.assertEqual("CLOSED", primary.api("/api/connections/" + second)[1]["browser"]["status"])

        waiting, pending = self.create(primary, preferred=[first])
        operation = self.observe(waiting, pending)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            queued = primary.api("/api/tasks/" + pending["id"])[1]
            if queued["waitReason"] == "CONNECTION_BUSY":
                break
            time.sleep(.2)
        self.assertEqual(("QUEUED", "CONNECTION_BUSY", None),
                         (queued["status"], queued["waitReason"], queued["browser"]))
        self.assertEqual("ACCEPTED", waiting.tool("operations.get", {"operationId": operation})[1]["status"])
        finish(selected["id"], automatic, selected_operation)
        self.assertEqual("SUCCEEDED", self.wait_operation(operation, waiting)["status"])
        resumed = primary.api("/api/tasks/" + pending["id"])[1]
        self.assertEqual("LIVE", resumed["browser"]["status"])
        self.assertNotEqual(active["browser"]["id"], resumed["browser"]["id"])
        self.assertEqual(resumed["browser"]["id"], primary.api("/api/connections/" + first)[1]["browser"]["id"])
        self.assertEqual("CLOSED", primary.api("/api/connections/" + second)[1]["browser"]["status"])
        finish(pending["id"], waiting, operation)
        unused, preferred = self.create(primary, preferred=[first])
        finish(preferred["id"])
        self.assertEqual(200, primary.api("/api/connections/" + first, "DELETE")[0])
        # Both a previously selected account and an unused preference can disappear after completion.
        # Neither may silently select B or fail with an opaque NOT_FOUND after explicit resume.
        for transport, stopped in ((waiting, pending), (unused, preferred)):
            value = primary.api("/api/tasks/" + stopped["id"])[1]
            status, value = primary.api("/api/tasks/" + stopped["id"] + "/commands", "POST", {
                "type": "RESUME", "expectedVersion": value["version"], "confirmBrowserLoss": True})
            self.assertEqual(200, status, value)
            operation = str(uuid.uuid4())
            error, receipt, _ = transport.tool("browser.execute", {"taskId": value["id"], "action": {
                "operationId": operation, "type": "observe", "arguments": {},
                "instructionRevision": value["instructionRevision"]}})
            self.assertFalse(error, receipt)
            value = primary.api("/api/tasks/" + stopped["id"])[1]
            self.assertEqual("ACCOUNT_CHOICE", value["request"]["type"])
            self.assertEqual("WAITING_USER", value["status"])
            self.assertEqual("ACCEPTED", transport.tool("operations.get", {"operationId": operation})[1]["status"])
            self.assertEqual("CLOSED", primary.api("/api/connections/" + second)[1]["browser"]["status"])
            error, chosen, _ = transport.respond(value,{"connectionId":second})
            self.assertFalse(error, chosen)
            receipt = self.wait_operation(operation, transport)
            self.assertEqual("SUCCEEDED", receipt["status"])
            finish(stopped["id"])

    def test_busy_connection_does_not_block_other_owner(self):
        identity,primary=self.owner()
        _,other=self.owner()
        client,task=self.create(primary)
        lease_client,lease_task=self.create(primary)
        for current,current_task in ((client,task),(lease_client,lease_task)):
            self.assertEqual("SUCCEEDED",self.wait_operation(self.observe(current,current_task),current)["status"])
        _,task=primary.api("/api/tasks/"+task["id"])
        _,lease_task=primary.api("/api/tasks/"+lease_task["id"])
        status,connection=primary.api("/api/connections","POST",{
            "name":"Busy queue fixture","site":"example.com","startUrl":"https://example.com"})
        self.assertEqual(200,status)
        operation=str(uuid.uuid4())
        # A committed approved switch is the admission input. The connection is intentionally
        # leased, so this operation must never dispatch or require a saved credential fixture.
        self.fixture_sql(identity,"UPDATE browser_sessions SET connection_id='"+connection["id"]+"' WHERE owner_id=:owner AND id='"+lease_task["browser"]["id"]+"'; "
            +"INSERT INTO operations(id,owner_id,task_id,type,arguments,status,mutating,instruction_revision,control_epoch) VALUES ('"+operation+"',:owner,'"+task["id"]+"','applyConnection','{\"connectionId\":\""+connection["id"]+"\"}','ACCEPTED',true,"+str(task["instructionRevision"])+","+str(task["browser"]["controlEpoch"])+");")
        other_client,other_task=self.create(other)
        other_operation=self.observe(other_client,other_task)
        deadline=time.monotonic()+20
        receipt={}
        while time.monotonic()<deadline:
            error,receipt,_=other_client.tool("operations.get",{"operationId":other_operation})
            self.assertFalse(error,receipt)
            if receipt["status"]=="SUCCEEDED":
                break
            time.sleep(.3)
        self.assertEqual("SUCCEEDED",receipt.get("status"),"A leased connection must not starve another runnable owner")
        error,blocked,_=client.tool("operations.get",{"operationId":operation})
        self.assertFalse(error)
        self.assertEqual("ACCEPTED",blocked["status"])


if __name__=="__main__":
    unittest.main(verbosity=2)
