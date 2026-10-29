import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  ACCOUNT_DELETION_COMPLETE_PATH,
  ACCOUNT_DELETION_PATH,
  API_PREFIX,
  AUTH_SESSION_PATH,
  AVATAR_PATH,
  AVATAR_UPLOADS_PATH,
  DELETION_TOKEN_PARAM,
  INVITATIONS_PATH,
  ME_PATH,
  NOTIFICATIONS_PATH,
  REACTIONS,
  REMOVED_MEMBER_DISPLAY_NAME,
  ROLE,
  USERS_PATH,
  isApiErrorBody,
  notePath,
  notePinPath,
  noteReactionPath,
  recordingNotesPath,
  type AccountDeletedPayload,
  type AccountListPayload,
  type CreateNotePayload,
  type NoteView,
  type NotesPayload,
  type NotificationListPayload,
  type SessionPayload,
  type UploadGrantPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertInvitation,
  insertRecording,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { mediaStore } from '@thp/media';
import {
  closeTestDatabase,
  createAccount,
  signIn,
  signedInAccount,
  type TestAccount,
} from '../support/accounts';
import { readWholeInbox } from '../support/inbox';
import { webpBytes } from '../support/artwork';
import { logOffset, waitForLogLines } from '../support/log-reader';
import { mailOffset, waitForMail, type CapturedMail } from '../support/mail';

/**
 * **A member deletes their own account** (docs/project/prd.md 3.1.8–3.1.11), driven over HTTP
 * against the running server, with the database and the object store read directly afterwards.
 *
 * The convention under test is packages/db/src/README.md, and the assertions follow its table:
 * what cascades is gone, what is set-null survives as "an account since removed", public notes and
 * replies survive under the placeholder with their text, private notes do not survive at all. The
 * two refusals — the wrong password and the last active admin — are checked for what they *leave*,
 * because a deletion that half-happened is the failure this feature cannot afford.
 */

const baseUrl = inject('apiBaseUrl');
const rateLimitedBaseUrl = inject('rateLimitedBaseUrl');
const rateLimitedDeletion = inject('rateLimitedAccountDeletion');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');
const mailPath = inject('mailCapturePath');
const mediaSettings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let sql: postgres.Sql;

