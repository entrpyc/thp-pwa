import type { AnalyticsPreferencePayload, AnalyticsPreferenceRequest } from '@thp/shared';
import { setAnalyticsOptOut } from '@thp/db';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * **Turn product analytics off or on for the signed-in account** (Apple guideline 5.1.1(ii)).
 *
 * The shape `writePlaybackSpeed` has: parse, write the row, log, answer with what the row holds.
 * The parse is strict — a boolean and nothing that coerces to one — because `"false"` is a string
 * that reads as consent withdrawn and would be stored as consent given, and that is the one
 * mistake this route must not be able to make.
 *
 * The log line carries the new value and the actor, as every account write's does, and **nothing
 * is sent to analytics about the change itself**: an event saying "this person opted out" is
 * exactly the event they just said not to send.
 */
export async function writeAnalyticsPreference(
  actor: Actor,
  body: unknown,
): Promise<AnalyticsPreferencePayload> {
  const optedOut = parseOptedOut(body);
  const written = await setAnalyticsOptOut(actor.id, optedOut);
  if (written === null) throw ApiError.notFound('There is no such account.');

  logger.info('account.analytics.set', {
    actorId: actor.id,
    action: 'account.analytics',
    target: `user:${actor.id}`,
    optedOut: written,
  });

  return { optedOut: written };
}

function parseOptedOut(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with optedOut.');
  }
  const { optedOut } = body as Partial<AnalyticsPreferenceRequest>;
  if (typeof optedOut !== 'boolean') {
    throw ApiError.invalidInput('optedOut must be true or false.');
  }
  return optedOut;
}
