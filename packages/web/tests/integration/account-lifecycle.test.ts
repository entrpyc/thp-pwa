import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  AUTH_SESSION_PATH,
  MAX_DISPLAY_NAME_LENGTH,
  ROLE,
  USERS_PATH,
  isApiErrorBody,
  type AccountListPayload,
  type AccountSummary,
  type Role,
  type SessionPayload,
} from '@thp/shared';
import { hashSessionToken } from '@/server/auth/session';
import {
  closeTestDatabase,
  createAccount,
  signIn,
  signedInAccount,
  type TestAccount,
} from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';
import { mailOffset, waitForMail } from '../support/mail';

/**
 * Deactivation, reactivation, role change, the last-admin guard and profile editing — driven over
 * HTTP against the running server.
 *
 * **There is no interface for any of this yet** (docs/epics/epic-core-listening/implementation-plan.md § Ticket 5 builds it),
 * which is not a gap in this file: docs/project/prd.md 3.1.11 says the invariant is enforced in the API, so
 * every assertion here is deliberately a direct request. A greyed-out button would satisfy none of
 * them.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');
const mailPath = inject('mailCapturePath');

const USERS_URL = `${baseUrl}${API_PREFIX}${USERS_PATH}`;
const SESSION_URL = `${baseUrl}${API_PREFIX}${AUTH_SESSION_PATH}`;

let sql: postgres.Sql;
let adminCookie: string;
let admin: TestAccount;
let memberCookie: string;
let member: TestAccount;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly body: T;
  readonly rawBody: string;
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
    message: isApiErrorBody(body) ? body.error.message : null,
    body: body as T,
    rawBody,
  };
}

const deactivate = (id: string, cookie: string) =>
  call<AccountSummary>(`${USERS_URL}/${id}/deactivate`, { method: 'POST', cookie });

const reactivate = (id: string, cookie: string) =>
  call<AccountSummary>(`${USERS_URL}/${id}/reactivate`, { method: 'POST', cookie });

const setRole = (id: string, role: Role, cookie: string) =>
  call<AccountSummary>(`${USERS_URL}/${id}`, {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ role }),
  });

const rename = (id: string, displayName: string, cookie: string) =>
  call<AccountSummary>(`${USERS_URL}/${id}`, {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ displayName }),
  });

async function roleOf(id: string): Promise<string | undefined> {
  const rows = await sql<{ role: string }[]>`select role::text as role from "user" where id = ${id}`;
  return rows[0]?.role;
}

async function isActive(id: string): Promise<boolean> {
  const rows = await sql<{ deactivated_at: Date | null }[]>`
    select deactivated_at from "user" where id = ${id}
  `;
  return rows[0]?.deactivated_at === null;
}

beforeAll(async () => {
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
  const asAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'lifecycle-admin');
  admin = asAdmin.account;
  adminCookie = asAdmin.cookie;
  const asMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'lifecycle-member');
  member = asMember.account;
  memberCookie = asMember.cookie;
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

describe('deactivating an account', () => {
  it('is refused to a member on every account route, including their own', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'member-cannot');

    const attempts = await Promise.all([
      deactivate(target.id, memberCookie),
      deactivate(member.id, memberCookie),
      reactivate(target.id, memberCookie),
      setRole(target.id, ROLE.admin, memberCookie),
      setRole(member.id, ROLE.admin, memberCookie),
      call(USERS_URL, { cookie: memberCookie }),
    ]);

    for (const answer of attempts) {
      expect(answer.code).toBe('forbidden');
      expect(answer.status).toBe(403);
    }
    expect(await isActive(target.id)).toBe(true);
    expect(await roleOf(target.id)).toBe(ROLE.member);
  }, 60_000);

  it('stops the account signing in, with a code distinct from a wrong password', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'cannot-signin');
    expect((await deactivate(target.id, adminCookie)).status).toBe(200);

    const rightPassword = await call(SESSION_URL, {
      method: 'POST',
      body: JSON.stringify({ email: target.email, password: target.password }),
    });
    const wrongPassword = await call(SESSION_URL, {
      method: 'POST',
      body: JSON.stringify({ email: target.email, password: 'not the password at all' }),
    });

    // The distinct code only after the password verifies. A wrong password against a deactivated
    // account is indistinguishable from a wrong password against any other, so nothing here tells
    // an attacker that the address exists.
    expect(rightPassword.code).toBe('account_deactivated');
    expect(wrongPassword.code).toBe('invalid_credentials');
    expect(wrongPassword.code).not.toBe('account_deactivated');
    // And it explains rather than stonewalls.
    expect((rightPassword.message ?? '').toLowerCase()).toContain('admin');
  }, 60_000);

  it('ends every live session immediately, not at the next expiry', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'sessions-end');
    const first = await signIn(baseUrl, target.email, target.password);
    const second = await signIn(baseUrl, target.email, target.password);
    expect((await call(SESSION_URL, { cookie: first.cookie ?? '' })).status).toBe(200);

    expect((await deactivate(target.id, adminCookie)).status).toBe(200);

    expect((await call(SESSION_URL, { cookie: first.cookie ?? '' })).status).toBe(401);
    expect((await call(SESSION_URL, { cookie: second.cookie ?? '' })).status).toBe(401);
  }, 90_000);

  it('refuses a session that survived revocation, because the account is deactivated', async () => {
    // Belt and braces. "No deactivated account acts" must not rest on remembering to revoke, so a
    // session row put back to live by hand — standing in for any route that forgot — still resolves
    // to nobody.
    const target = await createAccount(databaseUrl, ROLE.member, 'survivor');
    const opened = await signIn(baseUrl, target.email, target.password);
    const token = decodeURIComponent((opened.cookie ?? '').slice((opened.cookie ?? '').indexOf('=') + 1));

    expect((await deactivate(target.id, adminCookie)).status).toBe(200);
    await sql`
      update session set revoked_at = null, expires_at = now() + interval '30 days'
      where token_hash = ${hashSessionToken(token)}
    `;

    const live = await sql<{ revoked_at: Date | null }[]>`
      select revoked_at from session where token_hash = ${hashSessionToken(token)}
    `;
    expect(live[0]?.revoked_at, 'the row must genuinely be live for this to prove anything').toBeNull();

    const response = await call(SESSION_URL, { cookie: opened.cookie ?? '' });
    expect(response.status).toBe(401);
    expect(response.code).toBe('unauthenticated');
  }, 90_000);

  it('cannot be invited back in, cannot accept a standing invitation, and gets no reset', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'no-other-way-in');
    expect((await deactivate(target.id, adminCookie)).status).toBe(200);

    // Inviting the address is refused because it already has an account — deactivated or not, it
    // is taken, and an invitation would create a second one.
    const invited = await call(`${baseUrl}${API_PREFIX}/invitations`, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: target.email, role: ROLE.member }),
    });
    expect(invited.code).toBe('email_taken');

    // And an invitation issued *before* the account existed cannot be used to walk around the
    // deactivation either — the one route by which a deactivated address could otherwise get a
    // fresh, working account.
    const standing = `standing-${Date.now().toString(36)}@example.test`;
    const invitationOffset = mailOffset(mailPath);
    expect(
      (
        await call(`${baseUrl}${API_PREFIX}/invitations`, {
          method: 'POST',
          cookie: adminCookie,
          body: JSON.stringify({ email: standing, role: ROLE.member }),
        })
      ).status,
    ).toBe(201);
    const message = (await waitForMail(mailPath, invitationOffset, (found) => found.length > 0)).at(
      -1,
    );
    if (message === undefined) throw new Error('no invitation captured');
    const link = /https?:\/\/\S+/.exec(message.text)?.[0] ?? '';
    const token = new URL(link).searchParams.get('token') ?? '';

    // The address gains a deactivated account between the invitation and the acceptance.
    await sql`
      insert into "user" (email, password_hash, display_name, role, deactivated_at)
      values (${standing}, 'not-a-real-hash', 'Standing', 'member', now())
    `;

    const accepted = await call(`${baseUrl}${API_PREFIX}/invitations/accept`, {
      method: 'POST',
      body: JSON.stringify({ token, password: 'chosen-for-the-standing-invite' }),
    });
    expect(accepted.status).not.toBe(201);
    expect(accepted.code).toBe('email_taken');
    const accounts = await sql<{ count: string }[]>`
      select count(*)::text as count from "user" where lower(email) = ${standing}
    `;
    expect(accounts[0]?.count).toBe('1');

    // And a reset answers the uniform payload while sending nothing, which the reset suite pins
    // against a capture file; here it is enough that no reset row was written for it.
    await call(`${baseUrl}${API_PREFIX}/auth/password-reset`, {
      method: 'POST',
      body: JSON.stringify({ email: target.email }),
    });
    const resets = await sql<{ count: string }[]>`
      select count(*)::text as count from password_reset where user_id = ${target.id}
    `;
    expect(resets[0]?.count).toBe('0');
  }, 90_000);

  it('is a conflict, not a silent success, when the account is already deactivated', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'twice-off');
    expect((await deactivate(target.id, adminCookie)).status).toBe(200);

    const again = await deactivate(target.id, adminCookie);
    expect(again.status).toBe(409);
    expect(again.code).toBe('account_state_conflict');
  }, 60_000);

  it('answers not_found for an id that does not exist', async () => {
    const answer = await deactivate('9f1b0c2e-0000-4000-8000-000000000000', adminCookie);
    expect(answer.code).toBe('not_found');
  });
});

describe('reactivating an account', () => {
  it('restores it, and it signs in again with the password it already had', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'restored');
    expect((await deactivate(target.id, adminCookie)).status).toBe(200);
    expect((await signIn(baseUrl, target.email, target.password)).status).toBe(403);

    const restored = await reactivate(target.id, adminCookie);
    expect(restored.status).toBe(200);
    expect(restored.body.active).toBe(true);
    expect(restored.body.deactivatedAt).toBeNull();

    const back = await signIn(baseUrl, target.email, target.password);
    expect(back.status).toBe(201);
    expect(back.cookie).not.toBeNull();
  }, 90_000);

  it('is a conflict, not a silent success, when the account is already active', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'twice-on');
    const answer = await reactivate(target.id, adminCookie);
    expect(answer.status).toBe(409);
    expect(answer.code).toBe('account_state_conflict');
  }, 60_000);
});

describe('changing a role', () => {
  it('takes effect on the account’s next request, with no re-sign-in', async () => {
    // This is what ticket 2's per-request re-read bought, asserted rather than assumed.
    const target = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'promoted');
    const adminOnly = `${baseUrl}${API_PREFIX}/diagnostics/admin-only`;
    expect((await call(adminOnly, { cookie: target.cookie })).status).toBe(403);

    const promoted = await setRole(target.account.id, ROLE.admin, adminCookie);
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe(ROLE.admin);

    // The same cookie. No second sign-in.
    expect((await call(adminOnly, { cookie: target.cookie })).status).toBe(200);
  }, 90_000);

  it('refuses a role this product does not have, and changes nothing', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'contributor');
    const answer = await call(`${USERS_URL}/${target.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ role: 'contributor' }),
    });
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');
    expect(await roleOf(target.id)).toBe(ROLE.member);
  }, 60_000);

  it('reports the current state rather than failing when the role is already that', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'idempotent');
    const first = await setRole(target.id, ROLE.admin, adminCookie);
    expect(first.status).toBe(200);

    const again = await setRole(target.id, ROLE.admin, adminCookie);
    expect(again.status).toBe(200);
    expect(again.body.role).toBe(ROLE.admin);
    expect(again.code).toBeNull();
  }, 60_000);

  it('refuses a body carrying neither a role nor a display name', async () => {
    const answer = await call(`${USERS_URL}/${member.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({}),
    });
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');
  });
});

/**
 * The last-admin guard.
 *
 * Every account in this block is created inside the block, and the fixture admins from `beforeAll`
 * are deliberately not used: the invariant is about *how many active admins exist in the database*,
 * so a test that leaned on a shared admin would be asserting against whatever else the suite had
 * done that second.
 */
