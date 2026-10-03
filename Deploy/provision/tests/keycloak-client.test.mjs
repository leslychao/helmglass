import assert from 'node:assert/strict';
import test from 'node:test';
import { KeycloakClient } from '../src/keycloak-client.mjs';

test('does not send a bearer outside the configured admin endpoint', async () => {
  let requests = 0;
  const client = new KeycloakClient('http://keycloak:8080/auth', 'fixture-token', async () => {
    requests++;
    return new Response('{}');
  });
  for (const path of ['https://foreign.example/admin', '../admin', '/admin']) {
    await assert.rejects(client.request('GET', path), { code: 'INVALID_ADMIN_PATH' });
  }
  assert.equal(requests, 0);
  await client.request('GET', 'admin/realms/helm');
  assert.equal(requests, 1);
});

test('rejections and unknown outcomes never expose response secrets or retry a mutation', async () => {
  const secret = 'private-response-content';
  let requests = 0;
  const rejected = new KeycloakClient('http://keycloak:8080/auth', 'fixture-token', async () => {
    requests++;
    return new Response(secret, { status: 400 });
  });
  await assert.rejects(rejected.request('PUT', 'admin/realms/helm', { secret }), (error) => {
    assert.equal(error.code, 'ADMIN_HTTP_400');
    assert.ok(!error.message.includes(secret));
    return true;
  });
  const unknown = new KeycloakClient('http://keycloak:8080/auth', 'fixture-token', async () => {
    requests++;
    throw new Error(secret);
  });
  await assert.rejects(unknown.request('POST', 'admin/realms/helm/users', { secret }), (error) => {
    assert.equal(error.code, 'ADMIN_RESULT_UNKNOWN');
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(requests, 2);
});

test('limits admin response size and distinguishes missing optional resource from failure', async () => {
  const large = new KeycloakClient('http://keycloak:8080/auth', 'fixture-token',
    async () => new Response('x'.repeat(1_048_577)));
  await assert.rejects(large.request('GET', 'admin/realms/helm'), { code: 'ADMIN_RESPONSE_TOO_LARGE' });
  const absent = new KeycloakClient('http://keycloak:8080/auth', 'fixture-token',
    async () => new Response('', { status: 404 }));
  assert.equal(await absent.request('GET', 'admin/realms/helm', undefined, { allowNotFound: true }), undefined);
  await assert.rejects(absent.request('GET', 'admin/realms/helm'), { code: 'ADMIN_HTTP_404' });
});
