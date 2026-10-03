import assert from 'node:assert/strict';
import test from 'node:test';
import { ProvisioningError } from '../src/keycloak-client.mjs';
import { provisionPredefinedUsers } from '../src/predefined-users.mjs';

const input = () => ({
  installationId: 'integration-fixture',
  admin: { email: 'admin@example.test', lastName: 'Fixture', password: 'admin fixture password' },
  angelina: { email: 'angelina@example.test', lastName: 'Fixture', password: 'user fixture password' },
});

class KeycloakFixture {
  realm = { realm: 'helm', attributes: { 'helm.installationId': 'integration-fixture', unrelated: 'preserve' } };
  users = new Map();
  passwords = new Map();
  roles = new Map();
  mutations = [];
  lostCreateResponse = false;
  lostPasswordResponse = false;
  rejectPassword = false;

  async request(method, path, body, { allowNotFound = false } = {}) {
    const url = new URL(path, 'http://fixture/');
    const route = url.pathname;
    if (method !== 'GET') this.mutations.push({ method, path });
    if (route === '/admin/realms/helm') {
      if (method === 'PUT') this.realm = structuredClone(body);
      return structuredClone(this.realm);
    }
    if (route === '/admin/realms/helm/roles/platform_admin') {
      return { id: 'admin-role', name: 'platform_admin' };
    }
    if (route === '/admin/realms/helm/users') {
      if (method === 'POST') {
        const id = `user-${this.users.size + 1}`;
        this.users.set(id, { ...structuredClone(body), id });
        if (this.lostCreateResponse) {
          this.lostCreateResponse = false;
          throw new ProvisioningError('ADMIN_RESULT_UNKNOWN', 'Lost response');
        }
        return undefined;
      }
      return structuredClone([...this.users.values()].filter((user) =>
        url.searchParams.has('username') ? user.username === url.searchParams.get('username')
          : user.email === url.searchParams.get('email')));
    }
    const match = route.match(/^\/admin\/realms\/helm\/users\/([^/]+)(.*)$/);
    assert.ok(match, `Unexpected route ${method} ${path}`);
    const [, id, operation] = match;
    const user = this.users.get(id);
    if (!user) {
      if (allowNotFound) return undefined;
      throw new ProvisioningError('ADMIN_HTTP_404', 'Absent');
    }
    if (!operation) {
      if (method === 'PUT') this.users.set(id, structuredClone(body));
      return structuredClone(this.users.get(id));
    }
    if (operation === '/reset-password') {
      if (this.rejectPassword) throw new ProvisioningError('ADMIN_HTTP_400', 'Policy rejected');
      this.passwords.set(id, body.value);
      assert.equal(body.temporary, false);
      assert.equal(user.enabled, false);
      if (this.lostPasswordResponse) {
        this.lostPasswordResponse = false;
        throw new ProvisioningError('ADMIN_RESULT_UNKNOWN', 'Lost response');
      }
      return undefined;
    }
    if (operation === '/credentials') {
      return this.passwords.has(id) ? [{ id: `password-${id}`, type: 'password' }] : [];
    }
    if (operation === '/role-mappings/realm') {
      if (method === 'POST') this.roles.set(id, structuredClone(body));
      return this.roles.get(id) ?? [];
    }
    assert.fail(`Unexpected operation ${method} ${path}`);
  }
}

test('prepares exactly two enabled accounts with only application admin rights', async () => {
  const fixture = new KeycloakFixture();
  const result = await provisionPredefinedUsers(fixture, input());
  assert.deepEqual(result.map((item) => item.username), ['admin', 'angelina']);
  assert.equal(fixture.users.size, 2);
  for (const user of fixture.users.values()) {
    assert.equal(user.enabled, true);
    assert.equal(user.emailVerified, true);
    assert.deepEqual(user.requiredActions, []);
    assert.equal(user.lastName, 'Fixture');
  }
  assert.deepEqual(fixture.roles.get(result[0].id).map((role) => role.name), ['platform_admin']);
  assert.equal(fixture.roles.has(result[1].id), false);
  assert.equal(fixture.realm.attributes.unrelated, 'preserve');
});

test('restart preserves changed password, blocked status, revoked role and user profile', async () => {
  const fixture = new KeycloakFixture();
  const result = await provisionPredefinedUsers(fixture, input());
  const admin = fixture.users.get(result[0].id);
  admin.enabled = false;
  admin.lastName = 'Changed by user';
  admin.requiredActions = ['CONFIGURE_TOTP'];
  fixture.passwords.set(admin.id, 'changed outside provisioning');
  fixture.roles.set(admin.id, []);
  fixture.mutations = [];
  assert.equal((await provisionPredefinedUsers(fixture, input()))[0].status, 'preserved');
  assert.deepEqual(fixture.mutations, []);
  assert.equal(fixture.passwords.get(admin.id), 'changed outside provisioning');
  assert.equal(fixture.users.get(admin.id).enabled, false);
  assert.deepEqual(fixture.roles.get(admin.id), []);
  assert.deepEqual(fixture.users.get(admin.id).requiredActions, ['CONFIGURE_TOTP']);
});

