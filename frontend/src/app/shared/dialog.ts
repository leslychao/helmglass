import { A11yModule } from '@angular/cdk/a11y';
import { Component, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router } from '@angular/router';
import * as z from 'zod/mini';
import { Session } from '../core/session';

export interface DialogField {
  key: string;
  label: string;
  value?: string;
  type?: 'text' | 'textarea' | 'number' | 'select';
  required?: boolean;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}
interface DialogRequest {
  title: string;
  text: string;
  confirm: string;
  danger: boolean;
  fields: DialogField[];
  resolve: (value: Record<string, string> | null) => void;
  focus: Element | null;
  draftKey: string | null;
  baseVersion?: number;
  currentVersion?: number;
  currentFields: DialogField[];
  conflict: boolean;
}
const draftSchema = z.object({
  values: z.record(z.string(), z.string()),
  baseVersion: z.optional(z.number()),
});
@Injectable({ providedIn: 'root' })
export class Dialog {
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly submitted = new WeakMap<
    Record<string, string>,
    { key: string; version?: number }
  >();
  readonly current = signal<DialogRequest | null>(null);
  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      const request = this.current();
      if (!request) return;
      // Inputs are already persisted; a former route must not submit its pending action.
      this.current.set(null);
      request.resolve(null);
    });
  }
  ask(
    title: string,
    text: string,
    confirm = 'Продолжить',
    fields: DialogField[] = [],
    danger = false,
    subject = '',
    currentVersion?: number,
  ): Promise<Record<string, string> | null> {
    if (this.current()) return Promise.resolve(null);
    const draftKey = fields.length
      ? 'helm-dialog:' +
        JSON.stringify([this.session.user()?.id, this.router.url.split('?')[0], title, subject])
      : null;
    const currentFields = fields;
    let baseVersion = currentVersion;
    if (draftKey) {
      const draft = sessionStorage.getItem(draftKey);
      if (draft) {
        try {
          const saved = draftSchema.parse(JSON.parse(draft));
          const values = saved.values;
          baseVersion = saved.baseVersion;
          fields = fields.map((field) => ({ ...field, value: values[field.key] ?? field.value }));
        } catch {
          sessionStorage.removeItem(draftKey);
        }
      }
    }
    return new Promise((resolve) =>
      this.current.set({
        title,
        text,
        confirm,
        fields,
        danger,
        resolve,
        focus: document.activeElement,
        draftKey,
        baseVersion,
        currentVersion,
        currentFields,
        conflict: currentVersion !== undefined && baseVersion !== currentVersion,
      }),
    );
  }
  close(value: Record<string, string> | null) {
    const request = this.current();
    if (request?.draftKey) {
      if (value) {
        sessionStorage.setItem(
          request.draftKey,
          JSON.stringify({ values: value, baseVersion: request.baseVersion }),
        );
        this.submitted.set(value, { key: request.draftKey, version: request.baseVersion });
      } else sessionStorage.removeItem(request.draftKey);
    }
    this.current.set(null);
    request?.resolve(value);
    if (request?.focus instanceof HTMLElement) request.focus.focus();
  }
  preserve(form: HTMLFormElement) {
    const key = this.current()?.draftKey;
    if (!key) return;
    const values: Record<string, string> = {};
    new FormData(form).forEach((value, name) => {
      if (typeof value === 'string') values[name] = value;
    });
    sessionStorage.setItem(
      key,
      JSON.stringify({ values, baseVersion: this.current()?.baseVersion }),
    );
  }
  acceptCurrentVersion(form: HTMLFormElement) {
    this.current.update((request) =>
      request ? { ...request, baseVersion: request.currentVersion, conflict: false } : null,
    );
    this.preserve(form);
  }
  version(values: Record<string, string>) {
    return this.submitted.get(values)?.version;
  }
  complete(values: Record<string, string>) {
    const submission = this.submitted.get(values);
    if (submission) sessionStorage.removeItem(submission.key);
    this.submitted.delete(values);
  }
}
@Component({
  selector: 'hg-dialog',
  imports: [FormsModule, A11yModule],
  template: ` @if (dialog.current(); as request) {
    <div class="modal-shade" (keydown.escape)="dialog.close(null)">
      <section
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        cdkTrapFocus
        [cdkTrapFocusAutoCapture]="true"
      >
        <header>
          <h2 id="dialog-title">{{ request.title }}</h2>
          <button
            class="icon-button"
            aria-label="Закрыть"
            title="Закрыть"
            (click)="dialog.close(null)"
          >
            ×
          </button>
        </header>
        <p class="muted">{{ request.text }}</p>
        <form
          #form
          (submit)="submit($event, form)"
          (input)="clearValidity($event); dialog.preserve(form)"
          (change)="dialog.preserve(form)"
        >
          @if (request.conflict) {
            <div class="notice warning" role="alert">
              <strong>Сохранённый ввод относится к прежней версии.</strong>
              <p>Данные изменились. Сравните текущие значения с вашим вводом перед сохранением.</p>
              <dl>
                @for (field of request.currentFields; track field.key) {
                  @if (field.value !== undefined) {
                    <dt>{{ field.label }}</dt>
                    <dd>{{ field.value || 'Пусто' }}</dd>
                  }
                }
              </dl>
              <button type="button" class="button" (click)="dialog.acceptCurrentVersion(form)">
                Использовать мой ввод для текущей версии
              </button>
            </div>
          }
          @for (field of request.fields; track field.key) {
            <label class="field"
              >{{ field.label }}
              @switch (field.type) {
                @case ('textarea') {
                  <textarea
                    [name]="field.key"
                    [value]="field.value ?? ''"
                    [required]="field.required ?? false"
                    [maxLength]="field.max ?? 20000"
                    rows="4"
                  ></textarea>
                }
                @case ('select') {
                  <select [name]="field.key" [required]="field.required ?? false">
                    @for (option of field.options; track option.value) {
                      <option [value]="option.value" [selected]="option.value === field.value">
                        {{ option.label }}
                      </option>
                    }
                  </select>
                }
                @default {
                  <input
                    [type]="field.type ?? 'text'"
                    [name]="field.key"
                    [value]="field.value ?? ''"
                    [required]="field.required ?? false"
                    [min]="field.min ?? null"
                    [max]="field.type === 'number' ? (field.max ?? null) : null"
                    [maxLength]="field.type === 'number' ? 30 : (field.max ?? 4096)"
                  />
                }
              }
            </label>
          }
          <footer class="actions">
            <button type="button" class="button" (click)="dialog.close(null)">Отмена</button
            ><button
              class="button primary"
              [class.danger]="request.danger"
              type="submit"
              [disabled]="request.conflict"
            >
              {{ request.confirm }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  }`,
})
export class DialogHost {
  readonly dialog = inject(Dialog);
  clearValidity(event: Event) {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    )
      target.setCustomValidity('');
  }
  submit(event: Event, form: HTMLFormElement) {
    event.preventDefault();
    if (this.dialog.current()?.conflict) return;
    if (!form.reportValidity()) return;
    const values: Record<string, string> = {};
    new FormData(form).forEach((value, key) => {
      if (typeof value === 'string') values[key] = value.trim();
    });
    for (const field of this.dialog.current()?.fields ?? []) {
      if (field.required && !values[field.key]) {
        const control = form.elements.namedItem(field.key);
        if (
          control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement ||
          control instanceof HTMLSelectElement
        )
          control.setCustomValidity('Заполните поле.');
      }
    }
    if (!form.reportValidity()) return;
    this.dialog.close(values);
  }
}
