import { and, asc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ReportOutcome, ReportReason } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { note, noteReport, recording, user } from './schema';

/**
 * **Reports on notes** — the statements against `note_report`, and nothing else's.
 *
 * Three reads and two writes. The queue read joins the note, its author, the reporter and the
 * recording, because the console needs all four to show one row and four round trips per row is
 * how a queue of fifty becomes two hundred statements. **No privacy condition is stated here**,
 * deliberately: a report can only be made on a public note (the service refuses the rest before a
 * row exists), and the reader of this list is an admin acting on content the group can already
 * read. The join to the author is spelled `user.id = note.author_id` rather than the other way
 * round so tools/note-privacy.ts can tell a join from a privacy predicate — the module that owns
 * the private-note condition is `notes.ts`, and this one must not look like a second copy.
 *
 * **Resolution is by note, not by report.** An admin decides about a note; every open report on it
 * is closed with that one outcome in one statement, and the rows closed come back so the service
 * can tell each reporter. Two admins resolving the same note at once both succeed and the second
 * closes nothing, which the service reads as "already handled" rather than as an error.
 *
 * Crosses its boundary as row types in and row types out, plus an {@link Executor}, like every
 * module beside it. Drizzle never leaves the package.
 */

/** One `note_report` row as stored. */
export interface NoteReportRow {
  readonly id: string;
  readonly noteId: string;
  /** Null once the reporter's account is gone (README.md). */
  readonly reporterId: string | null;
  readonly reason: ReportReason;
  readonly detail: string | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  readonly outcome: ReportOutcome | null;
  readonly resolvedBy: string | null;
}

export interface NewNoteReport {
  readonly noteId: string;
  readonly reporterId: string;
  readonly reason: ReportReason;
  /** Already trimmed; `null` for none. */
  readonly detail: string | null;
}

/** An open report with everything the console shows beside it. */
export interface OpenNoteReportRow extends NoteReportRow {
  /** Null on a tombstone, as the column is. */
  readonly noteText: string | null;
  readonly noteDeletedAt: Date | null;
  readonly noteAuthorDisplayName: string;
  /** Null once the reporter's account is gone. */
  readonly reporterDisplayName: string | null;
  readonly recordingId: string;
  readonly recordingTitle: string;
}

/** What closing a note's reports answers: who to tell, and about which report. */
export interface ResolvedNoteReportRow {
  readonly id: string;
  readonly reporterId: string | null;
}

const REPORT_COLUMNS = {
  id: noteReport.id,
  noteId: noteReport.noteId,
  reporterId: noteReport.reporterId,
  reason: noteReport.reason,
  detail: noteReport.detail,
  createdAt: noteReport.createdAt,
  resolvedAt: noteReport.resolvedAt,
  outcome: noteReport.outcome,
  resolvedBy: noteReport.resolvedBy,
} as const;

// =================================================================================================
// Writing
// =================================================================================================

/** Write one report and answer the row. The service has already decided the note may be reported. */
export async function insertNoteReport(
  input: NewNoteReport,
  executor: Executor = getDatabase(),
): Promise<NoteReportRow> {
  const rows = await queryable(executor).insert(noteReport).values(input).returning(REPORT_COLUMNS);
  const row = rows[0] as NoteReportRow | undefined;
  if (!row) throw new Error('insertNoteReport returned no row');
  return row;
}

/**
 * Close every open report on one note with one outcome, and answer the rows that were open.
 *
 * `where resolved_at is null` is what makes a second resolution a no-op rather than a rewrite: a
 * decision already taken is not overwritten by a later admin acting on a stale screen, and the
 * empty answer is how the service knows to say so.
 */
export async function resolveOpenReportsForNote(
  input: { readonly noteId: string; readonly outcome: ReportOutcome; readonly resolvedBy: string },
  executor: Executor = getDatabase(),
): Promise<ResolvedNoteReportRow[]> {
  const rows = await queryable(executor)
    .update(noteReport)
    .set({ resolvedAt: new Date(), outcome: input.outcome, resolvedBy: input.resolvedBy })
    .where(and(eq(noteReport.noteId, input.noteId), isNull(noteReport.resolvedAt)))
    .returning({ id: noteReport.id, reporterId: noteReport.reporterId });
  return rows as ResolvedNoteReportRow[];
}

// =================================================================================================
// Reading
// =================================================================================================

/** One report by id, open or closed, or `null`. */
export async function findNoteReportById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<NoteReportRow | null> {
  const rows = await queryable(executor)
    .select(REPORT_COLUMNS)
    .from(noteReport)
    .where(eq(noteReport.id, id));
  return (rows[0] as NoteReportRow | undefined) ?? null;
}

/**
 * This reporter's open report on this note, or `null`. What makes a second press idempotent: a
 * member reporting a note they have already reported is answered with the report they made, and
 * no second row and no second notice to the admins come of it.
 */
export async function findOpenNoteReportByReporter(
  noteId: string,
  reporterId: string,
  executor: Executor = getDatabase(),
): Promise<NoteReportRow | null> {
  const rows = await queryable(executor)
    .select(REPORT_COLUMNS)
    .from(noteReport)
    .where(
      and(
        eq(noteReport.noteId, noteId),
        eq(noteReport.reporterId, reporterId),
        isNull(noteReport.resolvedAt),
      ),
    )
    .limit(1);
  return (rows[0] as NoteReportRow | undefined) ?? null;
}

/**
 * The queue: every open report, oldest first, with the note as it reads **now**, its author, the
 * reporter and the recording.
 *
 * Inner joins to the note and the recording, because a report's note cascades with both and so
 * always has a row; a **left** join to the reporter, because `reporter_id` sets null when the
 * account goes and the report still stands. The author join is inner for the reason `notes.ts`
 * gives: `author_id` restricts on delete and is re-pointed at the placeholder first.
 */
export async function listOpenNoteReports(
  executor: Executor = getDatabase(),
): Promise<OpenNoteReportRow[]> {
  const author = alias(user, 'author');
  const reporter = alias(user, 'reporter');
  const rows = await queryable(executor)
    .select({
      ...REPORT_COLUMNS,
      noteText: note.text,
      noteDeletedAt: note.deletedAt,
      noteAuthorDisplayName: author.displayName,
      reporterDisplayName: reporter.displayName,
      recordingId: recording.id,
      recordingTitle: recording.title,
    })
    .from(noteReport)
    .innerJoin(note, eq(note.id, noteReport.noteId))
    // Spelled user-first — see the module comment: a join, not the privacy predicate.
    .innerJoin(author, eq(author.id, note.authorId))
    .leftJoin(reporter, eq(reporter.id, noteReport.reporterId))
    .innerJoin(recording, eq(recording.id, note.recordingId))
    .where(isNull(noteReport.resolvedAt))
    .orderBy(asc(noteReport.createdAt), asc(noteReport.id));
  return rows as OpenNoteReportRow[];
}
