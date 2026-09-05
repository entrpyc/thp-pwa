import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { announcement, notification, user } from './schema';
import type { AnnouncementKind, NotificationKind } from '@thp/shared';

/**
 * **Notifications and announcements at the database** ([3.17](docs/project/prd.md),
 * [4.16](docs/project/prd.md)).
 *
 * Every statement against `notification` and `announcement` lives here. The module answers
 * *which rows* and never *may this person*: the recipient of every read and every write below is
 * the id the service hands in, and the service took it from the session — which is what makes
 * "a member reads their own notifications and nobody else's" a property of the `where` clause
 * rather than of a check somebody remembers.
 *
 * **Fan-out is one statement.** Writing a notice to everybody is `insert … select` over the active
 * accounts, in Postgres, rather than a list of ids fetched here and a thousand-row insert built
 * from it. At a hundred members the difference is nothing; at a thousand it is the difference
 * between a publish that takes a moment and one that takes a round trip per member — and the
 * statement is atomic, so a publish never notifies half the group.
 *
 * **Crosses its boundary as row types in and row types out**, plus an {@link Executor} so a caller
 * can pull a write into a transaction. Drizzle never leaves the package.
 */

/** One `notification` row. */
export interface NotificationRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
  readonly recordingId: string | null;
  readonly noteId: string | null;
  readonly actorId: string | null;
  readonly announcementId: string | null;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

/** What every notification carries, whoever it is for. The recipient is the write's own question. */
export interface NotificationContent {
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
  readonly recordingId?: string | null;
  readonly noteId?: string | null;
  readonly actorId?: string | null;
  readonly announcementId?: string | null;
}

/** One `announcement` row, with the sender's name joined for the console's list. */
export interface AnnouncementRow {
  readonly id: string;
  readonly kind: AnnouncementKind;
  readonly title: string;
  readonly body: string;
  readonly onboardingId: string | null;
  readonly sentBy: string | null;
  readonly sentByDisplayName: string | null;
  readonly sentAt: Date;
  readonly recipientCount: number;
}

export interface NewAnnouncement {
  readonly kind: AnnouncementKind;
  readonly title: string;
  readonly body: string;
  readonly onboardingId: string | null;
  readonly sentBy: string;
}

const NOTIFICATION_COLUMNS = {
  id: notification.id,
  userId: notification.userId,
  kind: notification.kind,
  title: notification.title,
  body: notification.body,
  href: notification.href,
  recordingId: notification.recordingId,
  noteId: notification.noteId,
  actorId: notification.actorId,
  announcementId: notification.announcementId,
  createdAt: notification.createdAt,
  readAt: notification.readAt,
} as const;

// =================================================================================================
// Writing
// =================================================================================================

/**
 * Write one notification for one member and answer the row.
 *
 * The shape a reply and a reaction take ([3.17.6](docs/project/prd.md),
 * [3.17.16](docs/project/prd.md)): the audience is one person, and the service already knows who.
 */
export async function insertNotification(
  userId: string,
  content: NotificationContent,
  executor: Executor = getDatabase(),
): Promise<NotificationRow> {
  const rows = await queryable(executor)
    .insert(notification)
    .values({
      userId,
      kind: content.kind,
      title: content.title,
      body: content.body,
      href: content.href,
      recordingId: content.recordingId ?? null,
      noteId: content.noteId ?? null,
      actorId: content.actorId ?? null,
      announcementId: content.announcementId ?? null,
    })
    .returning(NOTIFICATION_COLUMNS);
  const row = rows[0] as NotificationRow | undefined;
  if (!row) throw new Error('insertNotification returned no row');
  return row;
}

/**
 * Write one notification for **every active account**, and answer how many that was.
 *
 * The shape a publish and an announcement take ([3.17.4](docs/project/prd.md),
 * [3.17.9](docs/project/prd.md)). Deactivated accounts are skipped rather than written to and
 * hidden: an account that cannot sign in has nobody to read a notice, and a row written for it
 * would be counted the day it is reactivated as something it missed while it was away — which is
 * arguably true, and is not what "all members" means at the moment of sending.
 *
 * `insert … select` rather than a fetched list and a built insert, for the reason the module
 * header gives. The `returning` is only so the count is the rows actually written, not the rows
 * the select would have matched a moment earlier.
 */
export async function insertNotificationForAllMembers(
  content: NotificationContent,
  executor: Executor = getDatabase(),
): Promise<number> {
  const written = await queryable(executor).execute(sql`
    insert into ${notification}
      (user_id, kind, title, body, href, recording_id, note_id, actor_id, announcement_id)
    select
      ${user.id},
      ${content.kind}::notification_kind,
      ${content.title},
      ${content.body},
      ${content.href},
      ${content.recordingId ?? null}::uuid,
      ${content.noteId ?? null}::uuid,
      ${content.actorId ?? null}::uuid,
      ${content.announcementId ?? null}::uuid
    from ${user}
    where ${user.deactivatedAt} is null
    returning ${notification.id}
  `);
  return written.length;
}

