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
 * Every event the centre lists. Three are raised by what members and admins do in the product;
 * the last two are the announcement kinds an admin composes.
 */
export const NOTIFICATION_KINDS = [
  /** An admin published a teaching ([3.17.4](docs/project/prd.md)). Everybody. */
  'recording_published',
  /** Somebody replied to your public note ([3.17.6](docs/project/prd.md)). The author. */
  'note_reply',
  /** Somebody reacted to your public note ([3.17.16](docs/project/prd.md)). The author. */
  'note_reaction',
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
 * The most notifications one read answers with. The centre is a list of recent events, not an
 * archive: fifty is a few weeks of a busy group, and older rows stay stored without being listed.
 */
export const NOTIFICATIONS_PAGE_SIZE = 50;

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
 * Payload of `GET /api/v1/notifications` — the most recent {@link NOTIFICATIONS_PAGE_SIZE}, newest
 * first, and the unread count **over every row**, not only the ones listed. The bell reads the
 * count; the centre reads the list; one request answers both so the two cannot disagree.
 */
export interface NotificationListPayload {
  readonly notifications: readonly NotificationView[];
  readonly unreadCount: number;
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
