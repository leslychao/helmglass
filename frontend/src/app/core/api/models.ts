import type { components } from './generated/schema';

export type Query = Readonly<
  Record<string, string | number | boolean | readonly string[] | null | undefined>
>;
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  sort: Sort | null;
  snapshot: string;
}
export interface Sort {
  field: string;
  direction: 'asc' | 'desc';
}
export interface Problem {
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  operationId?: string;
  resourceVersion?: number;
}
export type Receipt = components['schemas']['MutationReceipt'];
export type LogoutResult = components['schemas']['LogoutResult'];
export type Operation = components['schemas']['Operation'];
export interface Capability {
  allowed: boolean;
  visible?: boolean;
  reason?: string;
}
export type Capabilities = Readonly<Record<string, Capability>>;
export type Policy = components['schemas']['Policy'];
export type Me = components['schemas']['Profile'];
export type Site = components['schemas']['Site'];
export type SiteSuggestions = components['schemas']['SiteSuggestions'];
export interface TaskInput {
  goal: string;
  startUrl: string;
  connectionIds: string[];
  outputFormat: 'TEXT' | 'TABLE' | 'FILE';
  confirmImportantActions: boolean;
  browserTimeLimitSeconds: number;
}
export interface Measurements {
  activeSeconds: number | null;
  browserSeconds: number | null;
  humanSeconds: number | null;
  mediaSeconds: number | null;
  mediaBytes: number | null;
  completeness?: string;
}
export type Task = components['schemas']['Task'];
export type TaskSummary = components['schemas']['TaskSummary'];
export type TaskEvent = components['schemas']['TaskEvent'];
export type ActionRequest = components['schemas']['TaskActionRequest'];
export type Continuation = components['schemas']['Continuation'];
export type Connection = components['schemas']['Connection'];
export type LoginComplete = components['schemas']['LoginComplete'];
export type BrowserNavigation = components['schemas']['BrowserNavigation'];
export type BrowserSave = components['schemas']['BrowserSave'];
export type BrowserClose = components['schemas']['BrowserClose'];
export type BrowserOpen = components['schemas']['BrowserOpen'];
export type BrowserSavePolicy = components['schemas']['BrowserSavePolicy'];
export type BrowserSnapshot = components['schemas']['BrowserSnapshot'];
export interface BrowserSession {
  id: string;
  version: number;
  taskId?: string;
  connectionId?: string;
  connectionVersion?: number | null;
  state: string;
  controlState: string;
  controlMode: string;
  controllerRelation: 'SELF' | 'OTHER' | 'NONE';
  controlEpoch: number;
  pageEpoch: number;
  privacyEpoch: number;
  mediaGeneration?: number;
  privacyMode: string;
  siteAccess: string;
  currentUrl?: string;
  loginOperationId?: string;
  viewport: { width: number; height: number };
  capabilities: Capabilities;
  savePolicy: string;
  profileVersion?: string | null;
  currentProfileVersion?: string | null;
  closeReason?: string;
  operationId?: string;
}
export interface ViewTicket {
  ticket: string;
  signalingUrl: string;
  viewGeneration: number;
  expiresAt: string;
  viewerAuthorizationExpiresAt?: string;
}
export interface InputTicket {
  ticket: string;
  inputUrl: string;
  expiresAt: string;
}
export type LoginOperation = components['schemas']['LoginOperation'];
export type Result = components['schemas']['TaskResult'];
export type ResultRow = components['schemas']['ResultRow'];
export interface Artifact {
  id: string;
  filename: string;
  mimeType: string;
  bytes: number;
  state: string;
}
export type ClientGrant = components['schemas']['ClientGrant'];
export type Notification = components['schemas']['Notification'];
export type Notifications = components['schemas']['Notifications'];
export type Usage = components['schemas']['UsageSummary'];
export type SiteUsage = components['schemas']['UsageSite'];
export type UsageMetric = components['schemas']['UsageMetric'];
export type UsageMetrics = components['schemas']['UsageMetrics'];
export type TaskUsage = components['schemas']['TaskUsage'];
export type UsageMeasurement = components['schemas']['UsageMeasurement'];
export type CalendarUsage = components['schemas']['CalendarUsage'];
export type AdminOverview = components['schemas']['AdminOverview'];
export type AdminCleanupOperation = components['schemas']['AdminCleanupOperation'];
export type AdminUser = components['schemas']['AdminUser'];
export type AdminTask = components['schemas']['AdminTask'];
export type Worker = components['schemas']['Worker'];
export type BrowserPool = components['schemas']['BrowserPool'];
export type AuditEntry = components['schemas']['AuditEntry'];

export type AdminUserListItem = components['schemas']['AdminUserListItem'];
export type UserLimits = components['schemas']['UserLimits'];

export type TaskListItem = components['schemas']['TaskListItem'];
