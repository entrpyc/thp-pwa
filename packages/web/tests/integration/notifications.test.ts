import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  ANNOUNCEMENTS_PATH,
  API_PREFIX,
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_ALL_PATH,
  REACTIONS,
  ROLE,
  isApiErrorBody,
  noteReactionPath,
  notificationReadPath,
  onboardingPagePath,
  recordingNotesPath,
  recordingPagePath,
  recordingPublishPath,
  type AnnouncementListPayload,
  type CreateNotePayload,
  type NotificationListPayload,
  type NotificationReadPayload,
  type NotificationView,
  type NotificationsReadAllPayload,
  type SendAnnouncementPayload,
} from '@thp/shared';
import { createDatabase, insertRecording, setRecordingPublication, type DatabaseHandle } from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';

/**
 * **In-app notifications over HTTP** ([3.17](docs/project/prd.md)) — every event this scope
 * raises, driven through the routes that raise it, and read back through the centre's own route.
 *
 * Five claims:
 *
 * 1. **Publishing tells every member** ([3.17.4](docs/project/prd.md)) and the press lands on the
 *    teaching. Publishing twice tells nobody twice.
 * 2. **A reply tells the author and nobody else** ([3.17.6](docs/project/prd.md)), and an author
 *    answering themselves is told nothing.
 * 3. **A reaction tells the author once per reactor** ([3.17.16](docs/project/prd.md)): three
 *    changes of mind are one row saying the last of them.
 * 4. **A member reads their own and marks their own.** Another member's id is `not_found`, not
 *    `forbidden` — the route does not report which ids exist.
 * 5. **An admin sends; a member cannot** ([3.17.15](docs/project/prd.md)). A new feature lands on
 *    its onboarding, an announcement lands nowhere, and both are refused when malformed.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let admin: Signed;
let author: Signed;
let other: Signed;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie: string; body?: unknown } ,
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: init.cookie,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    body: body as T,
  };
}

async function signedIn(role: 'admin' | 'member', label: string): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE[role], `${label}-${RUN}`);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

async function recording(title: string, published: boolean): Promise<string> {
  const row = await insertRecording(
    {
      originalMediaKey: `originals/notif-${title.replace(/\W+/g, '-')}-${RUN}.mp3`,
      title,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function inbox(who: Signed): Promise<NotificationListPayload> {
  const answer = await call<NotificationListPayload>(NOTIFICATIONS_PATH, { cookie: who.cookie });
  if (answer.status !== 200) throw new Error(`inbox refused ${answer.status}`);
  return answer.body;
}

/** This run's rows only — the suite shares a database, so a list is never asserted whole. */
function ours(list: NotificationListPayload, marker: string): NotificationView[] {
  return list.notifications.filter((one) => one.title.includes(marker) || one.body.includes(marker));
}

