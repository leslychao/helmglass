const MAX_RESPONSE_BYTES = 1_048_576;

export class ProvisioningError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ProvisioningError';
    this.code = code;
  }
}

export async function readKeycloakJson(response, maximumBytes = MAX_RESPONSE_BYTES) {
  if (response.status === 204 || !response.body) return undefined;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new ProvisioningError('ADMIN_RESPONSE_TOO_LARGE', 'Keycloak response exceeds its size limit.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    throw new ProvisioningError('ADMIN_RESULT_UNKNOWN', 'Keycloak response was interrupted.');
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new ProvisioningError('ADMIN_RESPONSE_INVALID', 'Keycloak returned invalid JSON.');
  }
}

export class KeycloakClient {
  #baseUrl;
  #accessToken;
  #fetch;

  constructor(baseUrl, accessToken, fetchImplementation = fetch) {
    this.#baseUrl = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    this.#accessToken = accessToken;
    this.#fetch = fetchImplementation;
  }

  async request(method, path, body, { allowNotFound = false } = {}) {
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin || !url.pathname.startsWith(this.#baseUrl.pathname)) {
      throw new ProvisioningError('INVALID_ADMIN_PATH', 'Admin request escaped its trusted endpoint.');
    }
    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#accessToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // An interrupted mutation may already have committed. Callers reconcile by reading.
      throw new ProvisioningError('ADMIN_RESULT_UNKNOWN', 'Keycloak response was not received.');
    }
    if (response.status === 404 && allowNotFound) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProvisioningError(`ADMIN_HTTP_${response.status}`, `Keycloak rejected the operation (${response.status}).`);
    }
    return readKeycloakJson(response);
  }
}
