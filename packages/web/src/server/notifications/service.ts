import {
  countUnreadNotifications,
  deleteReactionNotifications,
  insertAnnouncement,
  insertNotification,
  insertNotificationForAllMembers,
  insertNotificationForSosAudience,
  isBlockedEitherWay,
  listActiveAdminIds,
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
  ADMIN_REPORTS_PAGE_PATH,
  MAX_ANNOUNCEMENT_BODY_LENGTH,
  MAX_ANNOUNCEMENT_TITLE_LENGTH,
  NOTIFICATIONS_BEFORE_PARAM,
  NOTIFICATIONS_PAGE_SIZE,
  REPORT_DISMISSED_TITLE,
  REPORT_REASON_LABEL,
  REPORT_REMOVED_TITLE,
  SOS_PAGE_PATH,
  excerptForNotification,
  isAnnouncementKind,
  isOnboardingId,
  noteReactionNotificationTitle,
  noteReplyNotificationTitle,
  noteReportedNotificationTitle,
  onboardingPagePath,
  recordingPagePath,
  sosPagePath,
  sosRaisedNotificationTitle,
  sosReplyNotificationTitle,
  sosReportResolvedTitle,
  sosReportedNotificationTitle,
  sosThreadReplyNotificationTitle,
  type AnnouncementListPayload,
  type AnnouncementView,
  type NotificationListPayload,
  type NotificationReadPayload,
  type NotificationView,
  type NotificationsReadAllPayload,
  type OnboardingId,
  type ReportOutcome,
  type ReportReason,
  type SendAnnouncementPayload,
  type SosUrgency,
} from '@thp/shared';
import { deliverPush } from '@thp/push';
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
 * **A notice about one member's act on another's content is not written across a block**, in
 * either direction — the blocker hears nothing of the blocked member, and the blocked member
 * hears nothing of the blocker. The notes service already refuses the act itself, so for a
 * reply or a reaction this is a second answer to the same question; it is asked again here
 * because the two reads are not one transaction, and because this is the function a later
 * event will call — an SOS reply ([3.16.7](docs/project/prd.md)), a push ([3.17.1](docs/project/prd.md))
 * — and the suppression has to hold for a caller that did not think to ask first. The row is
 * simply never written: push is a second delivery of the same rows, so a notice that does not
 * exist is never pushed either.
 *
 * **Every raise ends with the second delivery.** Once the rows are written — and once any
 * transaction around them has committed — their ids go to `deliverPush` in `@thp/push`, which
 * reaches every registered device of each recipient whose switch for the kind's category is on
 * ([3.17.1](docs/project/prd.md), [3.17.13](docs/project/prd.md)). It throws nothing, so a push
 * service being down is a log line and never a refused reply. The block rule above costs push
 * nothing extra: a row that is never written is never pushed.
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
    await deliverPush(written);
    return { recordingId: input.recordingId, recipients: written.length };
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
    if (await isBlockedEitherWay(input.authorId, input.replier.id)) {
      return { noteId: input.noteId, suppressed: 'blocked' };
    }
    const row = await insertNotification(input.authorId, {
      kind: 'note_reply',
      title: noteReplyNotificationTitle(input.replier.displayName),
      body: excerptForNotification(input.replyText),
      href: recordingPagePath(input.recordingId),
      recordingId: input.recordingId,
      noteId: input.noteId,
      actorId: input.replier.id,
    });
    await deliverPush([row.id]);
    return { notificationId: row.id, noteId: input.noteId };
  });
}

/**
 * Somebody reacted to a public note ([3.17.16](docs/project/prd.md)). The author is told, once
 * per reactor: a member who picks 🙏, then ❤️, then 🔥 leaves the author one notice, not three.
 * The notice does not say which glyph — the note itself is where the author sees that.
 */
