import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, mergeMap } from 'rxjs';
import { Problem, Query, Receipt } from './models';
import { ResponseContractError, validateResponse } from './response-contract';

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  get<T>(path: string, query: Query = {}, headers?: HttpHeaders): Observable<T> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue;
      for (const item of Array.isArray(value) ? value : [value])
        params = params.append(key, String(item));
    }
    return this.http.get<T>(`/api/v1${path}`, { params, headers }).pipe(
      mergeMap(async (value) => {
        await validateResponse('GET', path, value);
        return value;
      }),
    );
  }

  mutate<T = Receipt>(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    key: string,
  ): Observable<T> {
    return this.http
      .request<T>(method, `/api/v1${path}`, {
        body,
        headers: new HttpHeaders({ 'Idempotency-Key': key, 'X-Request-Id': crypto.randomUUID() }),
      })
      .pipe(
        mergeMap(async (value) => {
          await validateResponse(method, path, value);
          return value;
        }),
      );
  }

  lookup(kind: string, key: string) {
    return this.get<Receipt>(
      '/operations/lookup',
      { kind },
      new HttpHeaders({ 'Idempotency-Key': key }),
    );
  }
}

export function problemOf(error: unknown): Problem {
  if (error instanceof ResponseContractError) {
    return {
      status: 502,
      code: error.code,
      title:
        error.code === 'API_CONTRACT_MISSING'
          ? 'Для ответа отсутствует согласованный контракт API'
          : 'Ответ сервера не соответствует контракту. Обновите данные.',
    };
  }
  if (error instanceof HttpErrorResponse) {
    const body: unknown = error.error;
    const fallbackTitle =
      error.status === 0
        ? 'Связь с сервером потеряна'
        : error.status === 401
          ? 'Войдите в Helm Glass'
          : error.status === 403
            ? 'Нет доступа'
            : 'Не удалось получить ответ сервера';
    if (typeof body === 'object' && body !== null) {
      return {
        title: 'title' in body && typeof body.title === 'string' ? body.title : fallbackTitle,
        status: error.status,
        code:
          'code' in body && typeof body.code === 'string'
            ? body.code
            : error.status === 0
              ? 'NETWORK_ERROR'
              : 'HTTP_ERROR',
        detail: 'detail' in body && typeof body.detail === 'string' ? body.detail : undefined,
        requestId:
          'requestId' in body && typeof body.requestId === 'string' ? body.requestId : undefined,
        operationId:
          'operationId' in body && typeof body.operationId === 'string'
            ? body.operationId
            : undefined,
      };
    }
    return {
      title: fallbackTitle,
      status: error.status,
      code: error.status === 0 ? 'NETWORK_ERROR' : 'HTTP_ERROR',
    };
  }
  return { title: 'Не удалось выполнить запрос', code: 'UNEXPECTED_ERROR', status: 0 };
}
