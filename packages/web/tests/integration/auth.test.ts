import { afterAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  AUTH_SESSION_PATH,
  ROLE,
  SESSION_COOKIE_NAME,
  isApiErrorBody,
  type SessionPayload,
} from '@thp/shared';
import { hashSessionToken } from '@/server/auth/session';
import {
  closeTestDatabase,
  createAccount,
  signIn,
  signedInAccount,
  testDatabase,
} from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');
const api = (path: string) => `${baseUrl}${API_PREFIX}${path}`;
const sessionUrl = api(AUTH_SESSION_PATH);

afterAll(async () => {
  await closeTestDatabase();
});

async function errorBody(response: Response): Promise<{ code: string; message: string }> {
  const body: unknown = await response.json();
  if (!isApiErrorBody(body)) throw new Error(`expected an error envelope, got ${JSON.stringify(body)}`);
  return { code: body.error.code, message: body.error.message };
}

describe('signing in', () => {
  it('establishes a session and returns an HTTP-only cookie', async () => {
    const account = await createAccount(databaseUrl, ROLE.member, 'signin');
    const result = await signIn(baseUrl, account.email, account.password);

    expect(result.status).toBe(201);
    expect(result.setCookie).toBeTruthy();
    const setCookie = result.setCookie ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite');
    expect(setCookie).toContain('Path=/');
    // The suite runs the production build; Secure is on everywhere but `next dev`.
    expect(setCookie).toContain('Secure');

    const payload = result.body as SessionPayload;
    expect(payload.user.email).toBe(account.email);
    expect(payload.user.id).toBe(account.id);
  });

  it('puts nothing about the user in the cookie value', async () => {
    const { account, cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'opaque');
    const value = cookie.slice(cookie.indexOf('=') + 1);

    expect(value).not.toContain(account.id);
    expect(value).not.toContain(account.email);
    expect(value).not.toContain(ROLE.member);
    expect(decodeURIComponent(value)).not.toContain(account.id);
    expect(decodeURIComponent(value)).not.toContain(account.email);
  });

  it('normalises the address, so the case it was typed in does not matter', async () => {
    const account = await createAccount(databaseUrl, ROLE.member, 'case');
    const shouted = await signIn(baseUrl, account.email.toUpperCase(), account.password);

    expect(shouted.status).toBe(201);
    expect((shouted.body as SessionPayload).user.email).toBe(account.email.toLowerCase());
  });

  it('answers identically for a wrong password, an unknown address and a malformed body', async () => {
    const account = await createAccount(databaseUrl, ROLE.member, 'identical');

    const attempts = await Promise.all([
      fetch(sessionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: account.email, password: 'not the password' }),
      }),
      fetch(sessionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody-at-all@example.test', password: 'anything at all' }),
      }),
      fetch(sessionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 42 }),
      }),
    ]);

    const bodies = await Promise.all(attempts.map(errorBody));
    expect(new Set(attempts.map((response) => response.status))).toEqual(new Set([401]));
    expect(new Set(bodies.map((body) => body.code))).toEqual(new Set(['invalid_credentials']));
    expect(new Set(bodies.map((body) => body.message)).size).toBe(1);
    // Nothing in the answer hints at which of the three it was.
    for (const body of bodies) {
      expect(body.message.toLowerCase()).not.toContain('unknown');
      expect(body.message.toLowerCase()).not.toContain('exist');
      expect(body.message).not.toContain(account.email);
    }
    expect(attempts.every((response) => response.headers.get('set-cookie') === null)).toBe(true);
  });

  it('never writes the submitted password to the log', async () => {
    const offset = logOffset(logPath);
    const password = 'zebra-quinine-lantern-9931';
    const account = await createAccount(databaseUrl, ROLE.member, 'logsafe', password);

    await signIn(baseUrl, account.email, password);
    await signIn(baseUrl, account.email, `${password}-wrong`);

    const lines = await waitForLogLines(logPath, offset, (candidates) =>
      candidates.some((line) => line.message === 'signin.refused'),
    );

    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(password);
  });
});

