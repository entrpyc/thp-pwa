import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { HighlightKind } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { highlight, note, recording, segment, series, transcript } from './schema';
import { noBlockBetween } from './member-blocks';
import { recordingIsPublished } from './visibility';

/**
 * **A member's Highlights** ([3.15](docs/project/prd.md)) — every statement against `highlight`.
 *
 * Owner-scoped throughout: every read and every write takes the member's id and puts it in the
 * `where`, so "private to the member" ([3.15.9](docs/project/prd.md)) is a property of calling
 * anything in this file rather than of each caller remembering a condition. There is no read that
 * takes only an entry id — a delete by id that forgot whose it was would be the one hole, so the
 * delete takes both and deletes nothing when they disagree.
 *
 * Crosses its boundary as row types in and row types out, plus an {@link Executor}, like every
 * module beside it.
 */

/** One `highlight` row. */
export interface HighlightRow {
  readonly id: string;
  readonly userId: string;
  readonly recordingId: string;
  readonly kind: HighlightKind;
  readonly positionMs: number | null;
  readonly segmentId: string | null;
  readonly noteId: string | null;
  readonly createdAt: Date;
}

/**
 * One entry as the playlist reads it: the row, the teaching it is in, the line it was snapped to
 * and the note it pins — one statement, so the list is never N+1.
 *
 * `segmentStartMs` and the two beside it are null for anything but a snapped `segment` entry;
 * `noteTimestampMs` and `noteText` for anything but a `note` entry. A tombstoned note never
 * reaches here (the read leaves it out), so `noteText` is the text whenever `noteId` is set.
 */
export interface HighlightListRow extends HighlightRow {
  readonly recordingTitle: string;
  readonly recordingDescription: string | null;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  readonly seriesId: string | null;
  readonly seriesTitle: string | null;
  /**
   * The series' cover key, or `null`. A key, and it stops at the service, which signs it — the
   * boundary every artwork read keeps. Carried so a playlist row's play control can hand the
   * transport its tile without the page fetching the teaching first.
   */
  readonly seriesArtworkKey: string | null;
  readonly segmentStartMs: number | null;
  readonly segmentEndMs: number | null;
  readonly segmentText: string | null;
  readonly noteTimestampMs: number | null;
  readonly noteText: string | null;
}

/** What a pin writes. The service decides the kind's shape; the check constraint is the backstop. */
export interface NewHighlight {
  readonly userId: string;
  readonly recordingId: string;
  readonly kind: HighlightKind;
  readonly positionMs?: number | null;
  readonly segmentId?: string | null;
  readonly noteId?: string | null;
}

const HIGHLIGHT_COLUMNS = {
  id: highlight.id,
  userId: highlight.userId,
  recordingId: highlight.recordingId,
  kind: highlight.kind,
  positionMs: highlight.positionMs,
  segmentId: highlight.segmentId,
  noteId: highlight.noteId,
  createdAt: highlight.createdAt,
} as const;

// =================================================================================================
// Reading
// =================================================================================================

/**
 * **A member's playlist, newest pinned first** ([3.15.6](docs/project/prd.md)).
 *
 * Two things are left out rather than returned flagged, and both are the product's existing
 * line for content a member may not see: an entry whose teaching is **not published** — the
 * member API refuses an unpublished teaching everywhere else, and a playlist row that opened one
 * would be the one door left ajar — and an entry whose note is a **tombstone**, because a removed
 * note's text is returned to nobody ([3.12.19](docs/project/prd.md)) and an entry with nothing to
 * print is nothing to pin. Neither is deleted by this read: a republished teaching brings its
 * entries back, which is what a member who pinned it would expect. A third, for the same reason:
 * an entry whose note is **another member's and no longer readable** — made private since, or
 * by a member now blocked either way — which the notes read path would not show either.
 *
 * The recording join is inner — the key cascades, so a highlight always has one — and the rest
 * are left joins over nullable keys. The line's text comes by its **id**, not by its position, so
 * a transcript replaced since the pin (which set the id null) prints the moment alone rather than
 * a line the new segmentation happens to start at the same millisecond.
 */
