import {
  deleteSosReply,
  findNoteById,
  findNoteReportById,
  findSosReportById,
  findSosSignalById,
  listOpenNoteReports,
  listOpenSosReports,
  removeSosSignal,
  resolveOpenReportsForNote,
  resolveOpenSosReports,
  withTransaction,
  type NoteReportRow,
  type OpenNoteReportRow,
  type OpenSosReportRow,
  type SosReportRow,
} from '@thp/db';
import {
  ANONYMOUS_DISPLAY_NAME,
  isReportOutcome,
  type NoteReportView,
  type ReportListPayload,
  type ReportOutcome,
  type ReportView,
  type ResolveReportPayload,
  type ResolveReportRequest,
  type SosReportView,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { authorise } from '@/server/auth/authorise';
import type { Actor } from '@/server/auth/policy';
import { deleteNote } from '@/server/notes/service';
import { notifyReportResolved, notifySosReportResolved } from '@/server/notifications/service';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';

/**
 * **The admin's side of a report** — reading the queue, and closing it one subject at a time.
 *
 * Who may is the policy module's answer, asked by the routes (`report.list`, `report.resolve`).
 * What this module decides is the two things a resolution can mean and what each does, for each
 * of the two kinds of content a member can flag:
 *
 * - **`dismissed`**: the content stays. Every open report on it is closed, and each reporter is
 *   told it was reviewed.
 * - **`removed`**: a note goes **through `deleteNote`**, the same function an admin's Delete in
 *   the note menu calls, so the moderation audit line ([3.12.10](docs/project/prd.md)) is written
 *   by the one place that writes it. A reply on a prayer request goes through the SOS service's
 *   moderation removal, a prayer request through `removeSignalFor` ([3.16.11](docs/project/prd.md))
 *   — in that case **after** its reports are closed and the reporters told, because removing a
 *   request cascades its reports away. Content already removed by somebody else is not an error
 *   here: the end state the admin asked for is reached, so the reports are closed as `removed` and
 *   the reporters are told.
 *
 * **Reports are resolved by subject, not one by one.** An admin deciding about a note, a request
 * or a reply has decided about every open report on it; closing them together is what stops a
 * queue of five reports on one thing being five decisions. The id in the path says which subject,
 * by way of which report — and the two report tables share one id space, so the id alone says
 * which table.
 *
 * Making a report is each content service's (`reportNote`, `reportSignalFor`), beside the other
 * things a member does there; this module is only what happens to it afterwards.
 */

const FORMER_MEMBER = 'A former member';

export async function listReportsFor(actor: Actor): Promise<ReportListPayload> {
  const [notes, sos] = await Promise.all([listOpenNoteReports(), listOpenSosReports()]);
  // One queue, oldest first, whichever table a row came from; the id breaks a tie the way each
  // list already does, so two listings agree.
  const reports: ReportView[] = [...notes.map(describeNote), ...sos.map(describeSos)].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  logger.info('report.list', { actorId: actor.id, count: reports.length });
  return { reports };
}

export async function resolveReportFor(
  actor: Actor,
  reportId: string,
  body: unknown,
): Promise<ResolveReportPayload> {
  const outcome = parseOutcome(body);
  const noteReport = await findNoteReportById(reportId);
  if (noteReport !== null) return resolveNoteReport(actor, noteReport, outcome);
  const sosReport = await findSosReportById(reportId);
  if (sosReport !== null) return resolveSosReport(actor, sosReport, outcome);
  throw ApiError.notFound('There is no report with that id.');
}

// =================================================================================================
// Notes
// =================================================================================================

async function resolveNoteReport(
  actor: Actor,
  report: NoteReportRow,
  outcome: ReportOutcome,
): Promise<ResolveReportPayload> {
  // A decision already taken stands. The admin acting on a stale screen reads what was decided.
  if (report.resolvedAt !== null) return alreadyResolved(actor, report, outcome);

  const note = await findNoteById(report.noteId);
  if (note === null) throw ApiError.notFound('The reported note no longer exists.');

  if (outcome === 'removed') await removeNoteThroughModeration(actor, report.noteId);

  const closed = await resolveOpenReportsForNote({
    noteId: report.noteId,
    outcome,
    resolvedBy: actor.id,
  });

  logger.info('report.resolve', {
    ...audit(actor, 'report.resolve', `report:${report.id}`),
    noteId: report.noteId,
    outcome,
    closed: closed.length,
  });

  // After the decision is committed and never as a condition of it, like every other notice.
  await notifyReportResolved({
    reporterIds: closed.map((row) => row.reporterId),
    noteId: report.noteId,
    recordingId: note.recordingId,
    outcome,
    resolver: actor,
  });

  return { outcome, closed: closed.length, ...(await listReportsFor(actor)) };
}

/**
 * Delete the note the way the menu does, and treat "already removed" as done.
 *
 * `deleteNote` asks the policy module itself — `note.delete` on ownership, then `note.moderate` —
 * so an admin removing their own reported note takes the owned path and is not logged as
 * moderation, exactly as it would be from the menu. A private note cannot reach here: it could
 * never have been reported.
 */
async function removeNoteThroughModeration(actor: Actor, noteId: string): Promise<void> {
  try {
    await deleteNote(actor, noteId);
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === 'note_removed') return;
    throw caught;
  }
}

