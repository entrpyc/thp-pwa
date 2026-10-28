import type { OnboardingId } from './onboarding';

/**
 * **In-app notifications — the event vocabulary, the wire contract, and the two things an admin
 * composes** ([3.17](docs/project/prd.md), [4.16](docs/project/prd.md)).
 *
 * One event model. [3.17](docs/project/prd.md) names two channels for it; this file carries the
 * one that exists — the in-app centre behind the bell — and nothing here anticipates push. What
 * arrives with push is a preference per category; what is here is the row the centre lists, and
 * a row is the same row whichever channel later carries it.
 *
 * **The kinds are declared once**, here, and the database derives its enum from the tuple rather
 * than restating it — `tools/domain-declarations.ts` registers {@link NOTIFICATION_KINDS} so a
 * second copy anywhere fails the build the way a restated `ROLES` already does.
 *
 * **Two of the five are composed by a person.** An admin announcement is a message from the group's
 * admin; a new-feature notice is the product saying what is new, which is why it carries a link
 * into an onboarding rather than a link an admin types. Both come through one route with a kind
 * picker, because they are the same act — a title, a body, and everybody — differing in who is
 * speaking and where a press lands.
 */

/**
 * The two kinds an admin sends from the console ([3.17.9](docs/project/prd.md),
 * [3.17.17](docs/project/prd.md)). A subset of {@link NOTIFICATION_KINDS}, spelled first so the
 * whole vocabulary below is built from it rather than beside it.
 */
export const ANNOUNCEMENT_KINDS = ['announcement', 'new_feature'] as const;

export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

/**
 * Every event the centre lists. All but the last two are raised by what members and admins do in
 * the product; the last two are the announcement kinds an admin composes.
 */
export const NOTIFICATION_KINDS = [
  /** An admin published a teaching ([3.17.4](docs/project/prd.md)). Everybody. */
  'recording_published',
  /** Somebody replied to your public note ([3.17.6](docs/project/prd.md)). The author. */
  'note_reply',
  /** Somebody reacted to your public note ([3.17.16](docs/project/prd.md)). The author. */
  'note_reaction',
  /**
   * A member reported a public note (Apple guideline 1.2, Google Play UGC policy). Every active
   * admin, one row per report: a report is a request for a person to look, and the bell is where
   * admins already learn that something waits on them.
   */
  'note_reported',
  /**
   * An admin acted on a report you made — the note was removed, or reviewed and left up. The
   * reporter, once per report, so "timely responses" is something the member can see rather than
   * infer from a note going quiet.
   */
  'report_resolved',
  /**
   * An AI summary reached draft and was waiting on an admin ([3.17.10](docs/project/prd.md),
   * [3.6.3](docs/project/prd.md)). **Nothing raises it any more**: the operator took pipeline
   * updates out of the bell, so the review queue and the pipeline view are where a waiting draft
   * is read. The value stays because it is a database enum with rows already written under it —
   * the centre still has to name those — and dropping it is a migration for another day.
   *
   * [3.17.12](docs/project/prd.md)'s processing-failure notice was never here for the same
   * reason: the pipeline view is where failures are read.
   */
  'summary_ready',
  /** A member raised an SOS signal ([3.17.7](docs/project/prd.md), [3.16.3](docs/project/prd.md)). Everybody but the member. */
  'sos_raised',
  /** Somebody replied to your SOS signal ([3.17.8](docs/project/prd.md), [3.16.7](docs/project/prd.md)). The author. */
  'sos_reply',
  ...ANNOUNCEMENT_KINDS,
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

export function isAnnouncementKind(value: unknown): value is AnnouncementKind {
  return typeof value === 'string' && (ANNOUNCEMENT_KINDS as readonly string[]).includes(value);
}

/**
 * The word the centre prints over a row, and the console prints over a past send. One table
 * rather than a `switch` in each surface, so the member and the admin read the same name for the
 * same kind.
 */
export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  recording_published: 'New recording',
  note_reply: 'Reply',
  note_reaction: 'Reaction',
  note_reported: 'Report',
  report_resolved: 'Report reviewed',
  summary_ready: 'Summary ready',
  sos_raised: 'Prayer request',
  sos_reply: 'Prayer request reply',
  announcement: 'Announcement',
  new_feature: 'New feature',
};