describe('the last-admin guard', () => {
  /** Take the database down to exactly the admins this test wants, and put it back afterwards. */
  async function withOnlyTheseAdmins<T>(keep: readonly string[], body: () => Promise<T>): Promise<T> {
    const others = await sql<{ id: string }[]>`
      select id from "user"
      where role = 'admin' and deactivated_at is null and id <> all(${sql.array([...keep])}::uuid[])
    `;
    const ids = others.map((row) => row.id);
    if (ids.length > 0) {
      await sql`update "user" set deactivated_at = now() where id = any(${sql.array(ids)}::uuid[])`;
    }
    try {
      return await body();
    } finally {
      if (ids.length > 0) {
        await sql`update "user" set deactivated_at = null where id = any(${sql.array(ids)}::uuid[])`;
      }
    }
  }

  it('refuses to deactivate the only active admin, and leaves it active', async () => {
    const only = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'only-admin');
    await withOnlyTheseAdmins([only.account.id], async () => {
      const answer = await deactivate(only.account.id, only.cookie);
      expect(answer.status).toBe(409);
      expect(answer.code).toBe('last_admin');
      // The message names the invariant, so an operator reads a guardrail rather than a bug.
      expect((answer.message ?? '').toLowerCase()).toContain('admin');
      expect(await isActive(only.account.id)).toBe(true);
    });
  }, 120_000);

  it('refuses to demote the only active admin, and leaves the role unchanged', async () => {
    const only = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'only-admin-demote');
    await withOnlyTheseAdmins([only.account.id], async () => {
      const answer = await setRole(only.account.id, ROLE.member, only.cookie);
      expect(answer.status).toBe(409);
      expect(answer.code).toBe('last_admin');
      expect(await roleOf(only.account.id)).toBe(ROLE.admin);
    });
  }, 120_000);

  it('stops the last admin doing it to themselves — the interface is not what refuses', async () => {
    const only = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'self-harm');
    await withOnlyTheseAdmins([only.account.id], async () => {
      // Their own session, their own id, straight at the API.
      expect((await deactivate(only.account.id, only.cookie)).code).toBe('last_admin');
      expect((await setRole(only.account.id, ROLE.member, only.cookie)).code).toBe('last_admin');
      expect(await isActive(only.account.id)).toBe(true);
      expect(await roleOf(only.account.id)).toBe(ROLE.admin);
    });
  }, 120_000);

  it('does not count a deactivated admin toward the invariant', async () => {
    const first = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'counted-one');
    const second = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'counted-two');

    await withOnlyTheseAdmins([first.account.id, second.account.id], async () => {
      // Two active admins, so the first may go.
      expect((await deactivate(first.account.id, second.cookie)).status).toBe(200);

      // And now the second is the last one, because a deactivated admin is not an admin who can
      // administer anything.
      expect((await deactivate(second.account.id, second.cookie)).code).toBe('last_admin');
      expect((await setRole(second.account.id, ROLE.member, second.cookie)).code).toBe('last_admin');
      expect(await isActive(second.account.id)).toBe(true);

      await sql`update "user" set deactivated_at = null where id = ${first.account.id}`;
    });
  }, 150_000);

  it('permits the operation while another active admin exists', async () => {
    // The guard must not be a blanket refusal — a rule that never lets anything through is
    // indistinguishable from a broken route.
    const keeper = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'keeper');
    const goer = await createAccount(databaseUrl, ROLE.admin, 'goer');
    const demoted = await createAccount(databaseUrl, ROLE.admin, 'demoted');

    await withOnlyTheseAdmins([keeper.account.id, goer.id, demoted.id], async () => {
      expect((await deactivate(goer.id, keeper.cookie)).status).toBe(200);
      expect((await setRole(demoted.id, ROLE.member, keeper.cookie)).status).toBe(200);
      expect(await isActive(goer.id)).toBe(false);
      expect(await roleOf(demoted.id)).toBe(ROLE.member);
      expect(await isActive(keeper.account.id)).toBe(true);
    });
  }, 150_000);

  it('lets exactly one of two simultaneous demotions through', async () => {
    // The reason the guard is a conditional write rather than a count followed by an update. Read
    // then write has a window in which two admins demote each other and both succeed, and this
    // invariant has no way back once broken: nobody left can promote anybody.
    const one = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'race-one');
    const two = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'race-two');

    await withOnlyTheseAdmins([one.account.id, two.account.id], async () => {
      const [first, second] = await Promise.all([
        setRole(one.account.id, ROLE.member, one.cookie),
        setRole(two.account.id, ROLE.member, two.cookie),
      ]);

      const succeeded = [first, second].filter((answer) => answer.status === 200);
      const refused = [first, second].filter((answer) => answer.code === 'last_admin');
      expect(succeeded).toHaveLength(1);
      expect(refused).toHaveLength(1);

      const remaining = await sql<{ count: string }[]>`
        select count(*)::text as count from "user"
        where role = 'admin' and deactivated_at is null
      `;
      expect(remaining[0]?.count).toBe('1');

      // Put the demoted one back so the fixture's own admins are unaffected by this test.
      await sql`update "user" set role = 'admin' where id in (${one.account.id}, ${two.account.id})`;
    });
  }, 180_000);

  it('logs a refused deactivation with actor, action and target', async () => {
    const only = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'logged-refusal');
    await withOnlyTheseAdmins([only.account.id], async () => {
      const offset = logOffset(logPath);
      const correlationId = `last-admin-${Date.now().toString(36)}`;

      const answer = await call(`${USERS_URL}/${only.account.id}/deactivate`, {
        method: 'POST',
        cookie: only.cookie,
        headers: { 'x-correlation-id': correlationId },
      });
      expect(answer.code).toBe('last_admin');

      const lines = await waitForLogLines(logPath, offset, (found) =>
        found.some(
          (line) => line.message === 'account.refused' && line.correlationId === correlationId,
        ),
      );
      const refusal = lines.find((line) => line.message === 'account.refused');
      expect(refusal?.['actorId']).toBe(only.account.id);
      expect(refusal?.['action']).toBe('account.deactivate');
      expect(refusal?.['target']).toBe(`account:${only.account.id}`);
      expect(refusal?.['reason']).toBe('last-active-admin');
      expect(Number.isNaN(Date.parse(String(refusal?.time)))).toBe(false);
    });
  }, 120_000);
});