describe('a session authenticates the requests that follow it', () => {
  it('lets the cookie through to a route that requires a session', async () => {
    const { account, cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'follow');

    const response = await fetch(sessionUrl, { headers: { cookie } });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as SessionPayload;
    expect(payload.user.id).toBe(account.id);
  });

  it('refuses the same route without a cookie', async () => {
    const response = await fetch(sessionUrl);
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe('unauthenticated');
  });

  it('refuses a tampered cookie cleanly, not with a 500', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'tamper');
    const mutated = `${cookie.slice(0, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`;

    for (const value of [mutated, `${SESSION_COOKIE_NAME}=forged`, `${SESSION_COOKIE_NAME}=%%%`]) {
      const response = await fetch(sessionUrl, { headers: { cookie: value } });
      expect(response.status, value).toBe(401);
      expect((await errorBody(response)).code, value).toBe('unauthenticated');
    }
  });

  it('stores the hash of the token, never the token', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'hashed');
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const { sql } = testDatabase(databaseUrl);

    const byRawToken = await sql<{ id: string }[]>`
      select id from session where token_hash = ${token}
    `;
    expect(byRawToken).toEqual([]);

    const byHash = await sql<{ id: string; token_hash: string }[]>`
      select id, token_hash from session where token_hash = ${hashSessionToken(token)}
    `;
    expect(byHash).toHaveLength(1);
    expect(byHash[0]?.token_hash).not.toBe(token);
  });

  it('reads role and account state per request rather than trusting the cookie', async () => {
    const { account, cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'rolechange');
    const adminOnly = api('/diagnostics/admin-only');

    const asMember = await fetch(adminOnly, { headers: { cookie } });
    expect(asMember.status).toBe(403);

    const { sql } = testDatabase(databaseUrl);
    await sql`update "user" set role = 'admin' where id = ${account.id}`;

    // The same cookie, no second sign-in.
    const asAdmin = await fetch(adminOnly, { headers: { cookie } });
    expect(asAdmin.status).toBe(200);
    expect((await asAdmin.json()) as { actorId: string }).toMatchObject({ actorId: account.id });
  });

  it('refuses a session that has been aged past its window', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'expired');
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const { sql } = testDatabase(databaseUrl);

    const before = await fetch(sessionUrl, { headers: { cookie } });
    expect(before.status).toBe(200);

    await sql`
      update session set expires_at = now() - interval '1 minute'
      where token_hash = ${hashSessionToken(token)}
    `;

    const after = await fetch(sessionUrl, { headers: { cookie } });
    expect(after.status).toBe(401);
    expect((await errorBody(after)).code).toBe('unauthenticated');
  });
});

describe('signing out', () => {
  it('ends the session server-side, so replaying the captured cookie is refused', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'signout');

    const signedOut = await fetch(sessionUrl, { method: 'DELETE', headers: { cookie } });
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get('set-cookie')).toContain('Max-Age=0');

    // The very same cookie value, sent again as a browser that ignored the clear would.
    const replayed = await fetch(sessionUrl, { headers: { cookie } });
    expect(replayed.status).toBe(401);
    expect((await errorBody(replayed)).code).toBe('unauthenticated');
  });

  it('marks the record revoked rather than deleting it', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'revoked');
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    await fetch(sessionUrl, { method: 'DELETE', headers: { cookie } });

    const { sql } = testDatabase(databaseUrl);
    const rows = await sql<{ revoked_at: Date | null }[]>`
      select revoked_at from session where token_hash = ${hashSessionToken(token)}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it('cannot be done anonymously', async () => {
    const response = await fetch(sessionUrl, { method: 'DELETE' });
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe('unauthenticated');
  });

  it('leaves one session untouched when another is ended', async () => {
    const account = await createAccount(databaseUrl, ROLE.member, 'twosessions');
    const first = await signIn(baseUrl, account.email, account.password);
    const second = await signIn(baseUrl, account.email, account.password);
    expect(first.cookie).not.toBe(second.cookie);

    await fetch(sessionUrl, { method: 'DELETE', headers: { cookie: first.cookie ?? '' } });

    expect((await fetch(sessionUrl, { headers: { cookie: first.cookie ?? '' } })).status).toBe(401);
    expect((await fetch(sessionUrl, { headers: { cookie: second.cookie ?? '' } })).status).toBe(200);
  });
});
