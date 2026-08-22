import { and, eq } from 'drizzle-orm';
import { getDatabase, queryable, type DatabaseHandle, type Executor } from './client';
import { playbackProgress, user } from './schema';

/**
 * Playback state reads and writes — the speed on the account, and the position in a teaching.
 *
 * Query construction lives in this package and nowhere else, as everywhere: the import-boundary
 * guard refuses a `drizzle-orm` import from `packages/web`.
 *
 * **What is not here is the resume card.** Choosing which teaching to offer needs to know whether
 * its recording is still published, and comparing `published_at` is `visibility.ts`'s and nothing
 * else's — so `findResumeProgress` lives there, guarded, beside the rest of the read rule.
 */

export interface PlaybackProgressRow {
  readonly userId: string;
  readonly recordingId: string;
  readonly positionMs: number;
  readonly updatedAt: Date;
}

/**
 * Set the account's playback speed.
 *
 * The value is checked by the caller *and* by the check constraint on the column. Both, because the
 * route's refusal is what a person reads and the constraint is what makes the column's contents a
 * fact rather than a habit — a future writer that forgets the first still cannot get past the
 * second.
 *
 * `null` back means there is no such account, which the caller turns into a refusal.
 */
export async function setPreferredPlaybackSpeed(
  userId: string,
  speed: number,
  handle: DatabaseHandle = getDatabase(),
): Promise<number | null> {
  const rows = await handle.db
    .update(user)
    .set({ preferredPlaybackSpeed: speed, updatedAt: new Date() })
    .where(eq(user.id, userId))
    .returning({ speed: user.preferredPlaybackSpeed });
  return (rows[0] as { speed: number } | undefined)?.speed ?? null;
}

/**
 * Write where this person has got to in this teaching.
 *
 * **An upsert onto the pair, never an insert beside one.** The composite primary key is what makes
 * that possible, and between them they are the whole of "one row per person per recording": a
 * second write from a second device updates the row the first one made rather than growing a
 * history somebody would then have to reconcile.
 *
 * **Last-write-wins, plainly** — there is no `greatest()` here on purpose. A member who scrubs back
 * to re-hear something and then closes the tab is returned to where they were listening, which is
 * what [3.2.5](docs/project/prd.md) promises; "furthest" would return them to where they had got
 * to, which is the opposite.
 */
export async function upsertPlaybackProgress(
  input: { readonly userId: string; readonly recordingId: string; readonly positionMs: number },
  executor: Executor = getDatabase(),
): Promise<PlaybackProgressRow> {
  const rows = await queryable(executor)
    .insert(playbackProgress)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [playbackProgress.userId, playbackProgress.recordingId],
      set: { positionMs: input.positionMs, updatedAt: new Date() },
    })
    .returning();
  const row = rows[0] as PlaybackProgressRow | undefined;
  if (!row) throw new Error('upsertPlaybackProgress returned no row');
  return row;
}

/**
 * This person's position in this teaching, or `null` when they have none.
 *
 * `null` rather than zero: "never opened" and "at the very beginning" are different answers, and
 * the recording page treats them differently — one is nothing to seek to, the other is a seek.
 */
export async function findPlaybackProgress(
  userId: string,
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<PlaybackProgressRow | null> {
  const rows = await queryable(executor)
    .select()
    .from(playbackProgress)
    .where(
      and(eq(playbackProgress.userId, userId), eq(playbackProgress.recordingId, recordingId)),
    )
    .limit(1);
  return (rows[0] as PlaybackProgressRow | undefined) ?? null;
}
