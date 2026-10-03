import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.uuid();
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const target = z.string().regex(/^(?:f\d+)?e\d+$/).max(40);
const targetAction = { target, observationId: id };
export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('OBSERVE'), depth: z.number().int().min(1).max(30).optional() }),
  z.strictObject({ type: z.literal('CLICK'), ...targetAction }),
  z.strictObject({ type: z.literal('FILL'), ...targetAction, text: z.string().max(16_384) }),
  z.strictObject({ type: z.literal('SELECT'), ...targetAction, values: z.array(z.string().max(2048)).min(1).max(50) }),
  z.strictObject({ type: z.literal('PRESS'), ...targetAction, key: z.string().min(1).max(80) }),
  z.strictObject({ type: z.literal('SCROLL'), deltaX: z.number().min(-5000).max(5000), deltaY: z.number().min(-5000).max(5000) }),
  z.strictObject({ type: z.literal('NAVIGATE'), url: z.url().max(8192) }),
  z.strictObject({ type: z.literal('BACK') }),
  z.strictObject({ type: z.literal('FORWARD') }),
  z.strictObject({ type: z.literal('RELOAD') }),
  z.strictObject({ type: z.literal('SNAPSHOT') }),
  z.strictObject({ type: z.literal('WAIT_FOR'), text: z.string().min(1).max(2048), state: z.enum(['VISIBLE', 'HIDDEN']) }),
  z.strictObject({ type: z.literal('READ_MEDIA'), observationId: id, mediaRef: id, maxBytes: z.number().int().min(1).max(268_435_456),
    maxDurationSeconds: z.number().int().min(1).max(1800), coverage: z.enum(['FULL', 'RANGE']),
    startSeconds: z.number().nonnegative().optional(), endSeconds: z.number().positive().optional() }),
]);
export const epochsSchema = z.strictObject({
  allocationEpoch: epoch,
  controlEpoch: epoch,
  pageEpoch: epoch,
  privacyEpoch: epoch,
  policyVersion: epoch,
});
const scope = {
  taskId: id.nullable(), userId: id, browserSessionId: id, workerBootId: id,
  instructionRevision: epoch,
  connectionId: id.optional(), scopeVersion: epoch.optional(), continuationClaimId: id.optional(),
  ...epochsSchema.shape,
};
export const assignmentSchema = z.strictObject({
  ...scope,
  purpose: z.enum(['TASK', 'CONNECTION_LOGIN', 'CONNECTION_CHECK']).default('TASK'),
  originPolicy: z.enum(['PUBLIC', 'ALLOWLIST', 'DENYLIST']),
  allowedOrigins: z.array(z.url()).max(64),
  deniedOrigins: z.array(z.url()).max(64).optional(),
  deadline: timestamp,
  viewport: z.strictObject({ width: z.number().int().min(640).max(1920), height: z.number().int().min(480).max(1080) }).default({ width: 1280, height: 720 }),
});
export const commandSchema = z.strictObject({
  commandId: id, attemptId: id, taskId: id.nullable(), browserSessionId: id,
  executionMode: z.enum(['HUMAN', 'HUMAN_PRIVATE']).optional(), controllerInstance: id.optional(),
  action: actionSchema,
}).refine(value => (value.executionMode === undefined) === (value.controllerInstance === undefined),
  'Human commands require both execution mode and controller');
export const permitSchema = z.strictObject({
  ...scope,
  permitId: id, commandId: id, attemptId: id,
  executionMode: z.enum(['HUMAN', 'HUMAN_PRIVATE']).optional(), controllerInstance: id.optional(),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  deadline: timestamp,
}).refine(value => (value.executionMode === undefined) === (value.controllerInstance === undefined),
  'Human permits require both execution mode and controller');