export async function listHighlightsForMember(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<HighlightListRow[]> {
  const rows = await queryable(executor)
    .select({
      ...HIGHLIGHT_COLUMNS,
      recordingTitle: recording.title,
      recordingDescription: recording.description,
      recordedAt: recording.recordedAt,
      seriesId: series.id,
      seriesTitle: series.title,
      seriesArtworkKey: series.artworkKey,
      segmentStartMs: segment.startMs,
      segmentEndMs: segment.endMs,
      segmentText: segment.text,
      noteTimestampMs: note.timestampMs,
      noteText: note.text,
    })
    .from(highlight)
    .innerJoin(recording, eq(recording.id, highlight.recordingId))
    .leftJoin(series, eq(series.id, recording.seriesId))
    .leftJoin(segment, eq(segment.id, highlight.segmentId))
    .leftJoin(note, eq(note.id, highlight.noteId))
    .where(
      and(
        eq(highlight.userId, userId),
        recordingIsPublished(),
        or(isNull(highlight.noteId), isNull(note.deletedAt)),
        or(
          isNull(highlight.noteId),
          eq(note.authorId, userId),
          and(eq(note.visibility, 'public'), noBlockBetween(userId, note.authorId)),
        ),
      ),
    )
    .orderBy(desc(highlight.createdAt), desc(highlight.id));
  return rows as HighlightListRow[];
}

/** How many entries this member holds, hidden or not — what the ceiling counts. */
export async function countHighlightsForMember(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .select({ count: sql<number>`count(*)::int` })
    .from(highlight)
    .where(eq(highlight.userId, userId));
  return rows[0]?.count ?? 0;
}

/** One entry by id **and owner**, or `null`. A test's read; the service answers the list. */
export async function findHighlightForMember(
  id: string,
  userId: string,
  executor: Executor = getDatabase(),
): Promise<HighlightRow | null> {
  const rows = await queryable(executor)
    .select(HIGHLIGHT_COLUMNS)
    .from(highlight)
    .where(and(eq(highlight.id, id), eq(highlight.userId, userId)))
    .limit(1);
  return (rows[0] as HighlightRow | undefined) ?? null;
}

/**
 * The entry this member already holds for this target, or `null` — the same three identities the
 * partial unique indexes state, asked before a write so the ceiling can let a duplicate press
 * through without counting it. `positionMs` here is the position **as it will be stored**: the
 * service snaps before it asks.
 */
export async function findHighlightByTarget(
  input: NewHighlight,
  executor: Executor = getDatabase(),
): Promise<HighlightRow | null> {
  const identity =
    input.kind === 'note'
      ? eq(highlight.noteId, input.noteId ?? '')
      : input.kind === 'segment'
        ? and(eq(highlight.recordingId, input.recordingId), eq(highlight.positionMs, input.positionMs ?? -1))
        : eq(highlight.recordingId, input.recordingId);
  const rows = await queryable(executor)
    .select(HIGHLIGHT_COLUMNS)
    .from(highlight)
    .where(and(eq(highlight.userId, input.userId), eq(highlight.kind, input.kind), identity))
    .limit(1);
  return (rows[0] as HighlightRow | undefined) ?? null;
}

/**
 * **The transcript line playing at this moment** of this teaching, or `null` — a teaching with no
 * transcript, or a position before its first line or after its last.
 *
 * What "this moment" is snapped to ([3.15.2](docs/project/prd.md)): the line whose span holds the
 * position, start inclusive and end exclusive, the same arithmetic the caption pill uses on every
 * tick. Lines never overlap, so the latest start at or before the position is the one, and the
 * `(transcript, start)` index answers it in one probe.
 */
export async function findSegmentAt(
  recordingId: string,
  positionMs: number,
  executor: Executor = getDatabase(),
): Promise<{ readonly id: string; readonly startMs: number; readonly endMs: number } | null> {
  const rows = await queryable(executor)
    .select({ id: segment.id, startMs: segment.startMs, endMs: segment.endMs })
    .from(segment)
    .innerJoin(transcript, eq(transcript.id, segment.transcriptId))
    .where(
      and(
        eq(transcript.recordingId, recordingId),
        lte(segment.startMs, positionMs),
        gt(segment.endMs, positionMs),
      ),
    )
    .orderBy(asc(segment.startMs))
    .limit(1);
  return rows[0] ?? null;
}

// =================================================================================================
// Writing
// =================================================================================================

/**
 * Pin an entry, or leave it pinned.
 *
 * `on conflict do nothing` over whichever of the three identities the kind has, which is what
 * makes a second press idempotent rather than a refusal: a member pinning from a stale screen has
 * still got what they asked for. Answers whether a row was written, which the service logs and
 * nothing else reads — every write answers the list.
 */
export async function insertHighlight(
  input: NewHighlight,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .insert(highlight)
    .values({
      userId: input.userId,
      recordingId: input.recordingId,
      kind: input.kind,
      positionMs: input.positionMs ?? null,
      segmentId: input.segmentId ?? null,
      noteId: input.noteId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: highlight.id });
  return rows.length > 0;
}

/**
 * Remove an entry **the member owns** ([3.15.8](docs/project/prd.md)). An id that is somebody
 * else's deletes nothing and answers `false`, indistinguishable from an id that is nobody's —
 * which is the whole of how the API refuses without revealing (3.15.9). Deleting nothing is a
 * success at the service: the member asked for an end state and has it.
 */
export async function deleteHighlightForMember(
  id: string,
  userId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .delete(highlight)
    .where(and(eq(highlight.id, id), eq(highlight.userId, userId)))
    .returning({ id: highlight.id });
  return rows.length > 0;
}

/**
 * Every entry pinning this note, whoever's — **what a soft delete has to do by hand.**
 *
 * The key on `note_id` cascades, and a tombstone fires no cascade: the row stays to hold its
 * thread's shape ([3.12.18](docs/project/prd.md)). So the notes service calls this in the delete's
 * own transaction, the way it clears the admin pin and the vector, and the entry goes with the
 * text — a pinned note that reads "this note was removed" would be an entry with nothing to show.
 * Any reader may have pinned a public note, so "whoever's" is every member's entry on it.
 */
export async function deleteHighlightsOfNote(
  noteId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .delete(highlight)
    .where(eq(highlight.noteId, noteId))
    .returning({ id: highlight.id });
  return rows.length;
}
