import { z } from 'zod';

const browserSchema = z.object({ id: z.uuid(), status: z.string(), privateMode: z.boolean() });
export const presentationSchema = z.object({
  generation: z.uuid(), continuationStatus: z.string(), continuationRevision: z.number().nullable(),
  continuationId: z.uuid().nullable(),
  continuationReason: z.string().nullable(), task: z.object({ id: z.uuid(), title: z.string(), goal: z.string(),
    status: z.string(), version: z.number(), instructionRevision: z.number(), browser: browserSchema.nullable(),
    request: z.object({ prompt: z.string() }).nullable(),
    result: z.object({ summary: z.string().optional(), limitations: z.array(z.string()).optional() }).passthrough().nullable(),
  }),
});
export const metadataSchema = z.object({ publicUrl: z.url(), taskUrl: z.url(), eventsUrl: z.url() });
export const ticketSchema = z.object({ url: z.string(), expiresAt: z.string() });
export const toolErrorSchema = z.object({ code: z.string(), message: z.string() });
export const widgetStateSchema = z.union([
  presentationSchema,
  z.object({ code: z.literal('STALE_WIDGET'), message: z.string() }),
]);
export type Presentation = z.infer<typeof presentationSchema>;
