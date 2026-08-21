import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  AUTH_SESSION_PATH,
  MINIMUM_PASSWORD_LENGTH,
  PASSWORD_RESET_COMPLETE_PATH,
  PASSWORD_RESET_PATH,
  ROLE,
  isApiErrorBody,
  type PasswordResetPreviewPayload,
  type SessionPayload,
} from '@thp/shared';
import {
  closeTestDatabase,
  cookieFromSetCookie,
  createAccount,
  signIn,
  signedInAccount,
  testDatabase,
  type TestAccount,
} from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';
import { mailOffset, readCapturedMail, waitForMail, type CapturedMail } from '../support/mail';

/**
 * Password reset, driven over HTTP against the running server.
 *
 * Two properties shape almost every assertion in this file, and neither can be checked by importing
 * a function:
 *
 * 1. **The request route answers one payload for every outcome.** Several tests below compare
 *    *byte-equal* responses across a real address, an unknown one, a deactivated account and a
 *    malformed string — because "indistinguishable" is a claim about the whole answer, not about
 *    the status line.
 * 2. **A live session issued before the reset does not survive it.** That needs real cookies against
 *    a real server, which is the whole reason sessions are server-side rows.
 */

const baseUrl = inject('apiBaseUrl');
const mailDownBaseUrl = inject('mailDownBaseUrl');
const databaseUrl = inject('databaseUrl');
const mailPath = inject('mailCapturePath');
const logPath = inject('apiLogPath');

const REQUEST_URL = `${baseUrl}${API_PREFIX}${PASSWORD_RESET_PATH}`;
const COMPLETE_URL = `${baseUrl}${API_PREFIX}${PASSWORD_RESET_COMPLETE_PATH}`;
const SESSION_URL = `${baseUrl}${API_PREFIX}${AUTH_SESSION_PATH}`;

/** Long enough for the shipped rule, and obviously not a real password. */
const NEW_PASSWORD = 'chosen-after-the-reset';

let sql: postgres.Sql;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
  readonly rawBody: string;
  readonly setCookie: string | null;
}

async function call<T>(url: string, init: RequestInit & { cookie?: string } = {}): Promise<Answer<T>> {
  const { cookie, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...rest.headers,
    },
  });
  const rawBody = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    body = undefined;
  }
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    body: body as T,
    rawBody,
    setCookie: response.headers.get('set-cookie'),
  };
}

