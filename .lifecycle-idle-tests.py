from pathlib import Path
p=Path('backend/api/tests/test_browser_idle.py')
s=p.read_text(encoding='utf-8')
s=s.replace('def test_manual_controller_protects_browser_and_incomplete_login_stays_private(self):', 'def test_manual_deadline_and_incomplete_login_stays_private(self):')
s=s.replace('''        self.expire_browser(identity, task['browser'])
        protected = self.wait_task(client, task['id'], lambda value: value['browser']['idleCloseAt'] is None)
        self.assertEqual(('LIVE', 'USER'), (protected['browser']['status'], protected['browser']['controlOwner']))''','''        protected = task
        self.assertEqual(900, protected['browser']['idleTimeoutSeconds'])
        self.assertGreater(datetime.fromisoformat(protected['browser']['idleCloseAt']).timestamp(), time.time() + 850)
        self.assertGreater(datetime.fromisoformat(protected['browser']['idleWarningAt']).timestamp(), time.time() + 550)
        self.assertEqual(('LIVE', 'USER'), (protected['browser']['status'], protected['browser']['controlOwner']))''')
s=s.replace('time.time() + 850)\n        rows =', 'time.time() + 250)\n        rows =')
anchor='    def test_concurrent_explicit_leaves_create_one_continuation(self):'
assert anchor in s
s=s.replace(anchor,'''    def test_manual_activity_requires_current_controller_and_never_replays(self):
        identity, client, model, task = self.ready()
        task, viewer, visit = self.take(client, task)
        browser = task['browser']
        path = '/api/browser-sessions/' + browser['id'] + '/pages/' + visit + '/activity'
        before = browser['idleCloseAt']
        payload = {'controlEpoch': browser['controlEpoch'], 'sequence': 1}
        _, foreign = self.owner()
        self.assertEqual(404, foreign.api(path, 'POST', payload)[0])
        self.assertEqual(409, client.api(path, 'POST', {**payload, 'controlEpoch': browser['controlEpoch'] - 1})[0])
        observer_visit = str(uuid.uuid4())
        self.assertEqual(200, self.page(client, browser, observer_visit, 'PUT', str(uuid.uuid4()))[0])
        observer_path = path.replace(visit, observer_visit)
        self.assertEqual(403, client.api(observer_path, 'POST', payload)[0])
        self.assertEqual(before, client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt'])
        self.assertEqual(200, client.api(path, 'POST', payload)[0])
        renewed = client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt']
        self.assertGreater(renewed, before)
        self.assertEqual(200, client.api(path, 'POST', payload)[0])
        self.assertEqual(200, self.page(client, browser, visit, 'PUT', viewer)[0])
        self.assertEqual(renewed, client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt'])
        self.expire_browser(identity, browser)
        closed = self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')
        self.assertEqual('PAUSED', closed['status'])
        self.assertEqual('IDLE_TIMEOUT', closed['browser']['closeReason'])
        self.assertEqual(409, client.api(path, 'POST', {**payload, 'sequence': 2})[0])

    def test_model_status_and_rejected_requests_do_not_extend_idle(self):
        identity, client, model, task = self.ready()
        browser = task['browser']
        self.assertEqual(300, browser['idleTimeoutSeconds'])
        before = browser['idleCloseAt']
        for _ in range(3):
            self.assertFalse(model.tool('tasks.get', {'taskId': task['id']})[0])
            client.api('/api/tasks/' + task['id'])
        self.assertEqual(before, client.api('/api/tasks/' + task['id'])[1]['browser']['idleCloseAt'])
        self.expire_browser(identity, browser)
        self.wait_task(client, task['id'], lambda value: value['browser']['status'] == 'CLOSED')

''' +anchor)
p.write_text(s,encoding='utf-8',newline='\n')
