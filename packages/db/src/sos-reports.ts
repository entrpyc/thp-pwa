import { and, asc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ReportOutcome, ReportReason, SosUrgency } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { sosReply, sosReport, sosSignal, user } from './schema';

/**
 * **Reports on the SOS channel** — the statements against `sos_report`, and nothing else's.
 * `note-reports.ts`'s twin: the same three reads and two writes, over a prayer request or one
 * reply on it instead of over a note.
 *
 * **One row is about one thing**: the request itself (`aboutReply` false, `replyId` null) or one
 * reply (`aboutReply` true). A reply is a hard delete, so `reply_id` **sets null** when the reply
 * goes and the row keeps saying it was about a reply — the console lists it as already removed
 * and the reporter is still told when an admin closes it, exactly as a tombstoned note's reports
 * are. A request is a hard delete too, and `signal_id` **cascades**: a report about a request the
 * database no longer holds is about nothing — which is why the service closes a request's open
 * reports *before* removing it, so the reporters are told first.
 *
 * **Resolution is by subject**, as a note's is by note: every open report on the same reply, or
 * on the same request, closes with one outcome in one statement. A report whose reply has already
 * gone has no reply to match on, so it closes by its own id.
 *
 * **No block condition is stated here**, deliberately: the reader of the queue is an admin acting
 * on content the group can read. The author joins are spelled `user.id = …author_id` so
 * tools/note-privacy.ts can tell a join from a privacy predicate.
 *
 * Crosses its boundary as row types in and row types out, plus an {@link Executor}, like every
 * module beside it. Drizzle never leaves the package.
 */

/** One `sos_report` row as stored. */
export interface SosReportRow {
  readonly id: string;
  readonly signalId: string;
  /** Whether the report is about a reply rather than the request itself. */
  readonly aboutReply: boolean;
  /** The reply, or null — for a report on the request, and for a reply since removed. */
  readonly replyId: string | null;
  /** Null once the reporter's account is gone (README.md). */
  readonly reporterId: string | null;
  readonly reason: ReportReason;
  readonly detail: string | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  readonly outcome: ReportOutcome | null;
  readonly resolvedBy: string | null;
}

export interface NewSosReport {
  readonly signalId: string;
  /** The reply reported, or null for the request itself. */
  readonly replyId: string | null;
  readonly reporterId: string;
  readonly reason: ReportReason;
  /** Already trimmed; `null` for none. */
  readonly detail: string | null;
}

/** An open report with everything the console shows beside it. */
export interface OpenSosReportRow extends SosReportRow {
  readonly urgency: SosUrgency;
  /** The request's description — what the row is about when `aboutReply` is false. */
  readonly signalDescription: string;
  readonly signalAnonymous: boolean;
  readonly signalAuthorDisplayName: string;
  /** The reply's words as they read now, or null when the reply has gone or the row is about the request. */
  readonly replyText: string | null;
  readonly replyAuthorDisplayName: string | null;
  /** Null once the reporter's account is gone. */
  readonly reporterDisplayName: string | null;
}

/** What closing a subject's reports answers: who to tell, and about which report. */
export interface ResolvedSosReportRow {
  readonly id: string;
  readonly reporterId: string | null;
}

const REPORT_COLUMNS = {
  id: sosReport.id,
  signalId: sosReport.signalId,
  aboutReply: sosReport.aboutReply,
  replyId: sosReport.replyId,
  reporterId: sosReport.reporterId,
  reason: sosReport.reason,
  detail: sosReport.detail,
  createdAt: sosReport.createdAt,
  resolvedAt: sosReport.resolvedAt,
  outcome: sosReport.outcome,
  resolvedBy: sosReport.resolvedBy,
} as const;

// =================================================================================================
// Writing
// =================================================================================================

/** Write one report and answer the row. The service has already decided the content may be reported. */
export async function insertSosReport(
  input: NewSosReport,
  executor: Executor = getDatabase(),
): Promise<SosReportRow> {
  const rows = await queryable(executor)
    .insert(sosReport)
    .values({
      signalId: input.signalId,
      aboutReply: input.replyId !== null,
      replyId: input.replyId,
      reporterId: input.reporterId,
      reason: input.reason,
      detail: input.detail,
    })
    .returning(REPORT_COLUMNS);
  const row = rows[0] as SosReportRow | undefined;
  if (!row) throw new Error('insertSosReport returned no row');
  return row;
}

