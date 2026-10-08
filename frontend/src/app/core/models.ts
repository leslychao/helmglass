import * as z from 'zod/mini';

const nullableNumber = z.nullable(z.number().check(z.gte(0)));
export const pageSchema = <T extends z.ZodMiniType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.int().check(z.gte(0)),
    page: z.int().check(z.gt(0)),
    pageSize: z.int().check(z.gt(0)),
  });
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export const meSchema = z.object({
  id: z.string(),
  version: z.number(),
  name: z.string(),
  email: z.string(),
  roles: z.array(z.string()),
  status: z.string(),
  avatarUrl: z.nullable(z.string()),
});
export type Me = z.infer<typeof meSchema>;
export const usageSchema = z.object({
  browserSeconds: nullableNumber,
  executionSeconds: nullableNumber,
  manualSeconds: nullableNumber,
  mediaSeconds: nullableNumber,
  mediaBytes: nullableNumber,
  incomplete: z.boolean(),
});
export const browserSchema = z.object({
  id: z.string(),
  status: z.string(),
  nodeId: z.nullable(z.string()),
  controlOwner: z.nullable(z.string()),
  controlEpoch: z.number(),
  privateMode: z.boolean(),
  currentUrl: z.nullable(z.string()),
  canView: z.boolean(),
  canControl: z.boolean(),
  version: z.number(),
});
export type BrowserSession = z.infer<typeof browserSchema>;
export const artifactSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  mimeType: z.string(),
  sizeBytes: nullableNumber,
  complete: z.boolean(),
  downloadUrl: z.nullable(z.string()),
});
export const resultSchema = z.object({
  summary: z.string(),
  limitations: z.array(z.string()),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
  columns: z.array(z.object({ key: z.string(), label: z.string(), type: z.string() })),
  artifactCount: z.int().check(z.gte(0)),
});
export const requestSchema = z.object({
  id: z.string(),
  type: z.string(),
  prompt: z.string(),
  version: z.number(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  operationId: z.optional(z.nullable(z.string())),
});
export const taskSchema = z.object({
  id: z.string(),
  version: z.number(),
  title: z.string(),
  goal: z.string(),
  startUrl: z.nullable(z.string()),
  outputFormat: z.string(),
  requireConfirmation: z.boolean(),
  preferredConnectionIds: z.array(z.string()),
  status: z.string(),
  outcome: z.nullable(z.string()),
  waitReason: z.nullable(z.string()),
  source: z.string(),
  site: z.nullable(z.string()),
  request: z.nullable(requestSchema),
  browser: z.nullable(browserSchema),
  result: z.nullable(resultSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  usage: usageSchema,
  allowedCommands: z.array(z.string()),
  instructionRevision: z.number(),
  summary: z.string(),
  chatUrl: z.optional(z.nullable(z.string())),
});
export type Task = z.infer<typeof taskSchema>;
export const connectionSchema = z.object({
  id: z.string(),
  version: z.number(),
  name: z.string(),
  startUrl: z.string(),
  site: z.string(),
  status: z.string(),
  accountSubject: z.nullable(z.string()),
  accountLabel: z.nullable(z.string()),
  lastUsedAt: z.nullable(z.string()),
  browser: z.nullable(browserSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Connection = z.infer<typeof connectionSchema>;
export const eventSchema = z.object({
  id: z.string(),
  sequence: z.number(),
  type: z.string(),
  title: z.string(),
  detail: z.nullable(z.string()),
  createdAt: z.string(),
});
export const notificationSchema = z.object({
  id: z.string(),
  sequence: z.number(),
  taskId: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;
export const notificationsSchema = z.object({
  items: z.array(notificationSchema),
  total: z.number(),
  throughSequence: z.number(),
});
export const kpiSchema = z.object({
  active: z.number(),
  succeeded: z.number(),
  waitingForYou: z.number(),
  total: z.number(),
  sources: z.array(z.string()),
});
export const ticketSchema = z.object({
  url: z.string(),
  ticket: z.string(),
  role: z.string(),
  expiresAt: z.string(),
});
export const resultRowSchema = z.object({
  id: z.string(),
  cells: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export const usageReportSchema = z.object({
  totalTasks: z.number(),
  successfulTasks: z.number(),
  completedTasks: z.number(),
  successRate: nullableNumber,
  usage: usageSchema,
  days: pageSchema(
    z.object({ date: z.string(), tasks: z.number(), browserSeconds: nullableNumber }),
  ),
  sites: pageSchema(
    z.object({
      site: z.nullable(z.string()),
      tasks: z.number(),
      browserSeconds: nullableNumber,
      mediaSeconds: nullableNumber,
      mediaBytes: nullableNumber,
    }),
  ),
  statuses: z.array(z.object({ status: z.string(), tasks: z.number() })),
});
export const adminUserSchema = z.object({
  id: z.string(),
  version: z.number(),
  name: z.string(),
  email: z.string(),
  status: z.string(),
  browserLimitMode: z.string(),
  browserLimit: nullableNumber,
  waitingLimit: nullableNumber,
  browserCount: nullableNumber,
  waitingCount: z.number(),
  lastAccessAt: z.nullable(z.string()),
  pendingOperations: z.number(),
  deleteUntil: z.optional(z.nullable(z.string())),
  previousStatus: z.optional(z.nullable(z.string())),
});
export type AdminUser = z.infer<typeof adminUserSchema>;
export const adminTaskSchema = z.object({
  id: z.string(),
  status: z.string(),
  browserId: z.nullable(z.string()),
  reason: z.nullable(z.string()),
  createdAt: z.string(),
});
export const adminBrowserSchema = z.object({
  id: z.string(),
  taskId: z.nullable(z.string()),
  ownerId: z.string(),
  ownerName: z.string(),
  status: z.string(),
});
export const nodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  status: z.string(),
  occupied: nullableNumber,
  capacity: z.number(),
  browsers: z.array(adminBrowserSchema),
});
export type BrowserNode = z.infer<typeof nodeSchema>;
export const auditSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  actor: z.string(),
  target: z.string(),
  action: z.string(),
  reason: z.nullable(z.string()),
  before: z.nullable(z.string()),
  after: z.nullable(z.string()),
  status: z.string(),
});
export const operationSchema = z.object({
  id: z.string(),
  status: z.string(),
  description: z.string(),
});
export const adminUsageSchema = z.strictObject({
  totalTasks: z.number(),
  successfulTasks: z.number(),
  completedTasks: z.number(),
  successRate: nullableNumber,
  usage: usageSchema,
});
export const adminDetailSchema = z.object({
  user: adminUserSchema,
  usage: adminUsageSchema,
  tasks: pageSchema(adminTaskSchema),
  operations: z.array(operationSchema),
  audit: pageSchema(auditSchema),
});
export const changeSchema = z.object({
  id: z.number(),
  resource: z.string(),
  entityId: z.nullable(z.string()),
  version: z.number(),
});
export type Change = z.infer<typeof changeSchema>;
export const integrationSchema = z.object({
  connected: z.boolean(),
  endpoint: z.string(),
  accountUrl: z.optional(z.string()),
  viewerClosePending: z.boolean(),
  viewerCloseFailed: z.boolean(),
});
export interface TaskInput {
  goal: string;
  startUrl: string;
  outputFormat: string;
  requireConfirmation: boolean;
  preferredConnectionIds: string[];
}
export interface Command {
  type: string;
  expectedVersion: number;
  requestId?: string;
  requestVersion?: number;
  text?: string;
  connectionId?: string;
  confirmBrowserLoss?: boolean;
  saveConnection?: boolean;
  resume?: boolean;
  viewerId?: string;
  goal?: string;
  startUrl?: string;
  outputFormat?: string;
  requireConfirmation?: boolean;
  preferredConnectionIds?: string[];
  accountLabel?: string;
  accountSubject?: string;
}