export const launchPermitSchema = z.strictObject({
  permitId: id, browserSessionId: id, workerBootId: id, allocationEpoch: epoch,
  assignmentDigest: z.string().regex(/^[a-f0-9]{64}$/), deadline: timestamp,
});
export const runtimeInventorySchema = z.union([
  z.strictObject({ browserSessionId: id, allocationEpoch: epoch, state: z.enum(['LAUNCHING', 'CLOSING']) }),
  z.strictObject({ browserSessionId: id, taskId: id.nullable(), runtimeGeneration: id, pageId: id,
    allocationEpoch: epoch, controlEpoch: epoch, pageEpoch: epoch, privacyEpoch: epoch,
    mode: z.enum(['AGENT', 'HUMAN', 'HUMAN_PRIVATE', 'QUIESCED']), closed: z.boolean(), unknown: z.boolean(),
    pendingResults: z.array(id).max(10_000), startPermitId: id,
    pendingProfileTransfers: z.array(z.strictObject({ transferId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/),
      byteLength: z.number().int().min(32).max(33_554_464), state: z.enum(['UPLOADING', 'UPLOADED']) })).max(1).optional(),
    lastAcceptedInputSequence: epoch, lastAppliedInputSequence: epoch,
    usage: z.strictObject({ sourceId: z.string().max(73), sourceStartedAt: timestamp, sourceSequence: epoch, browserMs: epoch,
      executionMs: epoch, humanMs: epoch, loginMs: epoch, browserComplete: z.boolean(), mediaComplete: z.literal(false), neverReady: z.literal(true).optional() }).optional(),
  }),
]);
export const workerRegistrationSchema = z.strictObject({
  schemaVersion: z.literal(1), type: z.literal('register'), requestId: id, workerId: id, bootId: id,
  protocolVersion: z.literal(1), version: z.string().min(1).max(80), imageDigest: z.string().min(1).max(200),
  capacity: z.literal(1), state: z.enum(['READY', 'DRAINING']), inventory: z.array(runtimeInventorySchema).max(1),
  capabilities: z.record(z.string(), z.json()),
});
export const workerHeartbeatSchema = z.strictObject({
  schemaVersion: z.literal(1), type: z.literal('heartbeat'), requestId: id, workerId: id, bootId: id,
  state: z.enum(['READY', 'DRAINING']), usedSlots: z.number().int().min(0).max(1),
  activeSessions: z.array(runtimeInventorySchema).max(1), capabilities: z.record(z.string(), z.json()),
});
export const inputActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('pointerMove'), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.strictObject({ type: z.literal('pointerDown'), button: z.enum(['LEFT', 'MIDDLE', 'RIGHT']), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.strictObject({ type: z.literal('pointerUp'), button: z.enum(['LEFT', 'MIDDLE', 'RIGHT']), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.strictObject({ type: z.literal('wheel'), deltaX: z.number().min(-5000).max(5000), deltaY: z.number().min(-5000).max(5000) }),
  z.strictObject({ type: z.literal('keyDown'), key: z.string().min(1).max(80) }),
  z.strictObject({ type: z.literal('keyUp'), key: z.string().min(1).max(80) }),
  z.strictObject({ type: z.literal('committedText'), text: z.string().max(16_384) }),
  z.strictObject({ type: z.literal('heartbeat') }),
]);
const base = { schemaVersion: z.literal(1), requestId: id };
export const profileBindingSchema = z.strictObject({
  userId: id, connectionId: id, profileId: id, revision: epoch, scopeVersion: epoch, formatVersion: z.literal(1),
  storageOrigins: z.array(z.url()).max(64), cookieDomains: z.array(z.string().min(1).max(253)).max(512),
});
const profileTransfer = { browserSessionId: id, allocationEpoch: epoch, privacyEpoch: epoch,
  controlEpoch: epoch, policyVersion: epoch, expiresAt: timestamp,
  transferId: id, transferToken: z.string().min(32).max(512), dek: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  binding: profileBindingSchema,
};
const viewerFence = { workerBootId: id, browserSessionId: id, allocationEpoch: epoch,
  viewerId: id, viewGeneration: epoch };
const viewerBinding = { ...viewerFence,
  controlEpoch: epoch, pageEpoch: epoch, privacyEpoch: epoch, mediaGeneration: epoch };
export const iceServerSchema = z.strictObject({
  urls: z.array(z.string().regex(/^turns?:[^\s]+$/).max(2048)).min(1).max(4),
  username: z.string().min(1).max(256), credential: z.string().min(1).max(512),
});
export const signalingMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('viewOpen'), ...viewerBinding,
    surface: z.enum(['WEB', 'WIDGET']), controllerInstance: id.optional(), leaseExpiresAt: timestamp,
    iceServers: z.array(iceServerSchema).min(1).max(4),
    producerIceServer: iceServerSchema,
    mediaProxy: z.strictObject({ url: z.literal('http://egress-proxy:3128'), username: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), password: z.string().min(32).max(256) }) }),
  z.strictObject({ ...base, type: z.literal('viewRenew'), ...viewerBinding, leaseExpiresAt: timestamp }),
  z.strictObject({ ...base, type: z.literal('viewClose'), ...viewerFence }),
  z.strictObject({ ...base, type: z.literal('viewerClosedAck'), ...viewerFence }),
  z.strictObject({ ...base, type: z.literal('signal'), viewerId: id, payload: z.record(z.string(), z.json()) }),
]);
export type SignalingMessage = z.infer<typeof signalingMessageSchema>;
export type ViewOpen = Extract<SignalingMessage, { type: 'viewOpen' }>;
export type ViewRenew = Extract<SignalingMessage, { type: 'viewRenew' }>;
export type ViewClose = Extract<SignalingMessage, { type: 'viewClose' }>;
export type ViewerClosedAck = Extract<SignalingMessage, { type: 'viewerClosedAck' }>;
export type ViewerFence = Pick<ViewClose, keyof typeof viewerFence>;
export const viewerClosedSchema = z.strictObject({ ...base, type: z.literal('viewerClosed'),
  ...viewerFence, code: z.literal('VIEW_CLOSED') });
