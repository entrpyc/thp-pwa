import type { NotificationKind } from './notifications';

/**
 * **Push delivery — the categories a member switches, the devices a push reaches, and the wire
 * contract for both** ([3.17.1](docs/project/prd.md), [3.17.13](docs/project/prd.md),
 * [3.17.14](docs/project/prd.md), [5.2.5](docs/project/prd.md)).
 *
 * Push is the **second delivery of the same rows** the in-app centre already lists. Nothing here
 * composes a message: a push carries the `notification` row's own title, body and destination,
 * fixed at the moment the event was written, and the row stays in the centre whether or not any
 * device was reached. What this file adds is the *gate* in front of that second delivery — a
 * preference per category — and the *addresses* it is delivered to — one subscription per device.
 *
 * **Categories, not kinds.** A member switches "notes", not "reply" and "reaction" separately: a
 * list of eight switches for a product with eight events would be a settings page that grows with
 * every ticket and asks a member to understand the event model. Four categories cover the
 * vocabulary, and a later kind — an SOS signal, a video — joins one of them by adding one line to
 * {@link NOTIFICATION_CATEGORY_OF_KIND}, which the type forces: a kind without a category does not
 * compile.
 *
 * **On by default.** No preference row means push is on for that category; the row exists to say
 * *off*. The operator chose this: a member who turns push on for their device expects to hear about
 * a new teaching without first visiting four switches. What is never on by default is the
 * *device*: no push reaches anybody until they press *Turn on push on this device* and the
 * platform's own permission prompt is answered — which is the one press Apple guideline 5.1.2
 * and every browser require to come from the member, never from a page load.
 *
 * **Admin announcements can be muted like anything else** (3.17.14): "announcements" is an
 * ordinary category with an ordinary switch. The admin-only category is the one a member never
 * sees — a member is never a recipient of a draft-ready or reported-note notice, so a switch for
 * it would be a switch over nothing.
 */

/**
 * The four categories a member can switch, in the order the settings section lists them. Declared
 * once here and derived into the database enum, like every vocabulary beside it.
 */