// =================================================================================================
// The wire contract — the centre
// =================================================================================================

/** The signed-in account's notifications, relative to the `/api/v1` prefix. `GET` lists them. */
export const NOTIFICATIONS_PATH = '/notifications';

/** `PUT` — every notification the account has is read. */
export const NOTIFICATIONS_READ_ALL_PATH = `${NOTIFICATIONS_PATH}/read`;

/** `PUT` — this one notification is read. Always the caller's own; anybody else's is `not_found`. */
export function notificationReadPath(notificationId: string): string {
  return `${NOTIFICATIONS_PATH}/${notificationId}/read`;
}

/** The centre itself, on the web origin — where the bell goes ([3.17.2](docs/project/prd.md)). */
export const NOTIFICATIONS_PAGE_PATH = '/notifications';

/**
 * The most notifications one read answers with. The centre opens on the ten most recent and reads
 * the next ten each time the member scrolls to the bottom ({@link NOTIFICATIONS_BEFORE_PARAM}), so
 * the first paint is one screen of rows and older rows are paid for only when scrolled to.
 */
export const NOTIFICATIONS_PAGE_SIZE = 10;

/**
 * Query parameter of `GET /api/v1/notifications` — the id of the last notification the caller has
 * already been shown. The answer is the page that follows it: older rows only. Absent, the answer
 * is the first page. An id that is not one of the caller's own notifications is `invalid_input`,
 * which is also the answer for anybody else's id, so the parameter reports nothing about which ids
 * exist.
 */
export const NOTIFICATIONS_BEFORE_PARAM = 'before';

/**
 * One notification, as the member is answered.
 *
 * `href` is **where a press lands** ([3.17.3](docs/project/prd.md)) — a teaching's page for a
 * publish, a reply or a reaction; an onboarding for a new feature — and `null` for an admin
 * announcement, whose content is the notification itself. It is a path on the web origin, never a
 * URL: the client is on the origin already, and a stored absolute URL would be a stored hostname.
 *
 * `readAt` is the read state ([4.16](docs/project/prd.md)); `null` is unread, and the count the
 * bell shows is the number of these that are `null`.
 */
export interface NotificationView {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
  /** ISO 8601, or `null` while unread. */
  readonly readAt: string | null;
  /** ISO 8601. */
  readonly createdAt: string;
}

/**
 * Payload of `GET /api/v1/notifications` — one page of at most {@link NOTIFICATIONS_PAGE_SIZE},
 * newest first, and the unread count **over every row**, not only the ones listed. The bell reads
 * the count; the centre reads the list; one request answers both so the two cannot disagree.
 *
 * `nextCursor` is what to send as {@link NOTIFICATIONS_BEFORE_PARAM} for the page after this one,
 * and `null` when this page reaches the member's oldest row. The centre stops asking at `null`
 * rather than at a short page, so a page that happens to be exactly full is never read as the end.
 */
export interface NotificationListPayload {
  readonly notifications: readonly NotificationView[];
  readonly unreadCount: number;
  readonly nextCursor: string | null;
}

/** Payload of `PUT /api/v1/notifications/{id}/read` — the row as it now reads, and the new count. */
export interface NotificationReadPayload {
  readonly notification: NotificationView;
  readonly unreadCount: number;
}

/** Payload of `PUT /api/v1/notifications/read` — how many were unread a moment ago. */
export interface NotificationsReadAllPayload {
  readonly marked: number;
  readonly unreadCount: 0;
}

// =================================================================================================
// The wire contract — the console
// =================================================================================================

/** What an admin sends, relative to the `/api/v1` prefix. `POST` sends one; `GET` lists past sends. */
export const ANNOUNCEMENTS_PATH = '/announcements';