interface Signed extends TestAccount {
  readonly cookie: string;
}

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly body: T;
  readonly setCookie: string | null;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown; origin?: string; address?: string } = {},
): Promise<Answer<T>> {
  const response = await fetch(`${init.origin ?? baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
      ...(init.address === undefined ? {} : { 'x-real-ip': init.address }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    message: isApiErrorBody(body) ? body.error.message : null,
    body: body as T,
    setCookie: response.headers.get('set-cookie'),
  };
}

async function signedIn(role: 'admin' | 'member', label: string): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE[role], `${label}-${RUN}`);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

async function recording(title: string): Promise<string> {
  const row = await insertRecording(
    {
      originalMediaKey: `originals/deletion-${title.replace(/\W+/g, '-')}-${RUN}.mp3`,
      title,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function write(
  recordingId: string,
  who: Signed,
  note: { text: string; visibility: 'private' | 'public'; timestampMs?: number; parentId?: string },
): Promise<NoteView> {
  const answer = await call<CreateNotePayload>(recordingNotesPath(recordingId), {
    method: 'POST',
    cookie: who.cookie,
    body: note,
  });
  if (answer.status !== 200) throw new Error(`write refused ${answer.status}: ${answer.code}`);
  return answer.body.note;
}

async function notesSeenBy(recordingId: string, who: Signed): Promise<readonly NoteView[]> {
  const answer = await call<NotesPayload>(recordingNotesPath(recordingId), { cookie: who.cookie });
  if (answer.status !== 200) throw new Error(`read refused ${answer.status}`);
  return answer.body.notes;
}

async function inboxOf(who: Signed): Promise<Pick<NotificationListPayload, 'notifications' | 'unreadCount'>> {
  return readWholeInbox(baseUrl, who.cookie);
}

async function deleteMe(cookie: string, password: string): Promise<Answer<AccountDeletedPayload>> {
  return call<AccountDeletedPayload>(ME_PATH, { method: 'DELETE', cookie, body: { password } });
}

async function userRow(id: string): Promise<{ email: string; deleted_at: Date | null } | null> {
  const rows = await sql<{ email: string; deleted_at: Date | null }[]>`
    select email, deleted_at from "user" where id = ${id}
  `;
  return rows[0] ?? null;
}

async function count(table: string, column: string, id: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n from ${sql(table)} where ${sql(column)} = ${id}
  `;
  return Number(rows[0]?.n ?? '0');
}

async function auditLine(offset: number, actorId: string) {
  const lines = await waitForLogLines(logPath, offset, (found) =>
    found.some((line) => line.message === 'account.delete' && line['actorId'] === actorId),
  );
  return lines.find((line) => line.message === 'account.delete' && line['actorId'] === actorId);
}

/** Upload a real picture for this account and answer the key the row now points at. */
async function giveAvatar(who: Signed): Promise<string> {
  const grant = await call<UploadGrantPayload>(AVATAR_UPLOADS_PATH, {
    method: 'POST',
    cookie: who.cookie,
    body: { filename: 'me.webp', contentType: 'image/webp', size: 4_096 },
  });
  expect(grant.status).toBe(200);
  const put = await fetch(grant.body.url, {
    method: 'PUT',
    headers: { 'content-type': grant.body.contentType },
    body: webpBytes(4_096),
  });
  expect(put.status).toBe(200);
  const set = await call<SessionPayload>(AVATAR_PATH, {
    method: 'PUT',
    cookie: who.cookie,
    body: { key: grant.body.key },
  });
  expect(set.status).toBe(200);
  return grant.body.key;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  // The store the servers write to, so the suite can ask it what is behind a key afterwards.
  Object.assign(process.env, mediaSettings);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('deleting your own account from a session', () => {
  it('keeps public notes and replies under the placeholder, deletes private ones, and ends the session', async () => {
    const [leaver, other] = await Promise.all([signedIn('member', 'leaver'), signedIn('member', 'other')]);
    const where = await recording(`Deletion notes ${RUN}`);

    const publicNote = await write(where, leaver, {
      text: 'A public thought that stays.',
      visibility: 'public',
      timestampMs: 10_000,
    });
    const privateNote = await write(where, leaver, {
      text: 'A private thought that goes.',
      visibility: 'private',
      timestampMs: 20_000,
    });
    const othersNote = await write(where, other, {
      text: 'Somebody else wrote this.',
      visibility: 'public',
      timestampMs: 30_000,
    });
    const leaverReply = await write(where, leaver, { text: 'A reply that stays.', visibility: 'public', parentId: othersNote.id });
    const othersReply = await write(where, other, { text: 'A reply to the leaver.', visibility: 'public', parentId: publicNote.id });

    const logFrom = logOffset(logPath);
    const answer = await deleteMe(leaver.cookie, leaver.password);

    expect(answer.status).toBe(200);
    expect(answer.body.deleted).toBe(true);
    expect(Number.isNaN(Date.parse(answer.body.deletedAt))).toBe(false);
    expect(answer.body.retained).toEqual({ publicNotes: 1, publicReplies: 1 });
    // The cookie is cleared in the same response, and the session behind it is gone.
    expect(answer.setCookie ?? '').toMatch(/Max-Age=0/);
    expect((await call(AUTH_SESSION_PATH, { cookie: leaver.cookie })).status).toBe(401);
    expect((await signIn(baseUrl, leaver.email, leaver.password)).status).toBe(401);

    // The row is gone, and what stands in for it is a placeholder nobody can sign in to.
    expect(await userRow(leaver.id)).toBeNull();
    const seen = await notesSeenBy(where, other);
    const retained = seen.find((one) => one.id === publicNote.id);
    expect(retained?.text).toBe('A public thought that stays.');
    expect(retained?.authorDisplayName).toBe(REMOVED_MEMBER_DISPLAY_NAME);
    expect(retained?.authorAvatarUrl).toBeNull();
    expect(retained?.mine).toBe(false);
    expect(retained?.replies.map((one) => one.id)).toEqual([othersReply.id]);
    const thread = seen.find((one) => one.id === othersNote.id);
    const reply = thread?.replies.find((one) => one.id === leaverReply.id);
    expect(reply?.text).toBe('A reply that stays.');
    expect(reply?.authorDisplayName).toBe(REMOVED_MEMBER_DISPLAY_NAME);
    expect(seen.map((one) => one.id)).not.toContain(privateNote.id);
    expect(await count('note', 'id', privateNote.id)).toBe(0);

    const placeholder = await sql<{ id: string; email: string; deleted_at: Date | null; deactivated_at: Date | null }[]>`
      select u.id, u.email, u.deleted_at, u.deactivated_at from "user" u
      join note n on n.author_id = u.id where n.id = ${publicNote.id}
    `;
    expect(placeholder[0]?.deleted_at).not.toBeNull();
    expect(placeholder[0]?.deactivated_at).not.toBeNull();
    expect(placeholder[0]?.email).toMatch(/@removed\.invalid$/);
    expect(placeholder[0]?.email).not.toContain(leaver.email);

    // The audit line: who removed what, with the counts, and the placeholder it left.
    const line = await auditLine(logFrom, leaver.id);
    expect(line?.['action']).toBe('account.delete');
    expect(line?.['target']).toBe(`account:${leaver.id}`);
    // The address is not on the line: audit lines name the account by id only (security audit, 19).
    expect(line?.['actorEmail']).toBeUndefined();
    expect(line?.['placeholderId']).toBe(placeholder[0]?.id);
    expect(line?.['retainedPublicNotes']).toBe(1);
    expect(line?.['deletedPrivateNotes']).toBe(1);
    expect(line?.['via']).toBe('session');
  }, 120_000);

  it('removes reactions, clears pins of nothing, keeps a pinned public note pinned, and renames notifications', async () => {
    const [leaver, other, admin] = await Promise.all([
      signedIn('member', 'leaver-2'),
      signedIn('member', 'other-2'),
      signedIn('admin', 'admin-2'),
    ]);
    const where = await recording(`Deletion reactions ${RUN}`);
    const marker = `marker-${RUN}`;

    const othersNote = await write(where, other, { text: `Reacted to ${marker}`, visibility: 'public', timestampMs: 5_000 });
    const leaverNote = await write(where, leaver, { text: `Pinned ${marker}`, visibility: 'public', timestampMs: 6_000 });

    // The leaver reacts to and replies to the other member's note, which tells the other member.
    expect((await call(noteReactionPath(othersNote.id), { method: 'PUT', cookie: leaver.cookie, body: { emoji: REACTIONS[0].emoji } })).status).toBe(200);
    await write(where, leaver, { text: `Reply ${marker}`, visibility: 'public', parentId: othersNote.id });
    // The other member reacts to the leaver's note, which tells the leaver; an admin pins it.
    expect((await call(noteReactionPath(leaverNote.id), { method: 'PUT', cookie: other.cookie, body: { emoji: REACTIONS[1].emoji } })).status).toBe(200);
    expect((await call(notePinPath(leaverNote.id), { method: 'PUT', cookie: admin.cookie })).status).toBe(200);

    const before = (await inboxOf(other)).notifications.filter((one) => one.body.includes(marker));
    expect(before.map((one) => one.title)).toEqual(
      expect.arrayContaining([`${leaver.displayName} replied to your note`, `${leaver.displayName} reacted to your note`]),
    );
    expect((await inboxOf(leaver)).notifications.some((one) => one.body.includes(marker))).toBe(true);

    expect((await deleteMe(leaver.cookie, leaver.password)).status).toBe(200);

    // The leaver's reaction is gone; the other member's reaction on the retained note stays.
    const seen = await notesSeenBy(where, other);
    expect(seen.find((one) => one.id === othersNote.id)?.reactions).toEqual([]);
    const kept = seen.find((one) => one.id === leaverNote.id);
    expect(kept?.reactions.map((one) => one.count)).toEqual([1]);
    expect(kept?.pinned).toBe(true);
    expect(kept?.authorDisplayName).toBe(REMOVED_MEMBER_DISPLAY_NAME);

    // The leaver's inbox went with them; the other member's keeps its rows under the placeholder name.
    expect(await count('notification', 'user_id', leaver.id)).toBe(0);
    const after = (await inboxOf(other)).notifications.filter((one) => one.body.includes(marker));
    expect(after).toHaveLength(before.length);
    expect(after.map((one) => one.title).sort()).toEqual(
      [`${REMOVED_MEMBER_DISPLAY_NAME} replied to your note`, `${REMOVED_MEMBER_DISPLAY_NAME} reacted to your note`].sort(),
    );
    expect(JSON.stringify(after)).not.toContain(leaver.displayName);
  }, 120_000);

  it('deletes the avatar object, playback state, onboarding, sessions and invitations, and frees the address', async () => {
    const leaver = await signedIn('member', 'leaver-3');
    const admin = await signedIn('admin', 'admin-3');
    const key = await giveAvatar(leaver);
    expect(await mediaStore().head(key)).not.toBeNull();
    // A second device, signed in too.
    const second = await signIn(baseUrl, leaver.email, leaver.password);
    expect(second.cookie).not.toBeNull();
    // An accepted invitation that once carried the address.
    await insertInvitation(
      { email: leaver.email, role: ROLE.member, tokenHash: `hash-${RUN}-${leaver.id}`, invitedBy: admin.id, expiresAt: new Date() },
      handle,
    );
    await sql`update invitation set accepted_at = now() where lower(email) = ${leaver.email}`;

    expect((await deleteMe(leaver.cookie, leaver.password)).status).toBe(200);

    expect(await mediaStore().head(key)).toBeNull();
    expect(await count('session', 'user_id', leaver.id)).toBe(0);
    expect(await count('user_onboarding', 'user_id', leaver.id)).toBe(0);
    expect(await count('playback_progress', 'user_id', leaver.id)).toBe(0);
    expect((await call(AUTH_SESSION_PATH, { cookie: second.cookie ?? '' })).status).toBe(401);
    const invitations = await sql<{ n: string }[]>`select count(*)::text as n from invitation where lower(email) = ${leaver.email}`;
    expect(Number(invitations[0]?.n)).toBe(0);

    // The address is free again: an admin can invite the same person anew — the invitation route
    // refuses with `email_taken` for as long as an account holds the address, so a `201` here is
    // the proof that nothing does. (Registration is closed, so an invitation is the way back in.)
    const again = await call(INVITATIONS_PATH, {
      method: 'POST',
      cookie: admin.cookie,
      body: { email: leaver.email, role: ROLE.member },
    });
    expect(again.status).toBe(201);
    expect(again.code).not.toBe('email_taken');

    // And the placeholder is not in the member list.
    const list = await call<AccountListPayload>(USERS_PATH, { cookie: admin.cookie });
    expect(list.body.accounts.some((one) => one.displayName === REMOVED_MEMBER_DISPLAY_NAME)).toBe(false);
    expect(list.body.accounts.some((one) => one.id === leaver.id)).toBe(false);
  }, 120_000);
});

describe('what refuses, and what it leaves', () => {
  it('refuses the wrong password with password_incorrect and changes nothing', async () => {
    const leaver = await signedIn('member', 'wrong-password');
    const where = await recording(`Deletion refused ${RUN}`);
    const note = await write(where, leaver, { text: 'Still here.', visibility: 'private', timestampMs: 1_000 });

    const answer = await deleteMe(leaver.cookie, 'not-the-password');
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('password_incorrect');
    expect(answer.setCookie).toBeNull();

    expect(await userRow(leaver.id)).not.toBeNull();
    expect(await count('note', 'id', note.id)).toBe(1);
    expect((await call(AUTH_SESSION_PATH, { cookie: leaver.cookie })).status).toBe(200);
    // A body with no password is a malformed request, not a wrong one.
    expect((await call(ME_PATH, { method: 'DELETE', cookie: leaver.cookie, body: {} })).code).toBe('invalid_input');
  });

  it('refuses the only active admin with last_admin and leaves the account intact', async () => {
    const only = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'only-admin-deletion');
    const others = await sql<{ id: string }[]>`
      select id from "user" where role = 'admin' and deactivated_at is null and id <> ${only.account.id}
    `;
    const ids = others.map((row) => row.id);
    if (ids.length > 0) {
      await sql`update "user" set deactivated_at = now() where id = any(${sql.array(ids)}::uuid[])`;
    }
    try {
      const answer = await deleteMe(only.cookie, only.account.password);
      expect(answer.status).toBe(409);
      expect(answer.code).toBe('last_admin');
      expect((answer.message ?? '').toLowerCase()).toContain('admin');
      expect(await userRow(only.account.id)).not.toBeNull();
      expect((await call(AUTH_SESSION_PATH, { cookie: only.cookie })).status).toBe(200);
    } finally {
      if (ids.length > 0) {
        await sql`update "user" set deactivated_at = null where id = any(${sql.array(ids)}::uuid[])`;
      }
    }
  }, 120_000);

  it('lets an admin go once another active admin exists', async () => {
    const leaving = await signedIn('admin', 'leaving-admin');
    await signedIn('admin', 'staying-admin');
    expect((await deleteMe(leaving.cookie, leaving.password)).status).toBe(200);
    expect(await userRow(leaving.id)).toBeNull();
  });
});

// =================================================================================================

function tokenFrom(message: CapturedMail): string {
  const link = /https?:\/\/\S+/.exec(message.text)?.[0];
  if (link === undefined) throw new Error('the plain-text part carries no link');
  const url = new URL(link);
  expect(url.pathname).toBe('/delete-account');
  const token = url.searchParams.get(DELETION_TOKEN_PARAM);
  if (token === null || token === '') throw new Error(`no token in ${link}`);
  return token;
}

async function requestLink(email: string): Promise<Answer<{ requested: true }>> {
  return call(ACCOUNT_DELETION_PATH, { method: 'POST', body: { email } });
}

async function requestAndCapture(email: string): Promise<string> {
  const offset = mailOffset(mailPath);
  expect((await requestLink(email)).status).toBe(200);
  const messages = await waitForMail(mailPath, offset, (found) => found.some((one) => one.to === email));
  const message = messages.find((one) => one.to === email);
  if (message === undefined) throw new Error(`no deletion message captured for ${email}`);
  return tokenFrom(message);
}

describe('starting deletion from outside a session', () => {
  it('answers identically for a member, a stranger and nonsense, and mails only the member', async () => {
    const member = await createAccount(databaseUrl, ROLE.member, `public-${RUN}`);
    const offset = mailOffset(mailPath);

    const real = await requestLink(member.email);
    const unknown = await requestLink(`nobody-${RUN}@example.test`);
    const nonsense = await requestLink('not an address');
    for (const answer of [real, unknown, nonsense]) {
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ requested: true });
    }

    const messages = await waitForMail(mailPath, offset, (found) => found.some((one) => one.to === member.email));
    const ours = messages.filter((one) => one.to === member.email || one.to.includes(`nobody-${RUN}`));
    expect(ours).toHaveLength(1);
    expect(ours[0]?.subject.toLowerCase()).toContain('delete');
    expect(ours[0]?.text).toContain(REMOVED_MEMBER_DISPLAY_NAME);
  }, 60_000);

  it('previews the address behind a token, and completes only with the right password', async () => {
    const member = await createAccount(databaseUrl, ROLE.member, `token-${RUN}`);
    const token = await requestAndCapture(member.email);

    const preview = await call<{ email: string }>(`${ACCOUNT_DELETION_PATH}?${DELETION_TOKEN_PARAM}=${encodeURIComponent(token)}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ email: member.email });

    const wrong = await call(ACCOUNT_DELETION_COMPLETE_PATH, { method: 'POST', body: { token, password: 'wrong' } });
    expect(wrong.status).toBe(403);
    expect(wrong.code).toBe('password_incorrect');
    expect(await userRow(member.id)).not.toBeNull();

    const done = await call<AccountDeletedPayload>(ACCOUNT_DELETION_COMPLETE_PATH, {
      method: 'POST',
      body: { token, password: member.password },
    });
    expect(done.status).toBe(200);
    expect(done.body.deleted).toBe(true);
    expect(await userRow(member.id)).toBeNull();

    // The request row went with the account, so the token is dead rather than reusable.
    const again = await call(ACCOUNT_DELETION_COMPLETE_PATH, { method: 'POST', body: { token, password: member.password } });
    expect(again.status).toBe(410);
    expect(again.code).toBe('deletion_invalid');
  }, 60_000);

  it('still works for a deactivated account, whose owner has the right to be gone', async () => {
    const member = await createAccount(databaseUrl, ROLE.member, `deactivated-${RUN}`);
    await sql`update "user" set deactivated_at = now() where id = ${member.id}`;
    const token = await requestAndCapture(member.email);
    const done = await call(ACCOUNT_DELETION_COMPLETE_PATH, { method: 'POST', body: { token, password: member.password } });
    expect(done.status).toBe(200);
    expect(await userRow(member.id)).toBeNull();
  }, 60_000);

  it('answers deletion_invalid for a token never issued and deletion_expired for one that ran out', async () => {
    const unknown = await call(ACCOUNT_DELETION_COMPLETE_PATH, { method: 'POST', body: { token: 'never-issued', password: 'x' } });
    expect(unknown.status).toBe(410);
    expect(unknown.code).toBe('deletion_invalid');

    const member = await createAccount(databaseUrl, ROLE.member, `expired-${RUN}`);
    const token = await requestAndCapture(member.email);
    await sql`update account_deletion_request set expires_at = now() - interval '1 minute' where user_id = ${member.id}`;
    const expired = await call(`${ACCOUNT_DELETION_PATH}?${DELETION_TOKEN_PARAM}=${encodeURIComponent(token)}`);
    expect(expired.status).toBe(410);
    expect(expired.code).toBe('deletion_expired');
  }, 60_000);

  it('stores only the hash of the token, and a second request revokes the first', async () => {
    const member = await createAccount(databaseUrl, ROLE.member, `hash-${RUN}`);
    const first = await requestAndCapture(member.email);
    const byToken = await sql<{ id: string }[]>`select id from account_deletion_request where token_hash = ${first}`;
    expect(byToken).toHaveLength(0);

    // Past the minute between messages, a second request issues a new link and kills the first.
    await sql`update account_deletion_request set created_at = now() - interval '2 minutes' where user_id = ${member.id}`;
    const second = await requestAndCapture(member.email);
    expect(second).not.toBe(first);
    const dead = await call(`${ACCOUNT_DELETION_PATH}?${DELETION_TOKEN_PARAM}=${encodeURIComponent(first)}`);
    expect(dead.code).toBe('deletion_invalid');
    const live = await call(`${ACCOUNT_DELETION_PATH}?${DELETION_TOKEN_PARAM}=${encodeURIComponent(second)}`);
    expect(live.status).toBe(200);
  }, 60_000);

  it('is rate-limited per caller on the server that has a budget', async () => {
    const address = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    for (let n = 0; n < rateLimitedDeletion.perAddress; n += 1) {
      const allowed = await call(ACCOUNT_DELETION_PATH, {
        method: 'POST',
        origin: rateLimitedBaseUrl,
        address,
        body: { email: `limit-${n}-${RUN}@example.test` },
      });
      expect(allowed.status).toBe(200);
    }
    const refused = await call(ACCOUNT_DELETION_PATH, {
      method: 'POST',
      origin: rateLimitedBaseUrl,
      address,
      body: { email: `limit-last-${RUN}@example.test` },
    });
    expect(refused.status).toBe(429);
    expect(refused.code).toBe('rate_limited');
  }, 60_000);
});

describe('the placeholder is not an account', () => {
  it('cannot be reactivated, promoted or deactivated by an admin, and answers not_found', async () => {
    const [leaver, admin] = await Promise.all([
      signedIn('member', 'leaver-4'),
      signedIn('admin', 'admin-4'),
    ]);
    const where = await recording(`Deletion placeholder ${RUN}`);
    const note = await write(where, leaver, { text: 'Leaves a placeholder behind.', visibility: 'public', timestampMs: 1_000 });
    expect((await deleteMe(leaver.cookie, leaver.password)).status).toBe(200);
    const rows = await sql<{ author_id: string }[]>`select author_id from note where id = ${note.id}`;
    const placeholderId = rows[0]?.author_id ?? '';
    expect(placeholderId).not.toBe(leaver.id);

    expect((await call(`${USERS_PATH}/${placeholderId}/reactivate`, { method: 'POST', cookie: admin.cookie })).code).toBe('not_found');
    expect((await call(`${USERS_PATH}/${placeholderId}/deactivate`, { method: 'POST', cookie: admin.cookie })).code).toBe('not_found');
    expect((await call(`${USERS_PATH}/${placeholderId}`, { method: 'PATCH', cookie: admin.cookie, body: { role: ROLE.admin } })).code).toBe('not_found');
    // Nothing a member did to the note is refused by the placeholder existing.
    expect((await call(notePath(note.id), { method: 'DELETE', cookie: admin.cookie })).status).toBe(200);
  }, 120_000);
});