/**
 * Close every open report on the subject of this one with one outcome, and answer the rows that
 * were open. The subject is the reply when the row is about one that still exists, the request
 * when it is about the request, and the row alone when its reply has already gone.
 *
 * `where resolved_at is null` is what makes a second resolution a no-op rather than a rewrite.
 */
export async function resolveOpenSosReports(
  input: { readonly report: SosReportRow; readonly outcome: ReportOutcome; readonly resolvedBy: string },
  executor: Executor = getDatabase(),
): Promise<ResolvedSosReportRow[]> {
  const { report } = input;
  const subject = !report.aboutReply
    ? and(eq(sosReport.signalId, report.signalId), eq(sosReport.aboutReply, false))
    : report.replyId === null
      ? eq(sosReport.id, report.id)
      : eq(sosReport.replyId, report.replyId);
  const rows = await queryable(executor)
    .update(sosReport)
    .set({ resolvedAt: new Date(), outcome: input.outcome, resolvedBy: input.resolvedBy })
    .where(and(subject, isNull(sosReport.resolvedAt)))
    .returning({ id: sosReport.id, reporterId: sosReport.reporterId });
  return rows as ResolvedSosReportRow[];
}

// =================================================================================================
// Reading
// =================================================================================================

/** One report by id, open or closed, or `null`. */
export async function findSosReportById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<SosReportRow | null> {
  const rows = await queryable(executor)
    .select(REPORT_COLUMNS)
    .from(sosReport)
    .where(eq(sosReport.id, id));
  return (rows[0] as SosReportRow | undefined) ?? null;
}

/**
 * This reporter's open report on this request, or on this reply, or `null` — what makes a second
 * press idempotent, as `findOpenNoteReportByReporter` is for a note.
 */
export async function findOpenSosReportByReporter(
  subject: { readonly signalId: string; readonly replyId: string | null },
  reporterId: string,
  executor: Executor = getDatabase(),
): Promise<SosReportRow | null> {
  const rows = await queryable(executor)
    .select(REPORT_COLUMNS)
    .from(sosReport)
    .where(
      and(
        eq(sosReport.signalId, subject.signalId),
        subject.replyId === null
          ? eq(sosReport.aboutReply, false)
          : eq(sosReport.replyId, subject.replyId),
        eq(sosReport.reporterId, reporterId),
        isNull(sosReport.resolvedAt),
      ),
    )
    .limit(1);
  return (rows[0] as SosReportRow | undefined) ?? null;
}

/**
 * The queue: every open report, oldest first, with the request as it reads **now**, the reply
 * when there still is one, both authors and the reporter.
 *
 * Inner join to the request and its author, because a report cascades with the request; **left**
 * joins to the reply and its author, because `reply_id` sets null when the reply goes; a left
 * join to the reporter for the same reason.
 */
export async function listOpenSosReports(
  executor: Executor = getDatabase(),
): Promise<OpenSosReportRow[]> {
  const signalAuthor = alias(user, 'signal_author');
  const replyAuthor = alias(user, 'reply_author');
  const reporter = alias(user, 'reporter');
  const rows = await queryable(executor)
    .select({
      ...REPORT_COLUMNS,
      urgency: sosSignal.urgency,
      signalDescription: sosSignal.description,
      signalAnonymous: sosSignal.anonymous,
      signalAuthorDisplayName: signalAuthor.displayName,
      replyText: sosReply.text,
      replyAuthorDisplayName: replyAuthor.displayName,
      reporterDisplayName: reporter.displayName,
    })
    .from(sosReport)
    .innerJoin(sosSignal, eq(sosSignal.id, sosReport.signalId))
    // Spelled user-first — see the module comment: a join, not the privacy predicate.
    .innerJoin(signalAuthor, eq(signalAuthor.id, sosSignal.authorId))
    .leftJoin(sosReply, eq(sosReply.id, sosReport.replyId))
    .leftJoin(replyAuthor, eq(replyAuthor.id, sosReply.authorId))
    .leftJoin(reporter, eq(reporter.id, sosReport.reporterId))
    .where(isNull(sosReport.resolvedAt))
    .orderBy(asc(sosReport.createdAt), asc(sosReport.id));
  return rows as OpenSosReportRow[];
}
