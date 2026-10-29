import {
  deletePushSubscription,
  findPushSubscriptionOwner,
  listPushPreferences,
  setPushPreference,
  upsertPushSubscription,
} from '@thp/db';
import { isAllowedWebPushEndpoint, readPushTransportName, readVapidSettings } from '@thp/push';
import {
  MAX_PUSH_ENDPOINT_LENGTH,
  NOTIFICATION_CATEGORY_DESCRIPTION,
  NOTIFICATION_CATEGORY_LABEL,
  categoriesVisibleTo,
  isNotificationCategory,
  isPushPlatform,
  type PushPreferencePayload,
  type PushPreferences,
  type PushPreferencesPayload,
  type RegisterPushSubscriptionPayload,
  type UnregisterPushSubscriptionPayload,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { can, type Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import { isStoreToken } from './push-endpoints';

/**
 * **A member's push switches and devices** ([3.17.13](docs/project/prd.md),
 * [3.17.14](docs/project/prd.md), [3.17.1](docs/project/prd.md)) — the writes behind the
 * `/profile/notifications` section and the registration the client makes after the permission
 * prompt.
 *
 * Always the caller's own. The account comes off the session and never off the request, so the
 * routes are `SESSION` with no policy action, as the centre's are: there is nothing to authorise
 * that the store's `where` is not already deciding.
 *
 * **A member is answered the categories they can be a recipient of and nothing more.** An admin
 * sees four; a member sees three. Writing the admin-only category as a member is refused
 * `invalid_input` rather than quietly stored, because a switch for events that will never reach
 * you is not a setting, it is a misunderstanding — and the section never offers it.
 *
 * **The public VAPID key travels with the preferences** rather than being inlined at build: it is
 * configuration, it can be rotated without a rebuild, and a deployment without one is answered
 * `webPush: null` so the section says push is not available in a browser rather than offering a
 * button that fails.
 */

export async function readPushPreferencesFor(actor: Actor): Promise<PushPreferencesPayload> {
  return describePreferences(actor, await heldPreferences(actor.id));
}

export async function writePushPreferenceFor(
  actor: Actor,
  body: unknown,
): Promise<PushPreferencePayload> {
  const { category, pushEnabled } = parsePreference(body);
  if (!categoriesVisibleTo(can(actor, 'notification.admin-alerts')).includes(category)) {
    throw ApiError.invalidInput('That category is not one your account receives.');
  }
  await setPushPreference(actor.id, category, pushEnabled);
  logger.info('account.push-preference.set', {
    actorId: actor.id,
    action: 'account.push-preference',
    target: `user:${actor.id}`,
    category,
    pushEnabled,
  });
  return describePreferences(actor, await heldPreferences(actor.id));
}

/**
 * Register this device for the signed-in account. An endpoint already registered — by this
 * account on an earlier visit, or by another account on the same phone — is re-pointed, which is
 * the whole of "a device belongs to whoever signed in on it last". The keys are stored as sent;
 * the server never needs to read them, only to hand them to the push library.
 *
 * **Re-pointing stays allowed, and is logged** (security audit, finding 12). The audit read it as
 * a takeover; it is also the only thing that keeps a shared phone right when the previous member's
 * session expired without a sign-out, which is when `unregister` never ran — refusing would leave
 * the new member silent and the old one's notifications arriving on a phone they no longer hold.
 * The address itself is the secret: a push endpoint is an unguessable capability URL and a store
 * token is issued per app install, so "whoever presents it" is the device. A change of owner is
 * written at `warn`, so a pattern of them is something an operator can see.
 */
export async function registerPushSubscriptionFor(
  actor: Actor,
  body: unknown,
): Promise<RegisterPushSubscriptionPayload> {
  const input = parseRegistration(body);
  const previousOwner = await findPushSubscriptionOwner(input.endpoint);
  const row = await upsertPushSubscription({ userId: actor.id, ...input });
  if (previousOwner !== null && previousOwner !== actor.id) {
    logger.warn('account.push-subscription.repointed', {
      actorId: actor.id,
      action: 'account.push-subscription',
      target: `push_subscription:${row.id}`,
      previousOwnerId: previousOwner,
      platform: row.platform,
    });
  }
  logger.info('account.push-subscription.registered', {
    actorId: actor.id,
    action: 'account.push-subscription',
    target: `push_subscription:${row.id}`,
    platform: row.platform,
  });
  return {
    subscription: { id: row.id, platform: row.platform, createdAt: row.createdAt.toISOString() },
  };
}

/**
 * Forget this device — sign-out's call, made before the session goes. Another account's endpoint
 * is `removed: false`, the same answer as an endpoint nobody registered; the route does not say
 * which it was.
 */
export async function unregisterPushSubscriptionFor(
  actor: Actor,
  body: unknown,
): Promise<UnregisterPushSubscriptionPayload> {
  const endpoint = parseEndpoint(
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['endpoint'] : undefined,
  );
  const removed = await deletePushSubscription(actor.id, endpoint);
  logger.info('account.push-subscription.removed', {
    actorId: actor.id,
    action: 'account.push-subscription',
    target: `user:${actor.id}`,
    removed,
  });
  return { removed };
}

// =================================================================================================
// Shapes
// =================================================================================================

async function heldPreferences(userId: string): Promise<PushPreferences> {
  const held: Partial<Record<string, boolean>> = {};
  for (const row of await listPushPreferences(userId)) held[row.category] = row.pushEnabled;
  return held as PushPreferences;
}

function describePreferences(actor: Actor, held: PushPreferences): PushPreferencesPayload {
  const vapid = readVapidSettingsQuietly();
  return {
    categories: categoriesVisibleTo(can(actor, 'notification.admin-alerts')).map((category) => ({
      category,
      label: NOTIFICATION_CATEGORY_LABEL[category],
      description: NOTIFICATION_CATEGORY_DESCRIPTION[category],
      // On unless a row says off — the default the operator chose, applied in one place.
      pushEnabled: held[category] !== false,
    })),
    webPush: vapid === null ? null : { publicKey: vapid.publicKey },
  };
}

/**
 * A VAPID pair set wrongly is a deployment mistake the dispatcher logs at the first send; here
 * it reads as "no browser push", so the section still renders and the switches still save.
 */
function readVapidSettingsQuietly(): { publicKey: string } | null {
  try {
    return readVapidSettings();
  } catch (caught) {
    logger.error('push.misconfigured', {
      platform: 'web',
      reason: caught instanceof Error ? caught.message : String(caught),
    });
    return null;
  }
}

function parsePreference(body: unknown): { category: import('@thp/shared').NotificationCategory; pushEnabled: boolean } {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the category and pushEnabled.');
  }
  const { category, pushEnabled } = body as Record<string, unknown>;
  if (!isNotificationCategory(category)) {
    throw ApiError.invalidInput('Name one of the notification categories.');
  }
  if (typeof pushEnabled !== 'boolean') {
    throw ApiError.invalidInput('pushEnabled must be true or false.');
  }
  return { category, pushEnabled };
}

function parseRegistration(body: unknown): {
  platform: import('@thp/shared').PushPlatform;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
} {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the platform and the endpoint.');
  }
  const { platform, endpoint, keys } = body as Record<string, unknown>;
  if (!isPushPlatform(platform)) {
    throw ApiError.invalidInput('Say whether this device is web, ios or android.');
  }
  const address = parseEndpoint(endpoint);

  if (platform === 'web') {
    const pair = typeof keys === 'object' && keys !== null ? (keys as Record<string, unknown>) : {};
    const p256dh = pair['p256dh'];
    const auth = pair['auth'];
    if (!isKey(p256dh) || !isKey(auth)) {
      throw ApiError.invalidInput('A web subscription needs its p256dh and auth keys.');
    }
    // The capture transport never contacts the address, and the integration suite registers
    // endpoints on an invented host so that only the capture ever sees them; the allow-list is
    // what the real transport is protected by (push-endpoints.ts says from what).
    const anyHost = readPushTransportName() === 'capture';
    if (!(anyHost ? /^https:\/\//.test(address) : isAllowedWebPushEndpoint(address))) {
      throw ApiError.invalidInput(
        'A web push endpoint is an https URL on one of the push services browsers use.',
      );
    }
    return { platform, endpoint: address, p256dh, auth };
  }

  if (keys !== undefined && keys !== null) {
    throw ApiError.invalidInput('A store device carries a token and no keys.');
  }
  if (!isStoreToken(platform, address)) {
    throw ApiError.invalidInput('A store device token is the string its push service issued.');
  }
  return { platform, endpoint: address, p256dh: null, auth: null };
}

function parseEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.invalidInput('Give the device endpoint or token.');
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_PUSH_ENDPOINT_LENGTH) {
    throw ApiError.invalidInput('That endpoint is longer than any push address.');
  }
  return trimmed;
}

/** Base64url, a few dozen to a few hundred characters: what both Web Push keys look like. */
function isKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(value);
}