/** Ask for a reset, exactly as the forgot-password screen does. */
async function requestReset(
  email: string,
  origin = baseUrl,
): Promise<Answer<{ requested: true }>> {
  return call(`${origin}${API_PREFIX}${PASSWORD_RESET_PATH}`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/** The token out of a captured reset message, taken from the plain-text part. */
function resetTokenFrom(message: CapturedMail): string {
  const link = /https?:\/\/\S+/.exec(message.text)?.[0];
  if (link === undefined) throw new Error('the plain-text part carries no link');
  const token = new URL(link).searchParams.get('token');
  if (token === null || token === '') throw new Error(`no token in ${link}`);
  return token;
}

/** Ask for a reset and hand back the token that was mailed. */
async function requestAndCapture(email: string): Promise<string> {
  const offset = mailOffset(mailPath);
  const answer = await requestReset(email);
  if (answer.status !== 200) throw new Error(`requesting for ${email} answered ${answer.status}`);
  const messages = await waitForMail(mailPath, offset, (found) => found.length > 0);
  const message = messages.at(-1);
  if (message === undefined) throw new Error(`no reset message captured for ${email}`);
  return resetTokenFrom(message);
}

async function complete(token: string, password = NEW_PASSWORD): Promise<Answer<SessionPayload>> {
  return call<SessionPayload>(COMPLETE_URL, {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
}

/**
 * An account with a fresh address every time.
 *
 * The re-send interval is sixty seconds and this suite makes many requests, so every test that
 * requests a reset uses an account nobody else has touched — otherwise one test's request would
 * silently suppress the next one's message.
 */
async function anAccount(label: string): Promise<TestAccount> {
  return createAccount(databaseUrl, ROLE.member, `reset-${label}`);
}

beforeAll(async () => {
  sql = postgres(databaseUrl, { max: 3, onnotice: () => {} });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

describe('requesting a reset', () => {
  it('sends exactly one message, to that address, with a link that completes', async () => {
    const account = await anAccount('one-message');
    const offset = mailOffset(mailPath);
    const before = Date.now();

    const answer = await requestReset(account.email);
    expect(answer.status).toBe(200);

    const messages = await waitForMail(mailPath, offset, (found) => found.length > 0);
    const message = messages[0];
    if (message === undefined) throw new Error('no message captured');
    expect(message.to).toBe(account.email);

    // "Exactly one" needs a second look. Polling returns the moment the first message lands, so a
    // duplicate sent a heartbeat later would go unnoticed by a length check taken right then.
    await new Promise((done) => setTimeout(done, 1_000));
    expect(readCapturedMail(mailPath, offset)).toHaveLength(1);

    const token = resetTokenFrom(message);
    expect((await complete(token)).status).toBe(200);

    // One hour from the request, within the tolerance of a round trip.
    const rows = await sql<{ expires_at: Date }[]>`
      select expires_at from password_reset where user_id = ${account.id}
    `;
    const window = (rows[0]?.expires_at.getTime() ?? 0) - before;
    expect(window).toBeGreaterThan(60 * 60 * 1000 - 60_000);
    expect(window).toBeLessThan(60 * 60 * 1000 + 60_000);
  }, 90_000);

  it('answers a real address, an unknown one, a deactivated account and rubbish identically', async () => {
    const real = await anAccount('uniform-real');
    const deactivated = await anAccount('uniform-dead');
    await sql`update "user" set deactivated_at = now() where id = ${deactivated.id}`;

    const mustNotSend = mailOffset(mailPath);

    // The real one is asked last so the three that must not send share a clean capture window,
    // and asked at all so the comparison is against a genuine success rather than four failures.
    const unknown = await requestReset(`nobody-${Date.now().toString(36)}@example.test`);
    const dead = await requestReset(deactivated.email);
    const rubbish = await requestReset('not an email at all');

    // Give the servers a moment: a message sent by any of the three would land after the response.
    await new Promise((done) => setTimeout(done, 1_000));
    expect(readCapturedMail(mailPath, mustNotSend)).toHaveLength(0);

    const genuineFrom = mailOffset(mailPath);
    const genuine = await requestReset(real.email);

    // The success case must genuinely have succeeded, otherwise the comparison below is four
    // failures agreeing with each other.
    const sent = await waitForMail(mailPath, genuineFrom, (found) => found.length > 0);
    expect(sent.at(-1)?.to).toBe(real.email);

    // Byte-equal, not merely same-status. A payload that differed by a field would be the
    // enumeration oracle this route exists to avoid.
    for (const other of [unknown, dead, rubbish]) {
      expect(other.status).toBe(genuine.status);
      expect(other.rawBody).toBe(genuine.rawBody);
      expect(other.setCookie).toBe(genuine.setCookie);
    }
    // And the payload says nothing that could be read as an outcome.
    expect(genuine.rawBody).not.toMatch(/sent|found|unknown|exists/i);
  }, 90_000);

  it('revokes the outstanding link when a second is issued, so exactly one works', async () => {
    const account = await anAccount('replaced');
    const first = await requestAndCapture(account.email);

    // Past the re-send interval, without waiting a minute for it.
    await sql`
      update password_reset set created_at = now() - interval '5 minutes'
      where user_id = ${account.id} and used_at is null and revoked_at is null
    `;
    const second = await requestAndCapture(account.email);
    expect(second).not.toBe(first);

    expect((await complete(first)).code).toBe('reset_invalid');
    expect((await complete(second)).status).toBe(200);
  }, 120_000);

  it('sends no second message inside the re-send interval, and answers the same either way', async () => {
    const account = await anAccount('interval');
    const offset = mailOffset(mailPath);

    const first = await requestReset(account.email);
    await waitForMail(mailPath, offset, (found) => found.length > 0);
    const second = await requestReset(account.email);

    expect(second.rawBody).toBe(first.rawBody);
    expect(second.status).toBe(first.status);

    await new Promise((done) => setTimeout(done, 1_000));
    expect(readCapturedMail(mailPath, offset)).toHaveLength(1);

    // And the first link is still the live one — a suppressed second request must not have quietly
    // revoked it.
    const token = resetTokenFrom(readCapturedMail(mailPath, offset)[0] as CapturedMail);
    expect((await complete(token)).status).toBe(200);
  }, 90_000);

  it('answers indistinguishably when the transport fails, and leaves no usable token', async () => {
    const account = await anAccount('mail-down');

    // The `mail-down` server shares the primary's database and refuses every message.
    const refused = await requestReset(account.email, mailDownBaseUrl);
    const working = await requestReset(
      `nobody-${Date.now().toString(36)}@example.test`,
    );
    expect(refused.status).toBe(working.status);
    expect(refused.rawBody).toBe(working.rawBody);
    expect(refused.status).not.toBe(503);

    // Nothing usable was left behind: no live reset holds the account's one slot, so a later
    // request is not made to wait out the re-send interval for a token nobody received.
    const live = await sql<{ count: string }[]>`
      select count(*)::text as count from password_reset
      where user_id = ${account.id} and used_at is null and revoked_at is null
    `;
    expect(live[0]?.count).toBe('0');

    const token = await requestAndCapture(account.email);
    expect((await complete(token)).status).toBe(200);
  }, 120_000);

  it('stores the hash of the token, never the token', async () => {
    const account = await anAccount('hashed');
    const token = await requestAndCapture(account.email);

    const byRawToken = await sql<{ id: string }[]>`
      select id from password_reset where token_hash = ${token}
    `;
    expect(byRawToken).toEqual([]);

    const stored = await sql<{ token_hash: string }[]>`
      select token_hash from password_reset where user_id = ${account.id}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).not.toBe(token);
  }, 90_000);
});

describe('previewing a reset token', () => {
  it('answers anonymously with the address it was mailed to, and nothing else', async () => {
    const account = await anAccount('preview');
    const token = await requestAndCapture(account.email);

    const answer = await call<PasswordResetPreviewPayload>(
      `${REQUEST_URL}?token=${encodeURIComponent(token)}`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.email).toBe(account.email);
    // Exactly one key. No id, no role, no display name, nothing about the account at all.
    expect(Object.keys(answer.body)).toEqual(['email']);
    expect(answer.rawBody).not.toContain(account.id);
    expect(answer.rawBody).not.toContain(ROLE.member);
  }, 90_000);

  it.each([
    ['an unknown token', 'this-token-was-never-issued'],
    ['a malformed token', '%%%not-base64url%%%'],
    ['an empty token', ''],
  ])('refuses %s cleanly rather than throwing', async (_label, token) => {
    const answer = await call(`${REQUEST_URL}?token=${encodeURIComponent(token)}`);
    expect(answer.status).not.toBe(500);
    expect(answer.code).toBe('reset_invalid');
  });

  it('refuses with no token parameter at all', async () => {
    const answer = await call(REQUEST_URL);
    expect(answer.status).not.toBe(500);
    expect(answer.code).toBe('reset_invalid');
  });
});

describe('completing a reset', () => {
  it('changes the password and returns a session in the same response', async () => {
    const account = await anAccount('completes');
    const token = await requestAndCapture(account.email);

    const answer = await complete(token);
    expect(answer.status).toBe(200);
    expect(answer.body.user.email).toBe(account.email);
    expect(answer.setCookie).not.toBeNull();

    // The cookie works with no separate sign-in — the whole point of finishing rather than
    // starting again.
    const cookie = cookieFromSetCookie(answer.setCookie ?? '');
    const session = await call<SessionPayload>(SESSION_URL, { cookie });
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe(account.email);
  }, 90_000);

  it('makes the old password stop working and the new one start', async () => {
    const account = await anAccount('swapped');
    const token = await requestAndCapture(account.email);
    expect((await complete(token)).status).toBe(200);

    const withOld = await signIn(baseUrl, account.email, account.password);
    expect(withOld.status).toBe(401);
    expect(withOld.cookie).toBeNull();

    const withNew = await signIn(baseUrl, account.email, NEW_PASSWORD);
    expect(withNew.status).toBe(201);
    expect(withNew.cookie).not.toBeNull();
  }, 90_000);

  it('revokes every other live session for the account', async () => {
    const account = await anAccount('sessions');
    const first = await signIn(baseUrl, account.email, account.password);
    const second = await signIn(baseUrl, account.email, account.password);
    expect(first.cookie).not.toBe(second.cookie);
    // Both are live before the reset, so their refusal afterwards is about the reset.
    expect((await call(SESSION_URL, { cookie: first.cookie ?? '' })).status).toBe(200);
    expect((await call(SESSION_URL, { cookie: second.cookie ?? '' })).status).toBe(200);

    // Reset from a third context entirely — a different browser, as somebody who has just realised
    // their password is known would.
    const token = await requestAndCapture(account.email);
    const reset = await complete(token);
    expect(reset.status).toBe(200);

    expect((await call(SESSION_URL, { cookie: first.cookie ?? '' })).status).toBe(401);
    expect((await call(SESSION_URL, { cookie: second.cookie ?? '' })).status).toBe(401);

    // And the session the reset itself issued is alive — nobody is signed out of the browser they
    // are standing in.
    const fresh = cookieFromSetCookie(reset.setCookie ?? '');
    expect((await call(SESSION_URL, { cookie: fresh })).status).toBe(200);
  }, 120_000);

  it('cannot be used twice, and the password stays as the first reset left it', async () => {
    const account = await anAccount('replay');
    const token = await requestAndCapture(account.email);
    expect((await complete(token)).status).toBe(200);

    const replayed = await complete(token, 'a-completely-different-password');
    expect(replayed.status).not.toBe(200);
    expect(replayed.code).toBe('reset_invalid');

    // The second attempt changed nothing.
    expect((await signIn(baseUrl, account.email, NEW_PASSWORD)).status).toBe(201);
    expect((await signIn(baseUrl, account.email, 'a-completely-different-password')).status).toBe(
      401,
    );
  }, 120_000);

  it('refuses an expired token with a code distinct from an invalid one', async () => {
    const account = await anAccount('aged');
    const token = await requestAndCapture(account.email);
    await sql`
      update password_reset set expires_at = now() - interval '1 minute'
      where user_id = ${account.id}
    `;

    const answer = await complete(token);
    expect(answer.code).toBe('reset_expired');
    expect(answer.code).not.toBe('reset_invalid');

    // The preview says the same thing, which is what lets the screen say "expired" up front.
    expect((await call(`${REQUEST_URL}?token=${encodeURIComponent(token)}`)).code).toBe(
      'reset_expired',
    );
    // And the password is untouched.
    expect((await signIn(baseUrl, account.email, account.password)).status).toBe(201);
  }, 90_000);

  it('refuses a revoked token', async () => {
    const account = await anAccount('revoked');
    const token = await requestAndCapture(account.email);
    await sql`update password_reset set revoked_at = now() where user_id = ${account.id}`;

    const answer = await complete(token);
    expect(answer.code).toBe('reset_invalid');
    expect((await signIn(baseUrl, account.email, account.password)).status).toBe(201);
  }, 90_000);

  it.each([
    ['an unknown token', 'this-token-was-never-issued'],
    ['a malformed token', '%%%not-base64url%%%'],
    ['an empty token', ''],
  ])('refuses %s cleanly rather than throwing', async (_label, token) => {
    const answer = await complete(token);
    expect(answer.status).not.toBe(500);
    expect(answer.code).toBe('reset_invalid');
  });

  it('refuses a body that is not an object at all', async () => {
    const answer = await call(COMPLETE_URL, { method: 'POST', body: '"just a string"' });
    expect(answer.status).not.toBe(500);
    expect(answer.code).toBe('reset_invalid');
  });

  it('refuses a password below the shipped rules and leaves the old one working', async () => {
    const account = await anAccount('weak');
    const token = await requestAndCapture(account.email);

    const answer = await complete(token, 'x'.repeat(MINIMUM_PASSWORD_LENGTH - 1));
    expect(answer.code).toBe('weak_password');
    expect((await signIn(baseUrl, account.email, account.password)).status).toBe(201);

    // And the link still works, so a bad first guess is not fatal.
    expect((await complete(token)).status).toBe(200);
  }, 120_000);

  it('refuses when the account was deactivated between the request and the completion', async () => {
    const account = await anAccount('deactivated-midway');
    const token = await requestAndCapture(account.email);

    await sql`update "user" set deactivated_at = now() where id = ${account.id}`;

    const answer = await complete(token);
    expect(answer.status).not.toBe(200);
    expect(answer.setCookie).toBeNull();

    // No session was issued, and the password was not changed.
    const sessions = await sql<{ count: string }[]>`
      select count(*)::text as count from session where user_id = ${account.id}
    `;
    expect(sessions[0]?.count).toBe('0');
    await sql`update "user" set deactivated_at = null where id = ${account.id}`;
    expect((await signIn(baseUrl, account.email, account.password)).status).toBe(201);
  }, 90_000);

  it('reads the same password rules the accept screen and the seed command read', async () => {
    // Not "all three refuse" — the *same sentence*, for the same input. Three paths that disagree
    // about what a usable password is would be three rules however carefully each was written.
    const tooShort = 'x'.repeat(MINIMUM_PASSWORD_LENGTH - 1);

    // 1. Reset.
    const account = await anAccount('same-rules');
    const token = await requestAndCapture(account.email);
    const fromReset = (await complete(token, tooShort)).body as unknown;
    expect(isApiErrorBody(fromReset) && fromReset.error.code).toBe('weak_password');

    // 2. Invitation accept. Issued and accepted over HTTP, exactly as an invitee would.
    const adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'rules-admin'))
      .cookie;
    const invitedEmail = `rules-invitee-${Date.now().toString(36)}@example.test`;
    const inviteFrom = mailOffset(mailPath);
    const issued = await call(`${baseUrl}${API_PREFIX}/invitations`, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: invitedEmail, role: ROLE.member }),
    });
    expect(issued.status).toBe(201);
    const invitation = (await waitForMail(mailPath, inviteFrom, (found) => found.length > 0)).at(-1);
    if (invitation === undefined) throw new Error('no invitation captured');
    const fromAccept = (
      await call(`${baseUrl}${API_PREFIX}/invitations/accept`, {
        method: 'POST',
        body: JSON.stringify({ token: resetTokenFrom(invitation), password: tooShort }),
      })
    ).body as unknown;

    // 3. The seed command, which reports its refusal to a terminal rather than over the wire.
    const { seedAdmin } = await import('@/server/auth/seed-admin');
    // Given the suite's own database handle rather than the ambient one: this refusal happens
    // before any query, but a command that reached for `process.env` from a test process would be
    // writing to the developer's database rather than the throwaway.
    const seeded = await seedAdmin(
      { email: 'rules-seed@example.test', displayName: 'Rules Seed', password: tooShort },
      testDatabase(databaseUrl),
    );

    const resetMessage = isApiErrorBody(fromReset) ? fromReset.error.message : '(no message)';
    const acceptMessage = isApiErrorBody(fromAccept) ? fromAccept.error.message : '(no message)';
    expect(acceptMessage).toBe(resetMessage);
    expect(seeded.status).toBe('refused');
    expect(seeded.status === 'refused' ? seeded.reason : '').toContain(resetMessage);
  }, 120_000);
});

describe('what the log says, and what it never says', () => {
  it('logs the request and the completion with actor, action, target and correlation id', async () => {
    const account = await anAccount('logged');
    const correlationId = `reset-log-${Date.now().toString(36)}`;
    const offset = logOffset(logPath);
    const mailFrom = mailOffset(mailPath);

    const requested = await call(REQUEST_URL, {
      method: 'POST',
      headers: { 'x-correlation-id': correlationId },
      body: JSON.stringify({ email: account.email }),
    });
    expect(requested.status).toBe(200);

    const messages = await waitForMail(mailPath, mailFrom, (found) => found.length > 0);
    const message = messages.at(-1);
    if (message === undefined) throw new Error('no message captured');

    const completed = await call(COMPLETE_URL, {
      method: 'POST',
      headers: { 'x-correlation-id': correlationId },
      body: JSON.stringify({ token: resetTokenFrom(message), password: NEW_PASSWORD }),
    });
    expect(completed.status).toBe(200);

    const lines = await waitForLogLines(logPath, offset, (found) =>
      ['password-reset.request', 'password-reset.complete'].every((name) =>
        found.some((line) => line.message === name),
      ),
    );

    for (const action of ['password-reset.request', 'password-reset.complete']) {
      const line = lines.find((candidate) => candidate.message === action);
      expect(line, `no log line for ${action}`).toBeDefined();
      expect(line?.['action']).toBe(action);
      expect(line?.['actorId']).toBe(account.id);
      expect(line?.['target']).toBe(`account:${account.id}`);
      expect(typeof line?.correlationId).toBe('string');
      expect(Number.isNaN(Date.parse(String(line?.time)))).toBe(false);
    }

    expect(
      lines.filter((line) => line.correlationId === correlationId).length,
    ).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('never puts a raw reset token in the log, across the whole request → complete path', async () => {
    const account = await anAccount('no-token-in-log');
    const offset = logOffset(logPath);
    const mailFrom = mailOffset(mailPath);

    await requestReset(account.email);
    const messages = await waitForMail(mailPath, mailFrom, (found) => found.length > 0);
    const message = messages.at(-1);
    if (message === undefined) throw new Error('no message captured');
    const token = resetTokenFrom(message);

    // Preview (token in the query string), then complete (token in the body).
    await call(`${REQUEST_URL}?token=${encodeURIComponent(token)}`);
    const completed = await complete(token);
    expect(completed.status).toBe(200);

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some((line) => line.message === 'password-reset.complete'),
    );
    expect(lines.length).toBeGreaterThan(0);

    expect(JSON.stringify(lines)).not.toContain(token);
    // The raw bytes too, not only the lines that parsed as ours: the token travels in a query
    // string, and a framework that decided to log request URLs would put it somewhere the
    // structured reader never looks.
    expect(readFileSync(logPath).subarray(offset).toString('utf8')).not.toContain(token);
    // Nor the digest, which is just as good as the token for looking a row up.
    expect(JSON.stringify(lines)).not.toContain('token_hash');

    // And no error message the caller saw carried it either.
    const refused = await complete(token);
    expect(refused.rawBody).not.toContain(token);
  }, 120_000);
});
