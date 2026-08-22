import { and, asc, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import { segment, transcript } from './schema';

/**
 * Transcript and segment reads and writes (Story 2 Ticket 03). Query construction lives in this
 * package and nowhere else — the import-boundary guard refuses a `drizzle-orm` import outside it.
 *
 * **The write is a replace, not an insert.** Dispatch is at-least-once: a worker killed mid-job has
 * its row reclaimed at the next boot and the handler runs again on the same recording, and Ticket
 * 04's per-step re-run does the same thing on purpose. So the only honest shape for "write the
 * transcript" is one that leaves exactly one transcript however many times it is called.
 */

export interface TranscriptRow {
  readonly id: string;
  readonly recordingId: string;
  /** BCP-47. `en` throughout this epic — pinned, not detected. */
  readonly language: string;
  /** The provider's confidence in the whole transcript, 0..1. */
  readonly confidence: number;
  readonly createdAt: Date;
}

export interface SegmentRow {
  readonly id: string;
  readonly transcriptId: string;
  /** Inclusive start offset from the beginning of the recording, in milliseconds. */
  readonly startMs: number;
  /** Exclusive end offset from the beginning of the recording, in milliseconds. */
  readonly endMs: number;
  readonly text: string;
  /** The provider's anonymous speaker index, or `null` when it attributed the sentence to nobody. */
  readonly speaker: number | null;
  readonly correctedAt: Date | null;
  readonly correctedByUserId: string | null;
}

/** One segment as a writer supplies it. The id and the parent are the table's business. */
export interface NewSegmentText {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /**
   * The provider's speaker index. `null` — and a writer that omits it entirely — is what a
   * transcript with no speaker information reads as, which is what every segment already written
   * says.
   */
  readonly speaker?: number | null;
}

export interface NewTranscript {
  readonly recordingId: string;
  readonly language: string;
  readonly confidence: number;
  readonly segments: readonly NewSegmentText[];
}

/**
 * Write this recording's transcript, replacing whatever was there.
 *
 * **Delete then insert, in one transaction**, which is the whole of what makes the transcription
 * handler idempotent. The delete cascades to the old segments, so there is no window in which the
 * recording has two transcripts or one transcript with two generations of segments in it.
 *
 * Takes an executor rather than a handle, like every write since Ticket 02, and **must be given one
 * that is a transaction** if the caller wants the replace to be atomic with anything else. On its
 * own it opens one, so a partially written transcript — a transcript with a hole in it, which
 * nothing downstream could tell from a complete one — is not a state this can leave behind.
 *
 * The segments go in as **one multi-row insert**: a 90-minute teaching is 700–900 sentences, and
 * that is one statement rather than nine hundred round trips.
 */
export async function replaceTranscript(
  input: NewTranscript,
  executor: Executor = getDatabase(),
): Promise<TranscriptRow> {
  return withTransaction(async (tx) => {
    await tx.delete(transcript).where(eq(transcript.recordingId, input.recordingId));

    const inserted = await tx
      .insert(transcript)
      .values({
        recordingId: input.recordingId,
        language: input.language,
        confidence: input.confidence,
      })
      .returning();

    const row = inserted[0] as TranscriptRow | undefined;
    if (!row) throw new Error('replaceTranscript returned no row');

    if (input.segments.length > 0) {
      await tx.insert(segment).values(
        input.segments.map((one) => ({
          transcriptId: row.id,
          startMs: one.startMs,
          endMs: one.endMs,
          text: one.text,
          speaker: one.speaker ?? null,
        })),
      );
    }

    return row;
  }, executor);
}

/** This recording's transcript, or `null` when it has none. There can never be two. */
export async function findTranscriptByRecording(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<TranscriptRow | null> {
  const rows = await queryable(executor)
    .select()
    .from(transcript)
    .where(eq(transcript.recordingId, recordingId))
    .limit(1);
  return (rows[0] as TranscriptRow | undefined) ?? null;
}

/**
 * A transcript's segments **in playback order**, decided here rather than by whichever reader asks
 * — so one answer to "what order is this transcript in" exists. `(transcript_id, start_ms)` is
 * indexed, which is the same index Story 5's follow-along reads on every tick.
 */
export async function listSegments(
  transcriptId: string,
  executor: Executor = getDatabase(),
): Promise<SegmentRow[]> {
  const rows = await queryable(executor)
    .select()
    .from(segment)
    .where(eq(segment.transcriptId, transcriptId))
    .orderBy(asc(segment.startMs));
  return rows as SegmentRow[];
}

/** One segment by id, or `null`. The parent transcript is on the row, so the caller can place it. */
export async function findSegmentById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<SegmentRow | null> {
  const rows = await queryable(executor).select().from(segment).where(eq(segment.id, id)).limit(1);
  return (rows[0] as SegmentRow | undefined) ?? null;
}

/** The segment either side of this one, in playback order. `null` at the ends of the transcript. */
export interface SegmentNeighbours {
  readonly previous: SegmentRow | null;
  readonly next: SegmentRow | null;
}

/**
 * The segments immediately before and after `id` within its transcript (Story 5 Ticket 01–02).
 *
 * **Two one-row queries rather than a scan**, both served by `segment_transcript_start_idx`: the
 * last row ordered before this one's start, and the first ordered after it. That index is the same
 * one the follow-along read uses, which is why the correction rule costs nothing to check.
 *
 * The self-exclusion is by id rather than by a strict comparison on `start_ms`, because a
 * correction that leaves the start where it is must still not find the segment itself as its own
 * neighbour.
 *
 * **Take an executor that is a transaction** when the answer is about to be acted on — the caller
 * is choosing whether a write is legal, and a read outside the write's transaction has a window in
 * it.
 */
export async function findSegmentNeighbours(
  row: SegmentRow,
  executor: Executor = getDatabase(),
): Promise<SegmentNeighbours> {
  const on = queryable(executor);
  const sameTranscript = eq(segment.transcriptId, row.transcriptId);

  const [before, after] = await Promise.all([
    on
      .select()
      .from(segment)
      .where(and(sameTranscript, lte(segment.startMs, row.startMs), ne(segment.id, row.id)))
      .orderBy(desc(segment.startMs))
      .limit(1),
    on
      .select()
      .from(segment)
      .where(and(sameTranscript, gte(segment.startMs, row.startMs), ne(segment.id, row.id)))
      .orderBy(asc(segment.startMs))
      .limit(1),
  ]);

  return {
    previous: (before[0] as SegmentRow | undefined) ?? null,
    next: (after[0] as SegmentRow | undefined) ?? null,
  };
}

/** A correction, as the caller that has already checked it supplies it. */
export interface SegmentCorrection {
  readonly id: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Who made it. Written with the timestamp, on every accepted correction. */
  readonly correctedByUserId: string;
}

/**
 * Apply a correction, stamping `corrected_at` and `corrected_by_user_id` — the two columns Story 2
 * shipped unwritten ([3.5.5](docs/project/prd.md)).
 *
 * The timestamp is `now()` from the database rather than a `Date` from this process, so the record
 * of when a line was fixed is the transaction's clock and not a caller's.
 */
export async function correctSegment(
  input: SegmentCorrection,
  executor: Executor = getDatabase(),
): Promise<SegmentRow> {
  const rows = await queryable(executor)
    .update(segment)
    .set({
      text: input.text,
      startMs: input.startMs,
      endMs: input.endMs,
      correctedAt: sql`now()`,
      correctedByUserId: input.correctedByUserId,
    })
    .where(eq(segment.id, input.id))
    .returning();

  const row = rows[0] as SegmentRow | undefined;
  if (!row) throw new Error('correctSegment returned no row');
  return row;
}
