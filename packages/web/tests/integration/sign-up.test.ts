import { afterAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  AUTH_SESSION_PATH,
  INVITATIONS_PATH,
  MINIMUM_PASSWORD_LENGTH,
  ROLE,
  SIGN_UP_PATH,
  USERS_PATH,
  isApiErrorBody,
  type AccountListPayload,
  type InvitationListPayload,
  type SessionPayload,
} from '@thp/shared';
import {
  closeTestDatabase,
  cookieFromSetCookie,
  signIn,
  signedInAccount,
} from '../support/accounts';

/**
 * Registering, driven over HTTP against the running server (docs/project/prd.md, 3.1.15).
 *
 * The four things this file exists to pin, none of which can be checked by importing a function:
 *
 * 1. **A registrant is a Member**, whatever they put in the request body.
 * 2. **The response carries a working session**, so registering lands somebody inside in one
 *    motion rather than handing them an account and then a sign-in form.
 * 3. **The account an admin sees is the same kind of account an invitation produces** — it appears
 *    in the member list and its role can be changed there, which is the half of the requirement
 *    that is about the admin rather than about the registrant.
 * 4. **A live invitation to the same address is retired** rather than left pending and doomed.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const SIGN_UP_URL = `${baseUrl}${API_PREFIX}${SIGN_UP_PATH}`;

/** Long enough for the shipped rule, and obviously not a real password. */
const PASSWORD = 'chosen-at-registration';

afterAll(async () => {
  await closeTestDatabase();
});

function freshEmail(label: string): string {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  return `${label}-${suffix}@example.test`;
}

interface Answer {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;
  readonly cookie: string | null;
}

async function register(body: unknown): Promise<Answer> {
  const response = await fetch(SIGN_UP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  const parsed: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code: isApiErrorBody(parsed) ? parsed.error.code : null,
    body: parsed,
    cookie: setCookie === null ? null : cookieFromSetCookie(setCookie),
  };
}

describe('registering an account', () => {
  it('creates the account and returns a session in the same response', async () => {
    const email = freshEmail('signup');
    const answer = await register({ email, password: PASSWORD });

    expect(answer.status).toBe(201);
    expect(answer.cookie).toBeTruthy();

    const { user } = answer.body as SessionPayload;
    expect(user.email).toBe(email);
    expect(user.displayName.length).toBeGreaterThan(0);

    // The session in that response is a real one: it answers "who am I" without a second sign-in.
    const who = await fetch(`${baseUrl}${API_PREFIX}${AUTH_SESSION_PATH}`, {
      headers: { cookie: answer.cookie ?? '' },
    });
    expect(who.status).toBe(200);
    expect(((await who.json()) as SessionPayload).user.id).toBe(user.id);
  });

  it('assigns Member, and ignores a role the caller puts in the body', async () => {
    const email = freshEmail('roleless');
    // The request shape has no role in it. Sending one anyway must change nothing — this is the
    // assertion that a self-service route is not an admin-console bypass.
    const answer = await register({ email, password: PASSWORD, role: ROLE.admin });

    expect(answer.status).toBe(201);
    expect((answer.body as SessionPayload).user.role).toBe(ROLE.member);

    // And the account really is a member: the admin-only listing refuses it.
    const listing = await fetch(`${baseUrl}${API_PREFIX}${USERS_PATH}`, {
      headers: { cookie: answer.cookie ?? '' },
    });
    expect(listing.status).toBe(403);
  });

  it('signs in afterwards with the password that was chosen', async () => {
    const email = freshEmail('returning');
    await register({ email, password: PASSWORD });

    const result = await signIn(baseUrl, email, PASSWORD);
    expect(result.status).toBe(201);
    expect((result.body as SessionPayload).user.email).toBe(email);
  });

  it('normalises the address, so the case it was typed in does not matter', async () => {
    const email = freshEmail('shouted');
    const answer = await register({ email: email.toUpperCase(), password: PASSWORD });

    expect(answer.status).toBe(201);
    expect((answer.body as SessionPayload).user.email).toBe(email.toLowerCase());

    // And the normalised address is the one that holds the account: registering again in the
    // original casing is refused.
    expect((await register({ email, password: PASSWORD })).code).toBe('email_taken');
  });

  it('refuses a second account for an address that already has one, and says so', async () => {
    const email = freshEmail('twice');
    expect((await register({ email, password: PASSWORD })).status).toBe(201);

    const second = await register({ email, password: 'a-completely-different-one' });
    expect(second.status).toBe(409);
    expect(second.code).toBe('email_taken');
    expect(second.cookie).toBeNull();
  });

  it('creates exactly one account when the same address registers twice at once', async () => {
    const email = freshEmail('race');
    const [first, second] = await Promise.all([
      register({ email, password: PASSWORD }),
      register({ email, password: PASSWORD }),
    ]);

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 409]);
    // Whichever lost, it lost with a sentence rather than with a 500 out of the unique index.
    expect([first.code, second.code]).toContain('email_taken');
  });

  it.each([
    ['a body that is not an object', 'null', 'invalid_input'],
    ['no email', JSON.stringify({ password: PASSWORD }), 'invalid_input'],
    [
      'something that is not an address',
      JSON.stringify({ email: 'not-an-address', password: PASSWORD }),
      'invalid_input',
    ],
    ['no password', JSON.stringify({ email: 'someone@example.test' }), 'weak_password'],
  ])('refuses %s', async (_label, raw, code) => {
    const response = await fetch(SIGN_UP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    const body: unknown = await response.json();
    expect(isApiErrorBody(body) ? body.error.code : null).toBe(code);
  });

  it('applies the same password rule the accept screen prints', async () => {
    const answer = await register({
      email: freshEmail('weak'),
      password: 'x'.repeat(MINIMUM_PASSWORD_LENGTH - 1),
    });

    expect(answer.status).toBe(400);
    expect(answer.code).toBe('weak_password');
    expect(answer.cookie).toBeNull();
  });
});