export const viewerEndedSchema = z.strictObject({ ...base, type: z.literal('viewerEnded'),
  ...viewerFence, code: z.string().regex(/^[A-Z_]+$/).max(128) });
export type ViewerClosed = z.infer<typeof viewerClosedSchema>;
export type ViewerEnded = z.infer<typeof viewerEndedSchema>;
export const apiMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('registered'), workerId: id, bootId: id }),
  z.strictObject({ ...base, type: z.literal('assign'), assignment: assignmentSchema }),
  z.strictObject({ ...base, type: z.literal('launchPermit'), permit: launchPermitSchema }),
  z.strictObject({ ...base, type: z.literal('launchPermitDenied'), code: z.string().regex(/^[A-Z_]+$/) }),
  z.strictObject({ ...base, type: z.literal('command'), command: commandSchema }),
  z.strictObject({ ...base, type: z.literal('startPermit'), permit: permitSchema }),
  z.strictObject({ ...base, type: z.literal('permitDenied'), code: z.string().regex(/^[A-Z_]+$/) }),
  z.strictObject({ ...base, type: z.literal('resultAck'), attemptId: id, digest: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...base, type: z.literal('close'), browserSessionId: id, allocationEpoch: epoch }),
  z.strictObject({ ...base, type: z.literal('runtimeReady'), browserSessionId: id, allocationEpoch: epoch }),
  z.strictObject({ ...base, type: z.literal('closedAck'), browserSessionId: id, allocationEpoch: epoch, receiptId: id }),
  z.strictObject({ ...base, type: z.literal('control'), browserSessionId: id, ...epochsSchema.shape,
    connectionId: id.optional(), scopeVersion: epoch.optional(), cleanupDeadline: timestamp.optional(),
    mode: z.enum(['AGENT', 'HUMAN', 'HUMAN_PRIVATE', 'QUIESCED']), controllerInstance: id.optional(), leaseExpiresAt: timestamp })
    .refine(value => (value.connectionId === undefined) === (value.scopeVersion === undefined), 'Connection binding requires both ID and scope version')
    .refine(value => value.cleanupDeadline === undefined || value.mode === 'QUIESCED', 'Cleanup requires quiescence'),
  z.strictObject({ ...base, type: z.literal('input'), browserSessionId: id, controlEpoch: epoch, pageEpoch: epoch, controllerInstance: id, inputSequence: epoch, action: inputActionSchema }),
  z.strictObject({ ...base, type: z.literal('controlRenew'), browserSessionId: id, controlEpoch: epoch, controllerInstance: id, leaseExpiresAt: timestamp }),
  z.strictObject({ ...base, type: z.literal('profileSave'), ...profileTransfer, reuseOnly: z.literal(true).optional() }),
  z.strictObject({ ...base, type: z.literal('profileLoad'), ...profileTransfer }),
  z.strictObject({ ...base, type: z.literal('profileTransferAck'), browserSessionId: id, allocationEpoch: epoch,
    transferId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...base, type: z.literal('profileCheck'), browserSessionId: id, allocationEpoch: epoch,
    controlEpoch: epoch, privacyEpoch: epoch, policyVersion: epoch, expectedOrigin: z.url().max(2048),
    userAsserted: z.boolean(), postLoginPathPrefix: z.string().startsWith('/').max(2048).optional(), accountEvidenceText: z.string().min(1).max(256).optional() }),
  z.strictObject({ ...base, type: z.literal('drain') }),
]);
export type Action = z.infer<typeof actionSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type Command = z.infer<typeof commandSchema>;
export type ExecutionPermit = z.infer<typeof permitSchema>;
export type LaunchPermit = z.infer<typeof launchPermitSchema>;
export type ApiMessage = z.infer<typeof apiMessageSchema>;
export type InputMessage = Extract<ApiMessage, { type: 'input' }>;
export type ControlMessage = Extract<ApiMessage, { type: 'control' }>;
export type ControlRenewMessage = Extract<ApiMessage, { type: 'controlRenew' }>;
export type ProfileTransferMessage = Extract<ApiMessage, { type: 'profileLoad' | 'profileSave' }>;
export type ProfileSaveMessage = Extract<ApiMessage, { type: 'profileSave' }>;
export type ProfileTransferAck = Extract<ApiMessage, { type: 'profileTransferAck' }>;
export type ProfileCheckMessage = Extract<ApiMessage, { type: 'profileCheck' }>;
export type Epochs = z.infer<typeof epochsSchema>;

export class WorkerError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new WorkerError('INVALID_DIGEST_INPUT');
  return json;
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function safeCode(error: unknown): string {
  return error instanceof WorkerError ? error.code : 'RUNTIME_FAILURE';
}
