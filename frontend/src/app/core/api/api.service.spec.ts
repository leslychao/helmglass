import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { problemOf } from './api.service';

describe('authentication error contracts', () => {
  it.each(['AUTHENTICATION_REQUIRED', 'REAUTHENTICATION_REQUIRED'])(
    'retains %s from the gateway and identity filter without a title',
    (code) => {
      const problem = problemOf(
        new HttpErrorResponse({
          status: 401,
          error: { status: 401, code, requestId: 'request-1' },
        }),
      );
      expect(problem).toMatchObject({
        code,
        status: 401,
        requestId: 'request-1',
        title: 'Войдите в Helm Glass',
      });
    },
  );
});
