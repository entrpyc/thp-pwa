import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  NOTIFICATION_CATEGORY_OF_KIND,
  type NotificationCategory,
  type NotificationKind,
  type PushPlatform,
} from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { notification, notificationPreference, pushSubscription } from './schema';

/**
 * **Push preferences and device subscriptions at the database** ([3.17.1](docs/project/prd.md),
 * [3.17.13](docs/project/prd.md)).
 *
 * Every statement against `notification_preference` and `push_subscription` lives here. As in
 * `notifications.ts`, the module answers *which rows* and never *may this person*: the account on
 * every read and write is the id the service hands in off the session.
 *
 * **The delivery read is one query.** {@link listPushDeliveries} joins the rows just written to
 * the devices of their recipients and applies the preference rule in the `where`, so a broadcast
 * to a thousand members is one statement answering the addresses to reach rather than a thousand
 * reads of one member's switches. The rule it applies is the sentence `isPushAllowed` in
 * `@thp/shared` states — "allowed unless the kind's category is switched off" — and the kind →
 * category table is handed to the query as a `values` list derived from the same constant, so
 * the two cannot drift.
 *
 * Crosses its boundary as row types in and out, plus an {@link Executor}. Drizzle never leaves.
 */

/** One `notification_preference` row — a category a member has set. */
export interface PushPreferenceRow {
  readonly category: NotificationCategory;
  readonly pushEnabled: boolean;
}

/** One `push_subscription` row. */
export interface PushSubscriptionRow {
  readonly id: string;
  readonly userId: string;
  readonly platform: PushPlatform;
  readonly endpoint: string;
  readonly p256dh: string | null;
  readonly auth: string | null;
  readonly createdAt: Date;
}

export interface NewPushSubscription {
  readonly userId: string;
  readonly platform: PushPlatform;
  readonly endpoint: string;
  readonly p256dh: string | null;
  readonly auth: string | null;
}

/**
 * One push to send: the notification's words and where it goes. The join of a row the service
 * just wrote and one device of its recipient, with the recipient's switch already applied.
 */
export interface PushDeliveryRow {
  readonly notificationId: string;
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
  readonly subscriptionId: string;
  readonly platform: PushPlatform;
  readonly endpoint: string;
  readonly p256dh: string | null;
  readonly auth: string | null;
}

const SUBSCRIPTION_COLUMNS = {
  id: pushSubscription.id,
  userId: pushSubscription.userId,
  platform: pushSubscription.platform,
  endpoint: pushSubscription.endpoint,
  p256dh: pushSubscription.p256dh,
  auth: pushSubscription.auth,
  createdAt: pushSubscription.createdAt,
} as const;

// =================================================================================================
// Preferences
// =================================================================================================

/** Every category this member has set. A category absent here has never been set, which reads as on. */
export async function listPushPreferences(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<PushPreferenceRow[]> {
  const rows = await queryable(executor)
    .select({
      category: notificationPreference.category,
      pushEnabled: notificationPreference.pushEnabled,
    })
    .from(notificationPreference)
    .where(eq(notificationPreference.userId, userId))
    .orderBy(asc(notificationPreference.category));
  return rows as PushPreferenceRow[];
}

/**
 * Set one category. An upsert on the primary key: setting a category twice is one row saying the
 * last thing, and turning a category back on keeps the row rather than deleting it, so the
 * section reads back exactly what was pressed.
 */
export async function setPushPreference(
  userId: string,
  category: NotificationCategory,
  pushEnabled: boolean,
  executor: Executor = getDatabase(),
): Promise<PushPreferenceRow> {
  const rows = await queryable(executor)
    .insert(notificationPreference)
    .values({ userId, category, pushEnabled })
    .onConflictDoUpdate({
      target: [notificationPreference.userId, notificationPreference.category],
      set: { pushEnabled, updatedAt: sql`now()` },
    })
    .returning({
      category: notificationPreference.category,
      pushEnabled: notificationPreference.pushEnabled,
    });
  const row = rows[0] as PushPreferenceRow | undefined;
  if (!row) throw new Error('setPushPreference returned no row');
  return row;
}

// =================================================================================================
// Subscriptions
// =================================================================================================

/**
 * Register a device for this member, or re-point it. The endpoint is unique across the table
 * (the schema says why), so a second registration of the same endpoint — by the same member on
 * the next visit, or by another member who signed in on the same phone — updates the one row:
 * the owner, the keys, and `last_seen_at`.
 */
export async function upsertPushSubscription(
  input: NewPushSubscription,
  executor: Executor = getDatabase(),
): Promise<PushSubscriptionRow> {
  const rows = await queryable(executor)
    .insert(pushSubscription)
    .values({
      userId: input.userId,
      platform: input.platform,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscription.endpoint,
      set: {
        userId: input.userId,
        platform: input.platform,
        p256dh: input.p256dh,
        auth: input.auth,
        lastSeenAt: sql`now()`,
      },
    })
    .returning(SUBSCRIPTION_COLUMNS);
  const row = rows[0] as PushSubscriptionRow | undefined;
  if (!row) throw new Error('upsertPushSubscription returned no row');
  return row;
}

/**
 * Forget one of **this member's** devices by its address — sign-out's call. Another member's
 * endpoint finds nothing, and the service answers `removed: false` for it exactly as for an
 * address nobody registered.
 */
export async function deletePushSubscription(
  userId: string,
  endpoint: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .delete(pushSubscription)
    .where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)))
    .returning({ id: pushSubscription.id });
  return rows.length > 0;
}

