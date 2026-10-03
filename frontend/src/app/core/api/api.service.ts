import {
  HttpClient,
  HttpErrorResponse,
  HttpEventType,
  HttpHeaders,
  HttpParams,
  HttpResponse,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, defer, filter, finalize, mergeMap, tap } from 'rxjs';
import { Problem, Query, Receipt } from './models';
import { ResponseContractError, validateResponse } from './response-contract';

export interface MutationProgress {
  readonly stage: 'SUBSCRIBED' | 'SENT' | 'RESPONSE_HEADERS' | 'RESPONSE_RECEIVED' | 'VALIDATED';
  readonly requestId: string;
  readonly serverRequestId?: string;
}

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
    observe?: (progress: MutationProgress) => void,
  ): Observable<T> {
    const requestId = crypto.randomUUID();
    return defer(() => {
      let active = true;
      let serverRequestId: string | undefined;
      const report = (stage: MutationProgress['stage'], headers?: HttpHeaders) => {
        if (!observe || !active) return;
        if (headers) {
          const value = headers.get('X-Request-ID');
          serverRequestId =
            value?.length === 32 && /^[a-f0-9]{32}$/i.test(value) ? value : undefined;
        }
        try {
          observe({ stage, requestId, ...(serverRequestId ? { serverRequestId } : {}) });
        } catch {
          // Optional diagnostics must neither cancel the request nor replace its result.
        }
      };
      report('SUBSCRIBED');
      return this.http
        .request<T>(method, `/api/v1${path}`, {
          body,
          observe: 'events',
          reportProgress: observe !== undefined,
          headers: new HttpHeaders({ 'Idempotency-Key': key, 'X-Request-Id': requestId }),
        })
        .pipe(
          tap((event) => {
            // SENT means handed to the browser transport, not arrival at the server.
            if (event.type === HttpEventType.Sent) report('SENT');
            if (event.type === HttpEventType.ResponseHeader)
              report('RESPONSE_HEADERS', event.headers);
          }),
          filter((event): event is HttpResponse<T> => event instanceof HttpResponse),
          mergeMap(async (response) => {
            report('RESPONSE_RECEIVED');
            await validateResponse(method, path, response.body);
            report('VALIDATED');
            // The canonical runtime validator above admits the endpoint's response body,
            // including null only where its schema allows it.
            return response.body as T;
          }),
          finalize(() => {
            active = false;
          }),
        );
    });
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