export const NOTIFICATION_CATEGORIES = [
  /** A teaching went live ([3.17.4](docs/project/prd.md)). */
  'recordings',
  /** Replies and reactions to your notes, and the outcome of a report you made. */
  'notes',
  /** What an admin or the product sent to everybody ([3.17.9](docs/project/prd.md), 3.17.17). */
  'announcements',
  /** What waits on an admin — a draft, a reported note. Listed for admins only. */
  'admin_alerts',
  /** SOS signals raised, and replies to your own ([3.16](docs/project/prd.md), [3.17.14](docs/project/prd.md)). */
  'sos',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return (
    typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Which category each kind belongs to. **Exhaustive by type**: adding a kind to
 * `NOTIFICATION_KINDS` without a line here fails the build, which is what keeps "every event is
 * switchable" true without anybody checking.
 */
export const NOTIFICATION_CATEGORY_OF_KIND: Record<NotificationKind, NotificationCategory> = {
  recording_published: 'recordings',
  note_reply: 'notes',
  note_reaction: 'notes',
  report_resolved: 'notes',
  announcement: 'announcements',
  new_feature: 'announcements',
  note_reported: 'admin_alerts',
  sos_reported: 'admin_alerts',
  summary_ready: 'admin_alerts',
  sos_raised: 'sos',
  sos_reply: 'sos',
};

/** The line the section prints over each switch, and the sentence under it. */
export const NOTIFICATION_CATEGORY_LABEL: Record<NotificationCategory, string> = {
  recordings: 'New recordings',
  notes: 'Your notes',
  announcements: 'Announcements',
  admin_alerts: 'Admin alerts',
  sos: 'Prayer requests',
};

export const NOTIFICATION_CATEGORY_DESCRIPTION: Record<NotificationCategory, string> = {
  recordings: 'When a new teaching is published.',
  notes: 'When somebody replies or reacts to one of your notes, and when a report you made is reviewed.',
  announcements: 'Messages from the admins, and what is new in the app.',
  admin_alerts: 'When a summary is ready for review, and when a member reports a note.',
  sos: 'When a member raises a prayer request, and when somebody replies to yours.',
};

/**
 * Categories only an admin is ever a recipient of, and therefore the only ones listed to an
 * admin and not to a member. Kept as a list rather than a flag per category so a second
 * admin-only category is one entry.
 */
export const ADMIN_ONLY_CATEGORIES: readonly NotificationCategory[] = ['admin_alerts'];

/**
 * The categories the section lists, in the declared order. Whether the admin-only ones are
 * among them is a role question, and role questions are answered by the policy module alone —
 * so this takes the answer (`can(actor, 'notification.admin-alerts')`) rather than the role.
 */
export function categoriesVisibleTo(adminAlerts: boolean): readonly NotificationCategory[] {
  return NOTIFICATION_CATEGORIES.filter(
    (category) => adminAlerts || !ADMIN_ONLY_CATEGORIES.includes(category),
  );
}

/** What a member has set, by category. A category with no entry has never been set. */
export type PushPreferences = Partial<Record<NotificationCategory, boolean>>;

/**
 * **The preference rule** (3.17.13, 3.17.14): push is allowed for a kind unless its category has
 * been switched off. Pure, so the rule is a unit test rather than a property of a query — and so
 * the query that applies it at scale (`listPushDeliveries` in `@thp/db`) has a sentence to be
 * checked against.
 */
export function isPushAllowed(kind: NotificationKind, preferences: PushPreferences): boolean {
  return preferences[NOTIFICATION_CATEGORY_OF_KIND[kind]] !== false;
}

// =================================================================================================
// Devices
// =================================================================================================

/**
 * Where a push can be delivered. `web` is a browser or the installed PWA — a Web Push endpoint
 * with its two keys; `ios` and `android` are the store shells — an APNs or FCM device token
 * (project tdd 2.1, 6.5). Declared once, derived into the database enum.
 */
export const PUSH_PLATFORMS = ['web', 'ios', 'android'] as const;

export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export function isPushPlatform(value: unknown): value is PushPlatform {
  return typeof value === 'string' && (PUSH_PLATFORMS as readonly string[]).includes(value);
}

/**
 * The longest endpoint or token a registration may carry. A Web Push endpoint is a URL of a few
 * hundred characters; a device token is shorter. Four thousand is far past both and short enough
 * that the column cannot be used to store anything else.
 */
export const MAX_PUSH_ENDPOINT_LENGTH = 4_096;

/**
 * **What a device receives.** The row's own words and destination, plus the row's id so a press
 * can be told apart from a second press. `href` is a path on the web origin, as it is in the
 * centre, and `null` for an announcement — a press on one opens the centre, which is where the
 * message lives.
 */
export interface PushMessage {
  readonly notificationId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
}

// =================================================================================================
// The wire contract
// =================================================================================================

/** The signed-in account's push switches, relative to the `/api/v1` prefix. `GET` reads, `PUT` sets one. */
export const PUSH_PREFERENCES_PATH = '/notifications/push-preferences';

/**
 * This device's registration, relative to the `/api/v1` prefix. `PUT` registers (or re-registers)
 * the device for the signed-in account; `DELETE` forgets it. `PUT` because registering the same
 * endpoint twice is one fact: a page that re-subscribes on every visit must not grow rows.
 */
export const PUSH_SUBSCRIPTIONS_PATH = '/notifications/push-subscriptions';

/** The settings section, on the web origin ([3.17.13](docs/project/prd.md)). */
export const NOTIFICATION_SETTINGS_PAGE_PATH = '/profile/notifications';

/** One switch, as the section renders it. */
export interface PushCategoryView {
  readonly category: NotificationCategory;
  readonly label: string;
  readonly description: string;
  readonly pushEnabled: boolean;
}

/**
 * Payload of `GET /api/v1/notifications/push-preferences` — the categories this account can
 * switch, each with its current setting, and the public half of the Web Push key pair so a
 * browser can subscribe. `webPush` is `null` when the deployment has no VAPID keys: the section
 * then says push is not available in a browser rather than offering a button that fails.
 */
export interface PushPreferencesPayload {
  readonly categories: readonly PushCategoryView[];
  readonly webPush: { readonly publicKey: string } | null;
}

/** Body of `PUT /api/v1/notifications/push-preferences` — one category, one setting. */
export interface PushPreferenceRequest {
  readonly category: NotificationCategory;
  readonly pushEnabled: boolean;
}

/** Payload of that `PUT` — the whole list again, as the `GET` answers, so the section re-renders from one shape. */
export type PushPreferencePayload = PushPreferencesPayload;

/**
 * Body of `PUT /api/v1/notifications/push-subscriptions`. `keys` is required on the web — a Web
 * Push message is encrypted to them — and refused on a store platform, whose token is the whole
 * address.
 */
export interface RegisterPushSubscriptionRequest {
  readonly platform: PushPlatform;
  /** The Web Push endpoint URL, or the APNs / FCM device token. */
  readonly endpoint: string;
  readonly keys?: { readonly p256dh: string; readonly auth: string };
}

export interface PushSubscriptionView {
  readonly id: string;
  readonly platform: PushPlatform;
  /** ISO 8601. */
  readonly createdAt: string;
}

export interface RegisterPushSubscriptionPayload {
  readonly subscription: PushSubscriptionView;
}

/** Body of `DELETE /api/v1/notifications/push-subscriptions` — which device, by its address. */
export interface UnregisterPushSubscriptionRequest {
  readonly endpoint: string;
}

/** Payload of that `DELETE` — whether a row of this account's was removed. */
export interface UnregisterPushSubscriptionPayload {
  readonly removed: boolean;
}
