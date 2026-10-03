// This is an isolated protocol fixture, not a browser session or an authentication bypass.
// The real pinned OAuth2 Proxy validates RSA-signed OIDC tokens, nonce and S256 PKCE and
// stores its real encrypted session in Redis. Seconds replace minutes; no proxy clock is mocked.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const configuredRefreshSeconds = Number(process.argv[2]);
assert.ok(Number.isInteger(configuredRefreshSeconds) && configuredRefreshSeconds > 0);
const issuer = 'http://127.0.0.1:8000';
const accessLifetimeSeconds = 5;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' };
const clients = new Map();
const codes = new Map();
const children = [];
const directory = await mkdtemp('/tmp/helm-oauth-expiry-');
let providerFailure;
const provider = createServer((request, response) => {
  handle(request, response).catch(error => {
    providerFailure = error instanceof assert.AssertionError ? error.message.split('\n')[0]
      : 'OIDC fixture rejected a protocol request';
    if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
    response.end('{"error":"invalid_request"}');
  });
});

function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk.toString();
    assert.ok(value.length <= 8192, 'OIDC request body is bounded');
  }
  return new URLSearchParams(value);
}

function jwt(claims) {
  const unsigned = [
    { alg: 'RS256', typ: 'JWT', kid: 'fixture' }, claims,
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

function accessClaims(token) {
  assert.ok(typeof token === 'string' && token.length < 8192, 'Forwarded token is bounded');
  const [header, payload, signature] = token.split('.');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey,
    Buffer.from(signature, 'base64url')), 'Forwarded token has the issuer signature');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.ok(claims.iss === issuer && claims.aud === 'helm-api-web', 'Access-token audience and issuer');
  return claims;
}

async function handle(request, response) {
  const url = new URL(request.url, issuer);
  if (url.pathname === '/jwks') return json(response, { keys: [jwk] });
  if (url.pathname === '/authorize') {
    const client = clients.get(url.searchParams.get('client_id'));
    assert.ok(client, 'Known disposable OIDC client');
    assert.ok(url.searchParams.get('redirect_uri') === client.callback, 'Exact registered callback');
    assert.ok(url.searchParams.get('code_challenge_method') === 'S256', 'PKCE remains enabled');
    assert.ok(url.searchParams.has('nonce') && url.searchParams.has('state'), 'Nonce and state required');
    assert.ok(codes.size < 4, 'Authorization code inventory is bounded');
    const code = randomBytes(32).toString('base64url');
    codes.set(code, { client, challenge: url.searchParams.get('code_challenge'),
      nonce: url.searchParams.get('nonce') });
    const callback = new URL(client.callback);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', url.searchParams.get('state'));
    response.writeHead(302, { location: callback.href });
    return response.end();
  }
  assert.ok(url.pathname === '/token' && request.method === 'POST', 'Only token or authorization routes');
  const form = await body(request);
  const basic = request.headers.authorization?.startsWith('Basic ')
    ? Buffer.from(request.headers.authorization.slice(6), 'base64').toString().split(':') : [];
  const client = clients.get(basic[0] ?? form.get('client_id'));
  assert.ok(client && client.secret === (basic[1] ?? form.get('client_secret')), 'OIDC client authenticates');
  const initial = form.get('grant_type') === 'authorization_code';
  if (initial) {
    const authorization = codes.get(form.get('code'));
    assert.ok(authorization?.client === client, 'Code is owned by the client');
    assert.ok(form.get('redirect_uri') === client.callback, 'Redeem callback is exact');
    const challenge = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
    assert.ok(challenge === authorization.challenge, 'Real proxy proves the PKCE verifier');
    client.nonce = authorization.nonce;
    codes.delete(form.get('code'));
  } else {
    assert.ok(form.get('grant_type') === 'refresh_token'
      && form.get('refresh_token') === client.refreshToken, 'Refresh uses the issued credential');
    if (client.revoked) return json(response, { error: 'invalid_grant' }, 400);
    client.refreshes++;
    client.refreshStartedAt = Date.now();
  }
  // Age() truncates the real clock to seconds. Fix only the issuer's scheduling phase so
  // the short fixture has a repeatable margin; neither process clock is replaced or advanced.
  if (initial) await until((Math.floor(Date.now() / 1000) + 1) * 1000 + 50);
  const issued = Math.floor(Date.now() / 1000);
  const expiry = issued + accessLifetimeSeconds;
  client.lastExpiry = expiry * 1000;
  const common = { iss: issuer, sub: 'fixture-user', iat: issued, exp: expiry,
    email: 'fixture@example.test', email_verified: true, sid: client.id };
  const tokens = {
    access_token: jwt({ ...common, aud: 'helm-api-web', azp: client.id }),
    id_token: jwt({ ...common, aud: client.id, nonce: client.nonce }),
    refresh_token: client.refreshToken, token_type: 'Bearer', expires_in: accessLifetimeSeconds,
  };
  // The issuer's JWT clock starts before the proxy records CreatedAt; deliberately expose that gap.
  if (initial) await delay(1200);
  json(response, tokens);
}

