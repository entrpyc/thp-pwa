import { and, eq } from 'drizzle-orm';
import { getDatabase, type DatabaseHandle } from './client';
import { userOnboarding } from './schema';

/**
 * Onboarding completion reads and writes. Query construction lives in this package and nowhere
 * else, as everywhere: the import-boundary guard refuses a `drizzle-orm` import from
 * `packages/web`.
 *
 * Which ids are real onboardings is not this module's question — the caller checks against
 * `ONBOARDING_IDS` before writing, and the column stores what it is given.
 */

export interface UserOnboardingRow {
  readonly userId: string;
  readonly onboardingId: string;
  readonly completedAt: Date;
}

/**
 * Record that this account has been through this onboarding.
 *
 * **Idempotent on the pair, and the first completion is the one that stands.** A member who is
 * routed back into an onboarding by hand and finishes it again has not completed it a second
 * time — `onConflictDoNothing` leaves the original row alone, and the re-read below is what lets
 * the caller report the moment it actually happened rather than the moment it was repeated.
 */
export async function completeOnboarding(
  userId: string,
  onboardingId: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<UserOnboardingRow> {
  const inserted = await handle.db
    .insert(userOnboarding)
    .values({ userId, onboardingId, completedAt: new Date() })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0] as UserOnboardingRow | undefined;
  if (row) return row;

  const existing = await findOnboardingCompletion(userId, onboardingId, handle);
  if (!existing) throw new Error('completeOnboarding inserted nothing and found nothing');
  return existing;
}

/** This account's completion of this onboarding, or `null` when it has never finished it. */
export async function findOnboardingCompletion(
  userId: string,
  onboardingId: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<UserOnboardingRow | null> {
  const rows = await handle.db
    .select()
    .from(userOnboarding)
    .where(and(eq(userOnboarding.userId, userId), eq(userOnboarding.onboardingId, onboardingId)))
    .limit(1);
  return (rows[0] as UserOnboardingRow | undefined) ?? null;
}
