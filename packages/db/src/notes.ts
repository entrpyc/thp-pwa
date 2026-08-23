import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { note } from './schema';
import type { NoteVisibility } from '@thp/shared';

/**
 * **The private-note condition, written once** — `visibility = 'public' or author_id = :me`.
 *
 * Every statement against `note` lives here, and this module is the only place in the codebase
 * allowed to decide which notes a given reader may see. tests/guards/note-privacy.test.ts refuses a
 * predicate over `note.visibility` or `note.author_id` anywhere else, which is what turns the
 * Privacy NFR — *"a private note is excluded by the query that reads notes, not by the interface
 * that renders them"* — from a claim into something a build can fail on.
 *
 * **What is not here is publication.** No statement in this file compares `recording.published_at`:
 * that is `visibility.ts`'s condition and tests/guards/visibility-boundary.test.ts refuses a second
 * copy of it. This module is handed a recording id the service has already gated, and it answers
 * *which rows*, never *may this person* — authorisation is the policy module's.
 *
 * **Crosses its boundary as row types in and row types out**, plus an {@link Executor} so a caller
 * can pull a write into a transaction — the same shape `transcripts.ts` and `playback.ts` already
 * take. Drizzle never leaves the package.
 */

/**
 * One `note` row.
 *
 * Every stored column except the two generated ones. `is_reply` and `parent_is_reply` are how the
 * one-level rule becomes a row the database cannot hold (active-scope architecture § 6.1) — they
 * are the table's plumbing and nothing outside it has a reason to read them, which is why the reads
 * below name their columns rather than selecting everything.
 *
 * `deletedBy` is on the row because the store answers what is stored. It is never sent to a member
 * ([3.5.8](docs/active-scope/prd.md)) — the wire contract is where it is dropped, not here.
 */
export interface NoteRow {
  readonly id: string;
  readonly recordingId: string;
  readonly authorId: string;
  /** The note this one replies to. Non-null exactly on replies. */
  readonly parentId: string | null;
  /** Where in the recording it was written, in milliseconds. Non-null exactly on top-level notes. */
  readonly timestampMs: number | null;
  readonly visibility: NoteVisibility;
  /** Null exactly when the row is a tombstone. */
  readonly text: string | null;
  readonly createdAt: Date;
  /** Null until the first edit; what drives the **edited** indicator. */
  readonly editedAt: Date | null;
  /** Presence is what makes a row a tombstone. */
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

/** A note as a writer supplies it. The id and the timestamps are the table's business. */
export interface NewNote {
  readonly recordingId: string;
  readonly authorId: string;
  readonly visibility: NoteVisibility;
  readonly text: string;
  /** A moment in the recording, on a top-level note. Omitted on a reply. */
  readonly timestampMs?: number | null;
  /** The note being replied to. Omitted on a top-level note. */
  readonly parentId?: string | null;
}

/** The columns every read below returns — named, so the generated pair stays inside the table. */
const NOTE_COLUMNS = {
  id: note.id,
  recordingId: note.recordingId,
  authorId: note.authorId,
  parentId: note.parentId,
  timestampMs: note.timestampMs,
  visibility: note.visibility,
  text: note.text,
  createdAt: note.createdAt,
  editedAt: note.editedAt,
  deletedAt: note.deletedAt,
  deletedBy: note.deletedBy,
} as const;

/**
 * Write a note and answer the row that was written.
 *
 * Takes an executor rather than a handle, like every write since Ticket 02, so a caller with more
 * than one statement to make — the pin-clear and the delete that
 * [3.6.9](docs/active-scope/prd.md) will not let happen separately — can pull this into its
 * transaction.
 *
 * **Nothing is checked here.** The shape rules are the table's: a top-level note without a position
 * and a reply carrying one, a reply to a reply, a private reply and text over the ceiling are each
 * refused by Postgres (active-scope architecture § 6.1), and the state rules are the service's.
 */
export async function insertNote(
  input: NewNote,
  executor: Executor = getDatabase(),
): Promise<NoteRow> {
  const rows = await queryable(executor)
    .insert(note)
    .values({
      recordingId: input.recordingId,
      authorId: input.authorId,
      visibility: input.visibility,
      text: input.text,
      timestampMs: input.timestampMs ?? null,
      parentId: input.parentId ?? null,
    })
    .returning(NOTE_COLUMNS);

  const row = rows[0] as NoteRow | undefined;
  if (!row) throw new Error('insertNote returned no row');
  return row;
}

/**
 * A recording's notes **as this reader may see them** — every public note on it, plus that reader's
 * own private ones, and no other member's private note in any position
 * ([3.1.9](docs/active-scope/prd.md)).
 *
 * The condition is stated here rather than applied to a set somebody else selected, which is the
 * whole reason this is a module: a caller that hands over a pre-filtered list has already made the
 * decision this file exists to own, and an admin asking is not a caller the condition bends for.
 *
 * **Ordered by position, then by when it was written** — the `(recording_id, timestamp_ms,
 * created_at)` index exactly, so [3.2.1](docs/active-scope/prd.md)'s order is one index scan and is
 * total: two notes at the same moment come back oldest-first, every time, rather than in whatever
 * order the rows happen to be on disk.
 *
 * **Top-level only.** A reply has no position, so it has no place in a list ordered by one; the
 * thread under a note is its own read and arrives with replies.
 */
export async function listNotesForReader(
  recordingId: string,
  readerId: string,
  executor: Executor = getDatabase(),
): Promise<NoteRow[]> {
  const rows = await queryable(executor)
    .select(NOTE_COLUMNS)
    .from(note)
    .where(
      and(
        eq(note.recordingId, recordingId),
        isNull(note.parentId),
        // The private-note condition. This line, and no other line in this codebase.
        or(eq(note.visibility, 'public'), eq(note.authorId, readerId)),
      ),
    )
    .orderBy(asc(note.timestampMs), asc(note.createdAt));

  return rows as NoteRow[];
}
