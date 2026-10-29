import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { API_PREFIX, ROLE, SOS_PATH, isApiErrorBody } from '@thp/shared';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * **A state-changing request must come from this site** (docs/security-audit-2026-10-29.md,
 * finding 3). The session cookie is `SameSite=Lax`, which does nothing against a sibling host under
 * the same parent domain; `apiRoute` therefore reads the two headers a browser attaches and a page
 * cannot forge — `Sec-Fetch-Site` and `Origin` — and refuses a body that is not JSON, which is the
 * one kind a cross-site page can send without a preflight.
 *
 * Driven over HTTP with the headers a browser would send in each case. A request carrying none of
 * them — this test runner, `curl` — passes, because a cookie-bearing request a browser did not make
 * is not a forgery.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

let cookie: string;

beforeAll(async () => {
  ({ cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'cross-site'));
}, 60_000);

afterAll(async () => {
  await closeTestDatabase();
});

async function send(
  method: string,
  headers: Record<string, string>,
  body: string | null = JSON.stringify({ urgency: 'green', description: 'a probe, not a prayer' }),
): Promise<{ status: number; code: string | null }> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${SOS_PATH}`, {
    method,
    headers: { cookie, accept: 'application/json', 'content-type': 'application/json', ...headers },
    ...(body === null ? {} : { body }),
  });
  const parsed = (await response.json().catch(() => undefined)) as unknown;
  return { status: response.status, code: isApiErrorBody(parsed) ? parsed.error.code : null };
}

describe('a write from another site', () => {
  it('is refused by its Origin, whatever the cookie says', async () => {
    const refused = await send('POST', { origin: 'https://other-site.indepthwebsolutions.com' });
    expect(refused.status).toBe(403);
    expect(refused.code).toBe('forbidden');
    // A sandboxed frame's opaque origin is nobody's either.
    expect((await send('POST', { origin: 'null' })).status).toBe(403);
  });

  it('is refused by Sec-Fetch-Site when the browser says it crossed a site', async () => {
    expect((await send('POST', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await send('POST', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
  });

  it('is refused when the body is not JSON — the one body a cross-site page can send without a preflight', async () => {
    const refused = await send('POST', { 'content-type': 'text/plain' });
    expect(refused.status).toBe(400);
    expect(refused.code).toBe('invalid_input');
    expect((await send('POST', { 'content-type': 'application/x-www-form-urlencoded' }, 'urgency=green')).status).toBe(400);
  });
});

describe('a write from this site', () => {
  it('passes with the headers a same-origin browser request carries', async () => {
    const origin = new URL(baseUrl).origin;
    expect((await send('POST', { origin, 'sec-fetch-site': 'same-origin' })).status).toBe(201);
    // A typed URL or a bookmark.
    expect((await send('POST', { origin, 'sec-fetch-site': 'none' })).status).toBe(201);
    // `charset` after the type is still JSON.
    expect((await send('POST', { origin, 'content-type': 'application/json; charset=utf-8' })).status).toBe(201);
  });

  it('leaves reads alone: a GET is not a state change, whoever asks for it', async () => {
    expect((await send('GET', { origin: 'https://other-site.indepthwebsolutions.com' }, null)).status).toBe(200);
    expect((await send('GET', { 'sec-fetch-site': 'cross-site' }, null)).status).toBe(200);
  });
});
