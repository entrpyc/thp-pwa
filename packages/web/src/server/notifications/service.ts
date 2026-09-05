import {
  countUnreadNotifications,
  deleteReactionNotifications,
  insertAnnouncement,
  insertNotification,
  insertNotificationForAllMembers,
  listAnnouncements,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  setAnnouncementRecipientCount,
  withTransaction,
  type AnnouncementRow,
  type NotificationRow,
} from '@thp/db';
import {
  MAX_ANNOUNCEMENT_BODY_LENGTH,
  MAX_ANNOUNCEMENT_TITLE_LENGTH,
  NOTIFICATIONS_PAGE_SIZE,
  excerptForNotification,
  isAnnouncementKind,
  isOnboardingId,
  onboardingPagePath,
  reactionName,
  recordingPagePath,
  type AnnouncementListPayload,
  type AnnouncementView,
  type NotificationListPayload,
  type NotificationReadPayload,
  type NotificationView,
  type NotificationsReadAllPayload,
  type OnboardingId,
  type SendAnnouncementPayload,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';

/**
 * **In-app notifications** ([3.17](docs/project/prd.md)) — writing them when something happens,
 * and reading them back for the person they are for.
 *
 * Two halves. The **raising** half is called by the services that own the events: publication
 * calls {@link notifyRecordingPublished}, and the notes service calls {@link notifyNoteReply} and
 * {@link notifyNoteReaction}. Each is a sentence and a destination, decided here once, so a reply
 * reads the same whichever route wrote it. **None of them throws to its caller.** A publish that
 * happened is a publish that happened; a notification that could not be written is a line in the
 * log, not a refused publish — the write is already committed, and un-publishing a teaching because
 * a notice failed would be the wrong thing to undo.
 *
 * The **reading** half is always about the caller's own rows. The account comes from the session
 * and never from the request, which is why the routes behind it are `SESSION` and no policy action
 * exists for them: there is nothing to authorise that the `where` clause is not already deciding.
 *
 * The **sending** half — an admin's announcement or a new-feature notice — is the one place a
 * notification is composed by a person, and the one place this module refuses anything.
 */

// =================================================================================================
// Raising
// =================================================================================================

/** A teaching went live ([3.17.4](docs/project/prd.md)). Everybody active is told. */
export async function notifyRecordingPublished(input: {
  readonly recordingId: string;
  readonly title: string;
}): Promise<void> {
  await raise('recording.publish', async () => {
    const written = await insertNotificationForAllMembers({
      kind: 'recording_published',
      title: 'New recording published',
      body: input.title,
      href: recordingPagePath(input.recordingId),
      recordingId: input.recordingId,
    });
    return { recordingId: input.recordingId, recipients: written };
  });
}

/**
 * Somebody replied to a public note ([3.17.6](docs/project/prd.md), [3.12.16](docs/project/prd.md)).
 * The author is told — unless the author is the one replying, who was there.
 */
export async function notifyNoteReply(input: {
  readonly authorId: string;
  readonly recordingId: string;
  readonly noteId: string;
  readonly replier: Actor;
  readonly replyText: string;
}): Promise<void> {
  if (input.authorId === input.replier.id) return;
  await raise('note.reply', async () => {
    const row = await insertNotification(input.authorId, {
      kind: 'note_reply',
      title: `${input.replier.displayName} replied to your note`,
      body: excerptForNotification(input.replyText),
      href: recordingPagePath(input.recordingId),
      recordingId: input.recordingId,
      noteId: input.noteId,
      actorId: input.replier.id,
    });
    return { notificationId: row.id, noteId: input.noteId };
  });
}

/**
 * Somebody reacted to a public note ([3.17.16](docs/project/prd.md)). The author is told, once
 * per reactor: a member who picks 🙏, then ❤️, then 🔥 leaves the author one notice that says the
 * last of those, not three.
 */
export async function notifyNoteReaction(input: {
  readonly authorId: string;
  readonly recordingId: string;
  readonly noteId: string;
  readonly reactor: Actor;
  readonly emoji: string;
  readonly noteText: string;
}): Promise<void> {
  if (input.authorId === input.reactor.id) return;
  await raise('note.react', async () =>
    withTransaction(async (tx) => {
      await deleteReactionNotifications(
        { userId: input.authorId, noteId: input.noteId, actorId: input.reactor.id },
        tx,
      );
      const row = await insertNotification(
        input.authorId,
        {
          kind: 'note_reaction',
          title: `${input.reactor.displayName} reacted ${input.emoji} (${reactionName(input.emoji)}) to your note`,
          body: excerptForNotification(input.noteText),
          href: recordingPagePath(input.recordingId),
          recordingId: input.recordingId,
          noteId: input.noteId,
          actorId: input.reactor.id,
        },
        tx,
      );
      return { notificationId: row.id, noteId: input.noteId };
    }),
  );
}

/**
 * Run one raise, logging the outcome either way and **throwing nothing**.
 *
 * The event it is about has already happened and is already committed. A caller that had to
 * handle a failure here would have to decide whether a publish counts if nobody was told — and
 * the answer is that it counts, and the failure is an operator's line to search for.
 */
async function raise(
  event: string,
  work: () => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    const detail = await work();
    logger.info('notification.raised', { event, ...detail });
  } catch (caught) {
    logger.error('notification.failed', {
      event,
      errorName: caught instanceof Error ? caught.name : typeof caught,
      errorMessage: caught instanceof Error ? caught.message : String(caught),
    });
  }
}

// =================================================================================================
// Reading — always the caller's own
// =================================================================================================

