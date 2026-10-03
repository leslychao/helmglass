import { z } from 'zod';

const uuid = z.uuid();
const version = z.number().int().nonnegative();
const idempotency = z.string().min(16).max(128);
const task = { taskId: uuid };
const mutation = { ...task, idempotencyKey: idempotency };
const versioned = { ...mutation, expectedTaskVersion: version };
const ref = z.string().regex(/^(?:f\d+)?e\d+$/);
const target = { target: ref, observationId: uuid };
const action = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('OBSERVE'), depth: z.number().int().min(1).max(30).optional() }),
  z.strictObject({ type: z.literal('NAVIGATE'), url: z.url().max(8192) }),
  z.strictObject({ type: z.literal('CLICK'), ...target }),
  z.strictObject({ type: z.literal('FILL'), ...target, text: z.string().max(16_384) }),
  z.strictObject({ type: z.literal('SELECT'), ...target, values: z.array(z.string().max(2048)).min(1).max(50) }),
  z.strictObject({ type: z.literal('PRESS'), ...target, key: z.string().min(1).max(80) }),
  z.strictObject({ type: z.literal('SCROLL'), deltaX: z.number().min(-5000).max(5000), deltaY: z.number().min(-5000).max(5000) }),
  z.strictObject({ type: z.literal('BACK') }), z.strictObject({ type: z.literal('FORWARD') }),
  z.strictObject({ type: z.literal('WAIT_FOR'), text: z.string().min(1).max(2048), state: z.enum(['VISIBLE', 'HIDDEN']) }),
]);
const binding = { browserSessionId: uuid.optional(), controlEpoch: version.optional(), pageEpoch: version.optional(), privacyEpoch: version.optional(),
  instructionRevision: version, continuationClaimId: uuid.optional() };
const page = { page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(20), search: z.string().max(200).optional() };

