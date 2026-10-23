import { API_PREFIX, CORRELATION_ID_HEADER, isApiErrorBody, type ApiErrorCode } from '@thp/shared';
import { normaliseOrigin, readApiOrigin } from './config';

/** A failure the API reported, carrying the code and the correlation id to quote when reporting it. */
export class ApiClientError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'malformed_response',
    readonly status: number,
    message: string,
    readonly correlationId: string | null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * Build the absolute URL for an API path. Exported separately from {@link apiFetch} so the
 * "absolute origin, never a relative path" rule is directly assertable.
 */
export function buildApiUrl(path: string, origin: string = readApiOrigin()): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${normaliseOrigin(origin)}${API_PREFIX}${suffix}`;
}

export interface ApiFetchOptions extends RequestInit {
  readonly origin?: string;
  /** Adopted by the API rather than replaced, so one id spans the whole causal chain. */
  readonly correlationId?: string;
}

/**
 * **What answers when the server cannot be reached** ([3.18.13](docs/project/prd.md)).
 *
 * `fetch` rejecting — no connection, not a refusal — is the one moment this client hands the
 * request to somebody else: the offline module, which answers reads about downloaded teachings
 * from the device and keeps a note written offline in the outbox. It is a hook rather than an
 * import so this file stays what it is, a thin fetch, and so the offline module is installed by
 * the member surface alone — the admin console and the sign-in screen never answer from a device.
 * `null` from the hook means "nothing to say", and the original failure is rethrown.
 *
 * The success side is a hook for the same reason: every answer about a downloaded teaching that
 * passes through here refreshes the copy stored with it, without the screens knowing.
 */
export interface OfflineHooks {
  fallback(input: { readonly path: string; readonly init: RequestInit }): Promise<Response | null>;
  observe(input: { readonly path: string; readonly method: string; readonly body: unknown }): void;
}

let offlineHooks: OfflineHooks | null = null;

export function installOfflineHooks(hooks: OfflineHooks | null): void {
  offlineHooks = hooks;
}

export async function apiFetch<TPayload>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<TPayload> {
  const { origin, correlationId, headers, ...init } = options;
  const url = origin === undefined ? buildApiUrl(path) : buildApiUrl(path, origin);
  const request: RequestInit = {
    ...init,
    headers: {
      accept: 'application/json',
      ...(correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {}),
      ...headers,
    },
  };

  let response: Response;
  try {
    response = await fetch(url, request);
  } catch (caught) {
    const answered = offlineHooks === null ? null : await offlineHooks.fallback({ path, init: request });
    if (answered === null) throw caught;
    response = answered;
  }

  const responseCorrelationId = response.headers.get(CORRELATION_ID_HEADER);
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok && offlineHooks !== null && response.headers.get('x-thp-offline') === null) {
    offlineHooks.observe({ path, method: (init.method ?? 'GET').toUpperCase(), body });
  }

  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(
        body.error.code,
        response.status,
        body.error.message,
        body.error.correlationId,
      );
    }
    throw new ApiClientError(
      'malformed_response',
      response.status,
      'The API returned a failure that is not in the error envelope.',
      responseCorrelationId,
    );
  }

  return body as TPayload;
}