/** The centre's list and the bell's count, in one answer ([3.17.2](docs/project/prd.md), 3.17.3). */
export async function readNotificationsFor(actor: Actor): Promise<NotificationListPayload> {
  const [rows, unreadCount] = await Promise.all([
    listNotificationsForUser(actor.id, NOTIFICATIONS_PAGE_SIZE),
    countUnreadNotifications(actor.id),
  ]);
  return { notifications: rows.map(describeNotification), unreadCount };
}

/**
 * Mark one read. `not_found` for a row that is not this member's — the same answer as for an id
 * nobody has, so the route does not report which ids exist.
 */
export async function markReadFor(actor: Actor, id: string): Promise<NotificationReadPayload> {
  const row = await markNotificationRead(id, actor.id);
  if (row === null) throw ApiError.notFound('There is no such notification.');
  return { notification: describeNotification(row), unreadCount: await countUnreadNotifications(actor.id) };
}

export async function markAllReadFor(actor: Actor): Promise<NotificationsReadAllPayload> {
  const marked = await markAllNotificationsRead(actor.id);
  return { marked, unreadCount: 0 };
}

function describeNotification(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// =================================================================================================
// Sending — what an admin composes
// =================================================================================================

/**
 * Send an announcement or a new-feature notice to every active account
 * ([3.17.9](docs/project/prd.md), [3.17.17](docs/project/prd.md), [3.19.8](docs/project/prd.md)).
 *
 * The send row and the fan-out are **one transaction**: a send with no recipients and a set of
 * notices with no send behind them are both states the console would report wrongly, and a
 * failure halfway is the only way to reach either.
 *
 * A new feature carries the onboarding it opens, checked against the shared list before anything
 * is written — the id is typed by hand, and a typo would be a press that lands on a 404 for every
 * member at once. An announcement carries no destination at all; a body that sends one is refused
 * rather than silently dropped, so the admin learns the form was read differently from how they
 * meant it.
 */
export async function sendAnnouncementFor(
  actor: Actor,
  body: unknown,
): Promise<SendAnnouncementPayload> {
  const request = parseSendRequest(body);

  const row = await withTransaction(async (tx) => {
    const sent = await insertAnnouncement(
      {
        kind: request.kind,
        title: request.title,
        body: request.body,
        onboardingId: request.onboardingId,
        sentBy: actor.id,
      },
      tx,
    );
    const recipients = await insertNotificationForAllMembers(
      {
        kind: request.kind,
        title: request.title,
        body: request.body,
        href: request.onboardingId === null ? null : onboardingPagePath(request.onboardingId),
        actorId: actor.id,
        announcementId: sent.id,
      },
      tx,
    );
    await setAnnouncementRecipientCount(sent.id, recipients, tx);
    return { ...sent, recipientCount: recipients };
  });

  logger.info('announcement.send', {
    ...audit(actor, 'announcement.send', `announcement:${row.id}`),
    kind: row.kind,
    recipients: row.recipientCount,
  });

  return { announcement: describeAnnouncement(row) };
}

export async function listAnnouncementsFor(actor: Actor): Promise<AnnouncementListPayload> {
  const rows = await listAnnouncements();
  logger.info('announcement.list', { actorId: actor.id, count: rows.length });
  return { announcements: rows.map(describeAnnouncement) };
}

function describeAnnouncement(row: AnnouncementRow): AnnouncementView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    // Stored as text and answered as the id it was checked to be on the way in; a retired
    // onboarding's id still travels, and the page it once opened is the client's business.
    onboardingId: (row.onboardingId as OnboardingId | null) ?? null,
    // A sender whose account is gone is answered as nobody rather than as a blank the console
    // would print as a name.
    sentByDisplayName: row.sentByDisplayName ?? 'A former admin',
    recipientCount: row.recipientCount,
    sentAt: row.sentAt.toISOString(),
  };
}

function parseSendRequest(body: unknown): {
  readonly kind: 'announcement' | 'new_feature';
  readonly title: string;
  readonly body: string;
  readonly onboardingId: OnboardingId | null;
} {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the kind, a title and a body.');
  }
  const fields = body as Record<string, unknown>;

  const { kind } = fields;
  if (!isAnnouncementKind(kind)) {
    throw ApiError.invalidInput('Say whether this is an announcement or a new feature.');
  }

  const title = parseLine(fields['title'], 'title', MAX_ANNOUNCEMENT_TITLE_LENGTH);
  const text = parseLine(fields['body'], 'body', MAX_ANNOUNCEMENT_BODY_LENGTH);

  const rawOnboarding = fields['onboardingId'];
  if (kind === 'announcement') {
    if (rawOnboarding !== undefined && rawOnboarding !== null && rawOnboarding !== '') {
      throw ApiError.invalidInput(
        'An announcement carries no link. Choose “New feature” to point members at an onboarding.',
      );
    }
    return { kind, title, body: text, onboardingId: null };
  }

  const onboardingId = typeof rawOnboarding === 'string' ? rawOnboarding.trim() : '';
  if (onboardingId === '') {
    throw ApiError.invalidInput('A new feature needs the id of the onboarding that shows it.');
  }
  if (!isOnboardingId(onboardingId)) {
    throw ApiError.invalidInput(
      `There is no onboarding called “${onboardingId}”. Add it to the onboarding list first.`,
    );
  }
  return { kind, title, body: text, onboardingId };
}

/** Trimmed, non-empty, and under the ceiling — refused rather than cut. */
function parseLine(value: unknown, field: 'title' | 'body', ceiling: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.invalidInput(field === 'title' ? 'Give it a title.' : 'Write the message.');
  }
  const trimmed = value.trim();
  if (trimmed.length > ceiling) {
    throw ApiError.invalidInput(
      `The ${field} can be at most ${ceiling.toLocaleString('en-GB')} characters.`,
    );
  }
  return trimmed;
}
