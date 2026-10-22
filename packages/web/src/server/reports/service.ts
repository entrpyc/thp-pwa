import {
  findNoteById,
  findNoteReportById,
  listOpenNoteReports,
  resolveOpenReportsForNote,
  type OpenNoteReportRow,
} from '@thp/db';
import {
  isReportOutcome,
  type ReportListPayload,
  type ReportOutcome,
  type ReportView,
  type ResolveReportPayload,
  type ResolveReportRequest,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { deleteNote } from '@/server/notes/service';
import { notifyReportResolved } from '@/server/notifications/service';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';

/**
 * **The admin's side of a report** — reading the queue, and closing it one note at a time.
 *
 * Who may is the policy module's answer, asked by the routes (`report.list`, `report.resolve`).
 * What this module decides is the two things a resolution can mean and what each does:
 *
 * - **`dismissed`**: the note stays. Every open report on it is closed, and each reporter is told
 *   the note was reviewed.
 * - **`removed`**: the note goes **through `deleteNote`**, the same function an admin's Delete in
 *   the note menu calls, so the moderation audit line ([3.12.10](docs/project/prd.md)) is written
 *   by the one place that writes it, the pin is cleared and the vector is dropped in the same
 *   transaction they always are. A note already removed by somebody else — its author, an admin on
 *   the teaching — is not an error here: the end state the admin asked for is reached, so the
 *   reports are closed as `removed` and the reporters are told.
 *
 * **Reports are resolved by note, not one by one.** An admin deciding about a note has decided
 * about every open report on it; closing them together is what stops a queue of five reports on
 * one note being five decisions. The id in the path says which note, by way of which report.
 *
 * Making a report is the notes service's (`reportNote`), beside the other things a member does to
 * a note; this module is only what happens to it afterwards.
 */

export async function listReportsFor(actor: Actor): Promise<ReportListPayload> {
  const rows = await listOpenNoteReports();
  logger.info('report.list', { actorId: actor.id, count: rows.length });
  return { reports: rows.map(describe) };
}

export async function resolveReportFor(
  actor: Actor,
  reportId: string,
  body: unknown,
): Promise<ResolveReportPayload> {
  const outcome = parseOutcome(body);
  const report = await findNoteReportById(reportId);
  if (report === null) throw ApiError.notFound('There is no report with that id.');

  // A decision already taken stands. The admin acting on a stale screen reads what was decided.
  if (report.resolvedAt !== null) {
    logger.info('report.resolve', {
      ...audit(actor, 'report.resolve', `report:${reportId}`),
      outcome: report.outcome,
      closed: 0,
      alreadyResolved: true,
    });
    return { outcome: report.outcome ?? outcome, closed: 0, ...(await listReportsFor(actor)) };
  }

  const note = await findNoteById(report.noteId);
  if (note === null) throw ApiError.notFound('The reported note no longer exists.');

  if (outcome === 'removed') await removeThroughModeration(actor, report.noteId);

  const closed = await resolveOpenReportsForNote({
    noteId: report.noteId,
    outcome,
    resolvedBy: actor.id,
  });

  logger.info('report.resolve', {
    ...audit(actor, 'report.resolve', `report:${reportId}`),
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
async function removeThroughModeration(actor: Actor, noteId: string): Promise<void> {
  try {
    await deleteNote(actor, noteId);
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === 'note_removed') return;
    throw caught;
  }
}

function parseOutcome(body: unknown): ReportOutcome {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the outcome.');
  }
  const { outcome } = body as Partial<ResolveReportRequest>;
  if (!isReportOutcome(outcome)) {
    throw ApiError.invalidInput('Say whether the report is dismissed or the note removed.');
  }
  return outcome;
}

function describe(row: OpenNoteReportRow): ReportView {
  return {
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
    reporterDisplayName: row.reporterDisplayName ?? 'A former member',
    recordingId: row.recordingId,
    recordingTitle: row.recordingTitle,
  };
}
