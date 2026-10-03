import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readKeycloakJson } from '../src/keycloak-client.mjs';

export async function tokenRequest(baseUrl, parameters) {
  const response = await fetch(`${baseUrl}/realms/helm/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'helm-mcp', ...parameters }),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await readKeycloakJson(response, 32_768) };
}

export async function authorizeMcp(baseUrl, password,
  scope = 'openid email offline_access tasks:read tasks:write browser:view browser:execute results:write', username = 'admin') {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const cookies = new Map();
  function remember(response) {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    assert.ok(cookies.size <= 20);
  }
  const authorize = new URL(`${baseUrl}/realms/helm/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({ client_id: 'helm-mcp', response_type: 'code', redirect_uri: redirectUri,
    scope,
    state, nonce: randomUUID(), code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
  const form = await fetch(authorize, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  assert.equal(form.status, 200, 'The real authorization request must render a login form');
  remember(form);
  const reader = form.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      assert.ok(bytes <= 131_072, 'Login form is bounded');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const html = Buffer.concat(chunks, bytes).toString('utf8');
  const action = /<form\b[^>]*\baction="([^"]+)"/.exec(html)?.[1];
  assert.ok(action, 'Keycloak login form must expose an action');
  const login = new URL(action.replaceAll('&amp;', '&'));
  assert.equal(login.origin, new URL(baseUrl).origin, 'Credentials stay in the disposable issuer');
  const submitted = await fetch(login, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded',
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') },
    body: new URLSearchParams({ username, password }),
  });
  await submitted.body?.cancel();
  assert.equal(submitted.status, 302, 'Valid credentials finish the standard code flow');
  const callback = new URL(submitted.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(callback.searchParams.has('error'), false, 'OAuth code flow must accept the requested scopes');
  const tokens = await tokenRequest(baseUrl, { grant_type: 'authorization_code',
    code: callback.searchParams.get('code'), redirect_uri: redirectUri, code_verifier: verifier });
  assert.equal(tokens.status, 200, 'Code exchange succeeds with PKCE S256');
  return tokens.body;
}

export function claims(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

