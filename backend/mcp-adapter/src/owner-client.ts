import { request, Agent } from 'node:https';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolName } from './catalog.js';

const safeEnvelope = z.object({
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(1_048_576) }),
    z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string().max(6_000_000) }),
    z.object({ type: z.literal('audio'), mimeType: z.string(), data: z.string().max(6_000_000) }),
    z.object({ type: z.literal('resource_link'), uri: z.string(), name: z.string(), mimeType: z.string().optional() }),
  ])).max(32),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export class OwnerClient {
  private readonly agent: Agent;
  constructor(private readonly endpoint: URL, cert: Buffer, key: Buffer, ca: Buffer) {
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('API_MCP_ENDPOINT must be a fixed HTTPS endpoint.');
    this.agent = new Agent({ cert, key, ca, rejectUnauthorized: true, keepAlive: true, maxSockets: 32, maxFreeSockets: 4 });
  }

  async call(name: ToolName, args: unknown, bearer: string, requestId: string): Promise<CallToolResult> {
    const url = new URL(`${this.endpoint.pathname.replace(/\/$/, '')}/tools/${encodeURIComponent(name)}`, this.endpoint);
    const body = Buffer.from(JSON.stringify({ arguments: args, requestId }));
    return new Promise<CallToolResult>((resolve, reject) => {
      const req = request(url, { method: 'POST', agent: this.agent, timeout: 25_000,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'content-length': body.byteLength, 'x-request-id': requestId } }, (res) => {
        const buffers: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 8_388_608) { req.destroy(new Error('OWNER_RESPONSE_LIMIT')); return; }
          buffers.push(chunk);
        });
        res.on('error', () => reject(new Error('OWNER_RESPONSE_INTERRUPTED')));
        res.on('end', () => {
          try {
            const value: unknown = JSON.parse(Buffer.concat(buffers).toString('utf8'));
            if (res.statusCode !== 200) {
              const problem = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/).optional() }).safeParse(value);
              const code = problem.success && problem.data.code ? problem.data.code : res.statusCode === 401 ? 'UNAUTHENTICATED' : res.statusCode === 403 ? 'FORBIDDEN' : 'OWNER_REJECTED';
              resolve({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, status: res.statusCode, requestId }) }] });
              return;
            }
            const envelope = safeEnvelope.safeParse(value);
            if (envelope.success) { resolve(envelope.data); return; }
            const domain = z.record(z.string(), z.unknown()).parse(value);
            const { _meta, ...structuredContent } = domain;
            const metadata = _meta === undefined ? undefined : z.record(z.string(), z.unknown()).parse(_meta);
            resolve({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent,
              ...(metadata ? { _meta: metadata } : {}) });
          } catch { reject(new Error('OWNER_CONTRACT_INVALID')); }
        });
      });
      // A timeout never retries a Java mutation: acceptance may already be committed.
      req.on('timeout', () => req.destroy(new Error('OWNER_RESPONSE_UNKNOWN')));
      req.on('error', () => reject(new Error('OWNER_RESPONSE_UNKNOWN')));
      req.end(body);
    });
  }

  close(): void { this.agent.destroy(); }
}
