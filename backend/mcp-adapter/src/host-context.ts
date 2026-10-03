import { createHash } from 'node:crypto';

export interface HostConversationContext {
  provider: 'CHATGPT_WEB';
  contractVersion: '2026-10-03';
  conversationKey: string;
}

const MAX_CORRELATION_BYTES = 4096;

/** Correlates a tested host conversation; OAuth and resource authorization remain independent. */
export function hostConversationContext(metadata: unknown): HostConversationContext | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value: unknown = Reflect.get(metadata, 'openai/session');
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CORRELATION_BYTES
    || Buffer.byteLength(value, 'utf8') > MAX_CORRELATION_BYTES) return undefined;
  return { provider: 'CHATGPT_WEB', contractVersion: '2026-10-03',
    conversationKey: createHash('sha256').update(value, 'utf8').digest('hex') };
}
