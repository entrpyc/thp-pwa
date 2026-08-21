import { asc, eq } from 'drizzle-orm';
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
  readonly correctedAt: Date | null;
  readonly correctedByUserId: string | null;
}

/** One segment as a writer supplies it. The id and the parent are the table's business. */
export interface NewSegmentText {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
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
