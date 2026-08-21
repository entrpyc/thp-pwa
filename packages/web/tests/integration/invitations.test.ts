import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  INVITATIONS_ACCEPT_PATH,
  INVITATIONS_PATH,
  MINIMUM_PASSWORD_LENGTH,
  ROLE,
  isApiErrorBody,
  type InvitationListPayload,
  type InvitationPreviewPayload,
  type InvitationSummary,
  type Role,
  type SessionPayload,
} from '@thp/shared';
import {
  closeTestDatabase,
  cookieFromSetCookie,
  createAccount,
  signIn,
  signedInAccount,
} from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';
import {
  linkFromHtml,
  mailOffset,
  readCapturedMail,
  tokenFromMail,
  waitForMail,
} from '../support/mail';

/**
 * Invitations, driven over HTTP against the running server.
 *
 * Nothing here imports a route handler. The properties this file exists to pin — that a member is
 * refused by the API, that a token stops working after a resend, that a send failure leaves the
 * invitation resendable — are all properties of the deployed thing, and importing a handler would
 * prove none of them.
 *
 * There is no admin interface yet ([Step 5] builds it), so the admin half is exercised over the API
 * alone. The invitee half has a screen, and it has its own file.
 */

const baseUrl = inject('apiBaseUrl');
const mailDownBaseUrl = inject('mailDownBaseUrl');
const databaseUrl = inject('databaseUrl');
const mailPath = inject('mailCapturePath');
const logPath = inject('apiLogPath');

const INVITATIONS_URL = `${baseUrl}${API_PREFIX}${INVITATIONS_PATH}`;
const ACCEPT_URL = `${baseUrl}${API_PREFIX}${INVITATIONS_ACCEPT_PATH}`;

/** Long enough for the shipped rule, and obviously not a real password. */
const CHOSEN_PASSWORD = 'chosen-by-the-invitee';

let adminCookie: string;
let memberCookie: string;
let sql: postgres.Sql;

function uniqueEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}@example.test`;
}

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
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
  const body: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    body: body as T,
    setCookie: response.headers.get('set-cookie'),
  };
}

/** Issue an invitation as the admin and hand back both the payload and the token that was mailed. */
async function issue(
  email: string,
  role: Role = ROLE.member,
): Promise<{ invitation: InvitationSummary; token: string }> {
  const offset = mailOffset(mailPath);
  const answer = await call<InvitationSummary>(INVITATIONS_URL, {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ email, role }),
  });
  if (answer.status !== 201) {
    throw new Error(`issuing ${email} answered ${answer.status} / ${answer.code ?? '(no code)'}`);
  }

  const messages = await waitForMail(mailPath, offset, (found) => found.length > 0);
  const message = messages.at(-1);
  if (message === undefined) throw new Error(`no message captured for ${email}`);
  return { invitation: answer.body, token: tokenFromMail(message) };
}

async function accept(token: string, password = CHOSEN_PASSWORD): Promise<Answer<SessionPayload>> {
  return call<SessionPayload>(ACCEPT_URL, {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
}

async function countAccounts(email: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from "user" where lower(email) = ${email.toLowerCase()}
  `;
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

beforeAll(async () => {
  sql = postgres(databaseUrl, { max: 3, onnotice: () => {} });
  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'inviter')).cookie;
  memberCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'invitee-member')).cookie;
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