describe('editing a display name', () => {
  it('changes your own, and the new name is in the session payload next request', async () => {
    const person = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'renames-self');

    const renamed = await rename(person.account.id, 'Ada Lovelace', person.cookie);
    expect(renamed.status).toBe(200);
    expect(renamed.body.displayName).toBe('Ada Lovelace');

    const session = await call<SessionPayload>(SESSION_URL, { cookie: person.cookie });
    expect(session.body.user.displayName).toBe('Ada Lovelace');
  }, 90_000);

  it('is refused on somebody else’s account — to a member and to an admin alike', async () => {
    const person = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'renamed-by-others');

    const byMember = await rename(person.account.id, 'Renamed By A Member', memberCookie);
    const byAdmin = await rename(person.account.id, 'Renamed By An Admin', adminCookie);

    for (const answer of [byMember, byAdmin]) {
      expect(answer.status).toBe(403);
      expect(answer.code).toBe('forbidden');
    }

    const rows = await sql<{ display_name: string }[]>`
      select display_name from "user" where id = ${person.account.id}
    `;
    expect(rows[0]?.display_name).toBe(person.account.displayName);
  }, 90_000);

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['over the ceiling', 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)],
  ])('refuses a name that is %s, and leaves the stored one alone', async (_label, name) => {
    const person = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'bad-name');
    const answer = await rename(person.account.id, name, person.cookie);

    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');
    const rows = await sql<{ display_name: string }[]>`
      select display_name from "user" where id = ${person.account.id}
    `;
    expect(rows[0]?.display_name).toBe(person.account.displayName);
  }, 90_000);

  it('stores the name as typed apart from trimming', async () => {
    const person = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'as-typed');
    const name = '  Ada  Byron  King — Comtesse de Lovelace 王小明  ';

    const renamed = await rename(person.account.id, name, person.cookie);
    expect(renamed.status).toBe(200);
    // Trimmed at the ends, and untouched everywhere else: internal spacing, punctuation and
    // non-ASCII characters survive, because a name is not an identifier.
    expect(renamed.body.displayName).toBe(name.trim());
  }, 90_000);
});

