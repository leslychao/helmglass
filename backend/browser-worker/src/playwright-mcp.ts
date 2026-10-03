import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BrowserContext, Page } from 'playwright';
import { z } from 'zod';
import { WorkerError } from './protocol.js';
import type { Action } from './protocol.js';

const responseSchema = z.object({ snapshot: z.unknown().optional(), isError: z.boolean().optional(), error: z.string().optional() });
const networkErrors = new Set(['ERR_ABORTED', 'ERR_BLOCKED_BY_CLIENT', 'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET', 'ERR_CONNECTION_TIMED_OUT', 'ERR_EMPTY_RESPONSE', 'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_TIMED_OUT',
  'ERR_TUNNEL_CONNECTION_FAILED']);

/** Only fixed upstream categories may cross the boundary; error text can contain private URLs. */
export function upstreamErrorCode(error: unknown): string {
  if (typeof error !== 'string') return 'BROWSER_HANDLER_FAILED';
  const firstLine = error.slice(0, 512).split('\n', 1)[0] ?? '';
  const network = /^(?:Error: )?(?:(?:page\.(?:goto|goBack|goForward|reload)|browserBackend\.callTool): )?net::(ERR_[A-Z0-9_]+)(?: |$)/.exec(firstLine)?.[1];
  if (network && networkErrors.has(network)) return 'BROWSER_NETWORK_' + network.slice(4);
  if (/^(?:TimeoutError: )?(?:page\.|locator\.|browserBackend\.)[^:]+: Timeout \d+ms exceeded\./.test(firstLine)) return 'BROWSER_ACTION_TIMEOUT';
  if (/^(?:Error: )?(?:page\.|locator\.|browserBackend\.)[^:]+: Target page, context or browser has been closed/.test(firstLine)) return 'BROWSER_TARGET_CLOSED';
  return 'BROWSER_HANDLER_FAILED';
}

/** The only translation from Helm typed commands into pinned upstream MCP tools. */
export class PlaywrightMcpAdapter {
  private closed = false;
  private initialized = false;
  private constructor(private readonly client: Client, private readonly server: Awaited<ReturnType<typeof createConnection>>) {}

  static async create(context: BrowserContext, outputDir: string): Promise<PlaywrightMcpAdapter> {
    const server = await createConnection({
      browser: { isolated: false }, saveSession: false, webmcp: false,
      codegen: 'none', snapshot: { mode: 'none' }, imageResponses: 'omit',
      outputDir, outputMaxSize: 8 * 1024 * 1024,
      timeouts: { action: 10_000, navigation: 20_000, idle: 0 },
    }, async () => context);
    const client = new Client({ name: 'helm-browser-control', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return new PlaywrightMcpAdapter(client, server);
  }

  async snapshot(depth = 20): Promise<unknown> {
    const result = await this.call('browser_snapshot', { depth, _meta: { json: true } });
    if (result.snapshot === undefined) throw new WorkerError('UPSTREAM_SNAPSHOT_INCOMPATIBLE');
    return result.snapshot;
  }

  async selectPage(context: BrowserContext, page: Page): Promise<void> {
    const index = context.pages().indexOf(page);
    if (index < 0 || page.isClosed()) throw new WorkerError('PAGE_LOST');
    if (!this.initialized) {
      const pages = context.pages();
      await this.call('browser_tabs', { action: 'list' });
      if (pages.length !== context.pages().length || pages.some((item, position) => context.pages()[position] !== item)) throw new WorkerError('UNEXPECTED_PAGE_REPLACEMENT');
      this.initialized = true;
    }
    await this.call('browser_tabs', { action: 'select', index });
    if (context.pages()[index] !== page) throw new WorkerError('PAGE_CHANGED');
  }

  async execute(action: Action, page: Page, timeout: number): Promise<void> {
    switch (action.type) {
      case 'OBSERVE': return;
      case 'CLICK': await this.call('browser_click', { target: action.target }); return;
      case 'FILL': await this.call('browser_type', { target: action.target, text: action.text, submit: false, slowly: false }); return;
      case 'SELECT': await this.call('browser_select_option', { target: action.target, values: action.values }); return;
      case 'PRESS': await page.locator(`aria-ref=${action.target}`).press(action.key, { timeout }); return;
      case 'SCROLL': await page.mouse.wheel(action.deltaX, action.deltaY); return;
      case 'NAVIGATE': await this.call('browser_navigate', { url: action.url }); return;
      case 'BACK': await this.call('browser_navigate_back', {}); return;
      case 'FORWARD': await page.goForward({ timeout, waitUntil: 'domcontentloaded' }); return;
      case 'RELOAD': await page.reload({ timeout, waitUntil: 'domcontentloaded' }); return;
      case 'WAIT_FOR': await page.getByText(action.text, { exact: true }).first().waitFor({ state: action.state === 'VISIBLE' ? 'visible' : 'hidden', timeout }); return;
      case 'READ_MEDIA': throw new WorkerError('MEDIA_OWNER_REQUIRED');
      case 'SNAPSHOT': throw new WorkerError('SCREENSHOT_OWNER_REQUIRED');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // Patched server.close waits for initialization, quiesced calls, listeners and writes.
    await this.server.close();
    await this.client.close();
  }

  private async call(name: string, args: Record<string, unknown>): Promise<z.infer<typeof responseSchema>> {
    if (this.closed) throw new WorkerError('MCP_BACKEND_CLOSED');
    const response = await this.client.callTool({ name, arguments: { ...args, _meta: { json: true } } }, undefined, { timeout: 30_000 });
    const content = response.content;
    if (!Array.isArray(content)) throw new WorkerError('UPSTREAM_RESPONSE_INCOMPATIBLE');
    const textParts: string[] = [];
    for (const part of content) {
      if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') textParts.push(part.text);
    }
    const text = textParts.join('\n');
    if (text.length > 1_048_576) throw new WorkerError('OBSERVATION_LIMIT');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new WorkerError(response.isError ? 'BROWSER_HANDLER_FAILED' : 'UPSTREAM_RESPONSE_INCOMPATIBLE'); }
    const result = responseSchema.safeParse(parsed);
    if (!result.success) throw new WorkerError('UPSTREAM_RESPONSE_INCOMPATIBLE');
    if (response.isError || result.data.isError) throw new WorkerError(upstreamErrorCode(result.data.error));
    return result.data;
  }
}
