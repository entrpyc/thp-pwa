import { completeOnboarding, findOnboardingCompletion } from '@thp/db';
import {
  NEW_USER_ONBOARDING_ID,
  isOnboardingId,
  type OnboardingCompletionPayload,
  type OnboardingId,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';

/**
 * Onboarding completions — recording one, and answering the one question sign-in asks.
 *
 * Always about the caller's own account: the account comes from the session and never from the
 * request, so there is no resource to authorise against — the same shape playback progress takes.
 */

/**
 * Record that this account has finished (or skipped past) an onboarding.
 *
 * The id is checked against the shared list before it touches the database: the column stores
 * whatever it is given, and a typo'd id recorded as completed would be a completion nobody could
 * ever be routed by. Unknown id → `not_found`, exactly as the page answers the same mistake.
 */
export async function recordOnboardingCompletion(
  actor: Actor,
  onboardingId: string,
): Promise<OnboardingCompletionPayload> {
  if (!isOnboardingId(onboardingId)) {
    throw ApiError.notFound('There is no such onboarding.');
  }
  const row = await completeOnboarding(actor.id, onboardingId);
  return { onboardingId, completedAt: row.completedAt.toISOString() };
}

/**
 * The onboarding a fresh session should be routed into, or `null` when there is none.
 *
 * Today that is one question — has this account been through the new-user onboarding — and the
 * `null` answer is what keeps sign-in a straight line for everybody who has.
 */
export async function pendingOnboardingFor(actorId: string): Promise<OnboardingId | null> {
  const completed = await findOnboardingCompletion(actorId, NEW_USER_ONBOARDING_ID);
  return completed === null ? NEW_USER_ONBOARDING_ID : null;
}
