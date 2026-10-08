import { Component, Pipe, PipeTransform, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

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
  CONNECTION_READY: 'Вход сохранён',
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
  imports: [LabelPipe],
  template:
    '<span class="badge" [class.success]="success()" [class.warning]="warning()" [class.error]="error()"><i></i>{{ value() | label }}</span>',
})
export class Status {
  readonly value = input<string | null>('');
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
  imports: [FormsModule],
  template: ` <footer class="table-footer">
    <span aria-live="polite">{{ total() === null ? 'Данные ещё не получены' : range() }}</span>
    @if (!fixed()) {
      <label
        >Строк:
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
        [disabled]="page() <= 1 || total() === null"
        (click)="pageChange.emit(page() - 1)"
      >
        ‹</button
      ><span>{{ page() }} / {{ pages() }}</span
      ><button
        type="button"
        class="icon-button"
        aria-label="Следующая страница"
        [disabled]="page() >= pages() || total() === null"
        (click)="pageChange.emit(page() + 1)"
      >
        ›
      </button>
    </div>
  </footer>`,
})
export class Pager {
  readonly page = input(1);
  readonly size = input(10);
  readonly total = input<number | null>(null);
  readonly fixed = input(false);
  readonly pageChange = output<number>();
  readonly sizeChange = output<number>();
  readonly sizes = [10, 20, 50];
  readonly pages = computed(() => Math.max(1, Math.ceil((this.total() ?? 0) / this.size())));
  readonly range = computed(() => {
    const total = this.total() ?? 0;
    if (total === 0) return '0 записей';
    const first = (this.page() - 1) * this.size() + 1;
    if (first > total) return `На странице нет записей · всего ${total}`;
    return `${first}–${Math.min(this.page() * this.size(), total)} из ${total}`;
  });
  changeSize(value: number) {
    this.sizeChange.emit(value);
  }
}
@Component({
  selector: 'hg-empty',
  template:
    '<div class="empty"><span class="empty-symbol">◇</span><h2>{{ title() }}</h2><p>{{ description() }}</p><ng-content /></div>',
})
export class Empty {
  readonly title = input('Ничего не найдено');
  readonly description = input('Измените поиск или выбранные фильтры.');
}
