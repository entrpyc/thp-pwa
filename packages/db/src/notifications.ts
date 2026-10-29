import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { blockPlacedByViewer, noBlockBetween } from './member-blocks';
import { announcement, notification, sosSignal, user } from './schema';
import {
  ROLE,
  SOS_URGENCIES,
  noteReactionNotificationTitle,
  noteReplyNotificationTitle,
  noteReportedNotificationTitle,
  sosRaisedNotificationTitle,
  sosReportedNotificationTitle,
  sosReplyNotificationTitle,
  type AnnouncementKind,
  type NotificationKind,
} from '@thp/shared';

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
  readonly sosSignalId: string | null;
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
  readonly sosSignalId?: string | null;
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
  sosSignalId: notification.sosSignalId,
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
      sosSignalId: content.sosSignalId ?? null,
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
 * header gives. The `returning` answers the ids of the rows actually written — not the rows the
 * select would have matched a moment earlier — and the ids rather than a count because the
 * second delivery (push, `@thp/push`) is addressed by them; the count is their length.
 */
export async function insertNotificationForAllMembers(
  content: NotificationContent,
  executor: Executor = getDatabase(),
): Promise<string[]> {
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
  return (written as unknown as { id: string }[]).map((row) => row.id);
}

/**
 * Write one notification for **every active account but the author's, less anybody either side
 * of a block with them** — the shape an SOS takes ([3.17.7](docs/project/prd.md),
 * [3.16.3](docs/project/prd.md)).
 *
 * The author was there. A member blocked either way would be handed a bell entry that opens onto
 * a signal the list read hides from them (`member-blocks.ts`), which is a press that lands on
 * nothing; the row is simply never written, and so never pushed. One `insert … select`, for the
 * reason the module header gives, and the signal's id on every row so an admin's removal takes
 * the notices with it.
 *
 * **An anonymous signal is withheld only from members the author blocked.** Withholding it from
 * members who blocked the author would tell each of them, by the notice's absence, that the
 * person they blocked is the one asking (docs/security-audit-2026-10-29.md, finding 2); the list
 * read makes the same carve-out (`sos.ts`), so the notice and the board agree.
 */
export async function insertNotificationForSosAudience(
  content: NotificationContent & { readonly sosSignalId: string },
  author: { readonly id: string; readonly anonymous: boolean },
  executor: Executor = getDatabase(),
): Promise<string[]> {
  const authorId = author.id;
  const audience = author.anonymous
    ? sql`not ${blockPlacedByViewer(authorId, user.id)}`
    : noBlockBetween(authorId, user.id);
  const written = await queryable(executor).execute(sql`
    insert into ${notification}
      (user_id, kind, title, body, href, actor_id, sos_signal_id)
    select
      ${user.id},
      ${content.kind}::notification_kind,
      ${content.title},
      ${content.body},
      ${content.href},
      ${authorId}::uuid,
      ${content.sosSignalId}::uuid
    from ${user}
    where ${user.deactivatedAt} is null
      and ${user.id} <> ${authorId}::uuid
      and ${audience}
    returning ${notification.id}
  `);
  return (written as unknown as { id: string }[]).map((row) => row.id);
}

/**
 * Write one notification for **every active admin**, and answer how many that was.
 *
 * The shape a draft-ready notice takes ([3.17.10](docs/project/prd.md)): the audience is a role,
 * not a person and not everybody. One `insert … select` over the active admins, for the reason
 * the module header gives, and so the worker — which raises this one and has no actor list in
 * hand — needs one statement rather than a read and a loop. A deactivated admin is skipped exactly
 * as a deactivated member is by the broadcast above. Answers the ids written, as the broadcast
 * does and for the same reason.
 */
