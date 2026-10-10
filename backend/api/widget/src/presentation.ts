import { z } from 'zod';

const browserSchema = z.object({ id: z.uuid(), status: z.string(), privateMode: z.boolean(),
  currentUrl: z.string().nullable(), version: z.number().int(), controlOwner: z.string(),
  startedAt: z.string().nullable(), closedAt: z.string().nullable(),
  idleCloseAt: z.string().nullable(), idleTimeoutSeconds: z.number(), idleWarningAt: z.string().nullable(),
  cleanupState: z.string(), cleanupError: z.string().nullable(), closeReason: z.enum(['USER', 'IDLE_TIMEOUT']).nullable() });
export const presentationSchema = z.object({
  generation: z.uuid(), continuationStatus: z.string(), continuationRevision: z.number().nullable(),
  continuationId: z.uuid().nullable(),
  continuationReason: z.string().nullable(), task: z.object({ id: z.uuid(), title: z.string(), goal: z.string(),
    status: z.string(), summary: z.string().nullable(), waitReason: z.string().nullable(), version: z.number(), instructionRevision: z.number(), stepCount: z.number().int().nonnegative(), browser: browserSchema.nullable(),
    request: z.object({ type: z.string(), prompt: z.string() }).nullable(),
    result: z.object({ summary: z.string().optional(), limitations: z.array(z.string()).optional() }).passthrough().nullable(),
  }),
});
// Saved tool results identify a presentation; widget.state owns its current data.
export const presentationReferenceSchema = presentationSchema.pick({ generation: true }).extend({
  task: presentationSchema.shape.task.pick({ id: true }),
});
export const metadataSchema = z.object({ publicUrl: z.url(), taskUrl: z.url(), loginUrl: z.url(), eventsUrl: z.url() })
  .refine(value => {
    const origin = new URL(value.publicUrl).origin;
    return [value.taskUrl, value.loginUrl, value.eventsUrl].every(value => {
      const url = new URL(value);
      return url.origin === origin && !url.username && !url.password;
    });
  }, 'Недопустимый адрес задачи');
export const ticketSchema = z.object({ url: z.string(), expiresAt: z.string() });
export const toolErrorSchema = z.object({ code: z.string(), message: z.string() });
export const widgetStateSchema = z.union([
  presentationSchema,
  z.object({ code: z.literal('STALE_WIDGET'), message: z.string() }),
]);
export type Presentation = z.infer<typeof presentationSchema>;

export const stepsSchema = z.object({
  items: z.array(z.object({ id: z.uuid(), sequence: z.number().int(), version: z.number().int(),
    status: z.enum(['PLANNED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'UNKNOWN', 'SKIPPED']),
    title: z.string(), result: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() })).max(10),
  total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.literal(10),
});
