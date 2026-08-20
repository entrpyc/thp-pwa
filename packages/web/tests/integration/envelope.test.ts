import { beforeAll, describe, expect, it, inject } from 'vitest';
import { API_PREFIX, CORRELATION_ID_HEADER, isApiErrorBody } from '@thp/shared';
import { BOOM_INTERNAL_MESSAGE } from '@/server/api/diagnostics';

const baseUrl = inject('apiBaseUrl');
const api = (path: string) => `${baseUrl}${API_PREFIX}${path}`;

describe('the /api/v1 envelope', () => {
  beforeAll(() => {
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('answers a health check over HTTP with 200 and a JSON body', async () => {
    const response = await fetch(api('/health'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('status');
    expect(isApiErrorBody(body)).toBe(false);
  });

  it('puts a successful payload at the top level, with no error key', async () => {
    const response = await fetch(api('/diagnostics/echo?lines=1&marker=envelope-success'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['marker']).toBe('envelope-success');
    expect(body).not.toHaveProperty('error');
  });

  it('returns the error envelope for a failure the route means to return', async () => {
    const response = await fetch(api('/diagnostics/handled-failure'));
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body: unknown = await response.json();
    expect(isApiErrorBody(body)).toBe(true);
    if (!isApiErrorBody(body)) throw new Error('unreachable');
    expect(body.error.code).toBe('service_unavailable');
    expect(body.error.message).not.toBe(body.error.code);
    expect(body.error.correlationId).toBeTruthy();
  });

  it('returns the error envelope with 500 for an unhandled throw', async () => {
    const response = await fetch(api('/diagnostics/boom'));
    expect(response.status).toBe(500);
    const body: unknown = await response.json();
    expect(isApiErrorBody(body)).toBe(true);
  });

  it('leaks neither the internal message nor a stack trace on an unhandled throw', async () => {
    const response = await fetch(api('/diagnostics/boom'));
    const text = await response.text();
    expect(text).not.toContain(BOOM_INTERNAL_MESSAGE);
    expect(text).not.toContain('swordfish');
    expect(text).not.toContain('.ts:');
    expect(text).not.toMatch(/\bat\s+\w+\s+\(/);
    expect(text).not.toContain('Error:');
  });

  it('answers an unknown path under /api/v1 with a JSON 404, not an HTML page', async () => {
    const response = await fetch(api('/there-is-no-such-route'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body: unknown = await response.json();
    expect(isApiErrorBody(body)).toBe(true);
    if (!isApiErrorBody(body)) throw new Error('unreachable');
    expect(body.error.code).toBe('not_found');
  });

  it('answers the bare /api/v1 root with the same JSON 404', async () => {
    const response = await fetch(`${baseUrl}${API_PREFIX}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('keeps the machine-readable code stable across two identical failures', async () => {
    const [first, second] = await Promise.all([
      fetch(api('/diagnostics/boom')).then((response) => response.json() as Promise<unknown>),
      fetch(api('/diagnostics/boom')).then((response) => response.json() as Promise<unknown>),
    ]);
    if (!isApiErrorBody(first) || !isApiErrorBody(second)) throw new Error('expected envelopes');

    expect(first.error.code).toBe('internal_error');
    expect(second.error.code).toBe(first.error.code);
    expect(first.error.message).toBe(second.error.message);
    // The code is stable; the correlation id is deliberately not.
    expect(first.error.correlationId).not.toBe(second.error.correlationId);
  });

  it('carries the correlation id on every response, success and failure alike', async () => {
    const paths = ['/health', '/diagnostics/handled-failure', '/diagnostics/boom', '/nope'];
    for (const path of paths) {
      const response = await fetch(api(path));
      expect(response.headers.get(CORRELATION_ID_HEADER), path).toBeTruthy();
      expect(response.headers.get('content-type'), path).toContain('application/json');
    }
  });
});

describe('the envelope agrees with the response headers', () => {
  it('reports the same correlation id in the body as in the header', async () => {
    for (const path of ['/diagnostics/handled-failure', '/diagnostics/boom', '/nope']) {
      const response = await fetch(api(path));
      const body: unknown = await response.json();
      if (!isApiErrorBody(body)) throw new Error(`expected an error envelope from ${path}`);
      expect(body.error.correlationId, path).toBe(response.headers.get(CORRELATION_ID_HEADER));
    }
  });
});
