import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import * as z from 'zod/mini';
import { browserViewerId } from '../browser/viewer';
import { Api, errorMessage } from '../core/api';
import { Tooltip } from '../shared/tooltip';

const metadataSchema = z.object({
  available: z.boolean(),
  revision: z.number(),
  origin: z.nullable(z.string()),
  currentOrigin: z.nullable(z.string()),
  captureEnabled: z.boolean(),
  captureRevision: z.number(),
  captureOrigin: z.nullable(z.string()),
  captureStatus: z.enum(['DISABLED', 'ARMED', 'CAPTURED', 'UNSUPPORTED']),
});
type Metadata = z.infer<typeof metadataSchema>;

@Component({
  selector: 'hg-saved-credentials',
  imports: [Tooltip],
  styleUrl: './saved-credentials.css',
  template: `
    <label class="credentials-consent" [hgTooltip]="hint()" [attr.tabindex]="disabled() ? 0 : null">
      <span>Сохранять логин и пароль</span>
      <input
        type="checkbox"
        role="switch"
        [checked]="metadata()?.captureEnabled === true"
        [disabled]="disabled()"
        [attr.aria-busy]="busy()"
        (change)="setCapture($event)"
      />
    </label>
    @if (enabled() && (error() || loadError())) {
      <p class="error-banner" role="alert">
        {{ error() || loadError() }}
        <button class="text-button" [disabled]="busy()" (click)="refresh()">Повторить</button>
      </p>
    }
  `,
})
export class SavedCredentials {
  readonly browserId = input.required<string>();
  readonly enabled = input(false);
  private readonly api = inject(Api);
  private readonly destroy = inject(DestroyRef);
  private generation = 0;
  private request = 0;
  readonly metadata = signal<Metadata | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly loadError = signal('');
  readonly disabled = computed(() => {
    const state = this.metadata();
    return (
      !this.enabled() ||
      this.busy() ||
      !!this.loadError() ||
      !state ||
      (!state.captureEnabled && !state.currentOrigin)
    );
  });
  readonly hint = computed(() => {
    if (!this.enabled()) return 'Возьмите управление и откройте защищённый вход.';
    const state = this.metadata();
    if (!state) return this.loadError() || 'Загружаем настройку сохранения…';
    if (!state.currentOrigin && !state.captureEnabled)
      return 'Сохранение пароля доступно на HTTPS-странице входа.';
    if (state.captureStatus === 'UNSUPPORTED')
      return 'Не удалось определить логин и пароль в этой форме. Сессию можно сохранить без пароля.';
    if (state.captureStatus === 'CAPTURED')
      return 'Данные получены. Подтвердите вход и сохраните сессию.';
    return 'Общая настройка подключения и связанной задачи. Сохранение данных формы для следующего входа на этот сайт.';
  });

  constructor() {
    effect((onCleanup) => {
      const id = this.browserId(),
        enabled = this.enabled();
      const generation = ++this.generation;
      this.busy.set(false);
      this.metadata.set(null);
      this.error.set('');
      this.loadError.set('');
      if (!enabled || !id) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let polling = false;
      const poll = async (interactive = false) => {
        if (generation !== this.generation || document.hidden || polling) return;
        polling = true;
        try {
          if (!this.busy()) await this.load(id, generation, interactive);
        } finally {
          polling = false;
          clearTimeout(timer);
          if (generation === this.generation && !document.hidden)
            timer = setTimeout(() => void poll(), 2000);
        }
      };
      const visibility = () => {
        clearTimeout(timer);
        if (!document.hidden) void poll();
      };
      untracked(() => void poll(true));
      document.addEventListener('visibilitychange', visibility);
      onCleanup(() => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', visibility);
      });
    });
    this.destroy.onDestroy(() => {
      this.generation++;
    });
  }

  private async load(id: string, generation: number, interactive = true) {
    const request = ++this.request;
    if (interactive) this.busy.set(true);
    try {
      const result = await this.api.get(
        '/api/browser-sessions/' + id + '/credentials',
        metadataSchema,
        { viewerId: browserViewerId() },
      );
      if (generation === this.generation && request === this.request) {
        this.metadata.set(result);
        this.loadError.set('');
      }
    } catch (error: unknown) {
      if (generation === this.generation && request === this.request)
        this.loadError.set(errorMessage(error));
    } finally {
      if (generation === this.generation && interactive) this.busy.set(false);
    }
  }

  async setCapture(event: Event) {
    const state = this.metadata();
    if (!state || !(event.target instanceof HTMLInputElement)) return;
    const enabled = event.target.checked;
    event.target.checked = state.captureEnabled;
    if (this.disabled() || (enabled && !state.currentOrigin)) return;
    await this.command({
      enabled,
      expectedCaptureRevision: state.captureRevision,
    });
  }

  async refresh() {
    if (this.busy() || !this.enabled()) return;
    this.error.set('');
    await this.load(this.browserId(), this.generation);
  }

  private async command(values: object) {
    if (this.busy() || !this.enabled()) return;
    const id = this.browserId(),
      generation = this.generation;
    this.request++;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.api.mutate(
        '/api/browser-sessions/' + id + '/credentials',
        { viewerId: browserViewerId(), ...values },
        metadataSchema,
      );
      if (generation !== this.generation) return;
      this.metadata.set(result);
    } catch (error: unknown) {
      if (generation !== this.generation) return;
      await this.load(id, generation);
      if (generation === this.generation) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
}
