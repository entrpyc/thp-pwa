import { and, eq, sql } from 'drizzle-orm';
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
  /** Media time heard across every visit, seeks excluded (docs/project/observability.md § 5.3). */
  readonly listenedMs: number;
  /** The length as the player last reported it, or `null` until one has. */
  readonly durationMs: number | null;
  /** When `listenedMs` first reached 80% of `durationMs`; set once, never cleared. */
  readonly completedAt: Date | null;
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
  return (await recordPlaybackProgress(input, executor)).row;
}

/** A day of listening — the most `listened_ms` may hold while the teaching's length is unknown. */
const MAX_LISTENED_TOTAL_MS = 24 * 60 * 60_000;

export interface PlaybackProgressInput {
  readonly userId: string;
  readonly recordingId: string;
  readonly positionMs: number;
  /** Media time heard since the caller's last write, already bounded by the caller. Zero when absent. */
  readonly listenedDeltaMs?: number;
  /** The length as the player reports it. Absent leaves whatever the row already knows. */
  readonly durationMs?: number;
}

export interface PlaybackProgressWrite {
  readonly row: PlaybackProgressRow;
  /**
   * Whether **this** write is the one that completed the teaching. True exactly once per pairing,
   * ever — the one moment the completion event is sent.
   */
  readonly completedNow: boolean;
}

/**
 * The write above, carrying what was heard (docs/project/observability.md § 5.3).
 *
 * **One statement.** The delta is added to the total, the duration is remembered, and
 * `completed_at` is set where it is null and the new total has reached 80% of the duration — all
 * in the same `ON CONFLICT DO UPDATE`, so two writes from two devices cannot both claim the
 * crossing: whichever lands second sees `completed_at` already set and leaves it. The comparison
 * is integer arithmetic, `listened × 5 ≥ duration × 4`, with no float to argue with.
 *
 * **Whether this write completed is read from the row**, not guessed: `completed_at` and
 * `updated_at` are both `now()` in the statement that sets them, and `now()` is one value for the
 * whole statement — so the two are equal exactly when this write set the first.
 */
export async function recordPlaybackProgress(
  input: PlaybackProgressInput,
  executor: Executor = getDatabase(),
): Promise<PlaybackProgressWrite> {
  const delta = input.listenedDeltaMs ?? 0;
  const duration = input.durationMs ?? null;
  const completesOnInsert = duration !== null && duration > 0 && delta * 5 >= duration * 4;

  const knownDuration = sql`coalesce(${duration}::integer, ${playbackProgress.durationMs})`;
  // The total is capped at twice the known length (a teaching heard twice over), or at a day when
  // no length is known: each write's delta is bounded by the caller, but two hundred of them from
  // one outbox were not, and a total that forces completion is a count the operator reads
  // (docs/security-audit-2026-10-29.md, finding 16).
  const newTotal = sql`least(${playbackProgress.listenedMs} + ${delta}::integer, coalesce(${knownDuration} * 2, ${MAX_LISTENED_TOTAL_MS}))`;

  const rows = await queryable(executor)
    .insert(playbackProgress)
    .values({
      userId: input.userId,
      recordingId: input.recordingId,
      positionMs: input.positionMs,
      updatedAt: sql`now()`,
      listenedMs: delta,
      durationMs: duration,
      completedAt: completesOnInsert ? sql`now()` : null,
    })
    .onConflictDoUpdate({
      target: [playbackProgress.userId, playbackProgress.recordingId],
      set: {
        positionMs: input.positionMs,
        updatedAt: sql`now()`,
        listenedMs: newTotal,
        durationMs: knownDuration,
        completedAt: sql`coalesce(
          ${playbackProgress.completedAt},
          case
            when ${knownDuration} > 0 and (${newTotal}) * 5 >= ${knownDuration} * 4 then now()
          end
        )`,
      },
    })
    .returning();
  const row = rows[0] as PlaybackProgressRow | undefined;
  if (!row) throw new Error('recordPlaybackProgress returned no row');
  return {
    row,
    completedNow: row.completedAt !== null && row.completedAt.getTime() === row.updatedAt.getTime(),
  };
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
