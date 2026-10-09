import { Injectable, inject } from '@angular/core';
import { Api } from '../core/api';
import { Task, taskSchema } from '../core/models';
import { Dialog } from '../shared/dialog';

@Injectable({ providedIn: 'root' })
export class TaskStop {
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);

  async stop(task: Task) {
    if (!task.allowedCommands.includes('STOP')) return;
    const confirmed = await this.dialog.ask(
      'Остановить задачу?',
      'После завершения отправленного действия браузер будет закрыт. Результаты сохранятся. Возобновить остановленную задачу нельзя.',
      'Остановить',
      [],
      true,
      task.id,
      undefined,
      {
        subject: {
          name: task.title || task.goal || 'Задача без названия',
          detail: '#' + task.id.slice(0, 8),
        },
      },
    );
    if (!confirmed) return;
    return this.api.mutate(
      '/api/tasks/' + task.id + '/commands',
      { type: 'STOP', expectedVersion: task.version },
      taskSchema,
    );
  }
}
