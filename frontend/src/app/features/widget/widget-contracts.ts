import { BrowserSession, ViewTicket } from '../../core/api/models';

export interface Presentation {
  taskId: string;
  taskUrl: string;
  summary: string;
  viewScopeId: string | null;
  presentationRevision: number;
  presentationState: string;
  observedSessionId?: string;
}
export interface WidgetSnapshot {
  presentation: Presentation;
  session: BrowserSession | null;
  continuation: {
    id: string;
    state: string;
    mode: string;
    reason?: string;
    deliveredAt?: string;
    manualMessage?: string;
  } | null;
  eventTicket?: { ticket: string; url: string };
  viewTicket: ViewTicket | null;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Некорректный ответ сервера');
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Некорректный ответ сервера');
  return value;
}
function optional(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
export function presentationOf(value: unknown, publicOrigin: string): Presentation {
  if (!record(value)) throw new Error('Нет данных о задаче');
  if (record(value['presentation'])) return presentationOf(value['presentation'], publicOrigin);
  const presentationState = string(value['presentationState']);
  if (!['ACTIVE', 'SUPERSEDED', 'LINK_ONLY'].includes(presentationState))
    throw new Error('Некорректное состояние просмотра');
  const viewScopeId =
    presentationState === 'LINK_ONLY' && value['viewScopeId'] === null
      ? null
      : string(value['viewScopeId']);
  const taskUrl = string(value['taskUrl']);
  const parsed = new URL(taskUrl, publicOrigin);
  const base = new URL(publicOrigin);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== base.origin ||
    parsed.pathname !== '/tasks/' + string(value['taskId']) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('Некорректная ссылка задачи');
  return {
    taskId: string(value['taskId']),
    taskUrl: parsed.href,
    summary: string(value['summary'] ?? ''),
    viewScopeId,
    presentationRevision: number(value['presentationRevision']),
    presentationState,
    observedSessionId: optional(value['observedSessionId']),
  };
}
function sessionOf(value: unknown): BrowserSession | null {
  if (value === null || value === undefined) return null;
  if (!record(value) || !record(value['viewport']) || !record(value['capabilities']))
    throw new Error('Некорректная сессия браузера');
  const capabilities: Record<string, { allowed: boolean; visible?: boolean; reason?: string }> = {};
  for (const [key, item] of Object.entries(value['capabilities'])) {
    if (!record(item) || typeof item['allowed'] !== 'boolean')
      throw new Error('Некорректные права просмотра');
    capabilities[key] = {
      allowed: item['allowed'],
      visible: typeof item['visible'] === 'boolean' ? item['visible'] : undefined,
      reason: optional(item['reason']),
    };
  }
  const controllerRelation = value['controllerRelation'];
  if (
    controllerRelation !== 'SELF' &&
    controllerRelation !== 'OTHER' &&
    controllerRelation !== 'NONE'
  )
    throw new Error('Некорректное управление');
  return {
    id: string(value['id']),
    version: number(value['version']),
    taskId: optional(value['taskId']),
    connectionId: optional(value['connectionId']),
    state: string(value['state']),
    controlState: string(value['controlState']),
    controlMode: string(value['controlMode']),
    controllerRelation,
    controlEpoch: number(value['controlEpoch']),
    pageEpoch: number(value['pageEpoch']),
    privacyEpoch: number(value['privacyEpoch']),
    privacyMode: string(value['privacyMode']),
    siteAccess: string(value['siteAccess']),
    currentUrl: optional(value['currentUrl']),
    viewport: {
      width: number(value['viewport']['width']),
      height: number(value['viewport']['height']),
    },
    capabilities,
    savePolicy: string(value['savePolicy'] ?? 'DISCARD_CHANGES'),
    mediaGeneration:
      typeof value['mediaGeneration'] === 'number' ? value['mediaGeneration'] : undefined,
  };
}
export function snapshotOf(
  value: unknown,
  meta: unknown,
  fallback: Presentation,
  publicOrigin: string,
): WidgetSnapshot {
  if (!record(value)) throw new Error('Не удалось прочитать состояние просмотра');
  const presentation = record(value['presentation'])
    ? presentationOf(value['presentation'], publicOrigin)
    : {
        ...fallback,
        presentationState: string(value['presentationState'] ?? fallback.presentationState),
      };
  if (
    presentation.taskId !== fallback.taskId ||
    presentation.viewScopeId !== fallback.viewScopeId ||
    presentation.presentationRevision !== fallback.presentationRevision
  )
    throw new Error('Показ задачи изменился');
  const source = value['continuation'];
  const continuation =
    record(source) && source['id']
      ? {
          id: string(source['id']),
          state: string(source['state']),
          mode: string(source['mode']),
          reason: optional(source['reason']),
          deliveredAt: optional(source['deliveredAt']),
          manualMessage: optional(source['manualMessage']),
        }
      : null;
  let eventTicket: WidgetSnapshot['eventTicket'];
  let viewTicket: ViewTicket | null = null;
  if (record(meta)) {
    const events = meta['eventTicket'];
    if (record(events))
      eventTicket = {
        ticket: string(events['ticket']),
        url: channelUrl(
          events['url'],
          publicOrigin,
          '/events/v1/widget/tasks/' + presentation.taskId,
        ),
      };
    const video = meta['viewTicket'];
    if (record(video))
      viewTicket = {
        ticket: string(video['ticket']),
        signalingUrl: channelUrl(
          video['signalingUrl'],
          publicOrigin,
          '/stream/v1/widget/signaling/' +
            string(record(value['session']) ? value['session']['id'] : undefined),
        ),
        viewGeneration: number(video['viewGeneration']),
        expiresAt: string(video['expiresAt']),
        viewerAuthorizationExpiresAt: optional(video['viewerAuthorizationExpiresAt']),
      };
  }
  return {
    presentation,
    session: sessionOf(value['session']),
    continuation,
    eventTicket,
    viewTicket,
  };
}

function channelUrl(value: unknown, publicOrigin: string, expectedPath: string): string {
  const url = new URL(string(value)),
    base = new URL(publicOrigin);
  if (
    url.protocol !== (base.protocol === 'https:' ? 'wss:' : 'ws:') ||
    url.host !== base.host ||
    url.pathname !== expectedPath ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Некорректный канал просмотра');
  return url.href;
}

/** A snapshot refresh does not replace a healthy channel or reuse private pixels. */
export function retainActiveTicket(
  previous: WidgetSnapshot | null,
  next: WidgetSnapshot,
): WidgetSnapshot {
  const before = previous?.session,
    after = next.session;
  if (!after || after.privacyMode === 'LOGIN_PRIVATE' || !after.capabilities['view']?.allowed)
    return { ...next, viewTicket: null };
  if (!previous || !before) return next;
  const sameBinding =
    before.id === after.id &&
    before.pageEpoch === after.pageEpoch &&
    before.privacyEpoch === after.privacyEpoch &&
    before.mediaGeneration === after.mediaGeneration;
  if (!sameBinding) return next;
  if (!next.viewTicket || next.viewTicket.viewGeneration === previous.viewTicket?.viewGeneration)
    return { ...next, viewTicket: previous.viewTicket };
  return next;
}
