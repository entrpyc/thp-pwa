import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  countUnreadNotifications,
  createDatabase,
  deleteReactionNotifications,
  findAnnouncementById,
  insertAnnouncement,
  insertNote,
  insertNotification,
  insertNotificationForAllMembers,
  insertRecording,
  insertUser,
  listAnnouncements,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  setAnnouncementRecipientCount,
  type DatabaseHandle,
} from '@thp/db';
import { ROLE } from '@thp/shared';

/**
 * **Notifications at the database** ([3.17](docs/project/prd.md), [4.16](docs/project/prd.md)).
 *
 * The round trip — a notification written and read back — plus the four properties the layer
 * above cannot fake:
 *
 * 1. **Fan-out writes to every active account and to no deactivated one.** The count it answers
 *    is the count of rows written.
 * 2. **A read is the recipient's alone.** Marking a row with somebody else's id finds nothing,
 *    and the unread count is per member.
 * 3. **The first read is the fact.** Marking a row read twice leaves its `read_at` where it was.
 * 4. **One reactor leaves one notice** — the earlier one is taken away before the next is written.
 *
 * The suite shares a database with every other file, so every assertion about "everybody" is
 * scoped to accounts this file created: the fan-out is checked by reading *those* accounts' lists.
 */

const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let seeded = 0;

async function newUser(label: string): Promise<string> {
  seeded += 1;
  const row = await insertUser(
    {
      email: `notif-db-${label}-${RUN}-${seeded}@example.test`,
      passwordHash: 'not-a-real-hash',
      displayName: `Notif ${label}`,
      role: ROLE.member,
    },
    handle,
  );
  return row.id;
}