export async function notifyNoteReaction(input: {
  readonly authorId: string;
  readonly recordingId: string;
  readonly noteId: string;
  readonly reactor: Actor;
  readonly noteText: string;
}): Promise<void> {
  if (input.authorId === input.reactor.id) return;
  await raise('note.react', async () => {
    if (await isBlockedEitherWay(input.authorId, input.reactor.id)) {
      return { noteId: input.noteId, suppressed: 'blocked' };
    }
    const written = await withTransaction(async (tx) => {
      await deleteReactionNotifications(
        { userId: input.authorId, noteId: input.noteId, actorId: input.reactor.id },
        tx,
      );
      const row = await insertNotification(
        input.authorId,
        {
          kind: 'note_reaction',
          title: noteReactionNotificationTitle(input.reactor.displayName),
          body: excerptForNotification(input.noteText),
          href: recordingPagePath(input.recordingId),
          recordingId: input.recordingId,
          noteId: input.noteId,
          actorId: input.reactor.id,
        },
        tx,
      );
      return { notificationId: row.id, noteId: input.noteId };
    });
    // After the transaction, so a push is never sent for a row a rollback then removed.
    await deliverPush([written.notificationId]);
    return written;
  });
}

/**
 * A member reported a public note (Apple guideline 1.2: a mechanism to report, with timely
 * responses). **Every active admin is told, one row each**, with a press that lands on the
 * console's queue — the bell is where an admin already learns that something waits on them.
 *
 * One notice per report rather than one per note, because each report is a separate request to
 * look and the admin's inbox is the record of those requests; the queue itself is where they are
 * read together. A reporter who is an admin is not told about their own report.
 *
 * **Not suppressed across a block.** The block predicate is about one member hearing of another's
 * act on *their* content; a report is addressed to the group's admins about content the group can
 * read, and an admin who has blocked the reporter still has a queue to work.
 */
export async function notifyNoteReported(input: {
  readonly reportId: string;
  readonly noteId: string;
  readonly recordingId: string;
  readonly reason: ReportReason;
  readonly noteText: string;
  readonly reporter: Actor;
}): Promise<void> {
  await raise('note.report', async () => {
    const admins = (await listActiveAdminIds()).filter((id) => id !== input.reporter.id);
    const body = `${REPORT_REASON_LABEL[input.reason]}: ${excerptForNotification(input.noteText)}`;
    const rows = await Promise.all(
      admins.map((adminId) =>
        insertNotification(adminId, {
          kind: 'note_reported',
          title: noteReportedNotificationTitle(input.reporter.displayName),
          body,
          href: ADMIN_REPORTS_PAGE_PATH,
          recordingId: input.recordingId,
          noteId: input.noteId,
          actorId: input.reporter.id,
        }),
      ),
    );
    await deliverPush(rows.map((row) => row.id));
    return { reportId: input.reportId, noteId: input.noteId, recipients: admins.length };
  });
}

/**
 * An admin closed a report (Apple guideline 1.2's "timely responses", made visible). **Each
 * reporter is told once**, which of the two things happened, with a press that lands on the
 * teaching — where a removed note is now a tombstone and a kept one still reads.
 *
 * The notice names no admin and quotes no text: the decision is the product's answer, and the
 * reporter already knows what they reported. A reporter whose account is gone has nobody to tell,
 * and the admin who decided is not told about their own report.
 */
export async function notifyReportResolved(input: {
  readonly reporterIds: readonly (string | null)[];
  readonly noteId: string;
  readonly recordingId: string;
  readonly outcome: ReportOutcome;
  readonly resolver: Actor;
}): Promise<void> {
  await raise('report.resolve', async () => {
    const recipients = [
      ...new Set(
        input.reporterIds.filter(
          (id): id is string => id !== null && id !== input.resolver.id,
        ),
      ),
    ];
    const removed = input.outcome === 'removed';
    const rows = await Promise.all(
      recipients.map((reporterId) =>
        insertNotification(reporterId, {
          kind: 'report_resolved',
          title: removed ? REPORT_REMOVED_TITLE : REPORT_DISMISSED_TITLE,
          body: removed
            ? 'An admin reviewed your report and removed the note. Thank you for flagging it.'
            : 'An admin reviewed your report and decided the note can stay. Thank you for flagging it.',
          href: recordingPagePath(input.recordingId),
          recordingId: input.recordingId,
          noteId: input.noteId,
          actorId: input.resolver.id,
        }),
      ),
    );
    await deliverPush(rows.map((row) => row.id));
    return { noteId: input.noteId, outcome: input.outcome, recipients: recipients.length };
  });
}

