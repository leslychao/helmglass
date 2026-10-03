import { z } from 'zod';

export const enrollmentRequestSchema = z.strictObject({
  schemaVersion: z.literal(1), installationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  workerId: z.uuid(), bootId: z.uuid(), capacity: z.literal(1),
  enrollmentToken: z.string().min(32).max(512), csrPem: z.string().min(100).max(16_384),
});
export const enrollmentResponseSchema = z.strictObject({
  schemaVersion: z.literal(1), workerId: z.uuid(), bootId: z.uuid(),
  certificatePem: z.string().min(100).max(32_768), caPem: z.string().min(100).max(65_536),
  expiresAt: z.iso.datetime({ offset: true }),
});