async function newRecording(title: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/notif-db-${RUN}-${seeded}.mp3`, title, recordedAt: '2026-05-01' },
    handle,
  );
  return row.id;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

// =================================================================================================

describe('a notification round-trips', () => {
  it('writes one for one member and reads it back unread, newest first', async () => {
    const me = await newUser('one');
    const recordingId = await newRecording(`Round trip ${RUN}`);

    const first = await insertNotification(
      me,
      { kind: 'recording_published', title: 'First', body: 'a', href: '/x', recordingId },
      handle,
    );
    const second = await insertNotification(
      me,
      { kind: 'note_reply', title: 'Second', body: 'b', href: '/y', recordingId },
      handle,
    );

    const listed = await listNotificationsForUser(me, 10, handle);
    expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(listed[0]?.readAt).toBeNull();
    expect(listed[0]?.kind).toBe('note_reply');
    expect(listed[0]?.href).toBe('/y');
    expect(listed[0]?.recordingId).toBe(recordingId);
    expect(await countUnreadNotifications(me, handle)).toBe(2);
  });

  it('honours the limit', async () => {
    const me = await newUser('limit');
    for (let n = 0; n < 3; n += 1) {
      await insertNotification(me, { kind: 'announcement', title: `${n}`, body: '', href: null }, handle);
    }
    expect((await listNotificationsForUser(me, 2, handle)).length).toBe(2);
    expect(await countUnreadNotifications(me, handle)).toBe(3);
  });
});

describe('fan-out', () => {
  it('writes to every active account, skips a deactivated one, and answers the count', async () => {
    const active = await newUser('active');
    const asleep = await newUser('asleep');
    await handle.sql`update "user" set deactivated_at = now() where id = ${asleep}`;

    const written = await insertNotificationForAllMembers(
      { kind: 'announcement', title: `Hello ${RUN}`, body: 'everybody', href: null },
      handle,
    );

    const mine = (await listNotificationsForUser(active, 50, handle)).filter(
      (row) => row.title === `Hello ${RUN}`,
    );
    const theirs = (await listNotificationsForUser(asleep, 50, handle)).filter(
      (row) => row.title === `Hello ${RUN}`,
    );
    expect(mine.length).toBe(1);
    expect(mine[0]?.href).toBeNull();
    expect(theirs).toEqual([]);
    // At least the one active account this test made; the rest of the suite's accounts count too.
    expect(written).toBeGreaterThanOrEqual(1);
  });
});

describe('reading is the recipient’s alone', () => {
  it('marks one read for its owner, finds nothing for anybody else, and keeps the first moment', async () => {
    const me = await newUser('reader');
    const other = await newUser('other');
    const row = await insertNotification(
      me,
      { kind: 'announcement', title: 'Read me', body: '', href: null },
      handle,
    );

    expect(await markNotificationRead(row.id, other, handle)).toBeNull();
    expect(await countUnreadNotifications(me, handle)).toBe(1);

    const read = await markNotificationRead(row.id, me, handle);
    expect(read?.readAt).toBeInstanceOf(Date);
    expect(await countUnreadNotifications(me, handle)).toBe(0);

    const again = await markNotificationRead(row.id, me, handle);
    expect(again?.readAt?.getTime()).toBe(read?.readAt?.getTime());
  });

  it('marks everything read at once and answers how many that was', async () => {
    const me = await newUser('all');
    await insertNotification(me, { kind: 'announcement', title: 'a', body: '', href: null }, handle);
    await insertNotification(me, { kind: 'announcement', title: 'b', body: '', href: null }, handle);
    expect(await markAllNotificationsRead(me, handle)).toBe(2);
    expect(await markAllNotificationsRead(me, handle)).toBe(0);
    expect(await countUnreadNotifications(me, handle)).toBe(0);
  });
});

describe('one reactor, one notice', () => {
  it('takes away the earlier reaction notice for the same note and reactor, and no other', async () => {
    const author = await newUser('author');
    const reactor = await newUser('reactor');
    const bystander = await newUser('bystander');
    const recordingId = await newRecording(`Reacted ${RUN}`);
    const note = await insertNote(
      { recordingId, authorId: author, visibility: 'public', text: 'a note', timestampMs: 0 },
      handle,
    );
    const otherNote = await insertNote(
      { recordingId, authorId: author, visibility: 'public', text: 'another', timestampMs: 5 },
      handle,
    );

    const content = { kind: 'note_reaction' as const, title: 'reacted', body: '', href: '/r' };
    await insertNotification(author, { ...content, noteId: note.id, actorId: reactor }, handle);
    await insertNotification(author, { ...content, noteId: note.id, actorId: bystander }, handle);
    await insertNotification(author, { ...content, noteId: otherNote.id, actorId: reactor }, handle);

    // The reactor's notice on this note, and only that one: the bystander's on the same note and
    // the reactor's on the other note both stand.
    expect(
      await deleteReactionNotifications(
        { userId: author, noteId: note.id, actorId: reactor },
        handle,
      ),
    ).toBe(1);
    expect(await countUnreadNotifications(author, handle)).toBe(2);
    expect(
      await deleteReactionNotifications(
        { userId: author, noteId: note.id, actorId: reactor },
        handle,
      ),
    ).toBe(0);
  });
});

describe('an announcement is kept once', () => {
  it('records the send with its sender, takes the recipient count, and lists newest first', async () => {
    const admin = await newUser('sender');
    const sent = await insertAnnouncement(
      { kind: 'new_feature', title: `Feature ${RUN}`, body: 'try it', onboardingId: 'new-user', sentBy: admin },
      handle,
    );
    expect(sent.sentByDisplayName).toBe('Notif sender');
    expect(sent.recipientCount).toBe(0);

    await setAnnouncementRecipientCount(sent.id, 7, handle);
    expect((await findAnnouncementById(sent.id, handle))?.recipientCount).toBe(7);

    const listed = await listAnnouncements(handle);
    expect(listed[0]?.id).toBe(sent.id);
    expect(listed[0]?.onboardingId).toBe('new-user');
  });

  it('refuses a new feature with no onboarding and an announcement with one', async () => {
    const admin = await newUser('sender2');
    await expect(
      insertAnnouncement(
        { kind: 'new_feature', title: 'x', body: 'y', onboardingId: null, sentBy: admin },
        handle,
      ),
    ).rejects.toThrow();
    await expect(
      insertAnnouncement(
        { kind: 'announcement', title: 'x', body: 'y', onboardingId: 'new-user', sentBy: admin },
        handle,
      ),
    ).rejects.toThrow();
  });
});
