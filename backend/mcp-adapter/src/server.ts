import { randomUUID } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { AuthInfo, CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { appOnlyTools, readOnlyTools, scopesForTool, supportedScopes, toolSchemas, widgetResourceUri, widgetTools } from './catalog.js';
import type { ToolName } from './catalog.js';
import type { OwnerClient } from './owner-client.js';

export function createAdapter(owner: Pick<OwnerClient, 'call'>, widgetHtml: string, publicOrigin: string) {
  const address = new URL(publicOrigin);
  if (address.protocol !== 'https:' || address.origin !== publicOrigin) {
    throw new Error('The widget requires a canonical HTTPS public origin');
  }
  const marker = '__HELM_PUBLIC_ORIGIN__';
  if (widgetHtml.split(marker).length !== 2) {
    throw new Error('The widget resource must contain exactly one public-origin config marker');
  }
  const originJson = JSON.stringify(publicOrigin).replaceAll('<', '\\u003c').slice(1, -1);
  const resourceHtml = widgetHtml.replace(marker, () => originJson);
  return createMcpHandler((context) => {
    const server = new McpServer({ name: 'helm-glass', version: '0.1.0' });
    const bearer = context.authInfo?.token;
    for (const [toolName, inputSchema] of Object.entries(toolSchemas)) {
      const name = toolName as ToolName;
      const schema: z.ZodType = inputSchema;
      server.registerTool(name, {
        title: name,
        description: name === 'browser.execute'
          ? 'Execute exactly one authorized browser action. Reuse the original commandId/idempotencyKey to recover a lost response; never repeat an unknown external effect.'
          : name === 'tasks.continue'
            ? 'Claim the existing continuation of this same task after manual participation; read fresh context and observe before the next action.'
            : `Helm Glass ${name}. Authorization, versions and durable receipts are enforced by the application owner.`,
        inputSchema: schema,
        annotations: { readOnlyHint: readOnlyTools.has(name), destructiveHint: !readOnlyTools.has(name), openWorldHint: name.startsWith('browser.') || name.startsWith('media.') },
        _meta: {
          securitySchemes: [{ type: 'oauth2', scopes: scopesForTool(name) }],
          ui: { ...(widgetTools.has(name) ? { resourceUri: widgetResourceUri } : {}), visibility: appOnlyTools.has(name) ? ['app'] : ['model'] },
          ...(widgetTools.has(name) ? { 'openai/outputTemplate': widgetResourceUri } : {}),
          ...(appOnlyTools.has(name) ? { 'openai/widgetAccessible': true } : {}),
        },
      }, async (args: unknown): Promise<CallToolResult> => {
        if (!bearer) return { isError: true, content: [{ type: 'text', text: 'UNAUTHENTICATED' }] };
        if (!scopesForTool(name).every((scope) => context.authInfo?.scopes.includes(scope))) {
          return { isError: true, content: [{ type: 'text', text: 'INSUFFICIENT_SCOPE' }] };
        }
        const requestId = randomUUID();
        try { return await owner.call(name, args, bearer, requestId); }
        catch { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'OWNER_RESPONSE_UNKNOWN', requestId,
          recovery: 'Read the original task, command or idempotency receipt. This transport failure does not prove rejection and does not authorize a repeated external action.' }) }] }; }
      });
    }
    const widgetMetadata = {
      ui: { csp: { connectDomains: [publicOrigin, publicOrigin.replace(/^http/, 'ws')], resourceDomains: [] }, domain: publicOrigin },
      'openai/widgetDescription': 'Current Helm Glass task and authorized live browser view. Manual control opens the same task in Helm Glass.',
      'openai/widgetDomain': publicOrigin,
      'openai/widgetCSP': { connect_domains: [publicOrigin, publicOrigin.replace(/^http/, 'ws')],
        resource_domains: [], redirect_domains: [publicOrigin] },
    };
    server.registerResource('helm-browser', widgetResourceUri, { mimeType: 'text/html;profile=mcp-app' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app',
        text: resourceHtml, _meta: widgetMetadata }] }));
    return server;
  }, { legacy: 'stateless', responseMode: 'json', maxSubscriptions: 0, maxRequestBodySize: 1_048_576, onerror: () => undefined });
}

export type VerifyBearer = (token: string) => Promise<AuthInfo>;

export function authenticatedAdapter(handler: ReturnType<typeof createAdapter>, verify: VerifyBearer, publicOrigin: string, issuer: string) {
  const metadataUrl = `${publicOrigin}/.well-known/oauth-protected-resource/mcp`;
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/health') return Response.json({ status: 'UP' });
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return Response.json({ resource: `${publicOrigin}/mcp`, authorization_servers: [issuer], scopes_supported: supportedScopes, bearer_methods_supported: ['header'] });
      }
      if (url.pathname !== '/mcp') return new Response(null, { status: 404 });
      if ((request.headers.get('host') ?? url.host) !== new URL(publicOrigin).host) return new Response(null, { status: 403 });
      const origin = request.headers.get('origin');
      if (origin && origin !== publicOrigin && origin !== 'https://chatgpt.com') return new Response(null, { status: 403 });
      const authorization = request.headers.get('authorization');
      if (!authorization?.startsWith('Bearer ')) {
        return new Response(null, { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"` } });
      }
      let authInfo: AuthInfo;
      try { authInfo = await verify(authorization.slice(7)); }
      catch { return new Response(null, { status: 401, headers: { 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${metadataUrl}"` } }); }
      return handler.fetch(request, { authInfo });
    },
  };
}