/** The console's seventh panel, on the web origin rather than under the API prefix. */
export const ADMIN_ANNOUNCEMENTS_PAGE_PATH = '/admin/announcements';

/**
 * The two ceilings. A title is a line the bell's list prints; a body is a paragraph the centre
 * opens. Enforced by the API before a write and by the database beside it, so the numbers live
 * here once and both read them.
 */
export const MAX_ANNOUNCEMENT_TITLE_LENGTH = 120;

export const MAX_ANNOUNCEMENT_BODY_LENGTH = 1_000;

/**
 * Body of `POST /api/v1/announcements`.
 *
 * `onboardingId` is **required on a new feature and refused on an announcement**: a new-feature
 * notice exists to take a member into the onboarding that shows the feature, so one without a
 * destination is not one; and an admin announcement carries no link at all, so a destination on
 * one would be a link nobody decided on. The id is typed by the admin and checked by the server
 * against `ONBOARDING_IDS` — a notice pointing at an onboarding that does not exist would be a
 * press that lands on a 404 for every member at once.
 */
export interface SendAnnouncementRequest {
  readonly kind: AnnouncementKind;
  readonly title: string;
  readonly body: string;
  readonly onboardingId?: OnboardingId | null;
}

/** One past send, as the console lists it. */
export interface AnnouncementView {
  readonly id: string;
  readonly kind: AnnouncementKind;
  readonly title: string;
  readonly body: string;
  readonly onboardingId: OnboardingId | null;
  /** The admin who sent it, by display name. */
  readonly sentByDisplayName: string;
  /** How many accounts a row was written for — every active account at the moment of sending. */
  readonly recipientCount: number;
  /** ISO 8601. */
  readonly sentAt: string;
}

/** Payload of `POST /api/v1/announcements`. */
export interface SendAnnouncementPayload {
  readonly announcement: AnnouncementView;
}

/** Payload of `GET /api/v1/announcements` — every past send, newest first. */
export interface AnnouncementListPayload {
  readonly announcements: readonly AnnouncementView[];
}

// =================================================================================================
// The sentences
// =================================================================================================

/**
 * How long of a note's text a reply or reaction notification quotes. A line, not the note: the
 * centre is a list, and the whole text is one press away on the teaching.
 */
export const NOTIFICATION_EXCERPT_LENGTH = 120;

/**
 * The first line of a note, for a notification's body. Whitespace collapsed and cut with an
 * ellipsis — the same excerpt whether the reply was one word or the full thousand characters.
 */
export function excerptForNotification(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= NOTIFICATION_EXCERPT_LENGTH) return flat;
  return `${flat.slice(0, NOTIFICATION_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

/**
 * **The two titles that name a person**, spelled once.
 *
 * A notification's title is denormalised on purpose — it says what the member was told at the
 * time — and ordinarily nothing rewrites it. Account deletion is the one exception
 * ([3.1.8](docs/project/prd.md); packages/db/src/README.md): the person named in "Ana replied to
 * your note" has asked to be gone, so the title is rewritten with the placeholder's name. The
 * service that writes the title and the erasure that rewrites it both call these, which is what
 * stops the rewrite from having to guess how the original was phrased.
 */
export function noteReplyNotificationTitle(displayName: string): string {
  return `${displayName} replied to your note`;
}

export function noteReactionNotificationTitle(displayName: string): string {
  return `${displayName} reacted to your note`;
}

/**
 * The title an admin reads when a member reports a note. It names the reporter — an admin acting
 * on a report may need to speak to the person who made it — and never the note's author, who is
 * one press away on the console and is not the subject of the notice.
 */
export function noteReportedNotificationTitle(reporterDisplayName: string): string {
  return `${reporterDisplayName} reported a note`;
}

/**
 * The two sentences a reporter reads when an admin closes their report. Neither names the admin:
 * a decision of the group's moderation is the product's answer, not one person's.
 */
export const REPORT_REMOVED_TITLE = 'The note you reported was removed';
export const REPORT_DISMISSED_TITLE = 'The note you reported was reviewed';