async function writeNote(
  recordingId: string,
  who: Signed,
  body: Record<string, unknown>,
): Promise<NotificationView['id']> {
  const answer = await call<CreateNotePayload>(recordingNotesPath(recordingId), {
    method: 'POST',
    cookie: who.cookie,
    body,
  });
  if (answer.status !== 200) throw new Error(`note refused ${answer.status}`);
  return answer.body.note.id;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  [admin, author, other] = await Promise.all([
    signedIn('admin', 'notif-admin'),
    signedIn('member', 'notif-author'),
    signedIn('member', 'notif-other'),
  ]);
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('publishing a teaching', () => {
  it('tells every member once, and the press lands on the teaching', async () => {
    const title = `Published ${RUN}`;
    const id = await recording(title, false);

    const published = await call(recordingPublishPath(id), { method: 'POST', cookie: admin.cookie });
    expect(published.status).toBe(200);
    // A second press moves nothing and tells nobody again.
    expect((await call(recordingPublishPath(id), { method: 'POST', cookie: admin.cookie })).status).toBe(200);

    for (const who of [author, other, admin]) {
      const mine = ours(await inbox(who), title);
      expect(mine.length, who.email).toBe(1);
      expect(mine[0]?.kind).toBe('recording_published');
      expect(mine[0]?.href).toBe(recordingPagePath(id));
      expect(mine[0]?.readAt).toBeNull();
    }
  });
});

describe('a reply to a public note', () => {
  it('tells the author and not the replier, and says nothing when the author answers themselves', async () => {
    const id = await recording(`Replies ${RUN}`, true);
    const noteId = await writeNote(id, author, {
      text: `A thought ${RUN}`,
      visibility: 'public',
      timestampMs: 1_000,
    });

    await writeNote(id, other, { text: `Reply from other ${RUN}`, parentId: noteId });
    await writeNote(id, author, { text: `Reply to myself ${RUN}`, parentId: noteId });

    const authors = ours(await inbox(author), `Reply`).filter((one) => one.kind === 'note_reply');
    expect(authors.map((one) => one.body)).toEqual([`Reply from other ${RUN}`]);
    expect(authors[0]?.title).toBe(`${other.displayName} replied to your note`);
    expect(authors[0]?.href).toBe(recordingPagePath(id));

    const others = ours(await inbox(other), RUN).filter((one) => one.kind === 'note_reply');
    expect(others).toEqual([]);
  });
});

describe('a reaction to a public note', () => {
  it('tells the author once per reactor, saying the last glyph chosen', async () => {
    const id = await recording(`Reactions ${RUN}`, true);
    const text = `React to me ${RUN}`;
    const noteId = await writeNote(id, author, { text, visibility: 'public', timestampMs: 2_000 });

    for (const one of REACTIONS.slice(0, 3)) {
      const set = await call(noteReactionPath(noteId), {
        method: 'PUT',
        cookie: other.cookie,
        body: { emoji: one.emoji },
      });
      expect(set.status).toBe(200);
    }
    // The author's own reaction tells the author nothing.
    await call(noteReactionPath(noteId), {
      method: 'PUT',
      cookie: author.cookie,
      body: { emoji: REACTIONS[0].emoji },
    });

    const notices = ours(await inbox(author), text).filter((one) => one.kind === 'note_reaction');
    expect(notices.length).toBe(1);
    expect(notices[0]?.title).toContain(REACTIONS[2].emoji);
    expect(notices[0]?.title).toContain(REACTIONS[2].name);
    expect(notices[0]?.title.startsWith(other.displayName)).toBe(true);
  });
});

describe('reading and marking', () => {
  it('marks one read for its owner, answers not_found for anybody else, and marks all', async () => {
    const title = `Marking ${RUN}`;
    const id = await recording(title, false);
    await call(recordingPublishPath(id), { method: 'POST', cookie: admin.cookie });

    const before = await inbox(author);
    const mine = ours(before, title)[0];
    if (mine === undefined) throw new Error('the publish did not reach the author');

    const stolen = await call(notificationReadPath(mine.id), { method: 'PUT', cookie: other.cookie });
    expect(stolen.status).toBe(404);
    expect(stolen.code).toBe('not_found');

    const read = await call<NotificationReadPayload>(notificationReadPath(mine.id), {
      method: 'PUT',
      cookie: author.cookie,
    });
    expect(read.status).toBe(200);
    expect(read.body.notification.readAt).not.toBeNull();
    expect(read.body.unreadCount).toBe(before.unreadCount - 1);

    const all = await call<NotificationsReadAllPayload>(NOTIFICATIONS_READ_ALL_PATH, {
      method: 'PUT',
      cookie: author.cookie,
    });
    expect(all.status).toBe(200);
    expect(all.body.marked).toBe(before.unreadCount - 1);
    expect((await inbox(author)).unreadCount).toBe(0);
  });
});

describe('what an admin sends', () => {
  it('refuses a member at both methods — forbidden, not not_found', async () => {
    const send = await call(ANNOUNCEMENTS_PATH, {
      method: 'POST',
      cookie: other.cookie,
      body: { kind: 'announcement', title: 'x', body: 'y' },
    });
    expect(send.status).toBe(403);
    expect(send.code).toBe('forbidden');
    const list = await call(ANNOUNCEMENTS_PATH, { cookie: other.cookie });
    expect(list.status).toBe(403);
  });

  it('sends an announcement to everybody, with no destination, and lists it', async () => {
    const title = `Announced ${RUN}`;
    const sent = await call<SendAnnouncementPayload>(ANNOUNCEMENTS_PATH, {
      method: 'POST',
      cookie: admin.cookie,
      body: { kind: 'announcement', title, body: '  Service moves to 10am.  ' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.announcement.kind).toBe('announcement');
    expect(sent.body.announcement.body).toBe('Service moves to 10am.');
    expect(sent.body.announcement.onboardingId).toBeNull();
    expect(sent.body.announcement.sentByDisplayName).toBe(admin.displayName);
    expect(sent.body.announcement.recipientCount).toBeGreaterThanOrEqual(3);

    for (const who of [author, other]) {
      const mine = ours(await inbox(who), title);
      expect(mine.length).toBe(1);
      expect(mine[0]?.kind).toBe('announcement');
      expect(mine[0]?.href).toBeNull();
    }

    const listed = await call<AnnouncementListPayload>(ANNOUNCEMENTS_PATH, { cookie: admin.cookie });
    expect(listed.body.announcements[0]?.id).toBe(sent.body.announcement.id);
  });

  it('sends a new feature that lands on its onboarding, and refuses one it does not have', async () => {
    const title = `Feature ${RUN}`;
    const sent = await call<SendAnnouncementPayload>(ANNOUNCEMENTS_PATH, {
      method: 'POST',
      cookie: admin.cookie,
      body: { kind: 'new_feature', title, body: 'Try the tour again.', onboardingId: 'new-user' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.announcement.onboardingId).toBe('new-user');

    const mine = ours(await inbox(author), title);
    expect(mine[0]?.kind).toBe('new_feature');
    expect(mine[0]?.href).toBe(onboardingPagePath('new-user'));

    const unknown = await call(ANNOUNCEMENTS_PATH, {
      method: 'POST',
      cookie: admin.cookie,
      body: { kind: 'new_feature', title, body: 'x', onboardingId: `nope-${RUN}` },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.code).toBe('invalid_input');

    const missing = await call(ANNOUNCEMENTS_PATH, {
      method: 'POST',
      cookie: admin.cookie,
      body: { kind: 'new_feature', title, body: 'x' },
    });
    expect(missing.code).toBe('invalid_input');

    const linked = await call(ANNOUNCEMENTS_PATH, {
      method: 'POST',
      cookie: admin.cookie,
      body: { kind: 'announcement', title, body: 'x', onboardingId: 'new-user' },
    });
    expect(linked.code).toBe('invalid_input');

    // Nothing was written for any refusal: the author has exactly the one feature notice.
    expect(ours(await inbox(author), title).length).toBe(1);
  });
});
