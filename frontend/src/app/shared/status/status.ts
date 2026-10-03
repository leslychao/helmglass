import { ChangeDetectionStrategy, Component, Pipe, PipeTransform, input } from '@angular/core';
const labels: Readonly<Record<string, string>> = {
  DRAFT: 'Черновик',
  WAITING_AGENT: 'Ожидает ChatGPT',
  QUEUED: 'В очереди',
  RUNNING: 'В работе',
  WAITING_USER: 'Нужно ваше участие',
  PAUSING: 'Приостанавливается',
  PAUSED: 'На паузе',
  INTERRUPTED: 'Прервано',
  STOPPING: 'Останавливается',
  CANCELLED: 'Остановлено',
  COMPLETED: 'Завершено',
  FAILED: 'Ошибка',
  SUCCESS: 'Готово',
  PARTIAL: 'Частично',
  NO_SUCCESS: 'Без успеха',
  NEEDS_LOGIN: 'Нужен вход',
  SAVED: 'Вход сохранён',
  AUTHENTICATED: 'Вход подтверждён',
  SESSION_ONLY: 'Вход в этой сессии',
  ACTIVE: 'Активен',
  BLOCKED: 'Заблокирован',
  DELETING: 'Удаляется',
  READY: 'Готов',
  LOST: 'Связь потеряна',
  CLOSED: 'Закрыт',
  OPEN: 'Открыт',
  RECOVERING: 'Восстановление',
  CHECKING: 'Проверяется',
  UNKNOWN: 'Результат неизвестен',
  PENDING: 'Выполняется',
  SUCCEEDED: 'Выполнено',
  HUMAN: 'Управляете вы',
  AGENT: 'Управляет ChatGPT',
  NONE: 'Без управления',
  LOGIN_PRIVATE: 'Приватный вход',
  PRIVATE_LOGIN: 'Приватный вход',
  PRIVATE: 'Приватное управление',
  PUBLIC: 'Открытый сайт',
  CONNECTED: 'Через подключение',
  NORMAL: 'Обычный режим',
  ANONYMOUS: 'Без входа',
  EXPIRED: 'Срок истёк',
  WRONG_ACCOUNT: 'Другой аккаунт',
  FORBIDDEN: 'Доступ запрещён',
  UNSUPPORTED: 'Не поддерживается',
  USER_ASSERTED: 'Подтверждено пользователем',
  DRAINING: 'Выводится из работы',
  OFFLINE: 'Не в сети',
  COMPLETE: 'Полные данные',
  PARTIAL_DATA: 'Неполные данные',
  KEEP_PAUSED: 'Оставить на паузе',
  CONTINUE_AFTER_USER: 'Продолжить после моего участия',
  DISPATCHED: 'Сообщение отправлено',
  CLAIMED: 'Принято ChatGPT',
  WAITING: 'Ожидание',
  MANUAL: 'Нужно сообщение в ChatGPT',
  TRANSFERRING: 'Передача управления',
  REVOKED: 'Доступ отозван',
  NEEDS_ATTENTION: 'Требуется внимание',
  ASYNC_RESULT_READY: 'Результат команды готов',
  CONTROL_RETURNED: 'Управление возвращено агенту',
  LOGIN_COMPLETED: 'Вход завершён',
  USER_RESPONSE: 'Ответ получен',
  EXPLICIT_RESUME: 'Продолжение подтверждено',
  NAVIGATE: 'Переход на страницу',
  OBSERVE: 'Чтение страницы',
  CLICK: 'Нажатие на элемент',
  FILL: 'Заполнение поля',
  SELECT: 'Выбор значения',
  PRESS: 'Нажатие клавиши',
  SCROLL: 'Прокрутка страницы',
  BACK: 'Возврат на предыдущую страницу',
  FORWARD: 'Переход вперёд',
  WAIT_FOR: 'Ожидание на странице',
};
@Pipe({ name: 'label' })
export class LabelPipe implements PipeTransform {
  transform(value: string | null | undefined) {
    return value ? (labels[value] ?? value) : '—';
  }
}
@Pipe({ name: 'duration' })
export class DurationPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value == null) return 'Нет данных';
    const seconds = Math.floor(value);
    return seconds >= 3600
      ? `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`
      : seconds >= 60
        ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
        : `${seconds} с`;
  }
}
@Pipe({ name: 'bytes' })
export class BytesPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value == null) return 'Нет данных';
    return value >= 1048576
      ? `${(value / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`
      : value >= 1024
        ? `${Math.round(value / 1024)} КБ`
        : `${value} Б`;
  }
}
@Component({
  selector: 'hg-status',
  imports: [LabelPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template:
    '<span class="badge" [class.success]="good()" [class.danger]="bad()" [class.warning]="attention()"><span class="status-point" aria-hidden="true"></span>{{ value() | label }}</span>',
})
export class Status {
  value = input<string | null | undefined>();
  good() {
    return ['SUCCESS', 'COMPLETED', 'AUTHENTICATED', 'READY', 'ACTIVE', 'SUCCEEDED'].includes(
      this.value() ?? '',
    );
  }
  bad() {
    return ['FAILED', 'INTERRUPTED', 'BLOCKED', 'FORBIDDEN'].includes(this.value() ?? '');
  }
  attention() {
    return ['WAITING_USER', 'UNKNOWN', 'NEEDS_LOGIN', 'PENDING', 'DELETING'].includes(
      this.value() ?? '',
    );
  }
}