/**
 * A member reported a prayer request or a reply on one — `notifyNoteReported`'s twin for the SOS
 * channel, on the same terms: every active admin but the reporter, one row per report, a press
 * that lands on the console's queue, and not suppressed across a block.
 *
 * The row names the signal so it goes with the signal: once an admin has removed the request,
 * a notice about reporting it is about nothing.
 */
export async function notifySosReported(input: {
  readonly reportId: string;
  readonly signalId: string;
  readonly replyId: string | null;
  readonly reason: ReportReason;
  readonly text: string;
  readonly reporter: Actor;
}): Promise<void> {
  await raise('sos.report', async () => {
    const admins = (await listActiveAdminIds()).filter((id) => id !== input.reporter.id);
    const body = `${REPORT_REASON_LABEL[input.reason]}: ${excerptForNotification(input.text)}`;
    const rows = await Promise.all(
      admins.map((adminId) =>
        insertNotification(adminId, {
          kind: 'sos_reported',
          title: sosReportedNotificationTitle(input.reporter.displayName),
          body,
          href: ADMIN_REPORTS_PAGE_PATH,
          sosSignalId: input.signalId,
          actorId: input.reporter.id,
        }),
      ),
    );
    await deliverPush(rows.map((row) => row.id));
    return {
      reportId: input.reportId,
      signalId: input.signalId,
      replyId: input.replyId,
      recipients: admins.length,
    };
  });
}

/**
 * An admin closed a report on the SOS channel — `notifyReportResolved`'s twin. The press lands on
 * the request's page while there is one; a request that was removed has no page, so the press
 * lands on the board instead, and the row does not name the signal, or the cascade that removes
 * the request would take the answer with it.
 */
export async function notifySosReportResolved(input: {
  readonly reporterIds: readonly (string | null)[];
  readonly signalId: string;
  readonly about: 'signal' | 'reply';
  readonly outcome: ReportOutcome;
  readonly resolver: Actor;
}): Promise<void> {
  await raise('report.resolve', async () => {
    const recipients = [
      ...new Set(
        input.reporterIds.filter(
          (id): id is string => id !== null && id !== input.resolver.id,
        ),
      ),
    ];
    const removed = input.outcome === 'removed';
    const what = input.about === 'signal' ? 'prayer request' : 'reply';
    const requestGone = input.about === 'signal' && removed;
    const rows = await Promise.all(
      recipients.map((reporterId) =>
        insertNotification(reporterId, {
          kind: 'report_resolved',
          title: sosReportResolvedTitle(input.about, input.outcome),
          body: removed
            ? `An admin reviewed your report and removed the ${what}. Thank you for flagging it.`
            : `An admin reviewed your report and decided the ${what} can stay. Thank you for flagging it.`,
          href: requestGone ? SOS_PAGE_PATH : sosPagePath(input.signalId),
          sosSignalId: requestGone ? null : input.signalId,
          actorId: input.resolver.id,
        }),
      ),
    );
    await deliverPush(rows.map((row) => row.id));
    return {
      signalId: input.signalId,
      about: input.about,
      outcome: input.outcome,
      recipients: recipients.length,
    };
  });
}

/**
 * A member raised an SOS signal ([3.17.7](docs/project/prd.md), [3.16.3](docs/project/prd.md)).
 * **Everybody active is told, at every urgency** — less the author, who was there, and less
 * anybody either side of a block with them, who would be handed a press that lands on a signal
 * the board hides from them. The title carries the colour, the body the request, and the press
 * lands on the signal's own page.
 */
export async function notifySosRaised(input: {
  readonly signalId: string;
  readonly urgency: SosUrgency;
  readonly description: string;
  readonly author: Actor;
  /** The name the title carries — the author's, or a stand-in for an anonymous signal. */
  readonly authorName: string;
}): Promise<void> {
  await raise('sos.raise', async () => {
    const written = await insertNotificationForSosAudience(
      {
        kind: 'sos_raised',
        title: sosRaisedNotificationTitle(input.authorName, input.urgency),
        body: excerptForNotification(input.description),
        href: sosPagePath(input.signalId),
        sosSignalId: input.signalId,
      },
      input.author.id,
    );
    await deliverPush(written);
    return { signalId: input.signalId, urgency: input.urgency, recipients: written.length };
  });
}

