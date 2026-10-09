import { TableView, TableColumn } from '../shared/table-view';
import { ColumnPicker } from '../shared/column-picker';
import { DataTable, TableCell } from '../shared/data-table';
import { DatePipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import * as z from 'zod/mini';
import { auditSchema } from '../core/models';
import { Tooltip } from '../shared/tooltip';
import { Empty, states } from '../shared/ui';

export const auditColumns: readonly TableColumn[] = [
  { key: 'createdAt', label: 'Время', width: 180 },
  { key: 'actor', label: 'Кто изменил', width: 200 },
  { key: 'target', label: 'Что изменили', width: 230, className: 'audit-text' },
  { key: 'action', label: 'Действие', width: 280, className: 'audit-text' },
  { key: 'reason', label: 'Причина', width: 280, className: 'audit-text' },
];

const actionLabels: Record<string, string> = {
  LIMITS: 'Изменение квот',
  BLOCK: 'Блокировка',
  UNBLOCK: 'Разблокировка',
  REQUEST_DELETION: 'Удаление аккаунта',
  CANCEL_DELETION: 'Отмена удаления',
  STOP_ALL: 'Остановка всех задач',
  STOP_TASK: 'Остановка задачи',
  DRAIN: 'Запрет новых запусков на узле',
  ENABLE: 'Разрешение запусков на узле',
  PAUSE_ADMISSION: 'Приостановка запусков',
  RESUME_ADMISSION: 'Разрешение запусков',
  PURGE: 'Очистка данных',
};

export function adminActionLabel(action: string): string {
  return actionLabels[action] ?? action;
}

const snapshotSchema = z.object({
  status: z.optional(z.string()),
  browserLimitMode: z.optional(z.string()),
  browserLimit: z.optional(z.nullable(z.number())),
  waitingLimit: z.optional(z.nullable(z.number())),
  acceptsNew: z.optional(z.boolean()),
  paused: z.optional(z.boolean()),
});

function snapshot(value: string | null, action: string): string {
  if (!value) return '';
  try {
    const parsed: unknown = JSON.parse(value);
    const result = snapshotSchema.safeParse(parsed);
    if (!result.success) return '';
    const data = result.data;
    if (action === 'LIMITS' && data.browserLimitMode) {
      const browser =
        data.browserLimitMode === 'UNLIMITED'
          ? 'весь общий пул'
          : data.browserLimitMode === 'CUSTOM'
            ? String(data.browserLimit)
            : 'стандартные 2';
      return 'Браузеры: ' + browser + '; ожидание: ' + (data.waitingLimit ?? 'без ограничения');
    }
    if (data.acceptsNew !== undefined)
      return data.acceptsNew ? 'Запуски разрешены' : 'Без новых запусков';
    if (data.paused !== undefined)
      return data.paused ? 'Запуски приостановлены' : 'Запуски разрешены';
    return data.status ? (states[data.status] ?? data.status) : '';
  } catch {
    return '';
  }
}

@Component({
  selector: 'hg-admin-audit-table',
  imports: [DataTable, TableCell, ColumnPicker, DatePipe, RouterLink, Empty, Tooltip],
  template: `
    <div class="table-tools"><hg-column-picker [view]="view()" /></div>
    @if (rows().length) {
      <hg-data-table [view]="view()" [rows]="rows()" label="Журнал административных действий">
        <ng-template hgCell="createdAt" [hgCellOf]="rows()" let-event>{{
          event.createdAt | date: 'dd.MM.yyyy HH:mm'
        }}</ng-template>
        <ng-template hgCell="actor" [hgCellOf]="rows()" let-event>
          <span [hgTooltip]="event.actor">{{ event.actorName }}</span>
        </ng-template>
        <ng-template hgCell="target" [hgCellOf]="rows()" let-event>
          @if (event.targetType === 'USER') {
            <a
              [routerLink]="['/admin/users', event.target]"
              [queryParams]="{ return: returnUrl() }"
              >{{ event.targetName }}</a
            >
          } @else {
            <span [hgTooltip]="event.target">{{ event.targetName }}</span>
          }
          <small>{{ targetLabels[event.targetType] }}</small>
        </ng-template>
        <ng-template hgCell="action" [hgCellOf]="rows()" let-event>
          <strong class="audit-action">{{ actionLabel(event.action) }}</strong>
          @if (event.change) {
            <p class="audit-change">{{ event.change }}</p>
          }
          <small
            [class.warning-text]="event.status === 'PENDING' || event.status === 'UNKNOWN'"
            [class.danger-text]="event.status === 'FAILED'"
            >{{ resultLabel(event.status) }}</small
          >
        </ng-template>
        <ng-template hgCell="reason" [hgCellOf]="rows()" let-event>
          <p class="audit-reason" [hgTooltip]="event.reason || ''">
            {{ event.reason || '—' }}
          </p>
        </ng-template>
      </hg-data-table>
    } @else {
      <hg-empty
        title="Действий не найдено"
        description="Измените условия или дождитесь новых событий."
      />
    }
  `,
})
export class AdminAuditTable {
  readonly actionLabel = adminActionLabel;
  readonly items = input.required<z.infer<typeof auditSchema>[]>();
  readonly returnUrl = input('/admin/audit');
  readonly view = input.required<TableView>();
  readonly targetLabels: Record<string, string> = {
    USER: 'Пользователь',
    NODE: 'Узел исполнения',
    TASK: 'Задача',
    PLATFORM: 'Настройка системы',
  };
  readonly rows = computed(() =>
    this.items().map((event) => {
      const before = snapshot(event.before, event.action),
        after = snapshot(event.after, event.action);
      return { ...event, change: before !== after ? (before || '—') + ' → ' + (after || '—') : '' };
    }),
  );
  resultLabel(status: string) {
    const labels: Record<string, string> = {
      SUCCEEDED: 'Изменение подтверждено',
      PENDING: 'Операция продолжается',
      FAILED: 'Операция не выполнена',
      UNKNOWN: 'Результат требует проверки',
    };
    return labels[status] ?? states[status] ?? status;
  }
}
