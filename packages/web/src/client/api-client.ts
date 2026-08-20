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

export async function apiFetch<TPayload>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<TPayload> {
  const { origin, correlationId, headers, ...init } = options;
  const url = origin === undefined ? buildApiUrl(path) : buildApiUrl(path, origin);

  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {}),
      ...headers,
    },
  });

  const responseCorrelationId = response.headers.get(CORRELATION_ID_HEADER);
  const body: unknown = await response.json().catch(() => undefined);

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
