import { Component, Pipe, PipeTransform, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Icon, IconName } from './icon';
import { Tooltip } from './tooltip';

export const states: Record<string, string> = {
  BROWSER_CAPACITY: 'Ожидание свободного браузера или освобождения лимита',
  CONNECTION_BUSY: 'Выбранное подключение занято другой задачей',
  QUESTION: 'Нужен ответ на вопрос',
  CONFIRMATION: 'Нужно подтверждение действия',
  ACCOUNT_CHOICE: 'Нужно выбрать учётную запись',
  UNKNOWN_RESULT: 'Нужно проверить неизвестный результат',
  BROWSER_LOST: 'Браузер потерян. Продолжение требует согласия на новый браузер',
  TABLE: 'Таблица',
  REPORT: 'Отчёт',
  TEXT: 'Текстовый ответ',
  FILE_READY: 'Готов',
  INCOMPLETE: 'Файл получен не полностью',
  WAITING_CHATGPT: 'Ожидает ChatGPT',
  SUCCEEDED: 'Успешно выполнена',
  STOPPED: 'Остановлено',
  LIVE: 'Открыт',
  CLOSING: 'Закрывается',
  TRANSFERRING: 'Передача управления',
  CHATGPT: 'ChatGPT',
  USER: 'Пользователь',
  NONE: 'Нет управления',
  LOST: 'Браузер потерян',
  UNREACHABLE: 'Нет связи с браузером',
  ALLOCATING: 'Запускается',
  RELEASING: 'Закрывается',
  DRAFT: 'Черновик',
  WAITING_AGENT: 'Ожидает ChatGPT',
  QUEUED: 'В очереди',
  STARTING: 'Запускается',
  RUNNING: 'Выполняется',
  PAUSING: 'Приостанавливается',
  PAUSED: 'На паузе',
  WAITING_USER: 'Ожидает вас',
  STOPPING: 'Останавливается',
  COMPLETED: 'Завершена',
  SUCCESS: 'Успешно выполнена',
  PARTIAL: 'Частично выполнено',
  NOT_ACHIEVED: 'Цель не достигнута',
  FAILED: 'Ошибка',
  CANCELLED: 'Остановлено',
  INTERRUPTED: 'Нужна проверка',
  LOGIN: 'Нужен вход',
  LOGIN_REQUIRED: 'Нужен вход',
  MANUAL_CONTROL: 'Ручное управление',
  CONNECTION_READY: 'Сессия сохранена',
  ACTION: 'Нужно действие',
  SAVED: 'Вход сохранён',
  NEEDS_LOGIN: 'Нужен вход',
  CHECKING: 'Проверяется',
  UNAVAILABLE: 'Недоступно',
  ACTIVE: 'Активен',
  BLOCKED: 'Заблокирован',
  DELETING: 'Ожидает удаления',
  DELETION_PENDING: 'Ожидает удаления',
  PURGING: 'Очистка данных',
  DELETED: 'Удалён',
  ONLINE: 'В сети',
  READY: 'В сети',
  DRAINING: 'Без новых запусков',
  OFFLINE: 'Нет связи',
  PENDING: 'Ожидается',
  UNKNOWN: 'Результат неизвестен',
  DONE: 'Подтверждено',
  AVAILABLE: 'Доступен',
  CLOSED: 'Закрыт',
};
@Pipe({ name: 'label' })
export class LabelPipe implements PipeTransform {
  transform(value: string | null | undefined) {
    return value ? (states[value.toUpperCase()] ?? value) : '—';
  }
}
@Pipe({ name: 'duration' })
export class DurationPipe implements PipeTransform {
  transform(value: number | null | undefined) {
    if (value === null || value === undefined) return 'Нет данных';
    if (value > 0 && value < 1) return '< 1 с';
    const seconds = Math.floor(value),
      minutes = Math.floor(seconds / 60),
      hours = Math.floor(minutes / 60);
    return hours
      ? `${hours} ч ${minutes % 60} мин ${seconds % 60} с`
      : minutes
        ? `${minutes} мин ${seconds % 60} с`
        : `${seconds} с`;
  }
}
@Component({
  selector: 'hg-status',
  imports: [LabelPipe, Tooltip],
  template:
    '<span class="badge" [hgTooltip]="description()" tabindex="0" [class.blue]="active()" [class.success]="success()" [class.warning]="warning()" [class.error]="error()"><i></i>{{ value() | label }}</span>',
})
export class Status {
  readonly value = input<string | null>('');
  readonly description = computed(() => {
    const value = this.value()?.toUpperCase() ?? '';
    const descriptions: Record<string, string> = {
      UNKNOWN: 'Исход операции ещё не установлен. Не повторяйте действие до проверки результата.',
      TRANSFERRING: 'Сервер подтверждает смену владельца управления браузером.',
      PAUSED: 'Задача приостановлена. Продолжение требует явного действия.',
      PAUSING: 'Завершается текущее действие перед паузой.',
      STOPPING: 'Остановка запрошена и ещё не подтверждена.',
      DELETION_PENDING: 'Удаление запланировано. До начала очистки его можно отменить.',
      PURGING: 'Очистка данных началась. Отменить удаление уже нельзя.',
      LOST: 'Браузер потерян. Новый браузер требует отдельного подтверждения.',
      UNREACHABLE: 'Связь с браузером потеряна. Состояние уточняется.',
      DRAINING: 'Новые браузеры на узле не запускаются. Открытые продолжают работать.',
      INCOMPLETE: 'Полученные данные неполные.',
    };
    return descriptions[value] ?? states[value] ?? value;
  });
  readonly active = computed(() =>
    ['RUNNING', 'STARTING', 'LIVE', 'ALLOCATING'].includes(this.value()?.toUpperCase() ?? ''),
  );
  readonly success = computed(() =>
    [
      'SUCCESS',
      'SUCCEEDED',
      'SAVED',
      'ACTIVE',
      'READY',
      'CONNECTION_READY',
      'FILE_READY',
      'ONLINE',
      'DONE',
    ].includes(this.value()?.toUpperCase() ?? ''),
  );
  readonly warning = computed(() =>
    [
      'WAITING_USER',
      'INTERRUPTED',
      'NEEDS_LOGIN',
      'LOGIN_REQUIRED',
      'PAUSED',
      'PAUSING',
      'STOPPING',
      'DRAINING',
      'DELETING',
      'DELETION_PENDING',
      'LOST',
      'UNREACHABLE',
      'PURGING',
      'UNKNOWN',
      'INCOMPLETE',
    ].includes(this.value()?.toUpperCase() ?? ''),
  );
  readonly error = computed(() =>
    ['FAILED', 'BLOCKED', 'UNAVAILABLE', 'OFFLINE'].includes(this.value()?.toUpperCase() ?? ''),
  );
}
@Component({
  selector: 'hg-pager',
  imports: [FormsModule, Icon, Tooltip],
  template: ` <footer class="table-footer">
    <span aria-live="polite">{{ total() === null ? 'Данные ещё не получены' : range() }}</span>
    @if (!fixed()) {
      <label
        >На странице
        <select
          [ngModel]="size()"
          (ngModelChange)="changeSize($event)"
          aria-label="Строк на странице"
        >
          @for (count of sizes; track count) {
            <option [ngValue]="count">{{ count }}</option>
          }
        </select></label
      >
    }
    <div class="pager">
      <button
        type="button"
        class="icon-button"
        aria-label="Предыдущая страница"
        hgTooltip="Предыдущая страница"
        [disabled]="page() <= 1 || total() === null"
        (click)="pageChange.emit(page() - 1)"
      >
        <hg-icon name="chevron-right" class="previous-page" /></button
      ><span>{{ page() }} / {{ pages() }}</span
      ><button
        type="button"
        class="icon-button"
        aria-label="Следующая страница"
        hgTooltip="Следующая страница"
        [disabled]="page() >= pages() || total() === null"
        (click)="pageChange.emit(page() + 1)"
      >
        <hg-icon name="chevron-right" />
      </button>
    </div>
  </footer>`,
})
export class Pager {
  readonly page = input(1);
  readonly size = input(5);
  readonly total = input<number | null>(null);
  readonly fixed = input(false);
  readonly summaryLabel = input('');
  readonly pageChange = output<number>();
  readonly sizeChange = output<number>();
  readonly sizes = [5, 10, 25, 50];
  readonly pages = computed(() => Math.max(1, Math.ceil((this.total() ?? 0) / this.size())));
  readonly range = computed(() => {
    const total = this.total() ?? 0;
    const prefix = this.summaryLabel() ? this.summaryLabel() + ': ' : '';
    if (total === 0) return prefix ? prefix + '0' : '0 записей';
    const first = (this.page() - 1) * this.size() + 1;
    if (first > total) return prefix
      ? prefix + `на странице пусто · всего ${total}`
      : `На странице нет записей · всего ${total}`;
    return prefix + `${first}–${Math.min(this.page() * this.size(), total)} из ${total}`;
  });
  changeSize(value: number) {
    this.sizeChange.emit(value);
  }
}
@Component({
  selector: 'hg-empty',
  imports: [Icon],
  template:
    '<div class="empty"><span class="empty-symbol"><hg-icon [name]="icon()" /></span><h2>{{ title() }}</h2><p>{{ description() }}</p><ng-content /></div>',
})
export class Empty {
  readonly icon = input<IconName>('list');
  readonly title = input('Ничего не найдено');
  readonly description = input('Измените поиск или выбранные фильтры.');
}