// =================================================================================================
// The SOS channel
// =================================================================================================

async function resolveSosReport(
  actor: Actor,
  report: SosReportRow,
  outcome: ReportOutcome,
): Promise<ResolveReportPayload> {
  if (report.resolvedAt !== null) return alreadyResolved(actor, report, outcome);

  const signal = await findSosSignalById(report.signalId);
  if (signal === null) throw ApiError.notFound('The reported prayer request no longer exists.');
  const about = report.aboutReply ? 'reply' : 'signal';
  const removing = outcome === 'removed';

  // **The decision and its effect are one transaction** (docs/security-audit-2026-10-29.md,
  // finding 6): the reports close and the content goes together, or neither happens. The reports
  // close first because a removed reply sets the rows' `reply_id` null, and "every open report on
  // this reply" would then match nothing. A request's removal is a mark on its row, so its reports
  // survive it as the moderation record; a reply's removal is a delete, and its reports keep
  // saying what they were about through `about_reply`.
  if (removing && about === 'signal') authorise(actor, 'sos.moderate', `sos:${report.signalId}`);
  if (removing && about === 'reply') authorise(actor, 'sos.moderate', `sos_reply:${report.replyId}`);
  const { closed, removed } = await withTransaction(async (tx) => {
    const closed = await resolveOpenSosReports({ report, outcome, resolvedBy: actor.id }, tx);
    let removed = false;
    if (removing && about === 'signal') {
      removed = await removeSosSignal({ signalId: report.signalId, removedBy: actor.id }, tx);
    }
    // A reply already gone — by its author, or by an admin on the page — is the end state asked for.
    if (removing && about === 'reply' && report.replyId !== null) {
      removed = await deleteSosReply(report.replyId, tx);
    }
    return { closed, removed };
  });

  if (removing) {
    logger.info('sos.moderate', {
      ...audit(actor, 'sos.moderate', about === 'signal' ? `sos:${report.signalId}` : `sos_reply:${report.replyId}`),
      signalId: report.signalId,
      outcome: removed ? 'removed' : 'already-removed',
      authorId: signal.authorId,
    });
  }
  logger.info('report.resolve', {
    ...audit(actor, 'report.resolve', `report:${report.id}`),
    signalId: report.signalId,
    replyId: report.replyId,
    about,
    outcome,
    closed: closed.length,
  });

  // After the decision is committed and never as a condition of it. The notice does not name a
  // removed request, so the press lands on the board rather than on a page that is gone.
  await notifySosReportResolved({
    reporterIds: closed.map((row) => row.reporterId),
    signalId: report.signalId,
    about,
    outcome,
    resolver: actor,
  });

  return { outcome, closed: closed.length, ...(await listReportsFor(actor)) };
}

// =================================================================================================
// Shared
// =================================================================================================

async function alreadyResolved(
  actor: Actor,
  report: { readonly id: string; readonly outcome: ReportOutcome | null },
  outcome: ReportOutcome,
): Promise<ResolveReportPayload> {
  logger.info('report.resolve', {
    ...audit(actor, 'report.resolve', `report:${report.id}`),
    outcome: report.outcome,
    closed: 0,
    alreadyResolved: true,
  });
  return { outcome: report.outcome ?? outcome, closed: 0, ...(await listReportsFor(actor)) };
}

function parseOutcome(body: unknown): ReportOutcome {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the outcome.');
  }
  const { outcome } = body as Partial<ResolveReportRequest>;
  if (!isReportOutcome(outcome)) {
    throw ApiError.invalidInput('Say whether the report is dismissed or the content removed.');
  }
  return outcome;
}

function describeNote(row: OpenNoteReportRow): NoteReportView {
  return {
    kind: 'note',
    id: row.id,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
    noteId: row.noteId,
    noteText: row.noteText ?? '',
    noteDeleted: row.noteDeletedAt !== null,
    noteAuthorDisplayName: row.noteAuthorDisplayName,
    // A reporter whose account is gone is answered as nobody rather than as a blank the console
    // would print as a name — the same line `describeAnnouncement` takes for a departed sender.
    reporterDisplayName: row.reporterDisplayName ?? FORMER_MEMBER,
    recordingId: row.recordingId,
    recordingTitle: row.recordingTitle,
  };
}

function describeSos(row: OpenSosReportRow): SosReportView {
  const aboutReply = row.aboutReply;
  return {
    kind: aboutReply ? 'sos_reply' : 'sos_signal',
    id: row.id,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
    signalId: row.signalId,
    replyId: row.replyId,
    urgency: row.urgency,
    text: aboutReply ? (row.replyText ?? '') : row.signalDescription,
    deleted: aboutReply && row.replyId === null,
    // The stand-in on an anonymous request, for everybody but its author — an admin included.
    authorDisplayName: aboutReply
      ? (row.replyAuthorDisplayName ?? FORMER_MEMBER)
      : row.signalAnonymous
        ? ANONYMOUS_DISPLAY_NAME
        : row.signalAuthorDisplayName,
    reporterDisplayName: row.reporterDisplayName ?? FORMER_MEMBER,
  };
}