describe('issuing an invitation', () => {
  it('reports the pending invitation, and carries no token under any key', async () => {
    const email = uniqueEmail('issued');
    const before = Date.now();
    const { invitation, token } = await issue(email);

    expect(invitation.email).toBe(email);
    expect(invitation.status).toBe('pending');
    expect(typeof invitation.expiresAt).toBe('string');

    // Not "has no `token` field" — nothing anywhere in the payload is the token or its digest.
    const serialised = JSON.stringify(invitation);
    expect(serialised).not.toContain(token);
    expect(serialised.toLowerCase()).not.toContain('token');

    // Seven days from issue, within the tolerance of a round trip.
    const window = new Date(invitation.expiresAt).getTime() - before;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(window).toBeGreaterThan(sevenDays - 60_000);
    expect(window).toBeLessThan(sevenDays + 60_000);
  }, 60_000);

  it('sends exactly one message, to the invited address, with a link that works', async () => {
    const email = uniqueEmail('one-message');
    const offset = mailOffset(mailPath);

    const answer = await call<InvitationSummary>(INVITATIONS_URL, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email, role: ROLE.member }),
    });
    expect(answer.status).toBe(201);

    const messages = await waitForMail(mailPath, offset, (found) => found.length > 0);
    const message = messages[0];
    if (message === undefined) throw new Error('no message captured');
    expect(message.to).toBe(email);

    // "Exactly one" needs a second look. Polling returns the moment the first message lands, so a
    // duplicate sent a heartbeat later would go unnoticed by a length check taken right then.
    await new Promise((done) => setTimeout(done, 1_000));
    expect(readCapturedMail(mailPath, offset)).toHaveLength(1);

    // Both parts, and the same link in each — the text part is what a text client reads.
    expect(message.html).toContain('<html');
    expect(message.text.trim().length).toBeGreaterThan(0);
    expect(linkFromHtml(message)).toContain(tokenFromMail(message));

    // And the link's token genuinely accepts.
    const accepted = await accept(tokenFromMail(message));
    expect(accepted.status).toBe(201);
  }, 60_000);

  it('refuses a role this product does not have', async () => {
    const email = uniqueEmail('contributor');
    const answer = await call(INVITATIONS_URL, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email, role: 'contributor' }),
    });
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');

    // Refused *before* a row exists — counting accounts would prove nothing here, since issuing
    // never creates one.
    const rows = await sql`select id from invitation where lower(email) = ${email}`;
    expect(rows).toHaveLength(0);
  });

  it('refuses an address that already has an account, with its own code', async () => {
    const existing = await createAccount(databaseUrl, ROLE.member, 'already-here');
    const answer = await call(INVITATIONS_URL, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: existing.email, role: ROLE.member }),
    });
    expect(answer.code).toBe('email_taken');
    expect(answer.code).not.toBe('invitation_exists');

    const rows = await sql<{ count: string }[]>`
      select count(*)::text as count from invitation where lower(email) = ${existing.email.toLowerCase()}
    `;
    expect(rows[0]?.count).toBe('0');
  }, 60_000);

  it('refuses a second live invitation, and points at resend', async () => {
    const email = uniqueEmail('twice');
    await issue(email);

    const answer = await call(INVITATIONS_URL, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email, role: ROLE.member }),
    });
    expect(answer.code).toBe('invitation_exists');
  }, 60_000);
});

describe('a member is refused by the API, on every invitation route', () => {
  it('cannot issue, list, revoke or resend', async () => {
    const email = uniqueEmail('member-refused');
    const { invitation } = await issue(email);

    const attempts = [
      call(INVITATIONS_URL, {
        method: 'POST',
        cookie: memberCookie,
        body: JSON.stringify({ email: uniqueEmail('by-member'), role: ROLE.member }),
      }),
      call(INVITATIONS_URL, { method: 'GET', cookie: memberCookie }),
      call(`${INVITATIONS_URL}/${invitation.id}`, { method: 'DELETE', cookie: memberCookie }),
      call(`${INVITATIONS_URL}/${invitation.id}/resend`, { method: 'POST', cookie: memberCookie }),
    ];

    for (const answer of await Promise.all(attempts)) {
      expect(answer.code).toBe('forbidden');
      expect(answer.status).toBe(403);
    }

    // And the invitation is untouched by any of it.
    const rows = await sql<{ revoked_at: Date | null }[]>`
      select revoked_at from invitation where id = ${invitation.id}
    `;
    expect(rows[0]?.revoked_at).toBeNull();
  }, 60_000);
});