export async function insertNotificationForActiveAdmins(
  content: NotificationContent,
  executor: Executor = getDatabase(),
): Promise<string[]> {
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
    where ${user.deactivatedAt} is null and ${roleColumn} = ${ROLE.admin}::user_role
    returning ${notification.id}
  `);
  return (written as unknown as { id: string }[]).map((row) => row.id);
}

/** The column, taken off the table once — the shape `accounts.ts` uses for the same filter. */
const { role: roleColumn } = user;

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

/**
 * **Take a departed member's name out of the notices they caused** (README.md beside the schema).
 *
 * The title is denormalised on purpose and nothing else ever rewrites one — see the table's
 * comment. This is the exception, and it is narrow: the rows are other members' records of having
 * been told something, so they stay; what goes is the one thing in them that is the leaver's, the
 * name in the title. Rewritten by kind from the shared helpers that wrote the title in the first
 * place, rather than by replacing the display name as a substring — a member who renamed
 * themselves between the reply and the deletion would otherwise keep their old name in somebody's
 * inbox. The body is the *recipient's* note's excerpt on a reaction and the reply's words on a
 * reply; the reply itself is retained under the placeholder (3.1.10), so its excerpt is too.
 *
 * Called **before** the account row is deleted: `actor_id` sets null when it goes, and after that
 * there would be nothing to find the rows by.
 */
export async function anonymiseNotificationsByActor(
  actorId: string,
  placeholderName: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const db = queryable(executor);
  const replies = await db
    .update(notification)
    .set({ title: noteReplyNotificationTitle(placeholderName) })
    .where(and(eq(notification.actorId, actorId), eq(notification.kind, 'note_reply')))
    .returning({ id: notification.id });
  const reactions = await db
    .update(notification)
    .set({ title: noteReactionNotificationTitle(placeholderName) })
    .where(and(eq(notification.actorId, actorId), eq(notification.kind, 'note_reaction')))
    .returning({ id: notification.id });
  // The third title that names a person: the admins' notice that this member reported a note.
  const reports = await db
    .update(notification)
    .set({ title: noteReportedNotificationTitle(placeholderName) })
    .where(and(eq(notification.actorId, actorId), eq(notification.kind, 'note_reported')))
    .returning({ id: notification.id });
  // The fourth: the title an SOS author read when this member replied to their signal.
  const sosReplies = await db
    .update(notification)
    .set({ title: sosReplyNotificationTitle(placeholderName) })
    .where(and(eq(notification.actorId, actorId), eq(notification.kind, 'sos_reply')))
    .returning({ id: notification.id });
  // The fifth: the admins' notice that this member reported a prayer request or a reply on one.
  const sosReports = await db
    .update(notification)
    .set({ title: sosReportedNotificationTitle(placeholderName) })
    .where(and(eq(notification.actorId, actorId), eq(notification.kind, 'sos_reported')))
    .returning({ id: notification.id });
  // The sixth: the whole group's notice that this member raised a prayer request. The signal now
  // belongs to the placeholder (`reassignSosOfDeletedAuthor`), so the title follows the name. The
  // title carries the urgency, so one update per urgency; an anonymous signal's title names
  // nobody already and is left alone.
  let sosRaised = 0;
  for (const urgency of SOS_URGENCIES) {
    const rows = await db
      .update(notification)
      .set({ title: sosRaisedNotificationTitle(placeholderName, urgency) })
      .where(
        and(
          eq(notification.actorId, actorId),
          eq(notification.kind, 'sos_raised'),
          sql`${notification.sosSignalId} in (select ${sosSignal.id} from ${sosSignal} where ${sosSignal.urgency} = ${urgency}::sos_urgency and ${sosSignal.anonymous} = false)`,
        ),
      )
      .returning({ id: notification.id });
    sosRaised += rows.length;
  }
  return (
    replies.length + reactions.length + reports.length + sosReplies.length + sosReports.length + sosRaised
  );
}

// =================================================================================================
// Reading
// =================================================================================================

/**
 * This member's most recent notifications, newest first — the `(user_id, created_at)` index
 * read backwards, and no more than `limit` of them.
 *
 * `before` is the id of the last row the caller already holds, and asks for the rows that follow
 * it in the same order: strictly older by `(created_at, id)`, the pair the order is on, so two rows
 * written in the same microsecond are split the same way on every page and nothing is listed twice
 * or skipped between pages. The cursor row is looked up **for this member**; another member's id
 * finds nothing, which the function answers as `null` rather than as an empty page, so the service
 * can refuse the cursor instead of pretending the list ended.
 */
export async function listNotificationsForUser(
  userId: string,
  limit: number,
  before: string | null = null,
  executor: Executor = getDatabase(),
): Promise<NotificationRow[] | null> {
  const db = queryable(executor);
  let olderThanCursor = undefined;
  if (before !== null) {
    const anchor = await db
      .select({ id: notification.id })
      .from(notification)
      .where(and(eq(notification.userId, userId), eq(notification.id, before)))
      .limit(1);
    if (anchor[0] === undefined) return null;
    // Compared in SQL against the stored row rather than against a `Date` carried through JS, which
    // keeps milliseconds only: a row written in the same millisecond as the cursor but a few
    // microseconds earlier would otherwise fall between two pages.
    olderThanCursor = sql`(${notification.createdAt}, ${notification.id}) < (
      select ${notification.createdAt}, ${notification.id} from ${notification}
      where ${notification.id} = ${before}::uuid and ${notification.userId} = ${userId}::uuid
    )`;
  }
  const rows = await db
    .select(NOTIFICATION_COLUMNS)
    .from(notification)
    .where(and(eq(notification.userId, userId), olderThanCursor))
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