/**
 * Somebody replied to an SOS signal ([3.17.8](docs/project/prd.md), [3.16.7](docs/project/prd.md)).
 * The author is told — unless the author is the one replying, who was there — and never across a
 * block, for the reason the module comment gives.
 */
export async function notifySosReply(input: {
  readonly signalId: string;
  readonly authorId: string;
  readonly replier: Actor;
  readonly replyText: string;
}): Promise<void> {
  if (input.authorId === input.replier.id) return;
  await raise('sos.reply', async () => {
    if (await isBlockedEitherWay(input.authorId, input.replier.id)) {
      return { signalId: input.signalId, suppressed: 'blocked' };
    }
    const row = await insertNotification(input.authorId, {
      kind: 'sos_reply',
      title: sosReplyNotificationTitle(input.replier.displayName),
      body: excerptForNotification(input.replyText),
      href: sosPagePath(input.signalId),
      actorId: input.replier.id,
      sosSignalId: input.signalId,
    });
    await deliverPush([row.id]);
    return { notificationId: row.id, signalId: input.signalId };
  });
}

/**
 * A reply inside a thread tells the thread's author too — unless they are the replier, or the
 * signal's author, who {@link notifySosReply} has already told. Same kind, same landing.
 */
export async function notifySosThreadReply(input: {
  readonly signalId: string;
  readonly signalAuthorId: string;
  readonly threadAuthorId: string;
  readonly replier: Actor;
  readonly replyText: string;
}): Promise<void> {
  if (input.threadAuthorId === input.replier.id) return;
  if (input.threadAuthorId === input.signalAuthorId) return;
  await raise('sos.thread_reply', async () => {
    if (await isBlockedEitherWay(input.threadAuthorId, input.replier.id)) {
      return { signalId: input.signalId, suppressed: 'blocked' };
    }
    const row = await insertNotification(input.threadAuthorId, {
      kind: 'sos_reply',
      title: sosThreadReplyNotificationTitle(input.replier.displayName),
      body: excerptForNotification(input.replyText),
      href: sosPagePath(input.signalId),
      actorId: input.replier.id,
      sosSignalId: input.signalId,
    });
    await deliverPush([row.id]);
    return { notificationId: row.id, signalId: input.signalId };
  });
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One page of the centre's list and the bell's count, in one answer ([3.17.2](docs/project/prd.md),
 * 3.17.3).
 *
 * `before` is the {@link NOTIFICATIONS_BEFORE_PARAM} query parameter as the route read it: `null`
 * or empty for the first page, otherwise the id of the last row the centre holds. One row more than
 * the page is read, and that row's presence — not the page's length — is what says whether there is
 * a next page; the extra row is dropped and the last listed row's id becomes the cursor.
 *
 * A cursor that is malformed, or that names a row this member does not have, is `invalid_input`:
 * the parameter was read fine and does not describe anything of the caller's. Another member's id
 * gets the same answer as a made-up one, so the parameter does not report which ids exist.
 */
export async function readNotificationsFor(
  actor: Actor,
  before: string | null = null,
): Promise<NotificationListPayload> {
  const cursor = before === null || before === '' ? null : before;
  if (cursor !== null && !UUID.test(cursor)) {
    throw ApiError.invalidInput(`${NOTIFICATIONS_BEFORE_PARAM} must be the id of one of your notifications.`);
  }
  const [rows, unreadCount] = await Promise.all([
    listNotificationsForUser(actor.id, NOTIFICATIONS_PAGE_SIZE + 1, cursor),
    countUnreadNotifications(actor.id),
  ]);
  if (rows === null) {
    throw ApiError.invalidInput(`${NOTIFICATIONS_BEFORE_PARAM} must be the id of one of your notifications.`);
  }
  const page = rows.slice(0, NOTIFICATIONS_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    notifications: page.map(describeNotification),
    unreadCount,
    nextCursor: rows.length > NOTIFICATIONS_PAGE_SIZE && last !== undefined ? last.id : null,
  };
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
    await setAnnouncementRecipientCount(sent.id, recipients.length, tx);
    return { ...sent, recipientCount: recipients.length, written: recipients };
  });

  // Outside the transaction, so a push never goes out for a send that then rolled back — and
  // inside `raise`'s rule rather than the route's: the send has happened whether or not the
  // devices were reached, and `deliverPush` throws nothing anyway.
  await deliverPush(row.written);

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