async function fetchBounded(url, options = {}) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000), ...options });
}

async function startProxy(id, port, refresh) {
  const client = { id, secret: randomBytes(32).toString('base64url'),
    refreshToken: randomBytes(32).toString('base64url'), callback: `http://127.0.0.1:${port}/oauth2/callback`,
    refreshes: 0, revoked: false, cookies: new Map(), origin: `http://127.0.0.1:${port}` };
  clients.set(id, client);
  const config = {
    provider: 'oidc', http_address: `127.0.0.1:${port}`, upstreams: ['static://202'],
    client_id: id, client_secret: client.secret, cookie_secret: randomBytes(32).toString('base64url'),
    oidc_issuer_url: issuer, skip_oidc_discovery: true, login_url: `${issuer}/authorize`,
    redeem_url: `${issuer}/token`, oidc_jwks_url: `${issuer}/jwks`, redirect_url: client.callback,
    code_challenge_method: 'S256', insecure_oidc_skip_nonce: false,
    scope: 'openid profile email', email_domains: ['*'],
    session_store_type: 'redis', redis_connection_url: 'redis://redis:6379/0',
    cookie_name: '_helm_fixture', cookie_secure: false, cookie_httponly: true,
    cookie_expire: '1h', cookie_refresh: `${refresh}s`, set_xauthrequest: true,
    pass_access_token: true, request_logging: false, auth_logging: false, standard_logging: true,
  };
  const path = `${directory}/${id}.cfg`;
  await writeFile(path, Object.entries(config).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n'),
    { mode: 0o600 });
  const child = spawn('/usr/local/bin/oauth2-proxy', [`--config=${path}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let startupError = '';
  const capture = chunk => {
    if (startupError.length < 4096) startupError += chunk.toString().slice(0, 4096 - startupError.length);
  };
  child.stderr.on('data', capture);
  child.stdout.on('data', capture);
  children.push(child);
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await fetchBounded(`${client.origin}/ping`).catch(() => null);
    if (response?.ok) { await response.body.cancel(); startupError = ''; return client; }
    if (response) await response.body.cancel();
    if (child.exitCode !== null) {
      // Readiness precedes authorization, so only configuration errors can occur here.
      for (const value of [client.secret, client.refreshToken, config.cookie_secret]) {
        startupError = startupError.replaceAll(value, '[redacted]');
      }
      process.stderr.write(startupError.replace(/https?:\/\/\S+/g, '[fixture-url]').slice(0, 1024));
      assert.fail('Pinned OAuth2 Proxy starts with the fixture config');
    }
    await delay(100);
  }
  throw new Error('Pinned OAuth2 Proxy readiness timed out');
}

function saveCookies(client, response) {
  for (const value of response.headers.getSetCookie()) {
    const cookie = value.split(';')[0];
    assert.ok(cookie.length < 4096 && client.cookies.size < 8, 'Cookie jar is bounded');
    const split = cookie.indexOf('=');
    client.cookies.set(cookie.slice(0, split), cookie.slice(split + 1));
  }
}

function cookies(client) {
  return [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function login(client) {
  let response = await fetchBounded(`${client.origin}/oauth2/start?rd=/`);
  assert.equal(response.status, 302, 'Proxy starts an OIDC authorization');
  saveCookies(client, response);
  let location = response.headers.get('location');
  await response.body.cancel();
  assert.ok(new URL(location).origin === issuer, 'Authorization only reaches the test issuer');
  response = await fetchBounded(location);
  assert.equal(response.status, 302, 'Issuer returns a one-use authorization code');
  location = response.headers.get('location');
  await response.body.cancel();
  assert.ok(new URL(location).origin === client.origin, 'Callback only reaches this proxy');
  response = await fetchBounded(location, { headers: { cookie: cookies(client) } });
  assert.equal(response.status, 302, 'OIDC callback succeeds with nonce and PKCE validation');
  saveCookies(client, response);
  await response.body.cancel();
  client.loginCompletedAt = Date.now();
  assert.equal(client.cookies.has('_helm_fixture'), true, 'Redis ticket cookie exists');
}

async function authorize(client) {
  const response = await fetchBounded(`${client.origin}/oauth2/auth`, { headers: { cookie: cookies(client) } });
  saveCookies(client, response);
  const status = response.status;
  const token = response.headers.get('x-auth-request-access-token');
  await response.body.cancel();
  return { status, claims: status === 202 ? accessClaims(token) : null };
}

async function until(timestamp) {
  const wait = timestamp - Date.now();
  assert.ok(wait < 10_000, 'Timing wait is bounded');
  if (wait > 0) await delay(wait);
}

try {
  provider.listen(8000, '127.0.0.1');
  await once(provider, 'listening');
  const legacy = await startProxy('legacy', 4180, accessLifetimeSeconds);
  const current = await startProxy('current', 4181, configuredRefreshSeconds);
  await login(legacy);
  let result = await authorize(legacy);
  assert.ok(result.status === 202 && result.claims.exp * 1000 > Date.now(), 'Initial access is valid');
  const legacyExpiry = result.claims.exp * 1000;
  await until(legacyExpiry + 100);
  result = await authorize(legacy);
  assert.ok(result.status === 202 && result.claims.exp * 1000 <= Date.now(),
    'Equal refresh/TTL reproduces forwarding an expired access token');
  assert.equal(legacy.refreshes, 0, 'Expired forwarding precedes the cookie-age refresh');
  await until(legacy.loginCompletedAt + 6100);
  result = await authorize(legacy);
  assert.ok(result.status === 202 && result.claims.exp * 1000 > Date.now(),
    'The same legacy session recovers after its later refresh threshold');
  assert.equal(legacy.refreshes, 1, 'Actual issuer refresh was used');

  await login(current);
  result = await authorize(current);
  const firstExpiry = result.claims.exp * 1000;
  await until(firstExpiry - 200);
  result = await authorize(current);
  assert.equal(current.refreshes, 1, 'Configured interval refreshes before the JWT expires');
  assert.ok(current.refreshStartedAt < firstExpiry && result.claims.exp * 1000 > firstExpiry,
    'Issuer refresh advances expiry before the old expiry boundary');
  const refreshedAt = Date.now();
  await until(firstExpiry + 100);
  result = await authorize(current);
  assert.ok(result.status === 202 && result.claims.exp * 1000 > Date.now(),
    'The original expiry boundary never forwards expired authorization');
  current.revoked = true;
  await until(refreshedAt + (configuredRefreshSeconds + 1.1) * 1000);
  assert.equal((await authorize(current)).status, 401, 'Revoked refresh remains denied');
  assert.equal(providerFailure, undefined, 'All fixture protocol validations passed');
  process.stdout.write(JSON.stringify({ pinnedVersion: '7.15.5', accessLifetimeSeconds,
    configuredRefreshSeconds, expiredForwardingReproduced: true, refreshBeforeExpiry: true,
    expiryBoundaryContinuous: true, revokedRefreshDenied: true }) + '\n');
} catch (error) {
  // Assertion values can contain OAuth credentials. Emit only our fixed assertion description.
  if (providerFailure) process.stderr.write(`${providerFailure}\n`);
  process.stderr.write(`${error instanceof assert.AssertionError ? error.message.split('\n')[0]
    : 'OAuth expiry fixture failed before completing its assertions'}\n`);
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  }
  provider.close();
  await rm(directory, { recursive: true, force: true });
}