/**
 * Forget devices a provider reported gone — a browser that unsubscribed, an app that was
 * uninstalled. By subscription id rather than endpoint, because the dispatcher holds the ids it
 * was handed and an endpoint re-registered between the send and the delete belongs to a row that
 * is now known to work.
 */
export async function deletePushSubscriptionsById(
  ids: readonly string[],
  executor: Executor = getDatabase(),
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await queryable(executor)
    .delete(pushSubscription)
    .where(inArray(pushSubscription.id, [...ids]))
    .returning({ id: pushSubscription.id });
  return rows.length;
}

/** This member's devices, oldest first — what a test reads, and what a later "your devices" list would. */
export async function listPushSubscriptionsForUser(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<PushSubscriptionRow[]> {
  const rows = await queryable(executor)
    .select(SUBSCRIPTION_COLUMNS)
    .from(pushSubscription)
    .where(eq(pushSubscription.userId, userId))
    .orderBy(asc(pushSubscription.createdAt), asc(pushSubscription.id));
  return rows as PushSubscriptionRow[];
}

// =================================================================================================
// Delivery
// =================================================================================================

/**
 * **Every push to send for these notifications**: each row joined to every device of its
 * recipient, minus the recipients whose switch for the row's category is off.
 *
 * The kind → category table travels as a `values` list built from the shared constant, so the
 * rule the query applies is the rule `isPushAllowed` states. `coalesce(push_enabled, true)` is the
 * default-on in one place: a recipient with no row for the category is reached.
 */
export async function listPushDeliveries(
  notificationIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<PushDeliveryRow[]> {
  if (notificationIds.length === 0) return [];

  const categoryOfKind = sql.join(
    Object.entries(NOTIFICATION_CATEGORY_OF_KIND).map(
      ([kind, category]) => sql`(${kind}::notification_kind, ${category}::notification_category)`,
    ),
    sql`, `,
  );

  const rows = await queryable(executor).execute(sql`
    with category_of (kind, category) as (values ${categoryOfKind})
    select
      ${notification.id} as "notificationId",
      ${notification.userId} as "userId",
      ${notification.kind} as "kind",
      ${notification.title} as "title",
      ${notification.body} as "body",
      ${notification.href} as "href",
      ${pushSubscription.id} as "subscriptionId",
      ${pushSubscription.platform} as "platform",
      ${pushSubscription.endpoint} as "endpoint",
      ${pushSubscription.p256dh} as "p256dh",
      ${pushSubscription.auth} as "auth"
    from ${notification}
    join category_of on category_of.kind = ${notification.kind}
    join ${pushSubscription} on ${pushSubscription.userId} = ${notification.userId}
    left join ${notificationPreference}
      on ${notificationPreference.userId} = ${notification.userId}
      and ${notificationPreference.category} = category_of.category
    where ${inArray(notification.id, [...notificationIds])}
      and coalesce(${notificationPreference.pushEnabled}, true)
    order by ${notification.id}, ${pushSubscription.createdAt}
  `);
  return rows as unknown as PushDeliveryRow[];
}