describe('previewing a token', () => {
  it('answers anonymously with the invited address and role, and nothing else', async () => {
    const email = uniqueEmail('preview');
    const { token } = await issue(email, ROLE.member);

    const answer = await call<InvitationPreviewPayload>(
      `${ACCEPT_URL}?token=${encodeURIComponent(token)}`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.email).toBe(email);
    // Exactly two keys. No id, no expiry, no inviter, and nothing about an account.
    expect(Object.keys(answer.body).sort()).toEqual(['email', 'role']);
  }, 60_000);

  it.each([
    ['an unknown token', 'this-token-was-never-issued'],
    ['a malformed token', '%%%not-base64url%%%'],
    ['an empty token', ''],
  ])('refuses %s cleanly rather than throwing', async (_label, token) => {
    const answer = await call(`${ACCEPT_URL}?token=${encodeURIComponent(token)}`);
    expect(answer.status).not.toBe(500);
    expect(answer.code).toBe('invitation_invalid');
  });

  it('refuses with no token parameter at all', async () => {
    const answer = await call(ACCEPT_URL);
    expect(answer.status).not.toBe(500);
    expect(answer.code).toBe('invitation_invalid');
  });
});

describe('accepting an invitation', () => {
  it('creates the account and returns a session in the same response', async () => {
    const email = uniqueEmail('accepts');
    const { token } = await issue(email);

    const answer = await accept(token);
    expect(answer.status).toBe(201);
    expect(answer.body.user.email).toBe(email);
    expect(answer.setCookie).not.toBeNull();

    // The cookie works with no separate sign-in — the whole point of accepting signing you in.
    const cookie = cookieFromSetCookie(answer.setCookie ?? '');
    const session = await call<SessionPayload>(`${baseUrl}${API_PREFIX}/auth/session`, { cookie });
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe(email);
  }, 60_000);

  it('gives the account the role the invitation carried, not one the caller chose', async () => {
    const email = uniqueEmail('as-admin');
    const { token } = await issue(email, ROLE.admin);
    const answer = await accept(token);
    expect(answer.status).toBe(201);

    // Read from the database rather than from the payload, so this is about the account and not
    // about what the response said.
    const rows = await sql<{ role: string }[]>`
      select role::text as role from "user" where lower(email) = ${email}
    `;
    expect(rows[0]?.role).toBe(ROLE.admin);
  }, 60_000);

  it('sets a password that actually verifies, and marks the invitation accepted', async () => {
    const email = uniqueEmail('verifies');
    const { invitation, token } = await issue(email);
    await accept(token);

    const fresh = await signIn(baseUrl, email, CHOSEN_PASSWORD);
    expect(fresh.status).toBe(201);
    expect(fresh.cookie).not.toBeNull();

    const rows = await sql<{ accepted_at: Date | null }[]>`
      select accepted_at from invitation where id = ${invitation.id}
    `;
    expect(rows[0]?.accepted_at).not.toBeNull();
  }, 60_000);

  it('cannot be accepted twice, and leaves exactly one account behind', async () => {
    const email = uniqueEmail('replay');
    const { token } = await issue(email);

    expect((await accept(token)).status).toBe(201);
    const replayed = await accept(token);
    expect(replayed.status).not.toBe(201);
    expect(replayed.code).toBe('invitation_invalid');
    expect(await countAccounts(email)).toBe(1);
  }, 60_000);

  it('refuses an expired token with a code distinct from an invalid one', async () => {
    const email = uniqueEmail('aged');
    const { invitation, token } = await issue(email);

    // Age it past its window in the database rather than waiting seven days.
    await sql`update invitation set expires_at = now() - interval '1 hour' where id = ${invitation.id}`;

    const answer = await accept(token);
    expect(answer.code).toBe('invitation_expired');
    expect(answer.code).not.toBe('invitation_invalid');
    expect(await countAccounts(email)).toBe(0);

    // The preview says the same thing, which is what lets the screen say "expired" up front.
    const preview = await call(`${ACCEPT_URL}?token=${encodeURIComponent(token)}`);
    expect(preview.code).toBe('invitation_expired');
  }, 60_000);

  it('refuses a revoked token', async () => {
    const email = uniqueEmail('revoked');
    const { invitation, token } = await issue(email);

    const revoked = await call<InvitationSummary>(`${INVITATIONS_URL}/${invitation.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');

    const answer = await accept(token);
    expect(answer.code).toBe('invitation_invalid');
    expect(await countAccounts(email)).toBe(0);
  }, 60_000);

  it.each([
    ['an unknown token', 'this-token-was-never-issued'],
    ['a malformed token', '%%%not-base64url%%%'],
    ['an empty token', ''],
  ])('refuses %s cleanly rather than throwing', async (_label, token) => {
    const answer = await accept(token);
    expect(answer.status).not.toBe(500);
    expect(answer.code).toBe('invitation_invalid');
  });

  it('refuses a body that is not an object at all', async () => {
    const answer = await call(ACCEPT_URL, { method: 'POST', body: '"just a string"' });
    expect(answer.status).not.toBe(500);
    expect(answer.code).toBe('invitation_invalid');
  });

  it('refuses a password below the shipped minimum, and creates no account', async () => {
    const email = uniqueEmail('weak');
    const { token } = await issue(email);

    const answer = await accept(token, 'x'.repeat(MINIMUM_PASSWORD_LENGTH - 1));
    expect(answer.code).toBe('weak_password');
    expect(await countAccounts(email)).toBe(0);

    // And the invitation is still usable, so a bad first guess is not fatal.
    expect((await accept(token)).status).toBe(201);
  }, 60_000);

  it('refuses when the address has gained an account since the invitation was issued', async () => {
    const email = uniqueEmail('overtaken');
    const { token } = await issue(email);

    // The address gains an account by another route between issue and accept.
    await sql`
      insert into "user" (email, password_hash, display_name, role)
      values (${email}, 'not-a-real-hash', 'Overtaken', ${ROLE.member}::user_role)
    `;

    const answer = await accept(token);
    expect(answer.code).toBe('email_taken');
    expect(await countAccounts(email)).toBe(1);
  }, 60_000);
});

describe('revoking and resending', () => {
  it('resend issues a fresh token, kills the old one, and moves the window forward', async () => {
    const email = uniqueEmail('resent');
    const first = await issue(email);

    const offset = mailOffset(mailPath);
    const answer = await call<InvitationSummary>(
      `${INVITATIONS_URL}/${first.invitation.id}/resend`,
      { method: 'POST', cookie: adminCookie },
    );
    expect(answer.status).toBe(201);

    const messages = await waitForMail(mailPath, offset, (found) => found.length > 0);
    const second = messages.at(-1);
    if (second === undefined) throw new Error('resend captured no message');
    const secondToken = tokenFromMail(second);

    expect(secondToken).not.toBe(first.token);
    expect(new Date(answer.body.expiresAt).getTime()).toBeGreaterThan(
      new Date(first.invitation.expiresAt).getTime(),
    );

    // The old link is dead; the new one works.
    expect((await accept(first.token)).code).toBe('invitation_invalid');
    expect((await accept(secondToken)).status).toBe(201);
  }, 90_000);

  it('refuses to revoke or resend an invitation that has been accepted', async () => {
    const email = uniqueEmail('settled');
    const { invitation, token } = await issue(email);
    expect((await accept(token)).status).toBe(201);

    const revoked = await call(`${INVITATIONS_URL}/${invitation.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    const resent = await call(`${INVITATIONS_URL}/${invitation.id}/resend`, {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(revoked.code).toBe('invitation_invalid');
    expect(resent.code).toBe('invitation_invalid');

    // Unchanged: still accepted, still not revoked.
    const rows = await sql<{ revoked_at: Date | null; accepted_at: Date | null }[]>`
      select revoked_at, accepted_at from invitation where id = ${invitation.id}
    `;
    expect(rows[0]?.revoked_at).toBeNull();
    expect(rows[0]?.accepted_at).not.toBeNull();
  }, 90_000);

  it('refuses to revoke an invitation that is already revoked', async () => {
    const email = uniqueEmail('twice-revoked');
    const { invitation } = await issue(email);
    expect(
      (await call(`${INVITATIONS_URL}/${invitation.id}`, { method: 'DELETE', cookie: adminCookie }))
        .status,
    ).toBe(200);
    expect(
      (await call(`${INVITATIONS_URL}/${invitation.id}`, { method: 'DELETE', cookie: adminCookie }))
        .code,
    ).toBe('invitation_invalid');
  }, 60_000);

  it('answers not_found for an id that does not exist', async () => {
    const answer = await call(`${INVITATIONS_URL}/9f1b0c2e-0000-4000-8000-000000000000`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(answer.code).toBe('not_found');
  });
});

describe('listing', () => {
  it('shows pending, expired, revoked and accepted, and carries no tokens', async () => {
    const pending = await issue(uniqueEmail('list-pending'));
    const expired = await issue(uniqueEmail('list-expired'));
    const revoked = await issue(uniqueEmail('list-revoked'));
    const accepted = await issue(uniqueEmail('list-accepted'));

    await sql`update invitation set expires_at = now() - interval '1 hour' where id = ${expired.invitation.id}`;
    await call(`${INVITATIONS_URL}/${revoked.invitation.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect((await accept(accepted.token)).status).toBe(201);

    const answer = await call<InvitationListPayload>(INVITATIONS_URL, { cookie: adminCookie });
    expect(answer.status).toBe(200);

    const byId = new Map(answer.body.invitations.map((row) => [row.id, row]));
    expect(byId.get(pending.invitation.id)?.status).toBe('pending');
    expect(byId.get(expired.invitation.id)?.status).toBe('expired');
    expect(byId.get(revoked.invitation.id)?.status).toBe('revoked');
    expect(byId.get(accepted.invitation.id)?.status).toBe('accepted');

    const serialised = JSON.stringify(answer.body);
    for (const token of [pending.token, expired.token, revoked.token, accepted.token]) {
      expect(serialised).not.toContain(token);
    }
  }, 120_000);
});

describe('a send failure leaves the invitation in place', () => {
  it('reports a retryable failure, keeps the row, and a resend then succeeds', async () => {
    const email = uniqueEmail('mail-down');

    // The `mail-down` server shares the primary's database and refuses every message.
    const answer = await call(`${mailDownBaseUrl}${API_PREFIX}${INVITATIONS_PATH}`, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email, role: ROLE.member }),
    });
    expect(answer.status).toBe(503);
    expect(answer.code).toBe('service_unavailable');

    // The row survived the failure — losing it would lose an intent the admin already expressed.
    const rows = await sql<{ id: string; accepted_at: Date | null; revoked_at: Date | null }[]>`
      select id, accepted_at, revoked_at from invitation where lower(email) = ${email}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accepted_at).toBeNull();
    expect(rows[0]?.revoked_at).toBeNull();

    // And resending through a working server delivers, which is what "retryable" has to mean.
    const offset = mailOffset(mailPath);
    const resent = await call<InvitationSummary>(`${INVITATIONS_URL}/${rows[0]?.id}/resend`, {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(resent.status).toBe(201);

    const messages = await waitForMail(mailPath, offset, (found) => found.length > 0);
    const message = messages.at(-1);
    if (message === undefined) throw new Error('resend after a failure captured no message');
    expect(message.to).toBe(email);
    expect((await accept(tokenFromMail(message))).status).toBe(201);
  }, 90_000);
});

describe('what the log says, and what it never says', () => {
  it('logs every transition with actor, action, target and correlation id', async () => {
    const email = uniqueEmail('logged');
    const correlationId = `invitation-log-${Date.now().toString(36)}`;
    const offset = logOffset(logPath);
    const mailFrom = mailOffset(mailPath);

    const issued = await call<InvitationSummary>(INVITATIONS_URL, {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'x-correlation-id': correlationId },
      body: JSON.stringify({ email, role: ROLE.member }),
    });
    expect(issued.status).toBe(201);

    const messages = await waitForMail(mailPath, mailFrom, (found) => found.length > 0);
    const message = messages.at(-1);
    if (message === undefined) throw new Error('no message captured');

    const resent = await call<InvitationSummary>(`${INVITATIONS_URL}/${issued.body.id}/resend`, {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'x-correlation-id': correlationId },
    });
    expect(resent.status).toBe(201);

    const secondMessages = await waitForMail(mailPath, mailFrom, (found) => found.length > 1);
    const second = secondMessages.at(-1);
    if (second === undefined) throw new Error('no resent message captured');

    await accept(tokenFromMail(second));

    const revokedTarget = await issue(uniqueEmail('logged-revoke'));
    await call(`${INVITATIONS_URL}/${revokedTarget.invitation.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'x-correlation-id': correlationId },
    });

    const lines = await waitForLogLines(logPath, offset, (found) =>
      ['invitation.issue', 'invitation.resend', 'invitation.accept', 'invitation.revoke'].every(
        (message_) => found.some((line) => line.message === message_),
      ),
    );

    for (const action of [
      'invitation.issue',
      'invitation.resend',
      'invitation.accept',
      'invitation.revoke',
    ]) {
      const line = lines.find((candidate) => candidate.message === action);
      expect(line, `no log line for ${action}`).toBeDefined();
      expect(line?.action).toBe(action);
      expect(typeof line?.actorId).toBe('string');
      expect(typeof line?.target).toBe('string');
      expect(typeof line?.correlationId).toBe('string');
      expect(typeof line?.time).toBe('string');
    }

    // The correlation id we sent is the one the issue and revoke lines carry, so one search
    // returns the whole story rather than four unrelated lines.
    expect(
      lines.filter((line) => line.correlationId === correlationId).length,
    ).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('never puts a raw token in the log, across the whole issue → accept path', async () => {
    const email = uniqueEmail('no-token-in-log');
    const offset = logOffset(logPath);
    const mailFrom = mailOffset(mailPath);

    const issued = await call<InvitationSummary>(INVITATIONS_URL, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email, role: ROLE.member }),
    });
    expect(issued.status).toBe(201);

    const messages = await waitForMail(mailPath, mailFrom, (found) => found.length > 0);
    const message = messages.at(-1);
    if (message === undefined) throw new Error('no message captured');
    const token = tokenFromMail(message);

    // Preview (token in the query string), then accept (token in the body).
    await call(`${ACCEPT_URL}?token=${encodeURIComponent(token)}`);
    const accepted = await accept(token);
    expect(accepted.status).toBe(201);

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some((line) => line.message === 'invitation.accept'),
    );
    expect(lines.length).toBeGreaterThan(0);

    // The whole captured slice, serialised — not a per-field check that a new field could dodge.
    expect(JSON.stringify(lines)).not.toContain(token);
    // And the raw bytes too, not only the lines that parsed as ours: the token travels in a query
    // string, and a framework that decided to log request URLs would put it somewhere the
    // structured reader never looks.
    expect(readFileSync(logPath).subarray(offset).toString('utf8')).not.toContain(token);
    // Nor the digest, which is just as good as the token for looking a row up.
    expect(JSON.stringify(lines)).not.toContain('token_hash');

    // And no error message the caller saw carried it either.
    const refused = await accept(token);
    expect(JSON.stringify(refused.body)).not.toContain(token);
  }, 90_000);
});