test('deleted completed account is never recreated', async () => {
  const fixture = new KeycloakFixture();
  const [admin] = await provisionPredefinedUsers(fixture, input());
  fixture.users.delete(admin.id);
  fixture.mutations = [];
  assert.equal((await provisionPredefinedUsers(fixture, input()))[0].status, 'previously-removed');
  assert.deepEqual(fixture.mutations, []);
});

test('conflict with second username prevents changes to either account', async () => {
  const fixture = new KeycloakFixture();
  fixture.users.set('foreign', { id: 'foreign', username: 'angelina', email: 'other@example.test' });
  await assert.rejects(provisionPredefinedUsers(fixture, input()), { code: 'USER_OWNERSHIP_CONFLICT' });
  assert.deepEqual(fixture.mutations, []);
});

test('foreign email and foreign realm are rejected without mutation', async () => {
  const fixture = new KeycloakFixture();
  fixture.users.set('foreign', { id: 'foreign', username: 'someone', email: 'admin@example.test' });
  await assert.rejects(provisionPredefinedUsers(fixture, input()), { code: 'USER_OWNERSHIP_CONFLICT' });
  fixture.realm.attributes['helm.installationId'] = 'someone-else';
  await assert.rejects(provisionPredefinedUsers(fixture, input()), { code: 'REALM_OWNERSHIP_CONFLICT' });
  assert.deepEqual(fixture.mutations, []);
});

test('lost create response is reconciled without a duplicate account', async () => {
  const fixture = new KeycloakFixture();
  fixture.lostCreateResponse = true;
  await provisionPredefinedUsers(fixture, input());
  assert.equal(fixture.users.size, 2);
  assert.equal(fixture.mutations.filter((operation) => operation.method === 'POST'
    && operation.path === 'admin/realms/helm/users').length, 2);
});

test('unknown password result stays disabled and is not blindly replayed', async () => {
  const fixture = new KeycloakFixture();
  fixture.lostPasswordResponse = true;
  await assert.rejects(provisionPredefinedUsers(fixture, input()), { code: 'PASSWORD_RESULT_UNKNOWN' });
  assert.equal(fixture.users.get('user-1').enabled, false);
  await assert.rejects(provisionPredefinedUsers(fixture, input()), { code: 'PASSWORD_RESULT_UNKNOWN' });
  assert.equal(fixture.mutations.filter((operation) => operation.path.endsWith('/reset-password')).length, 1);
});

test('confirmed password rejection can be corrected without duplicate creation', async () => {
  const fixture = new KeycloakFixture();
  fixture.rejectPassword = true;
  await assert.rejects(provisionPredefinedUsers(fixture, input()), { code: 'ADMIN_HTTP_400' });
  assert.equal(fixture.users.get('user-1').enabled, false);
  fixture.rejectPassword = false;
  await provisionPredefinedUsers(fixture, input());
  assert.equal(fixture.users.size, 2);
});

test('missing completion receipt preserves an already enabled account after admin edits', async () => {
  const fixture = new KeycloakFixture();
  const [admin] = await provisionPredefinedUsers(fixture, input());
  fixture.realm.attributes['helm.predefined.admin.complete'] = 'false';
  fixture.users.get(admin.id).enabled = false;
  fixture.roles.set(admin.id, []);
  await provisionPredefinedUsers(fixture, input());
  assert.equal(fixture.users.get(admin.id).enabled, false);
  assert.deepEqual(fixture.roles.get(admin.id), []);
  assert.equal(fixture.realm.attributes['helm.predefined.admin.complete'], 'true');
});

test('empty inputs and marker injection fail before any external request', async () => {
  for (const mutation of [
    (value) => { value.admin.password = ' '; },
    (value) => { value.angelina.lastName = ''; },
    (value) => { value.admin.email = 'bad'; },
    (value) => { value.angelina.email = value.admin.email; },
    (value) => { value.admin.attributes = { 'helm.provisioning.phase': ['ready'] }; },
  ]) {
    const data = input();
    mutation(data);
    const client = { request: () => assert.fail('Input validation must precede requests') };
    await assert.rejects(provisionPredefinedUsers(client, data), { code: 'INVALID_INPUT' });
  }
});
