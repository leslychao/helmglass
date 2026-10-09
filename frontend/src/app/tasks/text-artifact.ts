import { Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { Api, errorMessage } from '../core/api';
import { Icon } from '../shared/icon';

@Component({
  selector: 'hg-text-artifact',
  imports: [Icon],
  template: `
    <section class="text-artifact">
      <button class="artifact-heading" [attr.aria-expanded]="open()" (click)="toggle()">
        <hg-icon name="file" />
        <span
          ><strong>{{ name() }}</strong
          ><small>Отчёт внутри задачи</small></span
        >
        <hg-icon name="chevron-down" [class.expanded]="open()" />
      </button>
      @if (open()) {
        <div class="artifact-content">
          @if (loading()) {
            <p class="loading" role="status">Загружаем текст…</p>
          } @else if (error()) {
            <p class="error-banner" role="alert">
              {{ error() }} <button class="text-button" (click)="load()">Повторить</button>
            </p>
          } @else {
            <pre>{{ text() || 'Файл пуст.' }}</pre>
            @if (truncated()) {
              <p class="notice">Показаны первые 64 КиБ. Полный текст доступен в файле.</p>
            }
          }
          <a class="button small" [href]="'/api/artifacts/' + id() + '/download'" download
            >Скачать файл</a
          >
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .text-artifact {
      border: 1px solid var(--line);
      border-radius: 7px;
      overflow: hidden;
    }
    .artifact-heading {
      display: flex;
      align-items: center;
      gap: 14px;
      width: 100%;
      padding: 16px;
      text-align: left;
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
    }
    .artifact-heading span {
      flex: 1;
      min-width: 0;
    }
    .artifact-heading strong {
      display: block;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .artifact-heading small {
      display: block;
      color: var(--muted);
      font-size: 11px;
      margin-top: 3px;
    }
    .artifact-heading .expanded {
      transform: rotate(180deg);
    }
    .artifact-content {
      border-top: 1px solid var(--line);
      padding: 16px;
    }
    pre {
      margin: 0 0 16px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: inherit;
      line-height: 1.8;
    }
  `,
})
export class TextArtifact {
  readonly id = input.required<string>();
  readonly name = input.required<string>();
  readonly open = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly text = signal('');
  readonly truncated = signal(false);
  private readonly api = inject(Api);
  private request: AbortController | null = null;

  constructor() {
    effect(() => {
      this.id();
      this.reset();
    });
    inject(DestroyRef).onDestroy(() => this.request?.abort());
  }

  toggle() {
    if (this.open()) this.reset();
    else {
      this.open.set(true);
      void this.load();
    }
  }

  private reset() {
    this.request?.abort();
    this.request = null;
    this.open.set(false);
    this.text.set('');
    this.truncated.set(false);
    this.error.set('');
    this.loading.set(false);
  }

  async load() {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.error.set('');
    this.loading.set(true);
    try {
      const preview = await this.api.readTextPreview(
        '/api/artifacts/' + this.id() + '/download',
        request.signal,
      );
      if (this.request !== request || request.signal.aborted) return;
      this.text.set(preview.text);
      this.truncated.set(preview.truncated);
    } catch (error: unknown) {
      if (this.request === request && !request.signal.aborted) this.error.set(errorMessage(error));
    } finally {
      if (this.request === request) this.loading.set(false);
    }
  }
}
