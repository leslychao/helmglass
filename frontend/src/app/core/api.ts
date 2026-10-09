import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import * as z from 'zod/mini';
import { LiveEvents } from './live-events';

export type Query = Record<string, string | number | readonly string[] | undefined>;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly uncertain = false,
    readonly fields: Record<string, string> = {},
    readonly code = '',
  ) {
    super(message);
  }
}
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  private readonly live = inject(LiveEvents);
  readonly authenticationRequired = signal(false);
  private readonly operations = new Map<string, string>();
  private account = '';
  setAccount(id: string) {
    this.account = id;
  }

  async get<T>(path: string, schema: z.ZodMiniType<T>, query: Query = {}): Promise<T> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) params = params.append(key, item);
      } else if (value !== undefined && value !== '') params = params.set(key, String(value));
    }
    const tracked = untracked(() => this.live.beginRefresh());
    let success = false;
    try {
      const value = schema.parse(await firstValueFrom(this.http.get<unknown>(path, { params })));
      success = true;
      return value;
    } catch (error: unknown) {
      // An authoritative access/absence response is current, not a lost synchronization.
      success = error instanceof HttpErrorResponse && [403, 404].includes(error.status);
      throw this.failure(error, false);
    } finally {
      this.live.endRefresh(tracked, success);
    }
  }

  async mutate<T>(
    path: string,
    body: object,
    schema: z.ZodMiniType<T>,
    method = 'POST',
  ): Promise<T> {
    const fingerprint = this.account + method + path + (await this.bodyFingerprint(body));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint));
    const storageKey =
      'helm-operation:' +
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    let key = this.operations.get(fingerprint) ?? sessionStorage.getItem(storageKey);
    if (!key) {
      key = crypto.randomUUID();
      this.operations.set(fingerprint, key);
      sessionStorage.setItem(storageKey, key);
    }
    try {
      const result = schema.parse(
        await firstValueFrom(
          this.http.request<unknown>(method, path, {
            body,
            headers: { 'Idempotency-Key': key },
          }),
        ),
      );
      this.operations.delete(fingerprint);
      sessionStorage.removeItem(storageKey);
      return result;
    } catch (error: unknown) {
      const failure = this.failure(error, true);
      if (!failure.uncertain) {
        this.operations.delete(fingerprint);
        sessionStorage.removeItem(storageKey);
      }
      throw failure;
    }
  }

  async readTextPreview(path: string, signal: AbortSignal) {
    const limit = 64 * 1024;
    try {
      const response = await fetch(path, {
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpErrorResponse({ status: response.status });
      }
      if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'text/plain') {
        await response.body?.cancel();
        throw new Error('Этот файл нельзя просмотреть как обычный текст.');
      }
      if (!response.body) throw new Error('Содержимое файла не получено.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return { text: text + decoder.decode(), truncated: false };
          const remaining = limit - bytes;
          text += decoder.decode(value.subarray(0, remaining), { stream: true });
          bytes += value.byteLength;
          if (bytes > limit) {
            await reader.cancel();
            return { text, truncated: true };
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error('Не удалось загрузить текст за 15 секунд. Повторите попытку.');
      }
      if (error instanceof TypeError)
        throw this.failure(new HttpErrorResponse({ status: 0 }), false);
      throw this.failure(error, false);
    }
  }

  private async bodyFingerprint(body: object): Promise<string> {
    if (!(body instanceof FormData)) return JSON.stringify(body);
    const entries: [
      string,
      string | { name: string; type: string; size: number; sha256: string },
    ][] = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') entries.push([name, value]);
      else {
        if (value.size > 5 * 1024 * 1024)
          throw new Error('Размер фотографии не должен превышать 5 МБ.');
        const digest = await crypto.subtle.digest('SHA-256', await value.arrayBuffer());
        entries.push([
          name,
          {
            name: value.name,
            type: value.type,
            size: value.size,
            sha256: Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join(''),
          },
        ]);
      }
    }
    return JSON.stringify(entries);
  }

  private failure(error: unknown, mutation: boolean): ApiError {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 401) {
        this.authenticationRequired.set(true);
        this.live.stop();
      }
      const parsed = z
        .object({
          message: z.string(),
          code: z.optional(z.string()),
          fieldErrors: z.optional(z.record(z.string(), z.string())),
        })
        .safeParse(error.error);
      const text =
        error.status === 401
          ? 'Вход закончился. Войдите снова; введённые данные сохранены.'
          : parsed.success
            ? parsed.data.message
            : error.status === 403
              ? 'Нет разрешения на это действие.'
              : error.status === 409
                ? 'Данные изменились. Обновите состояние и проверьте действие.'
                : mutation && (!error.status || error.status >= 500)
                  ? 'Ответ не получен. Исход операции ещё не подтверждён. Повтор использует тот же номер операции.'
                  : 'Не удалось получить данные. Проверьте соединение.';
      return new ApiError(
        text,
        error.status,
        mutation &&
          (!error.status ||
            error.status >= 500 ||
            (parsed.success && parsed.data.code === 'OPERATION_PENDING')),
        parsed.success ? (parsed.data.fieldErrors ?? {}) : {},
        parsed.success ? (parsed.data.code ?? '') : '',
      );
    }
    return new ApiError(
      error instanceof Error && ['ZodError', '$ZodError'].includes(error.name)
        ? 'Ответ сервера не соответствует контракту.'
        : error instanceof Error
          ? error.message
          : 'Неизвестная ошибка.',
      0,
      mutation,
    );
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие.';
}
