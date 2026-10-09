import { A11yModule } from '@angular/cdk/a11y';
import { Component, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router } from '@angular/router';
import * as z from 'zod/mini';
import { Session } from '../core/session';
import { Icon } from './icon';
import { Tooltip } from './tooltip';
import { Status } from './ui';

export interface DialogField {
  key: string;
  label: string;
  value?: string;
  type?: 'text' | 'textarea' | 'number' | 'select';
  required?: boolean;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  visibleWhen?: { key: string; value: string };
  group?: string;
  placeholder?: string;
}
export interface DialogPresentation {
  subject?: { name: string; detail: string };
  groups?: { key: string; label: string; caption: string }[];
  note?: string;
  facts?: { label: string; value: string; status?: string }[];
  compact?: boolean;
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
  kind: 'confirmation' | 'information';
  presentation: DialogPresentation;
  sections: { key: string; label: string; caption: string; fields: DialogField[] }[];
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
    presentation: DialogPresentation = {},
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
        kind: 'confirmation',
        presentation,
        sections: [
          ...(presentation.groups ?? []).map((group) => ({
            ...group,
            fields: fields.filter((field) => field.group === group.key),
          })),
          {
            key: 'fields',
            label: '',
            caption: '',
            fields: fields.filter(
              (field) => !presentation.groups?.some((group) => group.key === field.group),
            ),
          },
        ],
      }),
    );
  }
  info(title: string, text: string, presentation: DialogPresentation = {}): void {
    if (this.current()) return;
    void this.ask(title, text, 'Закрыть', [], false, '', undefined, presentation);
    this.current.update((request) => (request ? { ...request, kind: 'information' } : null));
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
    for (const control of Array.from(form.elements)) {
      if (
        (control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement) &&
        control.name
      )
        values[control.name] = control.value;
    }
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
  imports: [FormsModule, A11yModule, Icon, Tooltip, Status],
  styleUrl: './dialog.css',
  template: ` @if (dialog.current(); as request) {
    <div class="modal-shade" (keydown.escape)="dialog.close(null)">
      <section
        class="dialog"
        [class.dialog-compact]="request.presentation.compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        [attr.aria-describedby]="request.text ? 'dialog-description' : null"
        cdkTrapFocus
        [cdkTrapFocusAutoCapture]="true"
      >
        <header>
          <h2 id="dialog-title">{{ request.title }}</h2>
          @if (!request.presentation.compact) {
            <button
              class="icon-button"
              aria-label="Закрыть"
              hgTooltip="Закрыть"
              (click)="dialog.close(null)"
            >
              <hg-icon name="close" />
            </button>
          }
        </header>
        @if (request.presentation.subject; as subject) {
          <div class="dialog-subject">
            <span class="dialog-subject-avatar">{{ initials(subject.name) }}</span>
            <div>
              <strong>{{ subject.name }}</strong
              ><small>{{ subject.detail }}</small>
            </div>
          </div>
        }
        @if (request.text) {
          <p id="dialog-description" class="muted">{{ request.text }}</p>
        }
        @if (request.presentation.facts?.length) {
          <dl class="dialog-facts">
            @for (fact of request.presentation.facts; track fact.label) {
              <div>
                <dt>{{ fact.label }}</dt>
                <dd>
                  @if (fact.status) {
                    <hg-status [value]="fact.status" />
                  } @else {
                    {{ fact.value }}
                  }
                </dd>
              </div>
            }
          </dl>
        }
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
          @for (section of request.sections; track section.key) {
            @if (section.key === 'fields' && request.presentation.note) {
              <p class="dialog-note">{{ request.presentation.note }}</p>
            }
            <fieldset class="dialog-field-group" [class.grouped]="!!section.label">
              @if (section.label) {
                <legend>{{ section.label }}</legend>
              }
              <div class="dialog-field-grid" [class.paired]="!!section.label">
                @for (field of section.fields; track field.key) {
                  <label class="field" [hidden]="!visible(field, form)"
                    >{{ field.label }}
                    @switch (field.type) {
                      @case ('textarea') {
                        <textarea
                          [name]="field.key"
                          [value]="field.value ?? ''"
                          [required]="field.required ?? false"
                          [disabled]="!visible(field, form)"
                          [maxLength]="field.max ?? 20000"
                          rows="4"
                        ></textarea>
                      }
                      @case ('select') {
                        <select
                          [name]="field.key"
                          [required]="field.required ?? false"
                          [disabled]="!visible(field, form)"
                        >
                          @for (option of field.options; track option.value) {
                            <option
                              [value]="option.value"
                              [selected]="option.value === field.value"
                            >
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
                          [disabled]="!visible(field, form)"
                          [min]="field.min ?? null"
                          [max]="field.type === 'number' ? (field.max ?? null) : null"
                          [maxLength]="field.type === 'number' ? 30 : (field.max ?? 4096)"
                          [placeholder]="field.placeholder ?? ''"
                        />
                      }
                    }
                  </label>
                }
              </div>
              @if (section.caption) {
                <p class="dialog-group-caption">{{ section.caption }}</p>
              }
            </fieldset>
          }
          <footer class="actions">
            @if (request.kind === 'information') {
              <button type="button" class="button primary" (click)="dialog.close(null)">
                Закрыть
              </button>
            } @else {
              <button
                type="button"
                class="button"
                [attr.cdkFocusInitial]="request.presentation.compact ? '' : null"
                (click)="dialog.close(null)"
              >
                Отмена</button
              ><button
                class="button primary"
                [class.danger]="request.danger"
                type="submit"
                [disabled]="request.conflict"
              >
                {{ request.confirm }}
              </button>
            }
          </footer>
        </form>
      </section>
    </div>
  }`,
})
export class DialogHost {
  readonly dialog = inject(Dialog);
  initials(name: string) {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.slice(0, 1))
      .join('')
      .toUpperCase();
  }
  visible(field: DialogField, form: HTMLFormElement): boolean {
    if (!field.visibleWhen) return true;
    const control = form.elements.namedItem(field.visibleWhen.key);
    const value =
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
        ? control.value
        : this.dialog.current()?.fields.find((item) => item.key === field.visibleWhen?.key)?.value;
    return value === field.visibleWhen.value;
  }
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
      if (this.visible(field, form) && field.required && !values[field.key]) {
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