describe('the account listing', () => {
  it('shows both roles and both states to an admin', async () => {
    const active = await createAccount(databaseUrl, ROLE.member, 'listed-active');
    const off = await createAccount(databaseUrl, ROLE.member, 'listed-off');
    const otherAdmin = await createAccount(databaseUrl, ROLE.admin, 'listed-admin');
    expect((await deactivate(off.id, adminCookie)).status).toBe(200);

    const answer = await call<AccountListPayload>(USERS_URL, { cookie: adminCookie });
    expect(answer.status).toBe(200);

    const byId = new Map(answer.body.accounts.map((row) => [row.id, row]));
    expect(byId.get(active.id)?.active).toBe(true);
    expect(byId.get(active.id)?.role).toBe(ROLE.member);
    expect(byId.get(off.id)?.active).toBe(false);
    expect(byId.get(off.id)?.deactivatedAt).not.toBeNull();
    expect(byId.get(otherAdmin.id)?.role).toBe(ROLE.admin);
    expect(byId.get(admin.id)?.email).toBe(admin.email);
  }, 90_000);

  it('carries no password hash and no token of any kind', async () => {
    const answer = await call<AccountListPayload>(USERS_URL, { cookie: adminCookie });
    expect(answer.body.accounts.length).toBeGreaterThan(3);

    // Every key of every row, so a field added later has to be named here before it can ship.
    const keys = new Set(answer.body.accounts.flatMap((row) => Object.keys(row)));
    expect([...keys].sort()).toEqual([
      'active',
      'createdAt',
      'deactivatedAt',
      'displayName',
      'email',
      'id',
      'role',
    ]);

    // And not the values either, however they were named. Checked against what is actually in the
    // database rather than against a pattern — a substring check for "token" fires on an address
    // that happens to contain the word, and proves nothing about what was disclosed.
    const secrets = await sql<{ secret: string }[]>`
      select password_hash as secret from "user"
      union all select token_hash from session
      union all select token_hash from invitation
      union all select token_hash from password_reset
    `;
    expect(secrets.length).toBeGreaterThan(3);
    for (const { secret } of secrets) {
      expect(answer.rawBody, 'the listing disclosed a stored secret').not.toContain(secret);
    }
  }, 60_000);
});

