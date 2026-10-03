import { AdminUserListItem, AuditEntry, UserLimits } from '../../core/api/models';
import { Column, TableItem } from '../../shared/data-table/data-table';

export const userColumns: Column[] = [
  { key: 'name', title: 'Пользователь', kind: 'person', sort: 'displayName' },
  { key: 'state', title: 'Состояние', kind: 'status' },
  { key: 'browser', title: 'Браузеры' },
  { key: 'queue', title: 'Ожидают' },
  { key: 'activity', title: 'Последнее обращение', sort: 'lastActivityAt' },
];

export function userRows(users: readonly AdminUserListItem[]): TableItem[] {
  return users.map((user) => ({
    id: user.id,
    link: '/admin/users/' + user.id,
    values: {
      name: user.displayName,
      state: user.accountState,
      browser: user.limits
        ? `${user.occupiedBrowsers} / ${user.limits.quotas.effectiveBrowserLimit ?? 'пул'}`
        : String(user.occupiedBrowsers),
      queue: user.limits
        ? `${user.queuedTasks} / ${user.limits.quotas.effectiveQueuedLimit ?? '∞'}`
        : String(user.queuedTasks),
      activity: user.lastActivityAt
        ? new Date(user.lastActivityAt).toLocaleString('ru-RU')
        : 'Нет данных',
    },
    metadata: {
      name: user.email + '\n' + user.id,
      browser: user.limits ? `Назначено: ${browserAssignment(user.limits)}` : 'Квота удалена',
      queue: user.limits
        ? `Назначено: ${user.limits.quotas.assignedQueuedLimit ?? 'без ограничения'}`
        : 'Квота удалена',
    },
  }));
}

export function browserAssignment(limits: UserLimits): string {
  const assigned = limits.quotas.assignedBrowserLimit;
  if (assigned === null) return 'весь пул';
  return limits.browserMode === 'STANDARD' ? `стандартный · ${assigned}` : String(assigned);
}

export const auditColumns: Column[] = [
  { key: 'time', title: 'Время', sort: 'occurredAt' },
  { key: 'actor', title: 'Кто изменил' },
  { key: 'target', title: 'Пользователь / объект' },
  { key: 'action', title: 'Действие и причина' },
];

export function auditRows(items: readonly AuditEntry[]): TableItem[] {
  return items.map((item) => ({
    id: item.id,
    values: {
      time: new Date(item.occurredAt).toLocaleString('ru-RU'),
      actor: item.actorName,
      action: item.action,
      target: item.targetId,
    },
    metadata: { action: item.reason, target: item.targetType },
  }));
}