export const toolSchemas = {
  'tasks.create': z.strictObject({ idempotencyKey: idempotency, title: z.string().min(1).max(200).optional(), goal: z.string().min(1).max(16_384),
    startUrl: z.url(), connectionIds: z.array(uuid).max(20).default([]), outputFormat: z.enum(['TEXT', 'TABLE', 'FILE']),
    browserTimeLimitSeconds: z.number().int().min(60).max(7200), confirmImportantActions: z.boolean(), intent: z.enum(['DRAFT', 'PREPARE']).default('PREPARE') }),
  'tasks.get': z.strictObject(task),
  'tasks.context': z.strictObject({ ...task, section: z.enum(['INSTRUCTIONS', 'RESULTS', 'HISTORY', 'OPERATIONS']), contextRef: z.string().max(200).optional(), cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(100).default(20) }),
  'tasks.list': z.strictObject({ ...page, status: z.string().max(40).optional(), snapshotToken: z.string().max(1024).optional() }),
  'tasks.clarify': z.strictObject({ ...versioned, clarificationId: uuid, expectedInstructionRevision: version, text: z.string().min(1).max(4096) }),
  'tasks.resume': z.strictObject(versioned),
  'tasks.view': z.strictObject({ ...mutation, viewScopeId: uuid.optional(), expectedPresentationRevision: version }),
  'tasks.continue': z.strictObject({ ...mutation, continuationId: uuid, expectedInstructionRevision: version }),
  'continuations.prepare_message': z.strictObject({ ...mutation, continuationId: uuid,
    viewScopeId: uuid, presentationRevision: version, viewerInstanceId: uuid }),
  'continuations.record_delivery': z.strictObject({ idempotencyKey: idempotency, dispatchId: uuid, outcome: z.enum(['DELIVERED', 'UNKNOWN', 'REJECTED']) }),
  'browser.attach_view': z.strictObject({ ...task, viewScopeId: uuid, presentationRevision: version, viewerInstanceId: uuid, observedSessionId: uuid.nullable().optional() }),
  'browser.observe': z.strictObject({ ...versioned, ...binding, commandId: uuid, depth: z.number().int().min(1).max(30).optional() }),
  'browser.execute': z.strictObject({ ...versioned, ...binding, commandId: uuid, action, intentId: uuid.optional() }),
  'media.capture': z.strictObject({ ...versioned, ...binding, commandId: uuid, observationId: uuid, mediaRef: uuid, maxDurationSeconds: z.number().int().min(1).max(1800),
    maxBytes: z.number().int().min(1).max(268_435_456), coverage: z.enum(['FULL', 'RANGE']), startSeconds: z.number().nonnegative().optional(), endSeconds: z.number().positive().optional() }),
  'audio.get': z.strictObject({ ...task, artifactId: uuid }),
  'audio.segments': z.strictObject({ ...task, artifactId: uuid, component: z.enum(['CAPTIONS', 'ACOUSTICS']), cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(100).default(100) }),
  'commands.get': z.strictObject({ ...task, commandId: uuid }),
  'operations.get': z.strictObject({ operationId: uuid }),
  'operations.lookup': z.strictObject({ idempotencyKey: idempotency, operationKind: z.string().min(1).max(80) }),
  'tasks.reconcile': z.strictObject({ ...versioned, commandId: uuid.optional(), humanOperationId: uuid.optional(), evidenceId: uuid.optional() })
    .refine((input) => Boolean(input.commandId) !== Boolean(input.humanOperationId), 'Exactly one source is required'),
  'tasks.answer': z.strictObject({ ...mutation, requestId: uuid, expectedVersion: version, intentHash: z.string().min(1).max(256),
    decision: z.enum(['APPROVE', 'DENY', 'ANSWER']), text: z.string().max(4096).optional(), selectedConnectionId: uuid.optional() }),
  'results.publish': z.strictObject({ ...versioned, instructionRevision: version, continuationClaimId: uuid.optional(),
    conclusion: z.string().max(16_000), limitations: z.array(z.string().max(16_000)).max(100), missing: z.array(z.string().max(16_000)).max(100),
    columns: z.array(z.strictObject({ key: z.string().min(1).max(100), label: z.string().min(1).max(200), type: z.enum(['TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'URL']) })).max(100),
    rows: z.array(z.record(z.string(), z.union([z.string().max(16_384), z.number(), z.boolean(), z.null()]))).max(10_000),
    coverage: z.record(z.string(), z.json()), artifactIds: z.array(uuid).max(100),
    sections: z.array(z.strictObject({ title: z.string().min(1).max(200), text: z.string().max(16_000) })).max(100).default([]),
    sources: z.array(z.strictObject({ title: z.string().min(1).max(200),
      url: z.url().max(2048).refine((value) => {
        const parsed = new URL(value);
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
      }) })).max(100).default([]) }),
  'tasks.complete': z.strictObject({ ...versioned, instructionRevision: version, continuationClaimId: uuid.optional(), resultId: uuid, resultRevision: version, outcome: z.enum(['SUCCESS', 'PARTIAL', 'NOT_ACHIEVED']) }),
  'tasks.stop': z.strictObject(mutation),
  'connections.list': z.strictObject({ ...page, status: z.enum(['ACTIVE', 'NEEDS_LOGIN', 'DELETING']).optional() }),
  'connections.resolve': z.strictObject({ ...versioned, url: z.url().max(8192), loginRequired: z.boolean(), instructionRevision: version }),
};
export type ToolName = keyof typeof toolSchemas;
export const supportedScopes = ['tasks:read', 'tasks:write', 'browser:view', 'browser:execute', 'results:write'];
export function scopesForTool(name: ToolName): string[] {
  if (name === 'connections.resolve') return ['tasks:write'];
  if (name === 'browser.attach_view' || name === 'tasks.view') return ['browser:view'];
  if (name.startsWith('browser.') || name === 'media.capture') return ['browser:execute'];
  if (name === 'results.publish' || name === 'tasks.complete') return ['results:write'];
  return [readOnlyTools.has(name) ? 'tasks:read' : 'tasks:write'];
}
export const readOnlyTools = new Set<ToolName>(['tasks.get', 'tasks.context', 'tasks.list', 'audio.get', 'audio.segments',
  'commands.get', 'operations.get', 'operations.lookup', 'connections.list']);
export const appOnlyTools = new Set<ToolName>(['browser.attach_view', 'continuations.prepare_message', 'continuations.record_delivery']);
export const widgetTools = new Set<ToolName>(['tasks.view', 'tasks.continue']);
export const widgetResourceUri = 'ui://helm-glass/browser.html';
