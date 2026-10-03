import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { OwnerClient } from './owner-client.js';
import { authenticatedAdapter, createAdapter } from './server.js';

const config = z.object({
  PORT: z.coerce.number().int().min(1024).max(65535).default(8080),
  PUBLIC_ORIGIN: z.url(), OIDC_ISSUER: z.url(), OIDC_JWKS_URL: z.url(),
  API_MCP_ENDPOINT: z.url(), MTLS_CERT_FILE: z.string().min(1), MTLS_KEY_FILE: z.string().min(1), MTLS_CA_FILE: z.string().min(1),
  WIDGET_HTML_PATH: z.string().min(1),
}).parse(process.env);
const [cert, key, ca, widgetHtml] = await Promise.all([
  readFile(config.MTLS_CERT_FILE), readFile(config.MTLS_KEY_FILE), readFile(config.MTLS_CA_FILE), readFile(config.WIDGET_HTML_PATH, 'utf8'),
]);
const publicOrigin = new URL(config.PUBLIC_ORIGIN).origin;
const owner = new OwnerClient(new URL(config.API_MCP_ENDPOINT), cert, key, ca);
const jwks = createRemoteJWKSet(new URL(config.OIDC_JWKS_URL), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 300_000 });
const handler = createAdapter(owner, widgetHtml, publicOrigin);
const authenticated = authenticatedAdapter(handler, async (token) => {
  const { payload } = await jwtVerify(token, jwks, { issuer: config.OIDC_ISSUER, audience: 'helm-mcp', algorithms: ['RS256', 'ES256'], clockTolerance: 5 });
  if (typeof payload.azp !== 'string' || !payload.sub || !payload.exp) throw new Error('INVALID_IDENTITY');
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
  return { token, clientId: payload.azp, scopes, expiresAt: payload.exp };
}, publicOrigin, config.OIDC_ISSUER);
const server = createServer((request, response) => {
  const incoming = Object.assign(request, { method: request.method ?? 'GET', url: request.url ?? '/' });
  const serve = toNodeHandler({ fetch: webRequest => authenticated.fetch(webRequest, () => response.destroy()) },
    { maxRequestBodySize: 1_048_576 });
  void serve(incoming, response).catch(() => { response.destroy(); });
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.maxRequestsPerSocket = 1000;
server.listen(config.PORT, '0.0.0.0');
process.stdout.write(JSON.stringify({ level: 'info', event: 'adapter_started', port: config.PORT }) + '\n');
process.once('SIGTERM', () => {
  server.close(() => { owner.close(); key.fill(0); void handler.close(); });
});