describe('what an admin can do with a registered account', () => {
  it('lists it beside invited accounts, and can change its role', async () => {
    const email = freshEmail('promotable');
    const registered = await register({ email, password: PASSWORD });
    const { user } = registered.body as SessionPayload;

    const { cookie: adminCookie } = await signedInAccount(
      baseUrl,
      databaseUrl,
      ROLE.admin,
      'signup-admin',
    );

    const listing = await fetch(`${baseUrl}${API_PREFIX}${USERS_PATH}`, {
      headers: { cookie: adminCookie },
    });
    expect(listing.status).toBe(200);
    const { accounts } = (await listing.json()) as AccountListPayload;
    const listed = accounts.find((account) => account.id === user.id);
    expect(listed?.role).toBe(ROLE.member);
    expect(listed?.active).toBe(true);

    const promotion = await fetch(`${baseUrl}${API_PREFIX}${USERS_PATH}/${user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: ROLE.admin }),
    });
    expect(promotion.status).toBe(200);

    // The change takes effect against the registrant's *existing* session, because nothing about
    // the role is in the cookie — the admin-only listing that refused them above now answers.
    const nowPermitted = await fetch(`${baseUrl}${API_PREFIX}${USERS_PATH}`, {
      headers: { cookie: registered.cookie ?? '' },
    });
    expect(nowPermitted.status).toBe(200);
  });

  it('retires an outstanding invitation to the address that registered', async () => {
    const { cookie: adminCookie } = await signedInAccount(
      baseUrl,
      databaseUrl,
      ROLE.admin,
      'signup-inviter',
    );
    const email = freshEmail('invited-then-registered');

    const issued = await fetch(`${baseUrl}${API_PREFIX}${INVITATIONS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ email, role: ROLE.admin }),
    });
    expect(issued.status).toBe(201);

    expect((await register({ email, password: PASSWORD })).status).toBe(201);

    const listing = await fetch(`${baseUrl}${API_PREFIX}${INVITATIONS_PATH}`, {
      headers: { cookie: adminCookie },
    });
    const { invitations } = (await listing.json()) as InvitationListPayload;
    const theirs = invitations.find((invitation) => invitation.email === email);

    // Revoked, not pending: the link can no longer produce an account, and the console says so
    // rather than showing an invitation that would be refused the moment anybody clicked it. The
    // role it carried is deliberately *not* applied — the admin re-assigns it (3.1.5).
    expect(theirs?.status).toBe('revoked');
  });
});