/**
 * Take away the earlier notice one person's reaction left on one note, so a member who changes
 * their mind three times leaves the author one row rather than three
 * ([3.17.16](docs/project/prd.md)).
 *
 * A delete before the insert rather than an upsert, because there is no key to conflict on — and
 * deliberately not one: two *different* members reacting to one note are two notices, and the
 * only thing being collapsed is one member's own indecision. Answers how many were removed, which
 * a test reads and nothing else does.
 */
export async function deleteReactionNotifications(
  input: { readonly userId: string; readonly noteId: string; readonly actorId: string },
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .delete(notification)
    .where(
      and(
        eq(notification.userId, input.userId),
        eq(notification.kind, 'note_reaction'),
        eq(notification.noteId, input.noteId),
        eq(notification.actorId, input.actorId),
      ),
    )
    .returning({ id: notification.id });
  return rows.length;
}

// =================================================================================================
// Reading
// =================================================================================================

/**
 * This member's most recent notifications, newest first — the `(user_id, created_at)` index
 * read backwards, and no more than `limit` of them.
 */
export async function listNotificationsForUser(
  userId: string,
  limit: number,
  executor: Executor = getDatabase(),
): Promise<NotificationRow[]> {
  const rows = await queryable(executor)
    .select(NOTIFICATION_COLUMNS)
    .from(notification)
    .where(eq(notification.userId, userId))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(limit);
  return rows as NotificationRow[];
}

/** How many of this member's notifications are unread — the partial index, exactly. */
export async function countUnreadNotifications(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .select({ count: sql<number>`count(*)::int` })
    .from(notification)
    .where(and(eq(notification.userId, userId), isNull(notification.readAt)));
  return rows[0]?.count ?? 0;
}

/**
 * Mark one of this member's notifications read, and answer it as it now reads — or `null` when
 * there is no such row **for this member**.
 *
 * The recipient is in the `where`, which is the whole of the privacy rule: another member's id
 * finds nothing here, and the service answers `not_found` for it exactly as for an id nobody has.
 * A row already read is answered again without moving its `read_at` — the first read is the fact.
 */
export async function markNotificationRead(
  id: string,
  userId: string,
  executor: Executor = getDatabase(),
): Promise<NotificationRow | null> {
  const rows = await queryable(executor)
    .update(notification)
    .set({ readAt: sql`coalesce(${notification.readAt}, now())` })
    .where(and(eq(notification.id, id), eq(notification.userId, userId)))
    .returning(NOTIFICATION_COLUMNS);
  return (rows[0] as NotificationRow | undefined) ?? null;
}

/** Mark every unread notification this member has read, and answer how many that was. */
export async function markAllNotificationsRead(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.userId, userId), isNull(notification.readAt)))
    .returning({ id: notification.id });
  return rows.length;
}

// =================================================================================================
// Announcements
// =================================================================================================

/**
 * Record a send. The fan-out is the caller's next statement, in the same transaction, and
 * {@link setAnnouncementRecipientCount} is where its count lands.
 */
export async function insertAnnouncement(
  input: NewAnnouncement,
  executor: Executor = getDatabase(),
): Promise<AnnouncementRow> {
  const rows = await queryable(executor)
    .insert(announcement)
    .values({
      kind: input.kind,
      title: input.title,
      body: input.body,
      onboardingId: input.onboardingId,
      sentBy: input.sentBy,
    })
    .returning({ id: announcement.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('insertAnnouncement returned no row');
  const row = await findAnnouncementById(id, executor);
  if (row === null) throw new Error('insertAnnouncement wrote a row it cannot read back');
  return row;
}

export async function setAnnouncementRecipientCount(
  id: string,
  recipientCount: number,
  executor: Executor = getDatabase(),
): Promise<void> {
  await queryable(executor)
    .update(announcement)
    .set({ recipientCount })
    .where(eq(announcement.id, id));
}

export async function findAnnouncementById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<AnnouncementRow | null> {
  const rows = await queryable(executor)
    .select(ANNOUNCEMENT_COLUMNS)
    .from(announcement)
    .leftJoin(user, eq(announcement.sentBy, user.id))
    .where(eq(announcement.id, id))
    .limit(1);
  return (rows[0] as AnnouncementRow | undefined) ?? null;
}

/** Every past send, newest first, with the sender's name — the console's list. */
export async function listAnnouncements(
  executor: Executor = getDatabase(),
): Promise<AnnouncementRow[]> {
  const rows = await queryable(executor)
    .select(ANNOUNCEMENT_COLUMNS)
    .from(announcement)
    .leftJoin(user, eq(announcement.sentBy, user.id))
    .orderBy(desc(announcement.sentAt), desc(announcement.id));
  return rows as AnnouncementRow[];
}

const ANNOUNCEMENT_COLUMNS = {
  id: announcement.id,
  kind: announcement.kind,
  title: announcement.title,
  body: announcement.body,
  onboardingId: announcement.onboardingId,
  sentBy: announcement.sentBy,
  sentByDisplayName: user.displayName,
  sentAt: announcement.sentAt,
  recipientCount: announcement.recipientCount,
} as const;