describe('what the log says about the lifecycle', () => {
  it('logs deactivation and reactivation with actor, action, target and timestamp', async () => {
    const target = await createAccount(databaseUrl, ROLE.member, 'logged-lifecycle');
    const correlationId = `lifecycle-${Date.now().toString(36)}`;
    const offset = logOffset(logPath);

    await call(`${USERS_URL}/${target.id}/deactivate`, {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'x-correlation-id': correlationId },
    });
    await call(`${USERS_URL}/${target.id}/reactivate`, {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'x-correlation-id': correlationId },
    });
    await call(`${USERS_URL}/${target.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'x-correlation-id': correlationId },
      body: JSON.stringify({ role: ROLE.admin }),
    });

    const lines = await waitForLogLines(logPath, offset, (found) =>
      ['account.deactivate', 'account.reactivate', 'role.assign'].every((name) =>
        found.some((line) => line.message === name),
      ),
    );

    for (const action of ['account.deactivate', 'account.reactivate', 'role.assign']) {
      const line = lines.find((candidate) => candidate.message === action);
      expect(line, `no log line for ${action}`).toBeDefined();
      expect(line?.['action']).toBe(action);
      expect(line?.['actorId']).toBe(admin.id);
      expect(line?.['target']).toBe(`account:${target.id}`);
      expect(Number.isNaN(Date.parse(String(line?.time)))).toBe(false);
    }

    expect(
      lines.filter((line) => line.correlationId === correlationId).length,
    ).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
